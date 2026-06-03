import { uploadPhotosForDefectLines } from "../lib/storage";
import { getSupabase } from "../lib/supabase";
import type { SkuEntry } from "../skuList";
import { parseIsoDateOnly } from "../expiry";
import type { DefectLine, MovementPayload, MovementRecord } from "../types";

type DbMovement = {
  id: string;
  direction: "inbound" | "outbound";
  logged_by: string;
  product_name: string;
  sku: string | null;
  batch_code: string;
  expiry_date: string | null;
  quantity_pcs: number;
  defect_reason: string | null;
  disposition: string | null;
  notes: string | null;
  rsp_per_unit: number | null;
  cogs_per_unit: number | null;
  defect_lines: DefectLine[] | null;
  created_at: string;
};

type DbProduct = {
  sku: string;
  product_name: string;
  barcode: string | null;
  product_category: string | null;
  image_url: string | null;
  image_storage_path: string | null;
  rsp_per_unit: number | null;
  cogs_per_unit: number | null;
};

function formatExpiry(iso: string | null): string {
  return parseIsoDateOnly(iso);
}

function toMovementRecord(row: DbMovement): MovementRecord {
  return {
    movement_id: row.id,
    timestamp_utc: row.created_at,
    direction: row.direction,
    logged_by: row.logged_by,
    product_name: row.product_name,
    sku: row.sku ?? undefined,
    batch_code: row.batch_code,
    expiry_date: formatExpiry(row.expiry_date),
    quantity_pcs: row.quantity_pcs,
    defect_reason: row.defect_reason ?? undefined,
    disposition: row.disposition ?? undefined,
    notes: row.notes ?? undefined,
    rsp_per_unit: row.rsp_per_unit ?? undefined,
    cogs_per_unit: row.cogs_per_unit ?? undefined,
    defect_lines: row.defect_lines ?? undefined,
  };
}

function toSkuEntry(row: DbProduct): SkuEntry {
  const image =
    row.image_storage_path?.trim() ||
    row.image_url?.trim() ||
    undefined;
  return {
    product_name: row.product_name,
    sku: row.sku,
    barcode: row.barcode ?? undefined,
    product_category: row.product_category ?? undefined,
    image_url: image,
    rsp_per_unit: row.rsp_per_unit ?? undefined,
    cogs_per_unit: row.cogs_per_unit ?? undefined,
  };
}

function payloadToRpc(payload: MovementPayload & { id?: string }): Record<string, unknown> {
  return {
    ...(payload.id ? { id: payload.id } : {}),
    direction: payload.direction,
    logged_by: payload.logged_by,
    product_name: payload.product_name,
    sku: payload.sku ?? "",
    batch_code: payload.batch_code,
    expiry_date: payload.expiry_date ?? "",
    quantity_pcs: payload.quantity_pcs,
    defect_reason: payload.defect_reason ?? "",
    disposition: payload.disposition ?? "",
    notes: payload.notes ?? "",
    rsp_per_unit: payload.rsp_per_unit ?? null,
    cogs_per_unit: payload.cogs_per_unit ?? null,
    defect_lines: payload.defect_lines ?? [],
  };
}

export async function fetchProducts(): Promise<SkuEntry[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("products")
    .select(
      "sku, product_name, barcode, product_category, image_url, image_storage_path, rsp_per_unit, cogs_per_unit",
    )
    .order("product_name");

  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => toSkuEntry(row as DbProduct));
}

export async function listMovements(): Promise<MovementRecord[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("movements")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => toMovementRecord(row as DbMovement));
}

export async function submitMovement(payload: MovementPayload): Promise<string> {
  const movementId = crypto.randomUUID();
  let defectLines = payload.defect_lines;

  if (defectLines?.length) {
    defectLines = await uploadPhotosForDefectLines(movementId, defectLines);
  }

  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("create_movement", {
    p_payload: payloadToRpc({ ...payload, id: movementId, defect_lines: defectLines }),
  });

  if (error) throw new Error(error.message);
  const result = data as { movement_id?: string } | null;
  return result?.movement_id ?? movementId;
}

export async function updateMovement(
  movementId: string,
  payload: Omit<MovementPayload, "action" | "movement_id">,
): Promise<void> {
  let defectLines = payload.defect_lines;
  if (defectLines?.length) {
    defectLines = await uploadPhotosForDefectLines(movementId, defectLines);
  }

  const supabase = getSupabase();
  const { error } = await supabase.rpc("update_movement", {
    p_id: movementId,
    p_payload: payloadToRpc({ ...payload, defect_lines: defectLines }),
  });
  if (error) throw new Error(error.message);
}

export async function deleteMovement(movementId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc("delete_movement", { p_id: movementId });
  if (error) throw new Error(error.message);
}

export async function patchMovementPhotos(
  movementId: string,
  defect_lines: NonNullable<MovementPayload["defect_lines"]>,
): Promise<void> {
  const uploaded = await uploadPhotosForDefectLines(movementId, defect_lines);
  const supabase = getSupabase();
  const { error } = await supabase.rpc("patch_movement_photos", {
    p_id: movementId,
    p_defect_lines: uploaded,
  });
  if (error) throw new Error(error.message);
}

/** @deprecated Google Apps Script removed — always configured via Supabase auth */
export function getMovementsScriptUrl(): string | null {
  return null;
}

/** @deprecated Single inventory source in Supabase */
export function getInventorySheetName(): string | null {
  return "inventory_lots";
}

/** @deprecated Use fetchProducts */
export async function fetchSkuList(): Promise<SkuEntry[]> {
  return fetchProducts();
}
