-- Fix typo in create_movement: v_reject_vendor -> v_source_vendor (undeclared var was read as column).

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
  perform app.purge_zero_inventory_lots(v_product);

  return jsonb_build_object(
    'ok', true,
    'movement_id', v_id,
    'direction', v_direction,
    'quantity_pcs', v_qty
  );
end;
$$;
