-- Edits failed when reversing an inbound whose lot had been partially depleted (or drifted out of
-- sync with history): reversal raised "Outbound quantity exceeds available stock", which the
-- fallback did not recognize. Treat insufficient-stock-on-reverse the same as "No matching lot" and
-- rebuild the product's inventory from movement history instead of failing the edit.

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
        if sqlerrm like '%No matching lot%' or sqlerrm like '%exceeds available stock%' then
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
      if sqlerrm like '%No matching lot%' or sqlerrm like '%exceeds available stock%' then
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
