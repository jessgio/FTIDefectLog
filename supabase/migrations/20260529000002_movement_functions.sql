-- FTI Defect Stock: movement / inventory logic (mirrors Apps Script)

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
    return null;
  end;
end;
$$;

create or replace function app.summarize_defect_lines(p_lines jsonb)
returns text
language plpgsql
immutable
as $$
declare
  rec record;
  parts text[] := array[]::text[];
begin
  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    return '';
  end if;
  for rec in
    select key as defect_reason, count(*)::int as cnt
    from (
      select trim(coalesce(elem ->> 'defect_reason', '')) as key
      from jsonb_array_elements(p_lines) elem
    ) t
    where key <> ''
    group by key
    order by key
  loop
    parts := array_append(parts, rec.defect_reason || ' (' || rec.cnt || ')');
  end loop;
  return array_to_string(parts, '; ');
end;
$$;

create or replace function app.lookup_catalog(p_product text, p_sku text)
returns public.products
language sql
stable
security definer
set search_path = public, app
as $$
  select p.*
  from public.products p
  where (p_sku <> '' and lower(p.sku) = lower(p_sku))
     or (p_product <> '' and lower(p.product_name) = lower(trim(p_product)))
  limit 1;
$$;

create or replace function app.resolve_payload_catalog(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_product text := trim(coalesce(p_payload ->> 'product_name', ''));
  v_sku text := trim(coalesce(p_payload ->> 'sku', ''));
  cat public.products;
  out jsonb := p_payload;
begin
  if v_product <> '' then
    select * into cat from app.lookup_catalog(v_product, '');
  end if;
  if cat is null and v_sku <> '' then
    select * into cat from app.lookup_catalog('', v_sku);
  end if;

  if cat is not null then
    if v_sku = '' then
      v_sku := cat.sku;
    end if;
    if v_product = '' then
      v_product := cat.product_name;
    end if;
    out := out || jsonb_build_object('product_name', v_product, 'sku', v_sku);
    if (out ->> 'rsp_per_unit') is null and cat.rsp_per_unit is not null then
      out := out || jsonb_build_object('rsp_per_unit', cat.rsp_per_unit);
    end if;
    if (out ->> 'cogs_per_unit') is null and cat.cogs_per_unit is not null then
      out := out || jsonb_build_object('cogs_per_unit', cat.cogs_per_unit);
    end if;
  end if;

  return out;
end;
$$;

create or replace function app.resolve_lot_pricing(
  p_product text,
  p_batch text,
  p_expiry date,
  p_payload jsonb
)
returns table (rsp_per_unit numeric, cogs_per_unit numeric)
language plpgsql
stable
security definer
set search_path = public, app
as $$
declare
  v_rsp numeric;
  v_cogs numeric;
  cat public.products;
  lot record;
begin
  if (p_payload ->> 'rsp_per_unit') is not null and (p_payload ->> 'rsp_per_unit') <> '' then
    v_rsp := (p_payload ->> 'rsp_per_unit')::numeric;
  end if;
  if (p_payload ->> 'cogs_per_unit') is not null and (p_payload ->> 'cogs_per_unit') <> '' then
    v_cogs := (p_payload ->> 'cogs_per_unit')::numeric;
  end if;

  for lot in
    select il.rsp_per_unit, il.cogs_per_unit
    from public.inventory_lots il
    where lower(il.product_name) = lower(p_product)
      and lower(il.batch_code) = lower(p_batch)
      and coalesce(il.expiry_date, '1000-01-01'::date) = coalesce(p_expiry, '1000-01-01'::date)
  loop
    if v_rsp is null and lot.rsp_per_unit is not null then
      v_rsp := lot.rsp_per_unit;
    end if;
    if v_cogs is null and lot.cogs_per_unit is not null then
      v_cogs := lot.cogs_per_unit;
    end if;
  end loop;

  if v_rsp is null or v_cogs is null then
    select * into cat from app.lookup_catalog(p_product, coalesce(p_payload ->> 'sku', ''));
    if cat is not null then
      if v_rsp is null then v_rsp := cat.rsp_per_unit; end if;
      if v_cogs is null then v_cogs := cat.cogs_per_unit; end if;
    end if;
  end if;

  return query select v_rsp, v_cogs;
end;
$$;

create or replace function app.find_inventory_lot_id(
  p_product text,
  p_batch text,
  p_expiry date,
  p_defect text
)
returns uuid
language sql
stable
security definer
set search_path = public, app
as $$
  select il.id
  from public.inventory_lots il
  where lower(il.product_name) = lower(trim(p_product))
    and lower(il.batch_code) = lower(trim(p_batch))
    and coalesce(il.expiry_date, '1000-01-01'::date) = coalesce(p_expiry, '1000-01-01'::date)
    and (
      coalesce(trim(p_defect), '') = ''
      or lower(coalesce(il.defect_reason, '')) = lower(trim(p_defect))
    )
  order by il.created_at
  limit 1;
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

  -- outbound
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
  idx integer := 0;
begin
  if jsonb_array_length(p_lines) <> (p_payload ->> 'quantity_pcs')::integer then
    raise exception 'defect_lines length must match quantity_pcs (%).', (p_payload ->> 'quantity_pcs');
  end if;

  for rec in
    select trim(coalesce(elem ->> 'defect_reason', '')) as defect_reason, count(*)::int as cnt
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
begin
  if v_direction = 'inbound' and jsonb_array_length(v_lines) > 0 then
    return app.apply_inbound_by_defect_lines(p_payload, v_product, v_batch, v_expiry, v_lines);
  end if;

  if v_direction = 'outbound' then
    v_defect := trim(coalesce(p_payload ->> 'defect_reason', ''));
  else
    v_defect := trim(coalesce(p_payload ->> 'defect_reason', app.summarize_defect_lines(v_lines)));
  end if;

  return app.apply_inventory_change(v_direction, p_payload, v_product, v_batch, v_expiry, v_qty, v_defect);
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
  v_product text := trim(coalesce(p_payload ->> 'product_name', ''));
  v_batch text := trim(coalesce(p_payload ->> 'batch_code', ''));
  v_expiry date := app.normalize_expiry(p_payload ->> 'expiry_date');
  v_lines jsonb := coalesce(p_payload -> 'defect_lines', '[]'::jsonb);
  rec record;
  slice jsonb;
  reversed jsonb;
begin
  if v_direction = 'inbound' and jsonb_array_length(v_lines) > 0 then
    for rec in
      select trim(coalesce(elem ->> 'defect_reason', '')) as defect_reason, count(*)::int as cnt
      from jsonb_array_elements(v_lines) elem
      group by 1
    loop
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
    'direction', case when v_direction = 'inbound' then 'outbound' else 'inbound' end
  );
  perform app.apply_movement_effect(reversed);
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
    'rsp_per_unit', p_row.rsp_per_unit,
    'cogs_per_unit', p_row.cogs_per_unit,
    'defect_lines', coalesce(p_row.defect_lines, '[]'::jsonb)
  );
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

  if v_direction not in ('inbound', 'outbound') then
    raise exception 'direction must be inbound or outbound';
  end if;
  if v_logged_by = '' then raise exception 'logged_by is required'; end if;
  if v_batch = '' then raise exception 'batch_code is required'; end if;
  if v_product = '' then raise exception 'product_name is required'; end if;
  if v_qty is null or v_qty <= 0 then raise exception 'quantity_pcs must be positive'; end if;

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
    quantity_pcs, defect_reason, disposition, notes, rsp_per_unit, cogs_per_unit,
    defect_lines, created_by
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

  perform app.reverse_movement_effect(app.movement_row_to_payload(v_old));

  v_defect_summary := case
    when v_direction = 'inbound' then coalesce(app.summarize_defect_lines(v_lines), trim(coalesce(v_payload ->> 'defect_reason', '')))
    else ''
  end;
  v_inventory_defect := case
    when v_direction = 'outbound' then trim(coalesce(v_payload ->> 'defect_reason', ''))
    else v_defect_summary
  end;

  update public.movements
  set
    direction = v_direction,
    logged_by = trim(coalesce(v_payload ->> 'logged_by', '')),
    product_name = trim(coalesce(v_payload ->> 'product_name', '')),
    sku = nullif(trim(coalesce(v_payload ->> 'sku', '')), ''),
    batch_code = trim(coalesce(v_payload ->> 'batch_code', '')),
    expiry_date = app.normalize_expiry(v_payload ->> 'expiry_date'),
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

  return jsonb_build_object('ok', true, 'deleted', p_id);
