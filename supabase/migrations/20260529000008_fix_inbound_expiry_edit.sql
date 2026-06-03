-- Inbound expiry edits failed intermittently when:
-- 1) lot_keys_only bulk-renamed multiple defect lots and hit unique-index conflicts
-- 2) defect summary comparison blocked the safe path on the 2nd save
-- 3) reverse+apply alone is reliable for inbound expiry-only changes

create or replace function app.rehome_inventory_lot_keys(
  p_product text,
  p_old_batch text,
  p_old_expiry date,
  p_new_batch text,
  p_new_expiry date,
  p_limit_defect text default null
)
returns void
language plpgsql
security definer
set search_path = public, app
as $$
declare
  rec record;
  v_target_id uuid;
  v_target_qty integer;
begin
  for rec in
    select il.id, il.defect_reason, il.quantity_pcs
    from public.inventory_lots il
    where lower(il.product_name) = lower(trim(p_product))
      and lower(il.batch_code) = lower(trim(p_old_batch))
      and coalesce(il.expiry_date, '1000-01-01'::date) = coalesce(p_old_expiry, '1000-01-01'::date)
      and il.quantity_pcs > 0
      and (
        p_limit_defect is null
        or lower(coalesce(il.defect_reason, '')) = lower(trim(p_limit_defect))
      )
  loop
    select il.id, il.quantity_pcs
    into v_target_id, v_target_qty
    from public.inventory_lots il
    where lower(il.product_name) = lower(trim(p_product))
      and lower(il.batch_code) = lower(trim(p_new_batch))
      and coalesce(il.expiry_date, '1000-01-01'::date) = coalesce(p_new_expiry, '1000-01-01'::date)
      and lower(coalesce(il.defect_reason, '')) = lower(coalesce(rec.defect_reason, ''))
      and il.id <> rec.id
    limit 1;

    if v_target_id is not null then
      update public.inventory_lots
      set quantity_pcs = v_target_qty + rec.quantity_pcs, updated_at = now()
      where id = v_target_id;

      update public.inventory_lots
      set quantity_pcs = 0, updated_at = now()
      where id = rec.id;
    else
      update public.inventory_lots
      set
        batch_code = trim(p_new_batch),
        expiry_date = p_new_expiry,
        updated_at = now()
      where id = rec.id;
    end if;
  end loop;
end;
$$;

