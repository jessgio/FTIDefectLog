-- reconcile_product_inventory loop variable must be movements, not anonymous record.

create or replace function public.reconcile_product_inventory(p_product text)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_product text := trim(p_product);
  m public.movements;
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
