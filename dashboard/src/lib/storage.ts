import { getSupabase, isAllowedEmail } from "./supabase";

export const DEFECT_PHOTOS_BUCKET = "defect-photos";
export const PRODUCT_IMAGES_BUCKET = "product-images";

export function isStoragePath(value: string): boolean {
  const v = value.trim();
  return v.startsWith(`${DEFECT_PHOTOS_BUCKET}/`) || v.startsWith(`${PRODUCT_IMAGES_BUCKET}/`);
}

export function storagePath(bucket: string, objectPath: string): string {
  return `${bucket}/${objectPath.replace(/^\/+/, "")}`;
}

export async function uploadDefectPhoto(
  movementId: string,
  piece: number,
  index: number,
  blob: Blob,
): Promise<string> {
  const supabase = getSupabase();
  const objectPath = `${movementId}/pc${piece}-${index + 1}.jpg`;
  const path = storagePath(DEFECT_PHOTOS_BUCKET, objectPath);

  const { error } = await supabase.storage.from(DEFECT_PHOTOS_BUCKET).upload(objectPath, blob, {
    contentType: blob.type || "image/jpeg",
    upsert: true,
  });
  if (error) throw new Error(error.message);

  return path;
}

export async function getSignedStorageUrl(path: string, expiresIn = 3600): Promise<string | null> {
  const trimmed = path.trim();
  if (!trimmed || !isStoragePath(trimmed)) return null;

  const slash = trimmed.indexOf("/");
  if (slash <= 0) return null;

  const bucket = trimmed.slice(0, slash);
  const objectPath = trimmed.slice(slash + 1);
  const supabase = getSupabase();

  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(objectPath, expiresIn);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

export async function resolvePhotoDisplayUrl(pathOrUrl: string): Promise<string> {
  const value = pathOrUrl.trim();
  if (!value) return "";
  if (value.startsWith("data:") || value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }
  const signed = await getSignedStorageUrl(value);
  return signed ?? value;
}

export async function uploadPhotosForDefectLines(
  movementId: string,
  lines: { piece: number; defect_reason: string; photo_urls?: string[] }[],
): Promise<{ piece: number; defect_reason: string; photo_urls?: string[] }[]> {
  const out: { piece: number; defect_reason: string; photo_urls?: string[] }[] = [];

  for (const line of lines) {
    const photos = line.photo_urls ?? [];
    const uploaded: string[] = [];

    for (let i = 0; i < photos.length && i < 2; i++) {
      const photo = photos[i]?.trim();
      if (!photo) continue;

      if (isStoragePath(photo) || photo.startsWith("http")) {
        uploaded.push(photo);
        continue;
      }

      if (photo.startsWith("data:")) {
        const blob = await dataUrlToBlob(photo);
        uploaded.push(await uploadDefectPhoto(movementId, line.piece, i, blob));
      }
    }

    out.push({
      piece: line.piece,
      defect_reason: line.defect_reason,
      ...(uploaded.length ? { photo_urls: uploaded } : {}),
    });
  }

  return out;
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}

export function assertAuthenticatedEmail(email: string | undefined): void {
  if (!isAllowedEmail(email)) {
    const domain = import.meta.env.VITE_ALLOWED_EMAIL_DOMAIN as string | undefined;
    throw new Error(
      domain
        ? `Sign-in blocked: use a @${domain} Google account.`
        : "Sign-in blocked: email domain is not allowed.",
    );
  }
}
