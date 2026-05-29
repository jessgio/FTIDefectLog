import type { SkuEntry } from "./skuList";
import type { MovementPayload, MovementRecord } from "./types";

type ScriptResponse = {
  ok?: boolean;
  error?: string;
  movements?: MovementRecord[];
  sku_list?: SkuEntry[];
};

export function getMovementsScriptUrl(): string | null {
  const url = import.meta.env.VITE_MOVEMENTS_SCRIPT_URL as string | undefined;
  return url?.trim() ? url.trim() : null;
}

export function getInventorySheetName(): string | null {
  const name = import.meta.env.VITE_INVENTORY_SHEET_NAME as string | undefined;
  return name?.trim() ? name.trim() : null;
}

async function callScript(body: Record<string, unknown>): Promise<ScriptResponse> {
  const url = getMovementsScriptUrl();
  if (!url) {
    throw new Error(
      "Missing VITE_MOVEMENTS_SCRIPT_URL. Deploy the Google Apps Script web app and add its URL to dashboard/.env.",
    );
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data: ScriptResponse | null = null;
  try {
    data = JSON.parse(text) as ScriptResponse;
  } catch {
    // ignore
  }

  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error ?? `Request failed (${res.status}): ${text.slice(0, 240)}`);
  }
  if (data?.ok !== true) {
    throw new Error("Request failed: unexpected response from server.");
  }
  return data;
}

export async function submitMovement(payload: MovementPayload): Promise<void> {
  await callScript({ ...payload, action: "create" });
}

export async function fetchSkuList(): Promise<SkuEntry[]> {
  const url = getMovementsScriptUrl();
  if (!url) return [];

  const res = await fetch(`${url}?action=sku_list`, { cache: "no-store" });
  const text = await res.text();
  let data: ScriptResponse | null = null;
  try {
    data = JSON.parse(text) as ScriptResponse;
  } catch {
    return [];
  }

  if (!res.ok) {
    throw new Error(data?.error ?? `SKU list request failed (${res.status})`);
  }
  if (data?.ok === false) {
    throw new Error(data?.error ?? "SKU list request failed");
  }
  return data?.sku_list ?? [];
}

export async function listMovements(): Promise<MovementRecord[]> {
  const url = getMovementsScriptUrl();
  if (!url) {
    throw new Error("Missing VITE_MOVEMENTS_SCRIPT_URL.");
  }

  const res = await fetch(`${url}?action=list`, { cache: "no-store" });
  const text = await res.text();
  let data: ScriptResponse | null = null;
  try {
    data = JSON.parse(text) as ScriptResponse;
  } catch {
    // ignore
  }

  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error ?? `List failed (${res.status}): ${text.slice(0, 240)}`);
  }
  return data?.movements ?? [];
}

export async function deleteMovement(movementId: string): Promise<void> {
  const inventory_sheet_name = getInventorySheetName() ?? undefined;
  await callScript({ action: "delete", movement_id: movementId, inventory_sheet_name });
}

export async function updateMovement(
  movementId: string,
  payload: Omit<MovementPayload, "action" | "movement_id">,
): Promise<void> {
  await callScript({ ...payload, action: "update", movement_id: movementId });
}

/** Update defect_breakdown photos only — does not change inventory quantities. */
export async function patchMovementPhotos(
  movementId: string,
  defect_lines: NonNullable<MovementPayload["defect_lines"]>,
): Promise<void> {
  await callScript({ action: "patch_photos", movement_id: movementId, defect_lines });
}
