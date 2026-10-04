import { DEFECT_REASONS, normalizeDefectLabel } from "./defectReasons";
import { formatExpiryDisplay } from "./expiry";
import { REJECT_SOURCE_TYPES } from "./rejectSources";
import type { SkuEntry } from "./skuList";
import type { MovementDirection, MovementRecord } from "./types";

/** Outbound reasons used on the stock entry form. */
const KNOWN_DISPOSITIONS = [
  "Clearance sale",
  "Mid-year sale",
  "Allocated to customer",
  "Internal use",
  "Destroyed",
  "Other",
] as const;

export type HistoryDirectionFilter = "" | MovementDirection;

export type MovementHistoryFilters = {
  /** Inclusive local calendar date, YYYY-MM-DD. */
  dateFrom: string;
  /** Inclusive local calendar date, YYYY-MM-DD. */
  dateTo: string;
  direction: HistoryDirectionFilter;
  /** Exact SKU matches. Any selected SKU includes the row. */
  skus: string[];
  defectType: string;
  batch: string;
  product: string;
  loggedBy: string;
  sourceType: string;
  vendor: string;
  disposition: string;
  expiry: string;
  notes: string;
  /** Free-text match across the entry. */
  query: string;
};

export const EMPTY_HISTORY_FILTERS: MovementHistoryFilters = {
  dateFrom: "",
  dateTo: "",
  direction: "",
  skus: [],
  defectType: "",
  batch: "",
  product: "",
  loggedBy: "",
  sourceType: "",
  vendor: "",
  disposition: "",
  expiry: "",
  notes: "",
  query: "",
};

export type SkuOption = {
  sku: string;
  productName: string;
};

export type DateRangePresetId = "today" | "7" | "30" | "month";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local calendar date as YYYY-MM-DD. */
export function formatLocalDateInput(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local calendar date of a timestamp. Empty when the value is not a date. */
export function localDateKey(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return formatLocalDateInput(d);
}

export function dateRangePreset(id: DateRangePresetId, now = new Date()): {
  dateFrom: string;
  dateTo: string;
} {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dateTo = formatLocalDateInput(today);
  if (id === "today") return { dateFrom: dateTo, dateTo };
  if (id === "month") {
    return { dateFrom: formatLocalDateInput(new Date(today.getFullYear(), today.getMonth(), 1)), dateTo };
  }
  const from = new Date(today);
  from.setDate(from.getDate() - (id === "7" ? 6 : 29));
  return { dateFrom: formatLocalDateInput(from), dateTo };
}

export function matchingDatePreset(
  filters: MovementHistoryFilters,
  now = new Date(),
): DateRangePresetId | null {
  const ids: DateRangePresetId[] = ["today", "7", "30", "month"];
  for (const id of ids) {
    const range = dateRangePreset(id, now);
    if (filters.dateFrom === range.dateFrom && filters.dateTo === range.dateTo) return id;
  }
  return null;
}

export function isDateRangeInverted(filters: MovementHistoryFilters): boolean {
  return Boolean(filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo);
}

function text(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase();
}

function contains(haystack: string | undefined | null, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  return (haystack ?? "").toLowerCase().includes(q);
}

/** Distinct defect labels on a movement, from piece lines and the summary string. */
export function movementDefectLabels(record: MovementRecord): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();

  function add(raw: string | undefined | null): void {
    const label = normalizeDefectLabel(raw);
    if (!label) return;
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    labels.push(label);
  }

  if (record.defect_lines?.length) {
    for (const line of record.defect_lines) add(line.defect_reason);
  }
  const summary = record.defect_reason?.trim() ?? "";
  if (summary) {
    for (const part of summary.split(";")) add(part);
  }
  return labels;
}

/**
 * Pieces per defect label.
 * Line items are counted one by one. A summary like "Dirty packaging (12)" uses
 * those counts. A single label with no count uses the logged quantity.
 * Returns null when the split cannot be recovered.
 */
