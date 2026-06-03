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
