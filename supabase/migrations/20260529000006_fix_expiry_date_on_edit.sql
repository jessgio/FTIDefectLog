-- Fix expiry date edits: reject invalid dates instead of wiping them, rename lots in place
-- when only batch/expiry change, and persist expiry_date on inbound lot updates.

create or replace function app.normalize_expiry(p_value text)
returns date
language plpgsql
immutable
as $$
declare
  s text;
begin
  s := trim(coalesce(p_value, ''));
  if s = '' then
    return null;
  end if;
  if lower(s) in ('n/a', 'na', 'no expiry', 'no-expiry', 'none') then
    return null;
  end if;
  if s ~ '^\d{4}-\d{2}-\d{2}' then
    return left(s, 10)::date;
  end if;
  begin
    return s::timestamptz::date;
  exception when others then
    raise exception 'Invalid expiry_date: "%". Use YYYY-MM-DD or check “No expiry”.', s;
  end;
end;
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
          updated_at = now()
      where id = v_lot_id;
      return jsonb_build_object('action', 'updated', 'lot_id', v_lot_id, 'new_quantity', v_current + p_qty);
    end if;

    insert into public.inventory_lots (
      product_name, sku, defect_reason, batch_code, expiry_date,
      quantity_pcs, rsp_per_unit, cogs_per_unit
    ) values (
      p_product,
      nullif(trim(coalesce(p_payload ->> 'sku', '')), ''),
      coalesce(p_defect_match, ''),
      p_batch,
      p_expiry,
      p_qty,
      v_rsp,
      v_cogs
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
  v_keys_conflict boolean := false;
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

  v_lot_keys_only :=
    (v_old_batch is distinct from v_new_batch or v_new_expiry is distinct from v_old_expiry)
    and v_direction = v_old.direction
    and lower(trim(coalesce(v_payload ->> 'product_name', ''))) = lower(trim(v_old.product_name))
    and (v_payload ->> 'quantity_pcs')::integer = v_old.quantity_pcs
    and v_lines = coalesce(v_old.defect_lines, '[]'::jsonb)
    and trim(coalesce(v_inventory_defect, '')) = trim(coalesce(v_old.defect_reason, ''));

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
