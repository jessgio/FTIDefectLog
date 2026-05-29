import { findEntryByBarcode, parseBarcodeList } from "./barcode";
import { normalizeProductKey, type SkuEntry } from "./skuList";

export type ProductSearchHit =
  | { kind: "catalog"; entry: SkuEntry }
  | { kind: "stock"; name: string };

export { findEntryByBarcode } from "./barcode";

export function searchProducts(
  entries: SkuEntry[],
  stockNames: string[],
  query: string,
  limit = 10,
): ProductSearchHit[] {
  const q = query.trim().toLowerCase();
  const out: ProductSearchHit[] = [];
  const seenNames = new Set<string>();

  const pushEntry = (entry: SkuEntry): void => {
    const nameKey = normalizeProductKey(entry.product_name);
    if (seenNames.has(nameKey)) return;
    seenNames.add(nameKey);
    out.push({ kind: "catalog", entry });
  };

  const pushStockName = (name: string): void => {
    const nameKey = normalizeProductKey(name);
    if (seenNames.has(nameKey)) return;
    seenNames.add(nameKey);
    out.push({ kind: "stock", name });
  };

  const entryMatchesQuery = (entry: SkuEntry): boolean => {
    if (entry.product_name.toLowerCase().includes(q)) return true;
    if (entry.sku.toLowerCase().includes(q)) return true;
    return parseBarcodeList(entry.barcode).some((b) => b.toLowerCase().includes(q));
  };

  if (!q) {
    for (const entry of entries) {
      if (out.length >= limit) break;
      pushEntry(entry);
    }
    for (const name of stockNames) {
      if (out.length >= limit) break;
      if (!entries.some((e) => normalizeProductKey(e.product_name) === normalizeProductKey(name))) {
        pushStockName(name);
      }
    }
    return out;
  }

  const barcodeHit = findEntryByBarcode(entries, q);
  if (barcodeHit) pushEntry(barcodeHit);

  for (const entry of entries) {
    if (out.length >= limit) break;
    if (entryMatchesQuery(entry)) pushEntry(entry);
  }

  for (const name of stockNames) {
    if (out.length >= limit) break;
    if (name.toLowerCase().includes(q)) pushStockName(name);
  }

  return out;
}

export function findExactCatalogEntry(entries: SkuEntry[], productName: string): SkuEntry | undefined {
  const key = normalizeProductKey(productName);
  if (!key) return undefined;
  return entries.find((e) => normalizeProductKey(e.product_name) === key);
}
