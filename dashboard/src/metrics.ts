import { isNoExpiry } from "./expiry";
import type { RejectRow } from "./types";

export type Metrics = {
  totalDistinctProducts: number;
  totalLots: number;
  totalPcs: number;

  expiringInLessThan365DaysPcs: number;
  expiringInLessThan365DaysLots: number;

  pcsByExpiryYear: Record<string, number>;

  totalRspValue: number | null;
  totalCogsValue: number | null;
};

function daysBetweenUtc(aIso: string, bIso: string): number | null {
  const a = new Date(`${aIso}T00:00:00Z`);
  const b = new Date(`${bIso}T00:00:00Z`);
  const ta = a.getTime();
  const tb = b.getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.floor((tb - ta) / (1000 * 60 * 60 * 24));
}

function todayIsoUtc(): string {
  const d = new Date();
  // Construct YYYY-MM-DD in UTC
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function computeMetrics(rows: RejectRow[]): Metrics {
  const totalLots = rows.length;
  const totalPcs = rows.reduce((acc, r) => acc + (r.quantity_pcs || 0), 0);

  const products = new Set(rows.map((r) => r.product_name));
  const pcsByExpiryYear: Record<string, number> = {};

  const today = todayIsoUtc();
  let expiringSoonPcs = 0;
  let expiringSoonLots = 0;

  let rspValue = 0;
  let rspCount = 0;
  let cogsValue = 0;
  let cogsCount = 0;

  for (const r of rows) {
    if (isNoExpiry(r.expiry_date)) {
      pcsByExpiryYear["No expiry"] = (pcsByExpiryYear["No expiry"] ?? 0) + r.quantity_pcs;
    } else {
      const year = r.expiry_date?.slice(0, 4) || "unknown";
      pcsByExpiryYear[year] = (pcsByExpiryYear[year] ?? 0) + r.quantity_pcs;

      const d = daysBetweenUtc(today, r.expiry_date);
      if (d != null && d >= 0 && d < 365) {
        expiringSoonPcs += r.quantity_pcs;
        expiringSoonLots += 1;
      }
    }

    if (typeof r.rsp_per_unit === "number" && Number.isFinite(r.rsp_per_unit)) {
      rspValue += r.rsp_per_unit * r.quantity_pcs;
      rspCount += 1;
    }
    if (typeof r.cogs_per_unit === "number" && Number.isFinite(r.cogs_per_unit)) {
      cogsValue += r.cogs_per_unit * r.quantity_pcs;
      cogsCount += 1;
    }
  }

  return {
    totalDistinctProducts: products.size,
    totalLots,
    totalPcs,
    expiringInLessThan365DaysPcs: expiringSoonPcs,
    expiringInLessThan365DaysLots: expiringSoonLots,
    pcsByExpiryYear,
    totalRspValue: rspCount ? rspValue : null,
    totalCogsValue: cogsCount ? cogsValue : null,
  };
}

