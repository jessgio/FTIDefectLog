-- Expiry edits failed when:
-- 1) v_lot_keys_only required defect_lines JSON to match exactly (UI rebuild always differs)
-- 2) Outbound: reverse put stock on the OLD expiry lot, then apply looked for the NEW expiry lot

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
  v_keys_conflict boolean := false;
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
  v_old_summary := coalesce(app.summarize_defect_lines(v_old_lines), trim(coalesce(v_old.defect_reason, '')));

  v_material_change :=
    v_direction <> v_old.direction
    or lower(trim(coalesce(v_payload ->> 'product_name', ''))) <> lower(trim(v_old.product_name))
    or (v_payload ->> 'quantity_pcs')::integer <> v_old.quantity_pcs
    or v_new_summary <> v_old_summary
    or (
      v_direction = 'outbound'
      and trim(coalesce(v_payload ->> 'disposition', '')) is distinct from trim(coalesce(v_old.disposition, ''))
    );

  v_lot_keys_only :=
    not v_material_change
    and (v_old_batch is distinct from v_new_batch or v_new_expiry is distinct from v_old_expiry);

  if v_lot_keys_only then
    select exists (
      select 1
      from public.inventory_lots il
      where lower(il.product_name) = lower(trim(v_old.product_name))
        and lower(il.batch_code) = lower(v_new_batch)
        and coalesce(il.expiry_date, '1000-01-01'::date) = coalesce(v_new_expiry, '1000-01-01'::date)
        and lower(coalesce(il.defect_reason, '')) = lower(trim(coalesce(v_old.defect_reason, '')))
        and not (
          lower(il.batch_code) = lower(v_old_batch)
          and coalesce(il.expiry_date, '1000-01-01'::date) = coalesce(v_old_expiry, '1000-01-01'::date)
        )
    ) into v_keys_conflict;

    if not v_keys_conflict then
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

      update public.inventory_lots il
      set
        batch_code = v_new_batch,
        expiry_date = v_new_expiry,
        updated_at = now()
      where lower(il.product_name) = lower(trim(v_old.product_name))
        and lower(il.batch_code) = lower(v_old_batch)
        and coalesce(il.expiry_date, '1000-01-01'::date) = coalesce(v_old_expiry, '1000-01-01'::date)
        and il.quantity_pcs > 0
        and (
          v_direction <> 'outbound'
          or lower(coalesce(il.defect_reason, '')) = lower(trim(coalesce(v_old.defect_reason, '')))
        );

      return jsonb_build_object('ok', true, 'updated', p_id, 'lot_keys_renamed', true);
    end if;
  end if;

  perform app.reverse_movement_effect(app.movement_row_to_payload(v_old));

  -- After reverse, outbound stock sits on the old lot keys; rename before apply so outbound can find the new keys.
  if v_old_batch is distinct from v_new_batch or v_new_expiry is distinct from v_old_expiry then
    update public.inventory_lots il
    set
      batch_code = v_new_batch,
      expiry_date = v_new_expiry,
      updated_at = now()
    where lower(il.product_name) = lower(trim(v_old.product_name))
      and lower(il.batch_code) = lower(v_old_batch)
      and coalesce(il.expiry_date, '1000-01-01'::date) = coalesce(v_old_expiry, '1000-01-01'::date)
      and il.quantity_pcs > 0;
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
