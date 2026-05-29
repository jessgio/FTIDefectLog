import { stripProductSuffix } from "./productImage";
import { normalizeProductKey } from "./skuList";
import type { DefectLine, MovementRecord, RejectRow } from "./types";

export type DefectPhotoRef = {
  url: string;
  piece?: number;
  movement_id: string;
  batch_code: string;
  logged_at: string;
  logged_by: string;
};

export type DefectEvidenceGroup = {
  defect_reason: string;
  photo_count: number;
  piece_count: number;
  photos: DefectPhotoRef[];
};

function productMatches(recordName: string, productName: string): boolean {
  const a = normalizeProductKey(recordName);
  const b = normalizeProductKey(productName);
  if (!a || !b) return false;
  if (a === b) return true;
  const as = normalizeProductKey(stripProductSuffix(recordName));
  const bs = normalizeProductKey(stripProductSuffix(productName));
  if (as === bs) return true;
  return a.startsWith(b) || b.startsWith(a) || as.startsWith(bs) || bs.startsWith(as);
}

export function filterMovementsForProduct(
  movements: MovementRecord[],
  productName: string,
): MovementRecord[] {
  return movements
    .filter((m) => productMatches(m.product_name, productName))
    .sort((a, b) => String(b.timestamp_utc).localeCompare(String(a.timestamp_utc)));
}

export function filterLotsForProduct(rows: RejectRow[], productName: string): RejectRow[] {
  return rows.filter((r) => productMatches(r.product_name, productName));
}

export function buildDefectEvidence(movements: MovementRecord[]): DefectEvidenceGroup[] {
  const byReason = new Map<string, DefectEvidenceGroup>();

  for (const m of movements) {
    if (m.direction !== "inbound") continue;

    const lines: DefectLine[] =
      m.defect_lines?.length ?
        m.defect_lines
      : m.defect_reason ?
        [{ piece: 1, defect_reason: m.defect_reason }]
      : [];

    for (const line of lines) {
      const reason = (line.defect_reason || "Unspecified").trim() || "Unspecified";
      let group = byReason.get(reason);
      if (!group) {
        group = {
          defect_reason: reason,
          photo_count: 0,
          piece_count: 0,
          photos: [],
        };
        byReason.set(reason, group);
      }
      group.piece_count += 1;

      const urls = (line.photo_urls ?? []).filter((u) => u?.trim());
      for (const url of urls.slice(0, 2)) {
        group.photos.push({
          url: url.trim(),
          piece: line.piece,
          movement_id: m.movement_id,
          batch_code: m.batch_code,
          logged_at: m.timestamp_utc,
          logged_by: m.logged_by,
        });
        group.photo_count += 1;
      }
    }
  }

  return [...byReason.values()].sort((a, b) => b.photo_count - a.photo_count || a.defect_reason.localeCompare(b.defect_reason));
}
