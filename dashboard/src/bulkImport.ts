import { DEFECT_REASONS, normalizeDefectLabel } from "./defectReasons";
import { defectGroupsToLines } from "./defectForm";
import { normalizeExpiryValue } from "./expiry";
import { isRejectSourceType, REJECT_SOURCE_TYPES } from "./rejectSources";
import type { MovementPayload } from "./types";

/** Canonical template columns for inbound defective stock bulk import. */
export const BULK_IMPORT_COLUMNS = [
  "product_name",
  "sku",
  "batch_code",
  "expiry_date",
  "quantity_pcs",
  "defect_reason",
  "reject_source_type",
  "reject_source_vendor",
  "notes",
  "rsp_per_unit",
  "cogs_per_unit",
] as const;

export type BulkImportColumn = (typeof BULK_IMPORT_COLUMNS)[number];

export type BulkImportRow = {
  rowNumber: number;
  product_name: string;
  sku: string;
  batch_code: string;
  expiry_date: string;
  quantity_pcs: number;
  defect_reason: string;
  reject_source_type: string;
  reject_source_vendor: string;
  notes: string;
  rsp_per_unit?: number;
  cogs_per_unit?: number;
};

export type ParsedBulkRow =
  | { ok: true; row: BulkImportRow }
  | { ok: false; rowNumber: number; errors: string[]; raw: Record<string, string> };

const HEADER_ALIASES: Record<string, BulkImportColumn> = {
  product_name: "product_name",
  product: "product_name",
  "product name": "product_name",
  sku: "sku",
  batch_code: "batch_code",
  batch: "batch_code",
  "batch code": "batch_code",
  expiry_date: "expiry_date",
  expiry: "expiry_date",
  "expiry date": "expiry_date",
  quantity_pcs: "quantity_pcs",
  quantity: "quantity_pcs",
  qty: "quantity_pcs",
  "quantity (pcs)": "quantity_pcs",
  defect_reason: "defect_reason",
  defect: "defect_reason",
  "defect reason": "defect_reason",
  "defect category": "defect_reason",
  reject_source_type: "reject_source_type",
  "reject source type": "reject_source_type",
  "return channel": "reject_source_type",
  source_type: "reject_source_type",
  reject_source_vendor: "reject_source_vendor",
  "reject source vendor": "reject_source_vendor",
  vendor: "reject_source_vendor",
  partner: "reject_source_vendor",
  notes: "notes",
  note: "notes",
  rsp_per_unit: "rsp_per_unit",
  rsp: "rsp_per_unit",
  "rsp / unit": "rsp_per_unit",
  cogs_per_unit: "cogs_per_unit",
  cogs: "cogs_per_unit",
  "cogs / unit": "cogs_per_unit",
};

const SAMPLE_ROWS: Record<string, string | number>[] = [
  {
    product_name: "Example Product A",
    sku: "SKU-001",
    batch_code: "BATCH2401",
    expiry_date: "2027-06-30",
    quantity_pcs: 3,
    defect_reason: "Dirty packaging",
    reject_source_type: "E-commerce returns",
    reject_source_vendor: "Shopee",
    notes: "Replace this sample row",
    rsp_per_unit: "",
    cogs_per_unit: "",
  },
  {
    product_name: "Example Product B",
    sku: "",
    batch_code: "TOOL-99",
    expiry_date: "",
    quantity_pcs: 1,
    defect_reason: "Damaged product",
    reject_source_type: "Distributor returns",
    reject_source_vendor: "",
    notes: "Leave expiry blank for no expiry",
    rsp_per_unit: "",
    cogs_per_unit: "",
  },
];

function cellString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    // Avoid scientific notation / float noise for batch codes typed as numbers in Excel
    if (Number.isInteger(value)) return String(value);
    return String(value);
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value).trim();
}

function normalizeHeader(header: string): BulkImportColumn | null {
  const key = header.trim().toLowerCase().replace(/[_]+/g, " ").replace(/\s+/g, " ");
  const compact = key.replace(/\s/g, "_");
  return HEADER_ALIASES[key] ?? HEADER_ALIASES[compact] ?? null;
}

