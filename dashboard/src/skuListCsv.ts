import Papa from "papaparse";
import type { SkuEntry } from "./skuList";
import { toCsvUrlFromAnyGoogleSheetsUrl } from "./sheet";

function normalizeHeader(h: string): string {
  return h
    .trim()
    .replace(/^\uFEFF/, "")
    .replace(/\u00A0/g, " ")
    .toLowerCase()
    .replace(/[_\s]+/g, " ");
}

function pickColumn(row: Record<string, string>, names: string[]): string {
  const keys = Object.keys(row);
  for (const name of names) {
    const want = normalizeHeader(name);
    const key = keys.find((k) => normalizeHeader(k) === want);
    if (key && row[key]?.trim()) return row[key].trim();
  }
  return "";
}

/** Match headers like "Product Category", "Category (required)", etc. */
function pickCategoryColumn(row: Record<string, string>): string {
  const exact = pickColumn(row, [
    "product_category",
    "category",
    "product category",
    "categories",
    "product type",
    "kategori",
  ]);
  if (exact) return exact;

  for (const key of Object.keys(row)) {
    const h = normalizeHeader(key);
    if (h.includes("categ") || h.includes("kategori")) {
      const v = row[key]?.trim();
      if (v) return v;
    }
  }
  return "";
}

export const SKU_LIST_CSV_LS_KEY = "fti_sku_list_csv_url";

type SkuListRuntimeConfig = { skuListCsvUrl?: string };

let runtimeSkuListCsvUrlCache: string | null | undefined;

/** Loaded at runtime from /sku-list-config.json (works on Vercel without build env vars). */
export async function loadRuntimeSkuListCsvUrl(): Promise<string | null> {
  if (runtimeSkuListCsvUrlCache !== undefined) return runtimeSkuListCsvUrlCache;
  try {
    const res = await fetch("/sku-list-config.json", { cache: "no-store" });
    if (!res.ok) {
      runtimeSkuListCsvUrlCache = null;
      return null;
    }
    const json = (await res.json()) as SkuListRuntimeConfig;
    const raw = json.skuListCsvUrl?.trim();
    runtimeSkuListCsvUrlCache = raw ? toCsvUrlFromAnyGoogleSheetsUrl(raw) : null;
    return runtimeSkuListCsvUrlCache;
  } catch {
    runtimeSkuListCsvUrlCache = null;
    return null;
  }
}

