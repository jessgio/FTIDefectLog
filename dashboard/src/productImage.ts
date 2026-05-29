import React from "react";
import { getSignedStorageUrl, isStoragePath } from "./lib/storage";

/** Extract Google Drive file ID from legacy migrated URLs. */
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

export function googleDriveEmbedUrls(fileId: string): string[] {
  return [
    `https://drive.google.com/thumbnail?id=${fileId}&sz=w400`,
    `https://drive.google.com/uc?export=view&id=${fileId}`,
  ];
}

/** Normalize image URLs for display (legacy Drive / external hosts). */
export function normalizeImageUrl(url: string): string {
  const u = url.trim();
  if (!u) return "";

  const fileId = extractGoogleDriveFileId(u);
  if (fileId) return `https://drive.google.com/thumbnail?id=${fileId}&sz=w400`;

  return u;
}

/**
 * Return URL candidates to try in order (sync — storage paths resolved via useDisplayImageUrl).
 */
export function imageUrlCandidates(url: string): string[] {
  const u = url.trim();
  if (!u) return [];
  if (u.startsWith("data:")) return [u];
  if (isStoragePath(u)) return [u];

  const fileId = extractGoogleDriveFileId(u);
  if (fileId) return [...new Set(googleDriveEmbedUrls(fileId))];

  const normalized = normalizeImageUrl(u);
  return [normalized];
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

/** Resolve storage paths to signed HTTPS URLs for img src. */
export function useDisplayImageUrl(input: string | null | undefined): {
  src: string;
  loading: boolean;
} {
  const [src, setSrc] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    const value = (input ?? "").trim();
    if (!value) {
      setSrc("");
      setLoading(false);
      return;
    }

    if (value.startsWith("data:") || value.startsWith("http://") || value.startsWith("https://")) {
      setSrc(value);
      setLoading(false);
      return;
    }

    if (isStoragePath(value)) {
      setLoading(true);
      void getSignedStorageUrl(value).then((signed) => {
        if (cancelled) return;
        setSrc(signed ?? "");
        setLoading(false);
      });
      return;
    }

    setSrc(normalizeImageUrl(value));
    setLoading(false);

    return () => {
      cancelled = true;
    };
  }, [input]);

  return { src, loading };
}
