-- Rebuild a product's inventory lots from movement history (fixes orphan lots after bad edits).

create or replace function app.purge_zero_inventory_lots(p_product text)
returns integer
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_deleted integer;
begin
  delete from public.inventory_lots il
  where lower(il.product_name) = lower(trim(p_product))
    and il.quantity_pcs <= 0;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

create or replace function public.reconcile_product_inventory(p_product text)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_product text := trim(p_product);
  m record;
  v_replayed integer := 0;
  v_purged integer;
begin
  if not app.is_allowed_user() then
    raise exception 'Not authorized';
  end if;
  if v_product = '' then
    raise exception 'product_name is required';
  end if;

  delete from public.inventory_lots il
  where lower(il.product_name) = lower(v_product);

  for m in
    select *
    from public.movements
    where lower(product_name) = lower(v_product)
    order by created_at asc, id asc
  loop
    perform app.apply_movement_effect(app.movement_row_to_payload(m));
    v_replayed := v_replayed + 1;
  end loop;

  v_purged := app.purge_zero_inventory_lots(v_product);

  return jsonb_build_object(
    'ok', true,
    'product_name', v_product,
    'movements_replayed', v_replayed,
    'zero_lots_removed', v_purged
  );
end;
$$;

-- Purge empty lots after every movement write
create or replace function public.create_movement(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_payload jsonb;
  v_id uuid;
  v_direction text;
  v_logged_by text;
  v_product text;
  v_batch text;
  v_expiry date;
  v_qty integer;
  v_defect_summary text;
  v_inventory_defect text;
  v_lines jsonb;
  v_source_type text;
  v_source_vendor text;
begin
  if not app.is_allowed_user() then
    raise exception 'Not authorized';
  end if;

  v_payload := app.resolve_payload_catalog(p_payload);
  v_direction := lower(trim(coalesce(v_payload ->> 'direction', '')));
  v_logged_by := trim(coalesce(v_payload ->> 'logged_by', ''));
  v_product := trim(coalesce(v_payload ->> 'product_name', ''));
  v_batch := trim(coalesce(v_payload ->> 'batch_code', ''));
  v_expiry := app.normalize_expiry(v_payload ->> 'expiry_date');
  v_qty := (v_payload ->> 'quantity_pcs')::integer;
  v_lines := coalesce(v_payload -> 'defect_lines', '[]'::jsonb);
  v_source_type := nullif(trim(coalesce(v_payload ->> 'reject_source_type', '')), '');
  v_source_vendor := nullif(trim(coalesce(v_payload ->> 'reject_source_vendor', '')), '');

  if v_direction not in ('inbound', 'outbound') then
    raise exception 'direction must be inbound or outbound';
  end if;
  if v_logged_by = '' then raise exception 'logged_by is required'; end if;
  if v_batch = '' then raise exception 'batch_code is required'; end if;
  if v_product = '' then raise exception 'product_name is required'; end if;
  if v_qty is null or v_qty <= 0 then raise exception 'quantity_pcs must be positive'; end if;
  if v_direction = 'inbound' and v_source_type is null then
    raise exception 'reject_source_type is required for inbound';
  end if;

  v_id := coalesce(nullif(trim(coalesce(v_payload ->> 'id', '')), '')::uuid, gen_random_uuid());

  v_defect_summary := case
    when v_direction = 'inbound' then coalesce(app.summarize_defect_lines(v_lines), trim(coalesce(v_payload ->> 'defect_reason', '')))
    else ''
  end;
  v_inventory_defect := case
    when v_direction = 'outbound' then trim(coalesce(v_payload ->> 'defect_reason', ''))
    else v_defect_summary
  end;

  insert into public.movements (
    id, direction, logged_by, product_name, sku, batch_code, expiry_date,
    quantity_pcs, defect_reason, disposition, notes,
    reject_source_type, reject_source_vendor,
    rsp_per_unit, cogs_per_unit, defect_lines, created_by
  ) values (
    v_id,
    v_direction,
    v_logged_by,
    v_product,
    nullif(trim(coalesce(v_payload ->> 'sku', '')), ''),
    v_batch,
    v_expiry,
    v_qty,
    nullif(v_inventory_defect, ''),
    case when v_direction = 'outbound' then nullif(trim(coalesce(v_payload ->> 'disposition', '')), '') else null end,
    nullif(trim(coalesce(v_payload ->> 'notes', '')), ''),
    case when v_direction = 'inbound' then v_source_type else null end,
    case when v_direction = 'inbound' then v_reject_vendor else null end,
    nullif(v_payload ->> 'rsp_per_unit', '')::numeric,
    nullif(v_payload ->> 'cogs_per_unit', '')::numeric,
    v_lines,
    auth.uid()
  );

  perform app.apply_movement_effect(v_payload);
  perform app.purge_zero_inventory_lots(v_product);

  return jsonb_build_object(
    'ok', true,
    'movement_id', v_id,
    'direction', v_direction,
    'quantity_pcs', v_qty
  );
end;
$$;

create or replace function public.delete_movement(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_old public.movements;
begin
  if not app.is_allowed_user() then
    raise exception 'Not authorized';
  end if;

  select * into v_old from public.movements where id = p_id for update;
  if not found then
    raise exception 'Movement not found';
  end if;

  perform app.reverse_movement_effect(app.movement_row_to_payload(v_old));
  delete from public.movements where id = p_id;
  perform app.purge_zero_inventory_lots(trim(v_old.product_name));

  return jsonb_build_object('ok', true, 'deleted', p_id);
end;
$$;

revoke all on function public.reconcile_product_inventory(text) from public;
grant execute on function public.reconcile_product_inventory(text) to authenticated, service_role;


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

    perform app.reverse_movement_effect(app.movement_row_to_payload(v_old));
    perform app.apply_movement_effect(v_payload);

    perform app.purge_zero_inventory_lots(trim(v_old.product_name));
    perform app.purge_zero_inventory_lots(trim(coalesce(v_payload ->> 'product_name', '')));

    return jsonb_build_object('ok', true, 'updated', p_id, 'inbound_expiry_fallback', true);
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
    reject_source_type = case when v_direction = 'inbound' then v_reject_type else null end,
    reject_source_vendor = case when v_direction = 'inbound' then v_reject_vendor else null end,
    rsp_per_unit = nullif(v_payload ->> 'rsp_per_unit', '')::numeric,
    cogs_per_unit = nullif(v_payload ->> 'cogs_per_unit', '')::numeric,
    defect_lines = v_lines,
    created_at = now()
  where id = p_id;

  perform app.apply_movement_effect(v_payload);

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

  return jsonb_build_object('ok', true, 'updated', p_id);
end;
$$;
