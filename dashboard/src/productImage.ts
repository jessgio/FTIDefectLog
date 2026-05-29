function getMovementsScriptUrl(): string | null {
  const url = import.meta.env.VITE_MOVEMENTS_SCRIPT_URL as string | undefined;
  return url?.trim() ? url.trim() : null;
}

/** Extract Google Drive file ID from common share / view link formats. */
export function extractGoogleDriveFileId(url: string): string | null {
  const u = url.trim();
  if (!u) return null;

  const filePath = u.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (filePath) return filePath[1];

  const openId = u.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (openId && /google\.com/i.test(u)) return openId[1];

  const ucId = u.match(/\/uc\?(?:export=[^&]+&)?id=([a-zA-Z0-9_-]+)/);
  if (ucId) return ucId[1];

  const thumbId = u.match(/thumbnail\?id=([a-zA-Z0-9_-]+)/);
  if (thumbId) return thumbId[1];

  return null;
}

/** Apps Script proxy — works for files the script owner can read (no public link required). */
export function driveImageProxyUrl(fileId: string): string | null {
  const scriptUrl = getMovementsScriptUrl();
  if (!scriptUrl || !fileId) return null;
  const base = scriptUrl.replace(/\?.*$/, "");
  return `${base}?action=drive_image&id=${encodeURIComponent(fileId)}`;
}

export function googleDriveEmbedUrls(fileId: string): string[] {
  return [
    `https://drive.google.com/thumbnail?id=${fileId}&sz=w400`,
    `https://drive.google.com/uc?export=view&id=${fileId}`,
    `https://drive.google.com/uc?export=download&id=${fileId}`,
    `https://lh3.googleusercontent.com/d/${fileId}=w400`,
  ];
}

/** Normalize image URLs for display (e.g. Google Drive share links). */
export function normalizeImageUrl(url: string): string {
  const u = url.trim();
  if (!u) return "";

  const fileId = extractGoogleDriveFileId(u);
  if (fileId) return `https://drive.google.com/thumbnail?id=${fileId}&sz=w400`;

  return u;
}

/**
 * Gallery / host page links often fail in <img>. Return direct-URL candidates to try in order.
 */
export function imageUrlCandidates(url: string): string[] {
  const u = url.trim();
  if (!u) return [];

  const fileId = extractGoogleDriveFileId(u);
  if (fileId) {
    const out = [...googleDriveEmbedUrls(fileId)];
    const proxy = driveImageProxyUrl(fileId);
    if (proxy) out.push(proxy);
    return [...new Set(out)];
  }

  const normalized = normalizeImageUrl(u);
  const out: string[] = [normalized];

  const freeImage = normalized.match(/freeimage\.host\/i\/([A-Za-z0-9]+)/i);
  if (freeImage) {
    const id = freeImage[1];
    for (const ext of ["jpg", "png", "webp"]) {
      out.push(`https://iili.io/${id}.${ext}`);
    }
    out.push(`https://freeimage.host/image/${id}.jpg`);
  }

  const iiliPage = normalized.match(/iili\.io\/([A-Za-z0-9]+)(?:\.[a-z]+)?$/i);
  if (iiliPage && !/\.(jpe?g|png|gif|webp)$/i.test(normalized)) {
    const id = iiliPage[1];
    for (const ext of ["jpg", "png", "webp"]) {
      out.push(`https://iili.io/${id}.${ext}`);
    }
  }

  const imgbbPage = normalized.match(/imgbb\.com\/([A-Za-z0-9]+)/i);
  if (imgbbPage) {
    out.push(`https://i.ibb.co/${imgbbPage[1]}.jpg`);
  }

  if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(normalized)) {
    return [...new Set(out)];
  }

  if (!/\.(jpe?g|png|gif|webp)/i.test(normalized)) {
    for (const ext of ["jpg", "png", "webp"]) {
      out.push(`${normalized.replace(/\/$/, "")}.${ext}`);
    }
  }

  return [...new Set(out)];
}

export function productInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Strip trailing size suffixes for looser product name matching. */
export function stripProductSuffix(name: string): string {
  return name
    .trim()
    .replace(/\s*\([^)]*\)\s*$/g, "")
    .replace(/\s*-\s*v\d+\s*$/i, "")
    .trim();
}

export function isGoogleDriveUrl(url: string): boolean {
  return extractGoogleDriveFileId(url) != null;
}
