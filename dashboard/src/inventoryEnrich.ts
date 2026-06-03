import type { MovementRecord, RejectRow } from "./types";

function lotExpiryKey(expiry: string | undefined): string {
  const e = (expiry ?? "").trim();
  return e || "__no_expiry__";
}

function movementMatchesLot(m: MovementRecord, lot: RejectRow): boolean {
  if (m.direction !== "inbound") return false;
  if (m.product_name.trim().toLowerCase() !== lot.product_name.trim().toLowerCase()) {
    return false;
  }
  if (m.batch_code.trim().toLowerCase() !== lot.batch_code.trim().toLowerCase()) {
    return false;
  }
  return lotExpiryKey(m.expiry_date) === lotExpiryKey(lot.expiry_date);
}

/** Parse "Dented packaging (3)" or first segment of a summarized defect_reason. */
function parseDefectFromSummary(summary: string): string | undefined {
  const part = summary.split(";")[0]?.trim();
  if (!part) return undefined;
  const m = part.match(/^(.+?)\s*\(\d+\)\s*$/);
  return (m ? m[1] : part).trim() || undefined;
}

export function inferDefectReasonFromMovement(m: MovementRecord): string | undefined {
  if (m.defect_lines?.length) {
    const counts = new Map<string, number>();
    for (const line of m.defect_lines) {
      const r = (line.defect_reason ?? "").trim();
      if (!r) continue;
      counts.set(r, (counts.get(r) ?? 0) + 1);
    }
    if (!counts.size) return undefined;
    if (counts.size === 1) return [...counts.keys()][0];
    let best = "";
    let max = 0;
    for (const [reason, count] of counts) {
      if (count > max) {
        max = count;
        best = reason;
      }
    }
    return best || undefined;
  }

  const summary = (m.defect_reason ?? "").trim();
  if (!summary) return undefined;
  if (summary.includes(";")) return parseDefectFromSummary(summary);
  const parsed = parseDefectFromSummary(summary);
  if (parsed) return parsed;
  const stripped = summary.replace(/\s*\(\d+\)\s*$/, "").trim();
  return stripped || undefined;
}

function pickMovementForLot(lot: RejectRow, movements: MovementRecord[]): MovementRecord | undefined {
  const matches = movements
    .filter((m) => movementMatchesLot(m, lot))
    .sort((a, b) => String(b.timestamp_utc).localeCompare(String(a.timestamp_utc)));

  if (!matches.length) return undefined;

  const lotDefect = (lot.defect_reason ?? "").trim().toLowerCase();
  if (lotDefect) {
    const byDefect = matches.find((m) => {
      const inferred = inferDefectReasonFromMovement(m);
      return inferred?.toLowerCase() === lotDefect;
    });
    if (byDefect) return byDefect;
  }

  return matches[0];
}

/** Fill missing lot defect / return-source fields from inbound movement history. */
export function enrichLotsFromMovements(
  lots: RejectRow[],
  movements: MovementRecord[],
): RejectRow[] {
  if (!movements.length) return lots;

  return lots.map((lot) => {
    const m = pickMovementForLot(lot, movements);
    if (!m) return lot;

    let next = lot;
    if (!lot.defect_reason?.trim()) {
      const defect = inferDefectReasonFromMovement(m);
      if (defect) next = { ...next, defect_reason: defect };
    }
    if (!lot.reject_source_type?.trim() && m.reject_source_type?.trim()) {
      next = {
        ...next,
        reject_source_type: m.reject_source_type,
        reject_source_vendor: m.reject_source_vendor ?? next.reject_source_vendor,
      };
    }
    return next;
  });
}
