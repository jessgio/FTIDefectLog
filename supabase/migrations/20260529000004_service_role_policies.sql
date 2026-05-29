-- Explicit full access for service_role (migration script + server-side tools).
-- The service_role JWT normally bypasses RLS; these policies are a safety net.

create policy products_service_role_all on public.products
  for all to service_role using (true) with check (true);

create policy inventory_lots_service_role_all on public.inventory_lots
  for all to service_role using (true) with check (true);

create policy movements_service_role_all on public.movements
  for all to service_role using (true) with check (true);

create policy app_settings_service_role_select on public.app_settings
  for select to service_role using (true);

create policy app_settings_service_role_update on public.app_settings
  for update to service_role using (true) with check (true);
