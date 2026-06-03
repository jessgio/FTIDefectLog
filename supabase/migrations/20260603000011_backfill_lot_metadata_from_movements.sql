-- Backfill inventory_lots defect_reason and reject_source from matching inbound movements.
-- Merges into an existing lot when the target defect key already exists (avoids lot_key_idx violation).

create or replace function app.infer_defect_from_movement(p_m public.movements)
returns text
language plpgsql
stable
as $$
declare
  rec record;
  v_summary text;
begin
  if coalesce(jsonb_array_length(p_m.defect_lines), 0) > 0 then
    for rec in
      select trim(coalesce(elem ->> 'defect_reason', '')) as reason, count(*)::int as cnt
      from jsonb_array_elements(p_m.defect_lines) elem
      where trim(coalesce(elem ->> 'defect_reason', '')) <> ''
      group by 1
      order by count(*) desc
      limit 1
    loop
      return rec.reason;
    end loop;
    return null;
  end if;

  v_summary := trim(coalesce(p_m.defect_reason, ''));
  if v_summary = '' then
    return null;
  end if;

  if position(';' in v_summary) > 0 then
    v_summary := trim(split_part(v_summary, ';', 1));
  end if;

  return nullif(trim(regexp_replace(v_summary, '\s*\(\d+\)\s*$', '')), '');
end;
$$;

do $$
declare
  rec record;
  v_target_id uuid;
begin
  for rec in
    with inferred as (
      select distinct on (il2.id)
        il2.id as lot_id,
        il2.product_name,
        il2.batch_code,
        il2.expiry_date,
        il2.quantity_pcs,
        app.infer_defect_from_movement(m) as defect_reason
      from public.inventory_lots il2
      join public.movements m
        on m.direction = 'inbound'
       and lower(m.product_name) = lower(il2.product_name)
       and lower(m.batch_code) = lower(il2.batch_code)
       and coalesce(m.expiry_date, '1000-01-01'::date) = coalesce(il2.expiry_date, '1000-01-01'::date)
      where coalesce(trim(il2.defect_reason), '') = ''
      order by il2.id, m.created_at desc
    )
    select *
    from inferred
    where defect_reason is not null
    order by
      lower(product_name),
      lower(batch_code),
      coalesce(expiry_date, '1000-01-01'::date),
      lower(defect_reason),
      lot_id
  loop
    select il.id
    into v_target_id
    from public.inventory_lots il
    where lower(il.product_name) = lower(rec.product_name)
      and lower(il.batch_code) = lower(rec.batch_code)
      and coalesce(il.expiry_date, '1000-01-01'::date) = coalesce(rec.expiry_date, '1000-01-01'::date)
      and lower(coalesce(il.defect_reason, '')) = lower(rec.defect_reason)
      and il.id <> rec.lot_id
    order by il.created_at
    limit 1;

    if v_target_id is not null then
      update public.inventory_lots
      set quantity_pcs = quantity_pcs + rec.quantity_pcs,
          updated_at = now()
      where id = v_target_id;

      delete from public.inventory_lots where id = rec.lot_id;
    else
      update public.inventory_lots
      set defect_reason = rec.defect_reason,
          updated_at = now()
      where id = rec.lot_id
        and coalesce(trim(defect_reason), '') = '';
    end if;
  end loop;
end;
$$;

update public.inventory_lots il
set
  reject_source_type = inferred.reject_source_type,
  reject_source_vendor = coalesce(inferred.reject_source_vendor, il.reject_source_vendor),
  updated_at = now()
from (
  select distinct on (il2.id)
    il2.id,
    m.reject_source_type,
    m.reject_source_vendor
  from public.inventory_lots il2
  join public.movements m
    on m.direction = 'inbound'
   and lower(m.product_name) = lower(il2.product_name)
   and lower(m.batch_code) = lower(il2.batch_code)
   and coalesce(m.expiry_date, '1000-01-01'::date) = coalesce(il2.expiry_date, '1000-01-01'::date)
  where il2.reject_source_type is null
    and m.reject_source_type is not null
  order by il2.id, m.created_at desc
) inferred
where il.id = inferred.id
  and il.reject_source_type is null;
