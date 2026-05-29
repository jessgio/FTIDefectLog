import Papa from "papaparse";
import { normalizeExpiryValue } from "./expiry";
import type { RejectRow } from "./types";

export function toCsvUrlFromAnyGoogleSheetsUrl(input: string): string {
  const s = input.trim();

  // Publish-to-web links (incl. /d/e/2PACX-…/pub?output=csv) — use as-is
  if (s.includes("output=csv") || s.includes("tqx=out:csv")) return s;

  // Common "edit" links:
  // https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit#gid={GID}
  // https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit?gid={GID}
  const m = s.match(/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/i);
  const sheetId = m?.[1];
  let gid: string | null = null;

  try {
    const u = new URL(s);
    gid = u.searchParams.get("gid");
    if (!gid && u.hash) {
      const hm = u.hash.match(/gid=(\d+)/);
      gid = hm?.[1] ?? null;
    }
  } catch {
    // ignore URL parse errors; fall through
  }

  if (sheetId && gid) {
    return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?tqx=out:csv&gid=${encodeURIComponent(gid)}`;
  }

  return s;
}

export function getSheetCsvUrl(): string | null {
  const direct = import.meta.env.VITE_SHEET_CSV_URL as string | undefined;
  if (direct?.trim()) return toCsvUrlFromAnyGoogleSheetsUrl(direct);
  const sheetId = import.meta.env.VITE_GOOGLE_SHEET_ID as string | undefined;
  const gid = import.meta.env.VITE_GOOGLE_SHEET_GID as string | undefined;
  if (!sheetId || !gid) return null;
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?tqx=out:csv&gid=${encodeURIComponent(gid)}`;
}

function toNumber(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v).trim();
  if (!s) return undefined;
  const n = Number(s.replaceAll(",", ""));
  return Number.isFinite(n) ? n : undefined;
}

export async function fetchRejectRows(): Promise<RejectRow[]> {
  const url = getSheetCsvUrl();
  if (!url) {
    throw new Error(
      "Missing sheet config. Set VITE_SHEET_CSV_URL (recommended) or VITE_GOOGLE_SHEET_ID + VITE_GOOGLE_SHEET_GID in dashboard/.env.",
    );
  }

  const res = await fetch(url, {
    cache: "no-store",
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Failed to fetch sheet CSV (${res.status}) from ${url}`);
  const csv = await res.text();
  const trimmed = csv.trimStart();
  if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html")) {
    throw new Error(
      `Sheet did not return CSV (got HTML). This usually means the sheet is not publicly readable without login.\nFix: in Google Sheets set access to "Anyone with the link" OR use File → Share → Publish to the web (CSV), then paste that CSV link into VITE_SHEET_CSV_URL.\nURL: ${url}`,
    );
  }

  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: "greedy",
  });

  if (parsed.errors?.length) {
    // Keep going, but surface first error
    // eslint-disable-next-line no-console
    console.warn("CSV parse warnings:", parsed.errors.slice(0, 3));
  }

  const rows: RejectRow[] = (parsed.data ?? [])
    .map((r) => {
      const product_name = (r.product_name ?? "").trim();
      const batch_code = (r.batch_code ?? "").trim();
      const expiry_date = normalizeExpiryValue(r.expiry_date);
      const quantity_pcs = toNumber(r.quantity_pcs) ?? 0;
      if (!product_name || !batch_code || !quantity_pcs) return null;

      return {
        source_file: r.source_file?.trim() || undefined,
        parsed_on: r.parsed_on?.trim() || undefined,

        product_name,
        sku: r.sku?.trim() || undefined,
        product_category:
          (r.product_category ?? r.category ?? r["product category"])?.trim() || undefined,
        image_url: (r.image_url ?? r.product_image ?? r.image)?.trim() || undefined,
        defect_reason: r.defect_reason?.trim() || undefined,
        batch_code,
        expiry_date,
        quantity_pcs,
        rsp_per_unit: toNumber(r.rsp_per_unit),
        months_until_exp: toNumber(r.months_until_exp),
        cogs_per_unit: toNumber(r.cogs_per_unit),
      };
    })
    .filter((x): x is RejectRow => Boolean(x));

  return rows;
}

