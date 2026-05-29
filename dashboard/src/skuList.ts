import { normalizeImageUrl, stripProductSuffix } from "./productImage";
import type { RejectRow } from "./types";

export type SkuEntry = {
  product_name: string;
  sku: string;
  /** From SKUList tab (aliases: category, product category) */
  product_category?: string;
  image_url?: string;
  rsp_per_unit?: number;
  cogs_per_unit?: number;
};

const UNCATEGORIZED = "Uncategorized";

export function buildCategoryMaps(entries: SkuEntry[]): {
  byProduct: Map<string, string>;
  bySku: Map<string, string>;
} {
  const byProduct = new Map<string, string>();
  const bySku = new Map<string, string>();
  for (const e of entries) {
    const cat = (e.product_category ?? "").trim();
    if (!cat) continue;
    const name = e.product_name.trim();
    const sku = e.sku.trim();
    if (name) byProduct.set(normalizeProductKey(name), cat);
    if (sku) bySku.set(sku.toLowerCase(), cat);
  }
  return { byProduct, bySku };
}

export function resolveProductCategory(
  entries: SkuEntry[],
  maps: ReturnType<typeof buildCategoryMaps>,
  productName: string,
  sku?: string,
): string {
  if (sku?.trim()) {
    const bySku = maps.bySku.get(sku.trim().toLowerCase());
    if (bySku) return bySku;
  }
  const fromMap = maps.byProduct.get(normalizeProductKey(productName));
  if (fromMap) return fromMap;

  const entry = lookupEntryFuzzy(entries, productName, sku);
  const fromEntry = (entry?.product_category ?? "").trim();
  if (fromEntry) return fromEntry;

  return UNCATEGORIZED;
}

/** Sum defective pcs per SKUList product_category for inventory rows. */
export function computePcsByCategory(rows: RejectRow[], entries: SkuEntry[]): Record<string, number> {
  const maps = buildCategoryMaps(entries);
  const out: Record<string, number> = {};
  for (const r of rows) {
    const fromRow = (r.product_category ?? "").trim();
    const cat = fromRow || resolveProductCategory(entries, maps, r.product_name, r.sku);
    out[cat] = (out[cat] ?? 0) + (r.quantity_pcs || 0);
  }
  return out;
}

export function skuListHasCategories(entries: SkuEntry[]): boolean {
  return entries.some((e) => (e.product_category ?? "").trim().length > 0);
}

export function normalizeProductKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function buildSkuByProduct(entries: SkuEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of entries) {
    const name = e.product_name.trim();
    const sku = e.sku.trim();
    if (!name || !sku) continue;
    map.set(normalizeProductKey(name), sku);
  }
  return map;
}

export function lookupSku(map: Map<string, string>, productName: string): string | undefined {
  const key = normalizeProductKey(productName);
  if (!key) return undefined;
  return map.get(key);
}

export function buildImageByProduct(entries: SkuEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of entries) {
    const name = e.product_name.trim();
    const url = (e.image_url ?? "").trim();
    if (!name || !url) continue;
    map.set(normalizeProductKey(name), url);
  }
  return map;
}

export function lookupImage(map: Map<string, string>, productName: string): string | undefined {
  const key = normalizeProductKey(productName);
  if (!key) return undefined;
  const raw = map.get(key);
  return raw ? normalizeImageUrl(raw) : undefined;
}

/** Match when inventory product name differs slightly from SKUList (e.g. missing “(10 gr)”). */
export function lookupEntryFuzzy(
  entries: SkuEntry[],
  productName: string,
  sku?: string,
): SkuEntry | undefined {
  if (sku?.trim()) {
    const skuKey = sku.trim().toLowerCase();
    const bySku = entries.find((e) => e.sku.trim().toLowerCase() === skuKey);
    if (bySku) return bySku;
  }

  const key = normalizeProductKey(productName);
  if (!key) return undefined;

  const exact = entries.find((e) => normalizeProductKey(e.product_name) === key);
  if (exact) return exact;

  const stripped = normalizeProductKey(stripProductSuffix(productName));
  if (stripped && stripped !== key) {
    const hit = entries.find((e) => normalizeProductKey(e.product_name) === stripped);
    if (hit) return hit;
  }

  for (const e of entries) {
    const mapKey = normalizeProductKey(e.product_name);
    if (mapKey.startsWith(key) || key.startsWith(mapKey)) return e;
    if (stripped && (mapKey.startsWith(stripped) || stripped.startsWith(mapKey))) return e;
  }

  return undefined;
}

export function lookupImageFuzzy(
  byProduct: Map<string, string>,
  entries: SkuEntry[],
  productName: string,
  sku?: string,
): string | undefined {
  const entry = lookupEntryFuzzy(entries, productName, sku);
  if (entry?.image_url) return normalizeImageUrl(entry.image_url);

  const exact = lookupImage(byProduct, productName);
  if (exact) return exact;

  const key = normalizeProductKey(productName);
  const stripped = normalizeProductKey(stripProductSuffix(productName));
  if (stripped && stripped !== key) {
    const hit = byProduct.get(stripped);
    if (hit) return normalizeImageUrl(hit);
  }

  for (const [mapKey, url] of byProduct) {
    if (mapKey.startsWith(key) || key.startsWith(mapKey)) return normalizeImageUrl(url);
    if (stripped && (mapKey.startsWith(stripped) || stripped.startsWith(mapKey))) {
      return normalizeImageUrl(url);
    }
  }

  return undefined;
}

export function formatPriceField(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  return String(value);
}