export function defectPieceCounts(record: MovementRecord): Map<string, number> | null {
  if (record.defect_lines?.length) {
    const counts = new Map<string, number>();
    for (const line of record.defect_lines) {
      const label = normalizeDefectLabel(line.defect_reason) || "Unspecified";
      const key = [...counts.keys()].find((existing) => existing.toLowerCase() === label.toLowerCase());
      const use = key ?? label;
      counts.set(use, (counts.get(use) ?? 0) + 1);
    }
    return counts;
  }

  const summary = record.defect_reason?.trim() ?? "";
  if (!summary) return null;

  const parsed: { label: string; qty: number | null }[] = [];
  for (const part of summary.split(";")) {
    const segment = part.trim();
    if (!segment) continue;
    const counted = segment.match(/^(.+?)\s*\((\d+)\)\s*$/u);
    if (counted) {
      parsed.push({ label: normalizeDefectLabel(counted[1]), qty: Number(counted[2]) });
    } else {
      parsed.push({ label: normalizeDefectLabel(segment), qty: null });
    }
  }
  const labeled = parsed.filter((part) => part.label);
  if (!labeled.length) return null;
  if (labeled.length === 1 && labeled[0].qty == null) {
    return new Map([[labeled[0].label, record.quantity_pcs]]);
  }
  if (labeled.every((part) => part.qty != null && part.qty > 0)) {
    const counts = new Map<string, number>();
    for (const part of labeled) {
      const key = [...counts.keys()].find((existing) => existing.toLowerCase() === part.label.toLowerCase());
      const use = key ?? part.label;
      counts.set(use, (counts.get(use) ?? 0) + (part.qty ?? 0));
    }
    return counts;
  }
  return null;
}

/** Pieces of one defect type, or all attributed defect pieces when no type is given. */
export function defectPieceQuantity(record: MovementRecord, defectType = ""): number | null {
  const counts = defectPieceCounts(record);
  if (!counts) return null;
  const want = text(normalizeDefectLabel(defectType));
  if (!want) {
    let total = 0;
    for (const qty of counts.values()) total += qty;
    return total;
  }
  for (const [label, qty] of counts) {
    if (label.toLowerCase() === want) return qty;
  }
  return 0;
}

/** Compact defect or disposition text for the table and the export. */
export function movementDetail(record: MovementRecord): string {
  if (record.direction === "outbound") return record.disposition?.trim() ?? "";
  if (record.defect_lines?.length) {
    const counts = new Map<string, number>();
    for (const line of record.defect_lines) {
      const label = line.defect_reason?.trim() || "Unspecified";
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()].map(([label, n]) => (n > 1 ? `${label} (${n})` : label)).join("; ");
  }
  return record.defect_reason?.trim() ?? "";
}

function matchesSkus(record: MovementRecord, skus: string[]): boolean {
  if (!skus.length) return true;
  const sku = text(record.sku);
  if (!sku) return false;
  return skus.some((selected) => text(selected) === sku);
}

function matchesDefect(record: MovementRecord, defectType: string): boolean {
  const want = text(normalizeDefectLabel(defectType));
  if (!want) return true;
  return movementDefectLabels(record).some((label) => label.toLowerCase() === want);
}

function matchesQuery(record: MovementRecord, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const fields = [
    record.product_name,
    record.sku,
    record.batch_code,
    record.logged_by,
    record.direction,
    record.disposition,
    record.notes,
    record.reject_source_type,
    record.reject_source_vendor,
    record.defect_reason,
    record.movement_id,
    movementDetail(record),
    ...movementDefectLabels(record),
  ];
  return fields.some((field) => (field ?? "").toLowerCase().includes(q));
}

function matchesExpiry(record: MovementRecord, expiry: string): boolean {
  const q = expiry.trim().toLowerCase();
  if (!q) return true;
  return (
    (record.expiry_date ?? "").toLowerCase().includes(q) ||
    formatExpiryDisplay(record.expiry_date).toLowerCase().includes(q)
  );
}

export function movementMatchesFilters(
  record: MovementRecord,
  filters: MovementHistoryFilters,
): boolean {
  if (isDateRangeInverted(filters)) return false;

  const day = localDateKey(record.timestamp_utc);
  if (filters.dateFrom && (!day || day < filters.dateFrom)) return false;
  if (filters.dateTo && (!day || day > filters.dateTo)) return false;
  if (filters.direction && record.direction !== filters.direction) return false;
  if (!matchesSkus(record, filters.skus)) return false;
  if (!matchesDefect(record, filters.defectType)) return false;
  if (!contains(record.batch_code, filters.batch)) return false;
  if (!contains(record.product_name, filters.product)) return false;
  if (!contains(record.logged_by, filters.loggedBy)) return false;
  if (filters.sourceType.trim() && text(record.reject_source_type) !== text(filters.sourceType)) {
    return false;
  }
  if (!contains(record.reject_source_vendor, filters.vendor)) return false;
  if (filters.disposition.trim() && text(record.disposition) !== text(filters.disposition)) {
    return false;
  }
  if (!matchesExpiry(record, filters.expiry)) return false;
  if (!contains(record.notes, filters.notes)) return false;
  if (!matchesQuery(record, filters.query)) return false;
  return true;
}

