import type { SkuEntry } from "./skuList";

/** Split a SKUList barcode cell (supports multiple codes separated by comma/semicolon). */
export function parseBarcodeList(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(/[,;|\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Normalized lookup keys for a scanned or stored barcode (handles leading zeros). */
export function barcodeMatchKeys(code: string): string[] {
  const raw = code.trim();
  if (!raw) return [];

  const keys = new Set<string>();
  keys.add(raw.toLowerCase());

  const digits = raw.replace(/\D/g, "");
  if (digits) {
    keys.add(digits);
    const trimmed = digits.replace(/^0+/, "");
    if (trimmed) keys.add(trimmed);
  }

  return [...keys];
}

export function buildBarcodeLookup(entries: SkuEntry[]): Map<string, SkuEntry> {
  const map = new Map<string, SkuEntry>();
  for (const entry of entries) {
    for (const code of parseBarcodeList(entry.barcode)) {
      for (const key of barcodeMatchKeys(code)) {
        if (!map.has(key)) map.set(key, entry);
      }
    }
  }
  return map;
}

/** Resolve a scanned barcode to a SKUList row via the `barcode` column. */
export function findEntryByBarcode(
  entries: SkuEntry[],
  code: string,
  lookup?: Map<string, SkuEntry>,
): SkuEntry | undefined {
  const raw = code.trim();
  if (!raw) return undefined;

  const index = lookup ?? buildBarcodeLookup(entries);
  for (const key of barcodeMatchKeys(raw)) {
    const hit = index.get(key);
    if (hit) return hit;
  }

  return undefined;
}

export function countEntriesWithBarcode(entries: SkuEntry[]): number {
  return entries.filter((e) => parseBarcodeList(e.barcode).length > 0).length;
}
