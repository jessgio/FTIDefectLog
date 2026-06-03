import { DEFECT_REASONS, normalizeDefectLabel } from "./defectReasons";
import type { DefectLine, MovementRecord } from "./types";

export type DefectGroupRowState = {
  defect_reason: string;
  quantity: number;
  photos: string[];
};

export function emptyDefectGroup(fill: string, quantity = 1): DefectGroupRowState {
  return { defect_reason: fill, quantity, photos: [] };
}

export function assignedDefectQuantity(groups: DefectGroupRowState[]): number {
  return groups.reduce((sum, g) => sum + (Number.isFinite(g.quantity) ? g.quantity : 0), 0);
}

/** Keep groups when possible; reset to one row when qty or structure no longer fits. */
export function syncDefectGroupsToQuantity(
  prev: DefectGroupRowState[],
  qty: number,
  fill: string,
): DefectGroupRowState[] {
  if (qty <= 0) return [];
  if (!prev.length) return [emptyDefectGroup(fill, qty)];
  if (prev.length === 1) {
    return [{ ...prev[0], quantity: qty }];
  }
  if (assignedDefectQuantity(prev) === qty) return prev;
  return [emptyDefectGroup(fill, qty)];
}

export function linesToDefectGroups(
  lines: DefectLine[],
  defaultReason?: string,
): DefectGroupRowState[] {
  const order: string[] = [];
  const groups = new Map<string, DefectGroupRowState>();
  const fill = defaultReason?.trim() || DEFECT_REASONS[0];

  for (const line of lines) {
    const reason = line.defect_reason.trim() || fill;
    let group = groups.get(reason);
    if (!group) {
      group = { defect_reason: reason, quantity: 0, photos: [] };
      groups.set(reason, group);
      order.push(reason);
    }
    group.quantity += 1;
    for (const url of line.photo_urls ?? []) {
      const trimmed = url.trim();
      if (trimmed && group.photos.length < 2 && !group.photos.includes(trimmed)) {
        group.photos.push(trimmed);
      }
    }
  }

  return order.map((reason) => groups.get(reason)!);
}

function parseDefectReasonSummary(summary: string): DefectGroupRowState[] {
  const groups: DefectGroupRowState[] = [];
  for (const part of summary.split(";")) {
    const segment = part.trim();
    if (!segment) continue;
    const m = segment.match(/^(.+?)\s*\((\d+)\)\s*$/u);
    if (m) {
      const qty = Number(m[2]);
      if (qty > 0) {
        groups.push({
          defect_reason: m[1].trim(),
          quantity: qty,
          photos: [],
        });
      }
    } else {
      const reason = normalizeDefectLabel(segment);
      if (reason) groups.push({ defect_reason: reason, quantity: 1, photos: [] });
    }
  }
  return groups;
}

export function recordToDefectGroups(record: MovementRecord): DefectGroupRowState[] {
  if (record.defect_lines?.length) {
    const fallback = normalizeDefectLabel(record.defect_reason) || DEFECT_REASONS[0];
    return linesToDefectGroups(record.defect_lines, fallback);
  }
  const qty = record.quantity_pcs;
  const summary = record.defect_reason?.trim();
  if (summary && (summary.includes(";") || /\(\d+\)/.test(summary))) {
    const parsed = parseDefectReasonSummary(summary);
    if (parsed.length && assignedDefectQuantity(parsed) === qty) {
      return parsed;
    }
  }
  const fill = normalizeDefectLabel(summary) || DEFECT_REASONS[0];
  return qty > 0 ? [emptyDefectGroup(fill, qty)] : [];
}

/** Expand grouped rows into one backend line per physical piece. */
export function defectGroupsToLines(groups: DefectGroupRowState[]): DefectLine[] {
  const merged: DefectGroupRowState[] = [];

  for (const row of groups) {
    const reason = row.defect_reason.trim();
    const qty = Math.max(0, Math.floor(row.quantity));
    if (!reason || qty <= 0) continue;

    const existing = merged.find((g) => g.defect_reason === reason);
    if (existing) {
      existing.quantity += qty;
      for (const url of row.photos) {
        if (existing.photos.length < 2 && !existing.photos.includes(url)) {
          existing.photos.push(url);
        }
      }
    } else {
      merged.push({
        defect_reason: reason,
        quantity: qty,
        photos: [...row.photos.slice(0, 2)],
      });
    }
  }

  const lines: DefectLine[] = [];
  let piece = 1;
  for (const group of merged) {
    for (let i = 0; i < group.quantity; i++) {
      lines.push({
        piece: piece++,
        defect_reason: group.defect_reason,
        ...(i === 0 && group.photos.length ? { photo_urls: group.photos.slice(0, 2) } : {}),
      });
    }
  }
  return lines;
}

export function validateDefectGroups(
  groups: DefectGroupRowState[],
  totalQty: number,
): string | null {
  if (!groups.length) return "Add at least one defect type.";
  for (const g of groups) {
    if (!g.defect_reason.trim()) return "Every row needs a defect type.";
    if (!Number.isFinite(g.quantity) || g.quantity <= 0) {
      return "Each row needs a positive quantity.";
    }
  }
  const assigned = assignedDefectQuantity(groups);
  if (assigned !== totalQty) {
    return `Quantities must add up to ${totalQty} pcs (currently ${assigned}).`;
  }
  return null;
}
