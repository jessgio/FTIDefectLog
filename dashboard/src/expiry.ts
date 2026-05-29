/** Canonical empty expiry for tools / non-dated products */
export function normalizeExpiryValue(value: string | undefined | null): string {
  const v = String(value ?? "").trim();
  if (!v) return "";
  const lower = v.toLowerCase();
  if (lower === "n/a" || lower === "na" || lower === "no expiry" || lower === "no-expiry" || lower === "none") {
    return "";
  }
  return v.length >= 10 ? v.slice(0, 10) : v;
}

export function isNoExpiry(value: string | undefined | null): boolean {
  return normalizeExpiryValue(value) === "";
}

export function formatExpiryDisplay(value: string | undefined | null): string {
  return isNoExpiry(value) ? "N/A" : normalizeExpiryValue(value);
}

export function compareExpiryAsc(a: string | undefined, b: string | undefined): number {
  const aa = isNoExpiry(a);
  const bb = isNoExpiry(b);
  if (aa && bb) return 0;
  if (aa) return 1;
  if (bb) return -1;
  return normalizeExpiryValue(a).localeCompare(normalizeExpiryValue(b));
}
