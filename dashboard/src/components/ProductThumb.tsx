import React from "react";
import { imageUrlCandidates, isGoogleDriveUrl, productInitials } from "../productImage";

type Props = {
  productName: string;
  imageUrl?: string | null;
  size?: "sm" | "md";
};

export function ProductThumb({
  productName,
  imageUrl,
  size = "sm",
}: Props): React.ReactElement {
  const candidates = React.useMemo(
    () => (imageUrl ? imageUrlCandidates(imageUrl) : []),
    [imageUrl],
  );
  const [candidateIndex, setCandidateIndex] = React.useState(0);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    setCandidateIndex(0);
    setFailed(false);
  }, [imageUrl]);

  const className = `productThumb productThumb--${size}`;
  const src = candidates[candidateIndex] ?? "";

  const failHint =
    imageUrl && failed && isGoogleDriveUrl(imageUrl)
      ? "Google Drive image could not load. Use “Anyone with the link” sharing, or store the file in the same Drive as the spreadsheet."
      : productName;

  if (!src || failed) {
    return (
      <span className={`${className} productThumbPlaceholder`} title={failHint}>
        {productInitials(productName)}
      </span>
    );
  }

  return (
    <img
      className={className}
      src={src}
      alt=""
      title={productName}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => {
        if (candidateIndex + 1 < candidates.length) {
          setCandidateIndex((i) => i + 1);
        } else {
          setFailed(true);
        }
      }}
    />
  );
}