end;
$$;

create or replace function public.patch_movement_photos(p_id uuid, p_defect_lines jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_old public.movements;
  v_summary text;
begin
  if not app.is_allowed_user() then
    raise exception 'Not authorized';
  end if;

  select * into v_old from public.movements where id = p_id for update;
  if not found then
    raise exception 'Movement not found';
  end if;
  if v_old.direction <> 'inbound' then
    raise exception 'Photos can only be added to inbound entries.';
  end if;
  if jsonb_array_length(p_defect_lines) <> v_old.quantity_pcs then
    raise exception 'defect_lines length must match entry quantity (%).', v_old.quantity_pcs;
  end if;

  v_summary := app.summarize_defect_lines(p_defect_lines);

  update public.movements
  set defect_lines = p_defect_lines,
      defect_reason = nullif(v_summary, '')
  where id = p_id;

  return jsonb_build_object('ok', true, 'patched', p_id);
end;
$$;

revoke all on function public.create_movement(jsonb) from public;
revoke all on function public.update_movement(uuid, jsonb) from public;
revoke all on function public.delete_movement(uuid) from public;
revoke all on function public.patch_movement_photos(uuid, jsonb) from public;

grant execute on function public.create_movement(jsonb) to authenticated, service_role;
grant execute on function public.update_movement(uuid, jsonb) to authenticated, service_role;
grant execute on function public.delete_movement(uuid) to authenticated, service_role;
grant execute on function public.patch_movement_photos(uuid, jsonb) to authenticated, service_role;
