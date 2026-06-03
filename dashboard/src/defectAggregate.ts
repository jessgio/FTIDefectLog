import type { RejectRow } from "./types";

export function normalizeDefectReason(reason?: string): string {
  return reason?.trim() || "Unspecified";
}

export type DefectProductBreakdown = {
  product_name: string;
  sku?: string;
  total_pcs: number;
  lot_count: number;
};

export type DefectTypeRow = {
  defect_reason: string;
  total_pcs: number;
  lot_count: number;
  product_count: number;
  products: DefectProductBreakdown[];
};

export function computePcsByDefectReason(rows: RejectRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const key = normalizeDefectReason(r.defect_reason);
    out[key] = (out[key] ?? 0) + r.quantity_pcs;
  }
  return out;
}

export function aggregateByDefectType(rows: RejectRow[]): DefectTypeRow[] {
  const defectMap = new Map<string, RejectRow[]>();

  for (const r of rows) {
    const key = normalizeDefectReason(r.defect_reason);
    const list = defectMap.get(key) ?? [];
    list.push(r);
    defectMap.set(key, list);
  }

  const result: DefectTypeRow[] = [];

  for (const [defect_reason, lots] of defectMap) {
    const productMap = new Map<string, DefectProductBreakdown>();
    let total_pcs = 0;

    for (const r of lots) {
      total_pcs += r.quantity_pcs;
      let p = productMap.get(r.product_name);
      if (!p) {
        p = {
          product_name: r.product_name,
          sku: r.sku?.trim() || undefined,
          total_pcs: 0,
          lot_count: 0,
        };
        productMap.set(r.product_name, p);
      }
      p.total_pcs += r.quantity_pcs;
      p.lot_count += 1;
      if (!p.sku && r.sku?.trim()) p.sku = r.sku.trim();
    }

    const products = [...productMap.values()].sort((a, b) => b.total_pcs - a.total_pcs);
    result.push({
      defect_reason,
      total_pcs,
      lot_count: lots.length,
      product_count: products.length,
      products,
    });
  }

  return result.sort((a, b) => b.total_pcs - a.total_pcs);
}
