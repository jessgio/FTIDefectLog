import { formatExpiryDisplay } from "./expiry";
import type { RejectRow } from "./types";

const EXPORT_COLUMNS = ["SKU", "Batch Code", "Expiry Date", "Defect Category", "Quantity"] as const;

function rowToExportRecord(r: RejectRow): Record<(typeof EXPORT_COLUMNS)[number], string | number> {
  return {
    SKU: r.sku ?? "",
    "Batch Code": r.batch_code,
    "Expiry Date": formatExpiryDisplay(r.expiry_date),
    "Defect Category": r.defect_reason ?? "",
    Quantity: r.quantity_pcs,
  };
}

export async function downloadInventoryExcel(rows: RejectRow[], filename?: string): Promise<void> {
  const XLSX = await import("xlsx");
  const data = rows.map(rowToExportRecord);
  const ws = XLSX.utils.json_to_sheet(data, { header: [...EXPORT_COLUMNS] });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Defect Inventory");
  const name = filename ?? `defect-inventory-${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, name);
}
