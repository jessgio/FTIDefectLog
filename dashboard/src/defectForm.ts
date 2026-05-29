import { DEFECT_REASONS, MAX_DEFECT_LINES } from "./defectReasons";
import type { DefectLine, MovementRecord } from "./types";

export type DefectRowState = {
  defect_reason: string;
  photos: string[];
};

export function emptyDefectRow(fill: string): DefectRowState {
  return { defect_reason: fill, photos: [] };
}

export function resizeDefectRows(
  prev: DefectRowState[],
  qty: number,
  fill: string,
): DefectRowState[] {
  if (qty <= 0) return [];
  if (qty > MAX_DEFECT_LINES) return prev.slice(0, MAX_DEFECT_LINES);
  const next = prev.slice(0, qty);
  while (next.length < qty) {
    next.push(emptyDefectRow(fill));
  }
  return next;
}

export function recordToDefectRows(record: MovementRecord): DefectRowState[] {
  if (record.defect_lines?.length) {
    return record.defect_lines.map((l) => ({
      defect_reason: l.defect_reason,
      photos: [...(l.photo_urls ?? [])],
    }));
  }
  const qty = record.quantity_pcs;
  const fill =
    record.defect_reason?.split(";")[0]?.replace(/\s*\(\d+\)\s*$/, "").trim() || DEFECT_REASONS[0];
  return Array.from({ length: qty }, () => emptyDefectRow(fill));
}

export function defectRowsToLines(rows: DefectRowState[]): DefectLine[] {
  return rows.map((row, i) => ({
    piece: i + 1,
    defect_reason: row.defect_reason.trim(),
    ...(row.photos.length ? { photo_urls: row.photos.slice(0, 2) } : {}),
  }));
}