function getLocalCsvOverride(): string | null {
  try {
    const v = localStorage.getItem(SKU_LIST_CSV_LS_KEY);
    return v?.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export function getSkuListCsvUrlCandidates(): string[] {
  const out: string[] = [];
  const local = getLocalCsvOverride();
  if (local) out.push(toCsvUrlFromAnyGoogleSheetsUrl(local));

  const direct = import.meta.env.VITE_SKU_LIST_CSV_URL as string | undefined;
  if (direct?.trim()) out.push(toCsvUrlFromAnyGoogleSheetsUrl(direct));

  const sheetId = import.meta.env.VITE_GOOGLE_SHEET_ID as string | undefined;
  const gid = import.meta.env.VITE_SKU_LIST_GID as string | undefined;
  if (!sheetId?.trim()) return out;

  const id = sheetId.trim();
  if (gid?.trim()) {
    out.push(
      `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/gviz/tq?tqx=out:csv&gid=${encodeURIComponent(gid.trim())}`,
    );
  }

  const sheetName =
    (import.meta.env.VITE_SKU_LIST_SHEET_NAME as string | undefined)?.trim() || "SKUList";
  out.push(
    `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`,
  );
  out.push(
    `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/export?format=csv&sheet=${encodeURIComponent(sheetName)}`,
  );

  return [...new Set(out)];
}

export function getSkuListCsvUrl(): string | null {
  const candidates = getSkuListCsvUrlCandidates();
  return candidates[0] ?? null;
}

async function fetchCsvText(url: string): Promise<string> {
  const res = await fetch(url, { cache: "no-store", redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const trimmed = text.trimStart();
  if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html")) {
    throw new Error("Not CSV (login or publish required)");
  }
  return text;
}

export function parseSkuListFromCsvText(csv: string): SkuEntry[] {
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: "greedy",
  });

  const entries: SkuEntry[] = [];
  for (const row of parsed.data ?? []) {
    const product_name = pickColumn(row, ["product_name", "product", "product name"]);
    const sku = pickColumn(row, ["sku", "sku code"]);
    if (!product_name || !sku) continue;

    const entry: SkuEntry = { product_name, sku };
    const category = pickCategoryColumn(row);
    if (category) entry.product_category = category;

    const image_url = pickColumn(row, [
      "image_url",
      "image url",
      "image",
      "product_image",
      "photo",
    ]);
    if (image_url) entry.image_url = image_url;

    entries.push(entry);
  }
  return entries;
}

export type SkuCsvFetchAttempt = {
  url: string;
  ok: boolean;
  detail: string;
  rows: number;
  withCategory: number;
};

async function getSkuListCsvUrlCandidatesAsync(): Promise<string[]> {
  const runtime = await loadRuntimeSkuListCsvUrl();
  const built = getSkuListCsvUrlCandidates();
  const merged = [...(runtime ? [runtime] : []), ...built];
  return [...new Set(merged)];
}

export async function fetchSkuListFromPublishedCsvWithDiagnostics(): Promise<{
  entries: SkuEntry[];
  attempts: SkuCsvFetchAttempt[];
}> {
  const candidates = await getSkuListCsvUrlCandidatesAsync();
  const attempts: SkuCsvFetchAttempt[] = [];

  if (!candidates.length) {
    return {
      entries: [],
      attempts: [
        {
          url: "(none)",
          ok: false,
          detail:
            "No CSV URL configured. Set VITE_SKU_LIST_CSV_URL to your Publish-to-web link, or VITE_SKU_LIST_GID on Vercel.",
          rows: 0,
          withCategory: 0,
        },
      ],
    };
  }

  let best: SkuEntry[] = [];
  for (const url of candidates) {
    try {
      const csv = await fetchCsvText(url);
      const entries = parseSkuListFromCsvText(csv);
      const withCategory = countEntriesWithCategory(entries);
      attempts.push({
        url,
        ok: entries.length > 0,
        detail:
          entries.length > 0
            ? withCategory > 0
              ? `OK — ${withCategory} rows with category`
              : `Loaded ${entries.length} SKUs but no category column in headers`
            : "CSV parsed but no product/SKU rows",
        rows: entries.length,
        withCategory,
      });
      if (withCategory > best.filter((e) => (e.product_category ?? "").trim()).length) {
        best = entries;
      } else if (!best.length && entries.length) {
        best = entries;
      }
    } catch (e: unknown) {
      attempts.push({
        url,
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
        rows: 0,
        withCategory: 0,
      });
    }
  }

  return { entries: best, attempts };
}

/** Try several public CSV URLs for the SKUList tab (no Apps Script required). */
export async function fetchSkuListFromPublishedCsv(): Promise<SkuEntry[]> {
  const { entries, attempts } = await fetchSkuListFromPublishedCsvWithDiagnostics();
  if (countEntriesWithCategory(entries) > 0) return entries;

  const last = attempts.filter((a) => !a.ok).pop();
  if (last) {
    throw new Error(
      `Could not load SKUList categories. Set VITE_SKU_LIST_CSV_URL to the exact Publish-to-web CSV link for the SKUList tab (not the inventory tab). Last error: ${last.detail}`,
    );
  }
  if (entries.length && !countEntriesWithCategory(entries)) {
    throw new Error(
      "SKUList CSV loaded but no category column found. Use header product_category or category.",
    );
  }
  return entries;
}

/** Prefer script list for images/prices; fill categories from CSV when the API omits them. */
export function mergeSkuEntries(primary: SkuEntry[], categorySource: SkuEntry[]): SkuEntry[] {
  if (!categorySource.length) return primary;
  if (!primary.length) return categorySource;

  const catBySku = new Map<string, string>();
  const catByProduct = new Map<string, string>();
  for (const e of categorySource) {
    const cat = (e.product_category ?? "").trim();
    if (!cat) continue;
    catBySku.set(e.sku.trim().toLowerCase(), cat);
    catByProduct.set(e.product_name.trim().toLowerCase(), cat);
  }

  return primary.map((e) => {
    if ((e.product_category ?? "").trim()) return e;
    const fromSku = catBySku.get(e.sku.trim().toLowerCase());
    const fromName = catByProduct.get(e.product_name.trim().toLowerCase());
    const product_category = fromSku ?? fromName;
    return product_category ? { ...e, product_category } : e;
  });
}

export function countEntriesWithCategory(entries: SkuEntry[]): number {
  return entries.filter((e) => (e.product_category ?? "").trim()).length;
}
