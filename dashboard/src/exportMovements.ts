import { formatExpiryDisplay } from "./expiry";
import { defectPieceQuantity, formatLocalDateInput, movementDetail } from "./historyFilters";
import type { MovementRecord } from "./types";

const EXPORT_COLUMNS = [
  "When",
  "Type",
  "Product",
  "SKU",
  "Batch",
  "Expiry",
  "Qty",
  "Defect pcs",
  "Detail",
  "Return channel",
  "Vendor",
  "Logged by",
  "Notes",
  "RSP",
  "COGS",
  "Movement ID",
] as const;

type ExportColumn = (typeof EXPORT_COLUMNS)[number];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatWhenExport(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function movementsToSheetRows(
  rows: MovementRecord[],
  defectType = "",
): Record<ExportColumn, string | number>[] {
  return rows.map((row) => ({
    When: formatWhenExport(row.timestamp_utc),
    Type: row.direction === "inbound" ? "Inbound" : "Outbound",
    Product: row.product_name,
    SKU: row.sku ?? "",
    Batch: row.batch_code,
    Expiry: formatExpiryDisplay(row.expiry_date),
    Qty: row.quantity_pcs,
    "Defect pcs": defectPieceQuantity(row, defectType) ?? "",
    Detail: movementDetail(row),
    "Return channel": row.direction === "inbound" ? (row.reject_source_type ?? "") : "",
    Vendor: row.direction === "inbound" ? (row.reject_source_vendor ?? "") : "",
    "Logged by": row.logged_by,
    Notes: row.notes ?? "",
    RSP: typeof row.rsp_per_unit === "number" ? row.rsp_per_unit : "",
    COGS: typeof row.cogs_per_unit === "number" ? row.cogs_per_unit : "",
    "Movement ID": row.movement_id,
  }));
}

export async function downloadMovementsExcel(
  rows: MovementRecord[],
  filename?: string,
  defectType = "",
): Promise<void> {
  const XLSX = await import("xlsx");
  const data = movementsToSheetRows(rows, defectType);
  const ws = XLSX.utils.json_to_sheet(data, { header: [...EXPORT_COLUMNS] });
  ws["!cols"] = [
    { wch: 18 },
    { wch: 12 },
    { wch: 32 },
    { wch: 16 },
    { wch: 16 },
    { wch: 14 },
    { wch: 10 },
    { wch: 12 },
    { wch: 36 },
    { wch: 24 },
    { wch: 18 },
    { wch: 18 },
    { wch: 28 },
    { wch: 12 },
    { wch: 12 },
    { wch: 38 },
  ];
  if (ws["!ref"]) {
    ws["!autofilter"] = { ref: ws["!ref"] };
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Movements");
  const name = filename ?? `movement-history-${formatLocalDateInput(new Date())}.xlsx`;
  XLSX.writeFile(wb, name);
}
