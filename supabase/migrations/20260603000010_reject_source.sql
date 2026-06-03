-- Track where defective stock was returned from (channel + vendor/partner).

alter table public.movements
  add column if not exists reject_source_type text,
  add column if not exists reject_source_vendor text;

alter table public.inventory_lots
  add column if not exists reject_source_type text,
  add column if not exists reject_source_vendor text;

create or replace function app.sync_inbound_reject_source(
  p_product text,
  p_batch text,
  p_expiry date,
  p_type text,
  p_vendor text
)
returns integer
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_count integer;
begin
  update public.inventory_lots il
  set
    reject_source_type = p_type,
    reject_source_vendor = p_vendor,
    updated_at = now()
  where lower(il.product_name) = lower(trim(p_product))
    and lower(il.batch_code) = lower(trim(p_batch))
    and coalesce(il.expiry_date, '1000-01-01'::date) = coalesce(p_expiry, '1000-01-01'::date)
    and il.quantity_pcs > 0;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function app.movement_row_to_payload(p_row public.movements)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'direction', p_row.direction,
    'logged_by', p_row.logged_by,
    'product_name', p_row.product_name,
    'sku', coalesce(p_row.sku, ''),
    'batch_code', p_row.batch_code,
    'expiry_date', coalesce(to_char(p_row.expiry_date, 'YYYY-MM-DD'), ''),
    'quantity_pcs', p_row.quantity_pcs,
    'defect_reason', coalesce(p_row.defect_reason, ''),
    'disposition', coalesce(p_row.disposition, ''),
    'notes', coalesce(p_row.notes, ''),
    'reject_source_type', coalesce(p_row.reject_source_type, ''),
    'reject_source_vendor', coalesce(p_row.reject_source_vendor, ''),
    'rsp_per_unit', p_row.rsp_per_unit,
    'cogs_per_unit', p_row.cogs_per_unit,
    'defect_lines', coalesce(p_row.defect_lines, '[]'::jsonb)
  );
$$;

create or replace function app.apply_inventory_change(
  p_direction text,
  p_payload jsonb,
  p_product text,
  p_batch text,
  p_expiry date,
  p_qty integer,
  p_defect_match text
)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_lot_id uuid;
  v_current integer;
  v_pricing record;
  v_rsp numeric;
  v_cogs numeric;
  v_source_type text := nullif(trim(coalesce(p_payload ->> 'reject_source_type', '')), '');
  v_source_vendor text := nullif(trim(coalesce(p_payload ->> 'reject_source_vendor', '')), '');
begin
  v_lot_id := app.find_inventory_lot_id(p_product, p_batch, p_expiry, p_defect_match);

  if p_direction = 'inbound' then
    select * into v_pricing from app.resolve_lot_pricing(p_product, p_batch, p_expiry, p_payload);
    v_rsp := v_pricing.rsp_per_unit;
    v_cogs := v_pricing.cogs_per_unit;

    if v_lot_id is not null then
      select quantity_pcs into v_current from public.inventory_lots where id = v_lot_id for update;
      update public.inventory_lots
      set quantity_pcs = v_current + p_qty,
          batch_code = p_batch,
          expiry_date = p_expiry,
          sku = coalesce(nullif(trim(coalesce(p_payload ->> 'sku', '')), ''), sku),
          rsp_per_unit = coalesce(rsp_per_unit, v_rsp),
          cogs_per_unit = coalesce(cogs_per_unit, v_cogs),
          reject_source_type = coalesce(v_source_type, reject_source_type),
          reject_source_vendor = coalesce(v_source_vendor, reject_source_vendor),
          updated_at = now()
      where id = v_lot_id;
      return jsonb_build_object('action', 'updated', 'lot_id', v_lot_id, 'new_quantity', v_current + p_qty);
    end if;

    insert into public.inventory_lots (
      product_name, sku, defect_reason, batch_code, expiry_date,
      quantity_pcs, rsp_per_unit, cogs_per_unit,
      reject_source_type, reject_source_vendor
    ) values (
      p_product,
      nullif(trim(coalesce(p_payload ->> 'sku', '')), ''),
      coalesce(p_defect_match, ''),
      p_batch,
      p_expiry,
      p_qty,
      v_rsp,
      v_cogs,
      v_source_type,
      v_source_vendor
    )
    returning id into v_lot_id;

    return jsonb_build_object('action', 'created', 'lot_id', v_lot_id);
  end if;

  if v_lot_id is null then
    raise exception 'No matching lot (product + batch + expiry + defect).';
  end if;

  select quantity_pcs into v_current from public.inventory_lots where id = v_lot_id for update;
  if p_qty > v_current then
    raise exception 'Outbound quantity exceeds available stock (% pcs).', v_current;
  end if;

  update public.inventory_lots
  set quantity_pcs = v_current - p_qty,
      updated_at = now()
  where id = v_lot_id;

  return jsonb_build_object('action', 'updated', 'lot_id', v_lot_id, 'new_quantity', v_current - p_qty);
end;
$$;

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
    case when v_direction = 'inbound' then v_source_vendor else null end,
    nullif(v_payload ->> 'rsp_per_unit', '')::numeric,
    nullif(v_payload ->> 'cogs_per_unit', '')::numeric,
    v_lines,
    auth.uid()
  );

  perform app.apply_movement_effect(v_payload);

  return jsonb_build_object(
    'ok', true,
    'movement_id', v_id,
    'direction', v_direction,
    'quantity_pcs', v_qty
  );
end;
$$;

-- Recreate update_movement (from 20260529000009) with reject-source support
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
      return jsonb_build_object('ok', true, 'updated', p_id, 'inbound_expiry_rehomed', v_rehomed);
    end if;

    perform app.reverse_movement_effect(app.movement_row_to_payload(v_old));
    perform app.apply_movement_effect(v_payload);

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

  return jsonb_build_object('ok', true, 'updated', p_id);
end;
$$;
