import { isNoExpiry } from "./expiry";
import type { RejectRow } from "./types";

export type AggregateGroupBy = "product_name" | "sku";

export type AggregateRow = {
  group_key: string;
  label: string;
  product_name: string;
  sku?: string;
  lot_count: number;
  total_pcs: number;
  earliest_expiry: string | null;
  expiring_soon_pcs: number;
  total_rsp_value: number | null;
  total_cogs_value: number | null;
};

function todayIsoUtc(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function daysUntilExpiry(expiryIso: string): number | null {
  const a = new Date(`${todayIsoUtc()}T00:00:00Z`);
  const b = new Date(`${expiryIso}T00:00:00Z`);
  const ta = a.getTime();
  const tb = b.getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.floor((tb - ta) / (1000 * 60 * 60 * 24));
}

function groupKey(row: RejectRow, groupBy: AggregateGroupBy): string {
  if (groupBy === "sku") {
    const sku = row.sku?.trim();
    if (sku) return `sku:${sku}`;
    return `product:${row.product_name}`;
  }
  return `product:${row.product_name}`;
}

export function aggregateRows(rows: RejectRow[], groupBy: AggregateGroupBy): AggregateRow[] {
  const map = new Map<string, AggregateRow>();

  for (const r of rows) {
    const key = groupKey(r, groupBy);
    let agg = map.get(key);
    if (!agg) {
      const sku = r.sku?.trim() || undefined;
      agg = {
        group_key: key,
        label: groupBy === "sku" && sku ? sku : r.product_name,
        product_name: r.product_name,
        sku,
        lot_count: 0,
        total_pcs: 0,
        earliest_expiry: null,
        expiring_soon_pcs: 0,
        total_rsp_value: 0,
        total_cogs_value: 0,
      };
      map.set(key, agg);
    }

    agg.lot_count += 1;
    agg.total_pcs += r.quantity_pcs;

    if (!isNoExpiry(r.expiry_date)) {
      if (!agg.earliest_expiry || r.expiry_date < agg.earliest_expiry) {
        agg.earliest_expiry = r.expiry_date;
      }
      const days = daysUntilExpiry(r.expiry_date);
      if (days != null && days >= 0 && days < 365) {
        agg.expiring_soon_pcs += r.quantity_pcs;
      }
    }

    if (typeof r.rsp_per_unit === "number" && Number.isFinite(r.rsp_per_unit)) {
      agg.total_rsp_value = (agg.total_rsp_value ?? 0) + r.rsp_per_unit * r.quantity_pcs;
    }
    if (typeof r.cogs_per_unit === "number" && Number.isFinite(r.cogs_per_unit)) {
      agg.total_cogs_value = (agg.total_cogs_value ?? 0) + r.cogs_per_unit * r.quantity_pcs;
    }
  }

  const result = [...map.values()].map((agg) => ({
    ...agg,
    total_rsp_value: agg.total_rsp_value && agg.total_rsp_value > 0 ? agg.total_rsp_value : null,
    total_cogs_value: agg.total_cogs_value && agg.total_cogs_value > 0 ? agg.total_cogs_value : null,
  }));

  return result.sort((a, b) => b.total_pcs - a.total_pcs);
}
