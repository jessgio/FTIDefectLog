export const MAX_PHOTOS_PER_DEFECT = 2;
export const MAX_PHOTO_BYTES = 900_000;

export async function compressImageFile(
  file: File,
  maxWidth = 1200,
  quality = 0.85,
): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Please choose an image file (JPEG, PNG, or WebP).");
  }

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxWidth / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not process image.");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  if (dataUrl.length > MAX_PHOTO_BYTES * 1.37) {
    dataUrl = canvas.toDataURL("image/jpeg", 0.7);
  }
  if (dataUrl.length > MAX_PHOTO_BYTES * 1.37) {
    throw new Error("Image is too large after compression. Use a smaller photo.");
  }
  return dataUrl;
}

export async function readPhotoFiles(files: FileList | File[]): Promise<string[]> {
  const list = Array.from(files).slice(0, MAX_PHOTOS_PER_DEFECT);
  const out: string[] = [];
  for (const file of list) {
    out.push(await compressImageFile(file));
  }
  return out;
}
