import { parseIsoDateOnly } from "./expiry";
import { getSupabase } from "./lib/supabase";
import type { RejectRow } from "./types";

type InventoryLotRow = {
  id: string;
  product_name: string;
  sku: string | null;
  defect_reason: string | null;
  batch_code: string;
  expiry_date: string | null;
  quantity_pcs: number;
  rsp_per_unit: number | null;
  cogs_per_unit: number | null;
  source_file: string | null;
  parsed_on: string | null;
};

function formatExpiry(iso: string | null): string {
  return parseIsoDateOnly(iso);
}

function toRejectRow(row: InventoryLotRow): RejectRow | null {
  const quantity_pcs = row.quantity_pcs ?? 0;
  const product_name = (row.product_name ?? "").trim();
  const batch_code = (row.batch_code ?? "").trim();
  if (!product_name || !batch_code || quantity_pcs <= 0) return null;

  return {
    source_file: row.source_file?.trim() || undefined,
    parsed_on: row.parsed_on?.trim() || undefined,
    product_name,
    sku: row.sku?.trim() || undefined,
    defect_reason: row.defect_reason?.trim() || undefined,
    batch_code,
    expiry_date: formatExpiry(row.expiry_date),
    quantity_pcs,
    rsp_per_unit: row.rsp_per_unit ?? undefined,
    cogs_per_unit: row.cogs_per_unit ?? undefined,
  };
}

export async function fetchInventoryLots(): Promise<RejectRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("inventory_lots")
    .select(
      "id, product_name, sku, defect_reason, batch_code, expiry_date, quantity_pcs, rsp_per_unit, cogs_per_unit, source_file, parsed_on",
    )
    .gt("quantity_pcs", 0)
    .order("expiry_date", { ascending: true, nullsFirst: false });

  if (error) throw new Error(error.message);

  return (data ?? [])
    .map((row) => toRejectRow(row as InventoryLotRow))
    .filter((x): x is RejectRow => Boolean(x));
}

/** @deprecated Use fetchInventoryLots — kept as alias during migration */
export const fetchRejectRows = fetchInventoryLots;
