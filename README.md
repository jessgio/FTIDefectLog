## Goal

Warehouse defective / reject stock tracking with:

- **Supabase Postgres** as the private source of truth (inventory, movements, product catalog)
- **Google sign-in** restricted to your company domain
- **Private Storage** for defect photos
- **React dashboard** on Vercel for CEO / commercial / warehouse teams

## 1) Supabase project setup

1. Create a project at [supabase.com](https://supabase.com).
2. Install the [Supabase CLI](https://supabase.com/docs/guides/cli) and link the project:

```bash
supabase login
cd fti-defect-stock
supabase link --project-ref YOUR_PROJECT_REF
```

3. Apply migrations:

```bash
supabase db push
```

4. Set the allowed email domain (must match `VITE_ALLOWED_EMAIL_DOMAIN`):

```sql
update public.app_settings
set value = 'yourcompany.com'
where key = 'allowed_email_domain';
```

5. **Authentication → Providers → Google**: enable Google, add OAuth client ID/secret from Google Cloud Console.
   - Authorized redirect URI: `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`
   - For local dev, also add `http://localhost:5173` as Site URL / redirect in Supabase Auth settings.

6. Copy **Project URL** and **anon public** key to `dashboard/.env` (see `.env.example`).

## 2) Run the dashboard locally

```bash
cd dashboard
cp .env.example .env
# Edit VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_ALLOWED_EMAIL_DOMAIN
npm install
npm run dev
```

Open http://localhost:5173 and sign in with Google.

## 3) Deploy to Vercel

Set environment variables on the Vercel project:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_ALLOWED_EMAIL_DOMAIN`

Add your production URL to Supabase **Authentication → URL configuration** (Site URL + redirect allow list).

## 4) Migrate data from Google Sheets

Before cutover, **freeze writes** in Google Sheets. Export three CSV files:

| Export | Sheet tab |
|--------|-----------|
| `--products` | SKUList |
| `--inventory` | Inventory / reject list tab |
| `--movements` | Movements |

Install migration dependencies:

```bash
python -m pip install pandas requests python-dotenv
```

Set (never commit):

```bash
export SUPABASE_URL=https://YOUR_PROJECT.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

Run:

```bash
python scripts/migrate_google_to_supabase.py \
  --products path/to/SKUList.csv \
  --inventory path/to/inventory.csv \
  --movements path/to/movements.csv \
  --migrate-photos
```

Photo failures are logged to `out/photo_migration_report.txt` for manual follow-up via **History → Photos**.

## 5) Cutover checklist

- [ ] Run migration against production Supabase
- [ ] Update `allowed_email_domain` in `app_settings`
- [ ] Point Vercel env vars to Supabase
- [ ] Unpublish Google Sheets (remove public CSV)
- [ ] Disable or delete Apps Script web app deployment
- [ ] Smoke-test: dashboard load, stock entry, history edit/delete, defect photos

## Optional: Excel import

To normalize a legacy Excel reject list to CSV for manual review:

```bash
python -m pip install -r requirements.txt
python scripts/parse_reject_list.py --input "samples/FTI Reject List 2026.xlsx" --output "out/reject_list_normalized.csv"
```

You can import rows into `inventory_lots` via the migration script or Supabase Table Editor.

## Schema overview

| Table | Purpose |
|-------|---------|
| `products` | SKU catalog (name, barcode, category, pricing, images) |
| `inventory_lots` | Current defective stock by lot |
| `movements` | Inbound/outbound audit log with `defect_lines` JSON |

Movement writes use Postgres RPCs: `create_movement`, `update_movement`, `delete_movement`, `patch_movement_photos` (inventory updates are atomic).

Storage buckets: `defect-photos`, `product-images` (private; signed URLs for display).

## Legacy Google integration

The previous Google Sheets + Apps Script setup is preserved under `scripts/google-apps-script/` for reference only and is **not** used by the dashboard after migration.
