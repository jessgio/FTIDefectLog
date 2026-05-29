import React from "react";
import { MAX_PHOTOS_PER_DEFECT, readPhotoFiles } from "../defectPhotos";
import { ResolvedImage } from "./ResolvedImage";

type Props = {
  photos: string[];
  onChange: (photos: string[]) => void;
  disabled?: boolean;
};

export function DefectPhotoPicker({ photos, onChange, disabled }: Props): React.ReactElement {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onFiles(files: FileList | null): Promise<void> {
    if (!files?.length || disabled) return;
    setBusy(true);
    setError(null);
    try {
      const remaining = MAX_PHOTOS_PER_DEFECT - photos.length;
      if (remaining <= 0) {
        setError(`Maximum ${MAX_PHOTOS_PER_DEFECT} photos.`);
        return;
      }
      const picked = Array.from(files).slice(0, remaining);
      const dataUrls = await readPhotoFiles(picked);
      onChange([...photos, ...dataUrls]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function removeAt(index: number): void {
    onChange(photos.filter((_, i) => i !== index));
  }

  return (
    <div className="defectPhotoPicker">
      <div className="defectPhotoThumbs">
        {photos.map((src, i) => (
          <div key={`${i}-${src.slice(0, 24)}`} className="defectPhotoThumbWrap">
            <ResolvedImage className="defectPhotoThumb" url={src} />
            {!disabled ? (
              <button
                type="button"
                className="defectPhotoRemove"
                onClick={() => removeAt(i)}
                aria-label="Remove photo"
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
        {photos.length < MAX_PHOTOS_PER_DEFECT && !disabled ? (
          <button
            type="button"
            className="defectPhotoAdd"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? "…" : "+ Photo"}
          </button>
        ) : null}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        multiple
        hidden
        onChange={(e) => void onFiles(e.target.files)}
      />
      {error ? <span className="fieldHint warnHint">{error}</span> : null}
    </div>
  );
}
