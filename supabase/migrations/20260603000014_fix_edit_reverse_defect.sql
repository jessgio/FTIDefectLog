-- Fix edit failures when defect_lines lack per-piece reasons or inventory is out of sync with history.

create or replace function app.defect_lines_have_reasons(p_lines jsonb)
returns boolean
language sql
immutable
as $$
  select exists (
    select 1
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) elem
    where nullif(trim(coalesce(elem ->> 'defect_reason', '')), '') is not null
  );
$$;

create or replace function app.apply_inbound_by_defect_lines(
  p_payload jsonb,
  p_product text,
  p_batch text,
  p_expiry date,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  rec record;
  slice jsonb;
  results jsonb := '[]'::jsonb;
  v_fallback text := trim(coalesce(p_payload ->> 'defect_reason', ''));
  idx integer := 0;
begin
  if jsonb_array_length(p_lines) <> (p_payload ->> 'quantity_pcs')::integer then
    raise exception 'defect_lines length must match quantity_pcs (%).', (p_payload ->> 'quantity_pcs');
  end if;

  for rec in
    select
      trim(
        coalesce(
          nullif(trim(coalesce(elem ->> 'defect_reason', '')), ''),
          nullif(v_fallback, '')
        )
      ) as defect_reason,
      count(*)::int as cnt
    from jsonb_array_elements(p_lines) elem
    group by 1
  loop
    if rec.defect_reason = '' then
      raise exception 'Each piece must have a defect reason.';
    end if;
    slice := p_payload || jsonb_build_object('defect_reason', rec.defect_reason, 'defect_lines', '[]'::jsonb);
    results := results || jsonb_build_array(
      app.apply_inventory_change('inbound', slice, p_product, p_batch, p_expiry, rec.cnt, rec.defect_reason)
        || jsonb_build_object('defect', rec.defect_reason, 'added', rec.cnt)
    );
    idx := idx + 1;
  end loop;

  return jsonb_build_object('mode', 'by_piece', 'lines', jsonb_array_length(p_lines), 'groups', results);
end;
$$;

create or replace function app.apply_movement_effect(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_direction text := lower(trim(coalesce(p_payload ->> 'direction', '')));
  v_product text := trim(coalesce(p_payload ->> 'product_name', ''));
  v_batch text := trim(coalesce(p_payload ->> 'batch_code', ''));
  v_expiry date := app.normalize_expiry(p_payload ->> 'expiry_date');
  v_qty integer := (p_payload ->> 'quantity_pcs')::integer;
  v_lines jsonb := coalesce(p_payload -> 'defect_lines', '[]'::jsonb);
  v_defect text;
  v_defect_match text;
begin
  if v_direction = 'inbound'
    and jsonb_array_length(v_lines) > 0
    and app.defect_lines_have_reasons(v_lines) then
    return app.apply_inbound_by_defect_lines(p_payload, v_product, v_batch, v_expiry, v_lines);
  end if;

  if v_direction = 'outbound' then
    v_defect := trim(coalesce(p_payload ->> 'defect_reason', ''));
  else
    v_defect := trim(coalesce(p_payload ->> 'defect_reason', app.summarize_defect_lines(v_lines)));
  end if;

  v_defect_match := coalesce(app.normalize_defect_for_match(v_defect), '');

  return app.apply_inventory_change(v_direction, p_payload, v_product, v_batch, v_expiry, v_qty, v_defect_match);
end;
$$;

create or replace function app.reverse_movement_effect(p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_direction text := lower(trim(coalesce(p_payload ->> 'direction', '')));
  v_lines jsonb := coalesce(p_payload -> 'defect_lines', '[]'::jsonb);
  v_fallback text := trim(coalesce(p_payload ->> 'defect_reason', ''));
  rec record;
  slice jsonb;
  reversed jsonb;
begin
  if v_direction = 'inbound'
    and jsonb_array_length(v_lines) > 0
    and app.defect_lines_have_reasons(v_lines) then
    for rec in
      select
        trim(
          coalesce(
            nullif(trim(coalesce(elem ->> 'defect_reason', '')), ''),
            nullif(v_fallback, '')
          )
        ) as defect_reason,
        count(*)::int as cnt
      from jsonb_array_elements(v_lines) elem
      group by 1
    loop
      if rec.defect_reason = '' then
        raise exception 'Each piece must have a defect reason.';
      end if;
      slice := p_payload || jsonb_build_object(
        'direction', 'outbound',
        'quantity_pcs', rec.cnt,
        'defect_reason', rec.defect_reason,
        'defect_lines', '[]'::jsonb
      );
      perform app.apply_movement_effect(slice);
    end loop;
    return;
  end if;

  reversed := p_payload || jsonb_build_object(
    'direction', case when v_direction = 'inbound' then 'outbound' else 'inbound' end,
    'defect_lines', '[]'::jsonb
  );
  perform app.apply_movement_effect(reversed);
end;
$$;

-- update_movement: if reverse cannot find a lot, update the row then rebuild inventory from history.
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
  v_source_only_change boolean := false;
  v_old_lines jsonb;
  v_old_summary text;
  v_new_summary text;
  v_rehomed integer;
  v_reject_type text;
  v_reject_vendor text;
  v_inventory_reconcile boolean := false;
  v_product text;
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
  v_reject_type := nullif(trim(coalesce(v_payload ->> 'reject_source_type', '')), '');
  v_reject_vendor := nullif(trim(coalesce(v_payload ->> 'reject_source_vendor', '')), '');

  if v_direction = 'inbound' and v_reject_type is null then
    raise exception 'reject_source_type is required for inbound';
  end if;

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

  v_inbound_expiry_only :=
    v_direction = 'inbound'
    and v_old.direction = 'inbound'
    and lower(v_old_batch) = lower(v_new_batch)
    and v_new_expiry is distinct from v_old_expiry
    and lower(trim(coalesce(v_payload ->> 'product_name', ''))) = lower(trim(v_old.product_name))
    and (v_payload ->> 'quantity_pcs')::integer = v_old.quantity_pcs;

  v_source_only_change :=
    v_direction = 'inbound'
    and v_old.direction = 'inbound'
    and not v_material_change
    and not v_inbound_expiry_only
    and (
      v_reject_type is distinct from nullif(trim(coalesce(v_old.reject_source_type, '')), '')
      or v_reject_vendor is distinct from nullif(trim(coalesce(v_old.reject_source_vendor, '')), '')
      or trim(coalesce(v_payload ->> 'notes', '')) is distinct from trim(coalesce(v_old.notes, ''))
      or trim(coalesce(v_payload ->> 'logged_by', '')) is distinct from trim(coalesce(v_old.logged_by, ''))
    );

  if v_source_only_change then
    update public.movements
    set
      logged_by = trim(coalesce(v_payload ->> 'logged_by', '')),
      notes = nullif(trim(coalesce(v_payload ->> 'notes', '')), ''),
      reject_source_type = v_reject_type,
      reject_source_vendor = v_reject_vendor,
      rsp_per_unit = nullif(v_payload ->> 'rsp_per_unit', '')::numeric,
      cogs_per_unit = nullif(v_payload ->> 'cogs_per_unit', '')::numeric,
      created_at = now()
    where id = p_id;

    perform app.sync_inbound_reject_source(
      trim(v_old.product_name),
      v_new_batch,
      v_new_expiry,
      v_reject_type,
      v_reject_vendor
    );

    perform app.purge_zero_inventory_lots(trim(v_old.product_name));
    perform app.purge_zero_inventory_lots(trim(coalesce(v_payload ->> 'product_name', '')));

    return jsonb_build_object('ok', true, 'updated', p_id, 'reject_source_only', true);
  end if;

  if v_inbound_expiry_only then
    v_rehomed := app.rehome_inbound_expiry_fuzzy(
      trim(v_old.product_name),
      v_old_batch,
      v_old_expiry,
      v_new_batch,
      v_new_expiry
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
      disposition = null,
      notes = nullif(trim(coalesce(v_payload ->> 'notes', '')), ''),
      reject_source_type = v_reject_type,
      reject_source_vendor = v_reject_vendor,
      rsp_per_unit = nullif(v_payload ->> 'rsp_per_unit', '')::numeric,
      cogs_per_unit = nullif(v_payload ->> 'cogs_per_unit', '')::numeric,
      defect_lines = v_lines,
      created_at = now()
    where id = p_id;

    if v_rehomed > 0 then
      perform app.sync_inbound_reject_source(
        trim(v_old.product_name),
        v_new_batch,
        v_new_expiry,
        v_reject_type,
        v_reject_vendor
      );
      perform app.purge_zero_inventory_lots(trim(v_old.product_name));
      perform app.purge_zero_inventory_lots(trim(coalesce(v_payload ->> 'product_name', '')));

      return jsonb_build_object('ok', true, 'updated', p_id, 'inbound_expiry_rehomed', v_rehomed);
    end if;

    begin
      perform app.reverse_movement_effect(app.movement_row_to_payload(v_old));
    exception
      when others then
        if sqlerrm like '%No matching lot%' then
          v_inventory_reconcile := true;
        else
          raise;
        end if;
    end;

    if v_inventory_reconcile then
      perform public.reconcile_product_inventory(trim(coalesce(v_payload ->> 'product_name', v_old.product_name)));
    else
      perform app.apply_movement_effect(v_payload);
    end if;

    perform app.purge_zero_inventory_lots(trim(v_old.product_name));
    perform app.purge_zero_inventory_lots(trim(coalesce(v_payload ->> 'product_name', '')));

    return jsonb_build_object(
      'ok', true,
      'updated', p_id,
      'inbound_expiry_fallback', true,
      'inventory_reconciled', v_inventory_reconcile
    );
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
      reject_source_type = case when v_direction = 'inbound' then v_reject_type else null end,
      reject_source_vendor = case when v_direction = 'inbound' then v_reject_vendor else null end,
      rsp_per_unit = nullif(v_payload ->> 'rsp_per_unit', '')::numeric,
      cogs_per_unit = nullif(v_payload ->> 'cogs_per_unit', '')::numeric,
      defect_lines = v_lines,
      created_at = now()
    where id = p_id;

    if v_direction = 'inbound' then
      perform app.sync_inbound_reject_source(
        trim(coalesce(v_payload ->> 'product_name', '')),
        v_new_batch,
        v_new_expiry,
        v_reject_type,
        v_reject_vendor
      );
    end if;

    perform app.purge_zero_inventory_lots(trim(v_old.product_name));
    perform app.purge_zero_inventory_lots(trim(coalesce(v_payload ->> 'product_name', '')));

    return jsonb_build_object('ok', true, 'updated', p_id, 'lot_keys_renamed', true);
  end if;

  begin
    perform app.reverse_movement_effect(app.movement_row_to_payload(v_old));
  exception
    when others then
      if sqlerrm like '%No matching lot%' then
        v_inventory_reconcile := true;
      else
        raise;
      end if;
  end;

  if not v_inventory_reconcile
    and (v_old_batch is distinct from v_new_batch or v_new_expiry is distinct from v_old_expiry) then
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
    reject_source_type = case when v_direction = 'inbound' then v_reject_type else null end,
    reject_source_vendor = case when v_direction = 'inbound' then v_reject_vendor else null end,
    rsp_per_unit = nullif(v_payload ->> 'rsp_per_unit', '')::numeric,
    cogs_per_unit = nullif(v_payload ->> 'cogs_per_unit', '')::numeric,
    defect_lines = v_lines,
    created_at = now()
  where id = p_id;

  v_product := trim(coalesce(v_payload ->> 'product_name', v_old.product_name));

  if v_inventory_reconcile then
    perform public.reconcile_product_inventory(v_product);
  else
    perform app.apply_movement_effect(v_payload);
  end if;

  if v_direction = 'inbound' then
    perform app.sync_inbound_reject_source(
      trim(coalesce(v_payload ->> 'product_name', '')),
      v_new_batch,
      v_new_expiry,
      v_reject_type,
      v_reject_vendor
    );
  end if;

  perform app.purge_zero_inventory_lots(trim(v_old.product_name));
  perform app.purge_zero_inventory_lots(v_product);

  return jsonb_build_object(
    'ok', true,
    'updated', p_id,
    'inventory_reconciled', v_inventory_reconcile
  );
end;
$$;
