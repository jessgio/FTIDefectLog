export const DEFECT_REASONS = [
  "Dented packaging",
  "Dirty packaging",
  "Unsalvable dirty packaging",
  "Discontinued item",
  "Damaged product",
  "Label / barcode issue",
  "Other",
] as const;

export type DefectReason = (typeof DEFECT_REASONS)[number];

/** Strip movement summary suffixes like "Dirty packaging (12)" or take first segment. */
export function normalizeDefectLabel(value?: string | null): string {
  if (!value?.trim()) return "";
  const first = value.split(";")[0]?.trim() ?? "";
  return first.replace(/\s*\(\d+\)\s*$/u, "").trim();
}

/** Options for defect selects, keeping legacy/custom values visible. */
export function defectReasonOptions(current?: string): string[] {
  const label = normalizeDefectLabel(current);
  if (label && !(DEFECT_REASONS as readonly string[]).includes(label)) {
    return [...DEFECT_REASONS, label];
  }
  return [...DEFECT_REASONS];
}
