-- Match inventory lots using canonical defect labels (strip " (N)" counts and multi-defect summaries).

create or replace function app.normalize_defect_for_match(p_defect text)
returns text
language sql
immutable
as $$
  select nullif(
    trim(
      regexp_replace(
        trim(split_part(coalesce(p_defect, ''), ';', 1)),
        '\s*\(\d+\)\s*$',
        '',
        'g'
      )
    ),
    ''
  );
$$;

create or replace function app.find_inventory_lot_id(
  p_product text,
  p_batch text,
  p_expiry date,
  p_defect text
)
returns uuid
language plpgsql
stable
security definer
set search_path = public, app
as $$
declare
  v_id uuid;
  v_norm text := coalesce(app.normalize_defect_for_match(p_defect), '');
begin
  select il.id into v_id
  from public.inventory_lots il
  where lower(il.product_name) = lower(trim(p_product))
    and lower(il.batch_code) = lower(trim(p_batch))
    and coalesce(il.expiry_date, '1000-01-01'::date) = coalesce(p_expiry, '1000-01-01'::date)
    and coalesce(app.normalize_defect_for_match(il.defect_reason), '') = v_norm
  order by il.created_at
  limit 1;

  if v_id is not null then
    return v_id;
  end if;

  if p_expiry is not null then
    select il.id into v_id
    from public.inventory_lots il
    where lower(il.product_name) = lower(trim(p_product))
      and lower(il.batch_code) = lower(trim(p_batch))
      and il.expiry_date is null
      and il.quantity_pcs > 0
      and coalesce(app.normalize_defect_for_match(il.defect_reason), '') = v_norm
    order by il.created_at
    limit 1;
  elsif p_expiry is null then
    select il.id into v_id
    from public.inventory_lots il
    where lower(il.product_name) = lower(trim(p_product))
      and lower(il.batch_code) = lower(trim(p_batch))
      and il.expiry_date is not null
      and il.quantity_pcs > 0
      and coalesce(app.normalize_defect_for_match(il.defect_reason), '') = v_norm
    order by il.quantity_pcs desc, il.created_at
    limit 1;
  end if;

  return v_id;
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
  v_source_type text := nullif(trim(coalesce(p_payload ->> 'reject_source_type', '')), '');
  v_source_vendor text := nullif(trim(coalesce(p_payload ->> 'reject_source_vendor', '')), '');
  v_defect text := coalesce(app.normalize_defect_for_match(p_defect_match), '');
begin
  v_lot_id := app.find_inventory_lot_id(p_product, p_batch, p_expiry, v_defect);

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
          defect_reason = coalesce(nullif(v_defect, ''), defect_reason),
          sku = coalesce(nullif(trim(coalesce(p_payload ->> 'sku', '')), ''), sku),
          rsp_per_unit = coalesce(rsp_per_unit, v_rsp),
          cogs_per_unit = coalesce(cogs_per_unit, v_cogs),
          reject_source_type = coalesce(v_source_type, reject_source_type),
          reject_source_vendor = coalesce(v_source_vendor, reject_source_vendor),
          updated_at = now()
      where id = v_lot_id;
      return jsonb_build_object('action', 'updated', 'lot_id', v_lot_id, 'new_quantity', v_current + p_qty);
    end if;

    begin
      insert into public.inventory_lots (
        product_name, sku, defect_reason, batch_code, expiry_date,
        quantity_pcs, rsp_per_unit, cogs_per_unit,
        reject_source_type, reject_source_vendor
      ) values (
        p_product,
        nullif(trim(coalesce(p_payload ->> 'sku', '')), ''),
        v_defect,
        p_batch,
        p_expiry,
        p_qty,
        v_rsp,
        v_cogs,
        v_source_type,
        v_source_vendor
      )
      returning id into v_lot_id;
    exception
      when unique_violation then
        select il.id into v_lot_id
        from public.inventory_lots il
        where lower(il.product_name) = lower(trim(p_product))
          and lower(il.batch_code) = lower(trim(p_batch))
          and coalesce(il.expiry_date, '1000-01-01'::date) = coalesce(p_expiry, '1000-01-01'::date)
          and coalesce(app.normalize_defect_for_match(il.defect_reason), '') = v_norm
        order by il.created_at
        limit 1
        for update;

        if v_lot_id is null then
          raise;
        end if;

        select quantity_pcs into v_current from public.inventory_lots where id = v_lot_id;
        update public.inventory_lots
        set quantity_pcs = v_current + p_qty,
            updated_at = now()
        where id = v_lot_id;
    end;

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
  if v_direction = 'inbound' and jsonb_array_length(v_lines) > 0 then
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
