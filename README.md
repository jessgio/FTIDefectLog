## Goal

This repo turns your warehouse “defective / reject” list into:

- **A clean Google Sheets table** (single source of truth)
- **A lightweight dashboard** for CEO / commercial teams to view the table + key metrics (expiry risk, value, etc.)

## 1) Parse the sample Excel into a normalized CSV

Install Python deps:

```bash
python -m pip install -r requirements.txt
```

Parse:

```bash
python scripts/parse_reject_list.py --input "samples/FTI Reject List 2026.xlsx" --output "out/reject_list_normalized.csv"
```

Then upload/import `out/reject_list_normalized.csv` into Google Sheets.

### Expected columns in Sheets

- `product_name`
- `sku` (optional, recommended)
- `defect_reason` (recommended)
- `batch_code`
- `expiry_date` (YYYY-MM-DD, optional — leave blank for tools / non-dated items)
- `quantity_pcs`
- `rsp_per_unit` (optional)
- `cogs_per_unit` (optional, recommended for COGS metrics)

## 2) Publish the Google Sheet as CSV

In Google Sheets:

- **File → Share → Publish to the web**
- Publish the tab that contains the normalized data

Copy:

- **Sheet ID** (from the URL)
- **Tab GID** (from the URL, `gid=...`)

## 3) Run the dashboard locally

```bash
cd dashboard
npm install
```

Create `dashboard/.env` from `dashboard/.env.example` and fill:

- `VITE_GOOGLE_SHEET_ID`
- `VITE_GOOGLE_SHEET_GID`

Run:

```bash
npm run dev
```

## 4) Stock entry (inbound / outbound)

The dashboard includes a **Stock entry** page (`/entry`) for warehouse/commercial teams to log:

- **Inbound**: new defective stock identified
- **Outbound**: stock sold, allocated, or destroyed

Submissions are saved to Google Sheets via a small **Apps Script web app**, and the script updates your inventory tab quantities automatically.

### Use one tab for dashboard + stock entry

The dashboard reads whichever worksheet tab you **publish as CSV**. Stock entry must update **that same tab** (not a separate `Inventory` tab).

1. Note the **exact tab name** at the bottom of Google Sheets (e.g. `reject_list_normalized`).
2. In `dashboard/.env` set:
   ```env
   VITE_INVENTORY_SHEET_NAME=reject_list_normalized
   ```
   (Use your real tab name — it is **not** the CSV filename.)
3. Row 1 must include at least: `product_name`, `batch_code`, `expiry_date`, `quantity_pcs` (extra columns like `source_file`, `parsed_on` are fine).
4. The script only auto-creates a **`Movements`** audit tab.

**Already logged rows on a separate `Inventory` tab?** In Apps Script, edit `DEST_TAB` in `copyLegacyInventoryTab`, run it once, then you can delete the old `Inventory` tab.

### Deploy Apps Script

1. Open the spreadsheet → **Extensions → Apps Script**
2. Paste `scripts/google-apps-script/movements-webapp.gs`
3. Run **createSheetsIfNeeded** once (▶ Run) — creates `Movements` only
4. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Copy the deployment URL into `dashboard/.env`:

```env
VITE_MOVEMENTS_SCRIPT_URL=https://script.google.com/macros/s/....../exec
VITE_INVENTORY_SHEET_NAME=reject_list_normalized
```

Restart `npm run dev`, open **Stock entry**, and submit a test row.

**Inbound per-piece defects:** for each quantity, pick a defect per pc and attach **1–2 photos per piece** (optional). Photos are uploaded to Google Drive and stored in the movement’s `defect_breakdown` JSON. Inventory is updated in separate rows per defect type (same batch/expiry). On the **Dashboard**, click a product name to open defect details and photo evidence for the CEO. To add photos to **older inbound entries**, open **History** → **Photos** on a row (updates the movement only, not inventory). Redeploy Apps Script after pulling script updates (requires Drive permission on first photo upload).

## SKUList tab (product ↔ SKU mapping)

Add a worksheet tab named **`SKUList`** with headers:

- `product_name` (or `product`)
- `sku`
- `product_category` (optional — used on the dashboard “Defects by product category” chart; aliases: `category`, `product category`)
- `image_url` (optional — HTTPS link to a product photo; aliases: `image`, `product_image`, `photo`)
- `rsp` (optional — retail price per unit; aliases: `rsp_per_unit`, `retail price`)
- `cogs` (optional — cost per unit; aliases: `cogs_per_unit`, `cost`)

Stock entry and all inventory writes use this tab to **auto-fill SKU**, **RSP**, and **COGS** from product name (and product name from SKU when only SKU is entered). The Apps Script also applies the mapping on the server if the form omits those fields.

**Product images:** add an `image_url` per row in **SKUList** (paste the full Google Drive **share link** as plain text or a hyperlink — not only the word “View”). The dashboard shows a thumbnail in the first column. For **Google Drive**:

1. Upload the product photo to Drive (same Google account as the spreadsheet is fine).
2. Right-click → **Share** → **General access: Anyone with the link** (Viewer).
3. Copy the link (`https://drive.google.com/file/d/…/view` or `…/open?id=…`) into `image_url`.

If public embed still fails, the dashboard also tries your Apps Script URL as an image proxy (`?action=drive_image`) for files the script can read. Redeploy Apps Script after updates. **freeimage.host** gallery links are converted automatically. Product names in inventory must match **SKUList** (minor differences like missing “(10 gr)” are tolerated).

Redeploy Apps Script after updates. The dashboard loads mappings via `?action=sku_list`.

## 5) Edit / delete history

Open **History** in the dashboard to list all movement entries. Edit or delete will **undo then re-apply** inventory changes automatically. Redeploy Apps Script after updating `movements-webapp.gs` (adds `movement_id` column).

## Notes / Next improvements

- Add a SKU master (SKU → product name, COGS) to auto-fill `sku` + `cogs_per_unit`
- Add filters (reason, expiry year, product category) and export views for sales planning
- Show recent movements on the dashboard