function parseOptionalNumber(raw: string, label: string, errors: string[]): number | undefined {
  const v = raw.trim();
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    errors.push(`${label} must be a non-negative number.`);
    return undefined;
  }
  return n;
}

function matchRejectSourceType(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (isRejectSourceType(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  const found = REJECT_SOURCE_TYPES.find((t) => t.toLowerCase() === lower);
  return found ?? null;
}

function matchDefectReason(raw: string): string {
  const normalized = normalizeDefectLabel(raw) || raw.trim();
  if (!normalized) return "";
  const lower = normalized.toLowerCase();
  const found = DEFECT_REASONS.find((r) => r.toLowerCase() === lower);
  return found ?? normalized;
}

function excelSerialToIso(serial: number): string | null {
  // Excel serial date (days since 1899-12-30); ignore time fraction
  if (!Number.isFinite(serial) || serial < 1) return null;
  const utc = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000;
  const d = new Date(utc);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseExpiryCell(raw: unknown): string {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return normalizeExpiryValue(cellString(raw));
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const iso = excelSerialToIso(raw);
    if (iso) return iso;
  }
  return normalizeExpiryValue(cellString(raw));
}

function mapObjectRow(
  obj: Record<string, unknown>,
): Partial<Record<BulkImportColumn, unknown>> {
  const mapped: Partial<Record<BulkImportColumn, unknown>> = {};
  for (const [key, value] of Object.entries(obj)) {
    const col = normalizeHeader(key);
    if (col && mapped[col] === undefined) mapped[col] = value;
  }
  return mapped;
}

function validateMappedRow(
  rowNumber: number,
  mapped: Partial<Record<BulkImportColumn, unknown>>,
): ParsedBulkRow {
  const raw: Record<string, string> = {};
  for (const col of BULK_IMPORT_COLUMNS) {
    raw[col] = cellString(mapped[col]);
  }

  const errors: string[] = [];
  const product_name = raw.product_name.trim();
  const batch_code = raw.batch_code.trim();
  const qtyRaw = raw.quantity_pcs.trim();
  const quantity_pcs = Number(qtyRaw);
  const defect_reason = matchDefectReason(raw.defect_reason);
  const reject_source_type = matchRejectSourceType(raw.reject_source_type);
  const expiry_date = parseExpiryCell(mapped.expiry_date);

  if (!product_name) errors.push("product_name is required.");
  if (!batch_code) errors.push("batch_code is required.");
  if (!qtyRaw || !Number.isFinite(quantity_pcs) || !Number.isInteger(quantity_pcs) || quantity_pcs <= 0) {
    errors.push("quantity_pcs must be a positive whole number.");
  }
  if (!defect_reason) errors.push("defect_reason is required.");
  if (!raw.reject_source_type.trim()) {
    errors.push("reject_source_type is required.");
  } else if (!reject_source_type) {
    errors.push(
      `reject_source_type must be one of: ${REJECT_SOURCE_TYPES.join(", ")}.`,
    );
  }

  if (expiry_date && !/^\d{4}-\d{2}-\d{2}$/.test(expiry_date)) {
    errors.push("expiry_date must be YYYY-MM-DD, blank, or N/A.");
  }

  const rsp_per_unit = parseOptionalNumber(raw.rsp_per_unit, "rsp_per_unit", errors);
  const cogs_per_unit = parseOptionalNumber(raw.cogs_per_unit, "cogs_per_unit", errors);

  if (errors.length) {
    return { ok: false, rowNumber, errors, raw };
  }

  return {
    ok: true,
    row: {
      rowNumber,
      product_name,
      sku: raw.sku.trim(),
      batch_code,
      expiry_date,
      quantity_pcs,
      defect_reason,
      reject_source_type: reject_source_type!,
      reject_source_vendor: raw.reject_source_vendor.trim(),
      notes: raw.notes.trim(),
      rsp_per_unit,
      cogs_per_unit,
    },
  };
}

export async function downloadBulkImportTemplate(filename?: string): Promise<void> {
  const XLSX = await import("xlsx");
  const ws = XLSX.utils.json_to_sheet(SAMPLE_ROWS, {
    header: [...BULK_IMPORT_COLUMNS],
  });
  ws["!cols"] = BULK_IMPORT_COLUMNS.map((col) => ({
    wch: Math.max(14, col.length + 2),
  }));

  const guide = XLSX.utils.aoa_to_sheet([
    ["Field", "Required", "Notes"],
    ["product_name", "Yes", "Product display name"],
    ["sku", "No", "Optional catalog SKU"],
    ["batch_code", "Yes", "Batch / lot code"],
    [
      "expiry_date",
      "No",
      "YYYY-MM-DD; leave blank or N/A for tools / non-dated",
    ],
    ["quantity_pcs", "Yes", "Positive whole number"],
    ["defect_reason", "Yes", DEFECT_REASONS.join(" | ")],
    ["reject_source_type", "Yes", REJECT_SOURCE_TYPES.join(" | ")],
    ["reject_source_vendor", "No", "Partner name (Shopee, Watsons, etc.)"],
    ["notes", "No", "Free text"],
    ["rsp_per_unit", "No", "Optional price"],
    ["cogs_per_unit", "No", "Optional cost"],
    [],
    ["Each data row creates one inbound stock movement (no photos)."],
    ["Delete the sample rows before importing your data."],
  ]);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Import");
  XLSX.utils.book_append_sheet(wb, guide, "Instructions");
  const name =
    filename ?? `defect-stock-import-template-${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, name);
}

export async function parseBulkImportFile(file: File): Promise<ParsedBulkRow[]> {
  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheetName =
    wb.SheetNames.find((n) => n.toLowerCase() === "import") ?? wb.SheetNames[0];
  if (!sheetName) return [];

  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: true,
  });

  const parsed: ParsedBulkRow[] = [];
  let dataRow = 0;
  for (const obj of rows) {
    dataRow += 1;
    const mapped = mapObjectRow(obj);
    // Skip fully empty rows
    const hasAny = BULK_IMPORT_COLUMNS.some((col) => cellString(mapped[col]));
    if (!hasAny) continue;
    // Skip leftover sample instructional rows that look empty of product
    parsed.push(validateMappedRow(dataRow + 1, mapped)); // +1 for header row in spreadsheet terms
  }
  return parsed;
}

export function bulkRowToPayload(row: BulkImportRow, loggedBy: string): MovementPayload {
  const defect_lines = defectGroupsToLines([
    { defect_reason: row.defect_reason, quantity: row.quantity_pcs, photos: [] },
  ]);

  const payload: MovementPayload = {
    direction: "inbound",
    logged_by: loggedBy.trim(),
    product_name: row.product_name,
    batch_code: row.batch_code,
    expiry_date: row.expiry_date,
    quantity_pcs: row.quantity_pcs,
    defect_lines,
    reject_source_type: row.reject_source_type,
  };

  if (row.sku) payload.sku = row.sku;
  if (row.reject_source_vendor) payload.reject_source_vendor = row.reject_source_vendor;
  if (row.notes) payload.notes = row.notes;
  if (row.rsp_per_unit != null) payload.rsp_per_unit = row.rsp_per_unit;
  if (row.cogs_per_unit != null) payload.cogs_per_unit = row.cogs_per_unit;

  return payload;
}

export type BulkImportResult = {
  rowNumber: number;
  product_name: string;
  batch_code: string;
  ok: boolean;
  error?: string;
  movementId?: string;
};

export async function importBulkRows(
  rows: BulkImportRow[],
  loggedBy: string,
  submit: (payload: MovementPayload) => Promise<string>,
  onProgress?: (done: number, total: number, last: BulkImportResult) => void,
): Promise<BulkImportResult[]> {
  const results: BulkImportResult[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let result: BulkImportResult;
    try {
      const movementId = await submit(bulkRowToPayload(row, loggedBy));
      result = {
        rowNumber: row.rowNumber,
        product_name: row.product_name,
        batch_code: row.batch_code,
        ok: true,
        movementId,
      };
    } catch (err: unknown) {
      result = {
        rowNumber: row.rowNumber,
        product_name: row.product_name,
        batch_code: row.batch_code,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    results.push(result);
    onProgress?.(i + 1, rows.length, result);
  }
  return results;
}
