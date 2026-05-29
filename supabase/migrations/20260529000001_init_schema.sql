-- FTI Defect Stock: core schema, RLS, domain gate

create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to postgres, service_role;

-- Configurable allowed email domain (set after deploy: update allowed_email_domain)
create table public.app_settings (
  key text primary key,
  value text not null
);

insert into public.app_settings (key, value)
values ('allowed_email_domain', 'yourcompany.com')
on conflict (key) do nothing;

create or replace function app.is_allowed_user()
returns boolean
language sql
stable
security definer
set search_path = public, app
as $$
  select
    auth.uid() is not null
    and exists (
      select 1
      from public.app_settings s
      where s.key = 'allowed_email_domain'
        and s.value <> ''
        and lower(coalesce(auth.jwt() ->> 'email', '')) like '%@' || lower(s.value)
    );
$$;

revoke all on function app.is_allowed_user() from public;
grant execute on function app.is_allowed_user() to authenticated, service_role;

-- Product catalog (formerly SKUList tab)
create table public.products (
  sku text primary key,
  product_name text not null,
  barcode text,
  product_category text,
  image_url text,
  image_storage_path text,
  rsp_per_unit numeric,
  cogs_per_unit numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index products_product_name_idx on public.products (lower(product_name));

-- Current defective inventory lots (formerly published inventory CSV)
create table public.inventory_lots (
  id uuid primary key default gen_random_uuid(),
  product_name text not null,
  sku text references public.products (sku) on update cascade on delete set null,
  defect_reason text not null default '',
  batch_code text not null,
  expiry_date date,
  quantity_pcs integer not null check (quantity_pcs >= 0),
  rsp_per_unit numeric,
  cogs_per_unit numeric,
  source_file text,
  parsed_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_lots_qty_positive check (quantity_pcs > 0 or quantity_pcs = 0)
);

create unique index inventory_lots_lot_key_idx on public.inventory_lots (
  lower(product_name),
  lower(batch_code),
  coalesce(expiry_date, '1000-01-01'::date),
  lower(coalesce(defect_reason, ''))
);

create index inventory_lots_product_idx on public.inventory_lots (lower(product_name));

-- Movement audit log (formerly Movements tab)
create table public.movements (
  id uuid primary key default gen_random_uuid(),
  direction text not null check (direction in ('inbound', 'outbound')),
  logged_by text not null,
  product_name text not null,
  sku text,
  batch_code text not null,
  expiry_date date,
  quantity_pcs integer not null check (quantity_pcs > 0),
  defect_reason text,
  disposition text,
  notes text,
  rsp_per_unit numeric,
  cogs_per_unit numeric,
  defect_lines jsonb not null default '[]'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index movements_created_at_idx on public.movements (created_at desc);
create index movements_product_idx on public.movements (lower(product_name));

-- RLS
alter table public.app_settings enable row level security;
alter table public.products enable row level security;
alter table public.inventory_lots enable row level security;
alter table public.movements enable row level security;

-- app_settings: no direct client access
create policy app_settings_deny_all on public.app_settings
  for all to authenticated using (false);

-- products
create policy products_select on public.products
  for select to authenticated using (app.is_allowed_user());
create policy products_insert on public.products
  for insert to authenticated with check (app.is_allowed_user());
create policy products_update on public.products
  for update to authenticated using (app.is_allowed_user()) with check (app.is_allowed_user());
create policy products_delete on public.products
  for delete to authenticated using (app.is_allowed_user());

-- inventory_lots (direct read; writes via RPC only)
create policy inventory_lots_select on public.inventory_lots
  for select to authenticated using (app.is_allowed_user());
create policy inventory_lots_insert on public.inventory_lots
  for insert to authenticated with check (app.is_allowed_user());
create policy inventory_lots_update on public.inventory_lots
  for update to authenticated using (app.is_allowed_user()) with check (app.is_allowed_user());
create policy inventory_lots_delete on public.inventory_lots
  for delete to authenticated using (app.is_allowed_user());

-- movements (direct read; writes via RPC)
create policy movements_select on public.movements
  for select to authenticated using (app.is_allowed_user());
create policy movements_insert on public.movements
  for insert to authenticated with check (app.is_allowed_user());
create policy movements_update on public.movements
  for update to authenticated using (app.is_allowed_user()) with check (app.is_allowed_user());
create policy movements_delete on public.movements
  for delete to authenticated using (app.is_allowed_user());

-- updated_at trigger
create or replace function app.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger products_updated_at
  before update on public.products
  for each row execute function app.set_updated_at();

create trigger inventory_lots_updated_at
  before update on public.inventory_lots
  for each row execute function app.set_updated_at();
