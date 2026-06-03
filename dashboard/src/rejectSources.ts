export const REJECT_SOURCE_TYPES = [
  "E-commerce returns",
  "Consignment returns",
  "B2B returns",
  "Distributor returns",
] as const;

export type RejectSourceType = (typeof REJECT_SOURCE_TYPES)[number];

export function formatRejectSource(
  type?: string | null,
  vendor?: string | null,
): string {
  const t = type?.trim();
  const v = vendor?.trim();
  if (!t && !v) return "";
  if (t && v) return `${t} · ${v}`;
  return t ?? v ?? "";
}

export function isRejectSourceType(value: string): value is RejectSourceType {
  return (REJECT_SOURCE_TYPES as readonly string[]).includes(value);
}