export function filterMovements(
  rows: MovementRecord[],
  filters: MovementHistoryFilters,
): MovementRecord[] {
  if (isDateRangeInverted(filters)) return [];
  return rows.filter((row) => movementMatchesFilters(row, filters));
}

export function sumMovementQuantity(rows: MovementRecord[]): number {
  return rows.reduce((sum, row) => sum + (Number.isFinite(row.quantity_pcs) ? row.quantity_pcs : 0), 0);
}

export function countActiveHistoryFilters(filters: MovementHistoryFilters): number {
  let n = 0;
  if (filters.dateFrom) n += 1;
  if (filters.dateTo) n += 1;
  if (filters.direction) n += 1;
  if (filters.skus.length) n += 1;
  if (filters.defectType) n += 1;
  if (filters.batch.trim()) n += 1;
  if (filters.product.trim()) n += 1;
  if (filters.loggedBy.trim()) n += 1;
  if (filters.sourceType.trim()) n += 1;
  if (filters.vendor.trim()) n += 1;
  if (filters.disposition.trim()) n += 1;
  if (filters.expiry.trim()) n += 1;
  if (filters.notes.trim()) n += 1;
  if (filters.query.trim()) n += 1;
  return n;
}

export function countExtraHistoryFilters(filters: MovementHistoryFilters): number {
  let n = 0;
  if (filters.product.trim()) n += 1;
  if (filters.loggedBy.trim()) n += 1;
  if (filters.sourceType.trim()) n += 1;
  if (filters.vendor.trim()) n += 1;
  if (filters.disposition.trim()) n += 1;
  if (filters.expiry.trim()) n += 1;
  if (filters.notes.trim()) n += 1;
  return n;
}

function uniqueLabels(preferred: readonly string[], extra: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  function add(raw: string): void {
    const label = raw.trim();
    if (!label) return;
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(label);
  }
  for (const label of preferred) add(label);
  const rest = [...extra].sort((a, b) => a.localeCompare(b));
  for (const label of rest) add(label);
  return out;
}

export function collectDefectTypeOptions(rows: MovementRecord[]): string[] {
  const extra: string[] = [];
  for (const row of rows) extra.push(...movementDefectLabels(row));
  return uniqueLabels(DEFECT_REASONS, extra);
}

export function collectDispositionOptions(rows: MovementRecord[]): string[] {
  return uniqueLabels(
    KNOWN_DISPOSITIONS,
    rows.map((row) => row.disposition ?? ""),
  );
}

export function collectSourceTypeOptions(rows: MovementRecord[]): string[] {
  return uniqueLabels(
    REJECT_SOURCE_TYPES,
    rows.map((row) => row.reject_source_type ?? ""),
  );
}

export function collectSkuOptions(rows: MovementRecord[], catalog: SkuEntry[]): SkuOption[] {
  const map = new Map<string, SkuOption>();

  function add(sku: string | undefined, productName: string | undefined): void {
    const value = sku?.trim() ?? "";
    if (!value) return;
    const key = value.toLowerCase();
    const name = productName?.trim() ?? "";
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { sku: value, productName: name });
      return;
    }
    if (!existing.productName && name) existing.productName = name;
  }

  for (const entry of catalog) add(entry.sku, entry.product_name);
  for (const row of rows) add(row.sku, row.product_name);
  return [...map.values()].sort((a, b) => a.sku.localeCompare(b.sku));
}

/** Keep canonical catalog casing and drop duplicates. */
export function mergeSelectedSkus(
  current: string[],
  incoming: string[],
  options: SkuOption[],
): string[] {
  const next = [...current];
  const seen = new Set(current.map((sku) => sku.trim().toLowerCase()).filter(Boolean));
  for (const part of incoming) {
    const raw = part.trim();
    if (!raw) continue;
    const canonical =
      options.find((option) => option.sku.toLowerCase() === raw.toLowerCase())?.sku ?? raw;
    const key = canonical.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(canonical);
  }
  return next;
}