create or replace function public.update_movement(p_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_old public.movements;
  v_payload jsonb;
  v_direction text;
  v_defect_summary text;
  v_inventory_defect text;
  v_lines jsonb;
  v_old_batch text;
  v_new_batch text;
  v_old_expiry date;
  v_new_expiry date;
  v_lot_keys_only boolean := false;
  v_material_change boolean := false;
  v_inbound_expiry_only boolean := false;
  v_old_lines jsonb;
  v_old_summary text;
  v_new_summary text;
begin
  if not app.is_allowed_user() then
    raise exception 'Not authorized';
  end if;

  select * into v_old from public.movements where id = p_id for update;
  if not found then
    raise exception 'Movement not found';
  end if;

  v_payload := app.resolve_payload_catalog(p_payload);
  v_direction := lower(trim(coalesce(v_payload ->> 'direction', '')));
  v_lines := coalesce(v_payload -> 'defect_lines', '[]'::jsonb);
  v_old_lines := coalesce(v_old.defect_lines, '[]'::jsonb);

  v_defect_summary := case
    when v_direction = 'inbound' then coalesce(app.summarize_defect_lines(v_lines), trim(coalesce(v_payload ->> 'defect_reason', '')))
    else ''
  end;
  v_inventory_defect := case
    when v_direction = 'outbound' then trim(coalesce(v_payload ->> 'defect_reason', ''))
    else v_defect_summary
  end;

  v_old_batch := trim(v_old.batch_code);
  v_new_batch := trim(coalesce(v_payload ->> 'batch_code', ''));
  if v_new_batch = '' then
    raise exception 'batch_code is required';
  end if;

  v_old_expiry := v_old.expiry_date;
  v_new_expiry := app.normalize_expiry(v_payload ->> 'expiry_date');

  v_new_summary := coalesce(app.summarize_defect_lines(v_lines), '');
  v_old_summary := coalesce(app.summarize_defect_lines(v_old_lines), '');
  if v_old_summary = '' then
    v_old_summary := trim(coalesce(v_old.defect_reason, ''));
  end if;

  v_material_change :=
    v_direction <> v_old.direction
    or lower(trim(coalesce(v_payload ->> 'product_name', ''))) <> lower(trim(v_old.product_name))
    or (v_payload ->> 'quantity_pcs')::integer <> v_old.quantity_pcs
    or v_new_summary <> v_old_summary
    or (
      v_direction = 'outbound'
      and trim(coalesce(v_payload ->> 'disposition', '')) is distinct from trim(coalesce(v_old.disposition, ''))
    );

  -- Inbound expiry-only: same product / batch / qty; defect breakdown may be re-serialized by the UI.
  v_inbound_expiry_only :=
    v_direction = 'inbound'
    and v_old.direction = 'inbound'
    and lower(v_old_batch) = lower(v_new_batch)
    and v_new_expiry is distinct from v_old_expiry
    and lower(trim(coalesce(v_payload ->> 'product_name', ''))) = lower(trim(v_old.product_name))
    and (v_payload ->> 'quantity_pcs')::integer = v_old.quantity_pcs;

  if v_inbound_expiry_only then
    perform app.reverse_movement_effect(app.movement_row_to_payload(v_old));

    update public.movements
    set
      direction = v_direction,
      logged_by = trim(coalesce(v_payload ->> 'logged_by', '')),
      product_name = trim(coalesce(v_payload ->> 'product_name', '')),
      sku = nullif(trim(coalesce(v_payload ->> 'sku', '')), ''),
      batch_code = v_new_batch,
      expiry_date = v_new_expiry,
      quantity_pcs = (v_payload ->> 'quantity_pcs')::integer,
      defect_reason = nullif(v_inventory_defect, ''),
      disposition = null,
      notes = nullif(trim(coalesce(v_payload ->> 'notes', '')), ''),
      rsp_per_unit = nullif(v_payload ->> 'rsp_per_unit', '')::numeric,
      cogs_per_unit = nullif(v_payload ->> 'cogs_per_unit', '')::numeric,
      defect_lines = v_lines,
      created_at = now()
    where id = p_id;

    perform app.apply_movement_effect(v_payload);

    return jsonb_build_object('ok', true, 'updated', p_id, 'inbound_expiry_only', true);
  end if;

  v_lot_keys_only :=
    not v_material_change
    and (v_old_batch is distinct from v_new_batch or v_new_expiry is distinct from v_old_expiry);

  if v_lot_keys_only then
    perform app.rehome_inventory_lot_keys(
      trim(v_old.product_name),
      v_old_batch,
      v_old_expiry,
      v_new_batch,
      v_new_expiry,
      case when v_direction = 'outbound' then trim(coalesce(v_old.defect_reason, '')) else null end
    );

    update public.movements
    set
      direction = v_direction,
      logged_by = trim(coalesce(v_payload ->> 'logged_by', '')),
      product_name = trim(coalesce(v_payload ->> 'product_name', '')),
      sku = nullif(trim(coalesce(v_payload ->> 'sku', '')), ''),
      batch_code = v_new_batch,
      expiry_date = v_new_expiry,
      quantity_pcs = (v_payload ->> 'quantity_pcs')::integer,
      defect_reason = nullif(v_inventory_defect, ''),
      disposition = case when v_direction = 'outbound' then nullif(trim(coalesce(v_payload ->> 'disposition', '')), '') else null end,
      notes = nullif(trim(coalesce(v_payload ->> 'notes', '')), ''),
      rsp_per_unit = nullif(v_payload ->> 'rsp_per_unit', '')::numeric,
      cogs_per_unit = nullif(v_payload ->> 'cogs_per_unit', '')::numeric,
      defect_lines = v_lines,
      created_at = now()
    where id = p_id;

    return jsonb_build_object('ok', true, 'updated', p_id, 'lot_keys_renamed', true);
  end if;

  perform app.reverse_movement_effect(app.movement_row_to_payload(v_old));

  if v_old_batch is distinct from v_new_batch or v_new_expiry is distinct from v_old_expiry then
    perform app.rehome_inventory_lot_keys(
      trim(v_old.product_name),
      v_old_batch,
      v_old_expiry,
      v_new_batch,
      v_new_expiry,
      case when v_direction = 'outbound' then trim(coalesce(v_old.defect_reason, '')) else null end
    );
  end if;

  update public.movements
  set
    direction = v_direction,
    logged_by = trim(coalesce(v_payload ->> 'logged_by', '')),
    product_name = trim(coalesce(v_payload ->> 'product_name', '')),
    sku = nullif(trim(coalesce(v_payload ->> 'sku', '')), ''),
    batch_code = v_new_batch,
    expiry_date = v_new_expiry,
    quantity_pcs = (v_payload ->> 'quantity_pcs')::integer,
    defect_reason = nullif(v_inventory_defect, ''),
    disposition = case when v_direction = 'outbound' then nullif(trim(coalesce(v_payload ->> 'disposition', '')), '') else null end,
    notes = nullif(trim(coalesce(v_payload ->> 'notes', '')), ''),
    rsp_per_unit = nullif(v_payload ->> 'rsp_per_unit', '')::numeric,
    cogs_per_unit = nullif(v_payload ->> 'cogs_per_unit', '')::numeric,
    defect_lines = v_lines,
    created_at = now()
  where id = p_id;

  perform app.apply_movement_effect(v_payload);

  return jsonb_build_object('ok', true, 'updated', p_id);
end;
$$;
