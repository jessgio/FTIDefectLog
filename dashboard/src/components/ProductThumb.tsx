import React from "react";
import { isGoogleDriveUrl, productInitials, useDisplayImageUrl } from "../productImage";

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
  const { src, loading } = useDisplayImageUrl(imageUrl);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    setFailed(false);
  }, [imageUrl, src]);

  const className = `productThumb productThumb--${size}`;

  const failHint =
    imageUrl && failed && isGoogleDriveUrl(imageUrl)
      ? "Image could not load."
      : productName;

  if (!src || failed || loading) {
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
      onError={() => setFailed(true)}
    />
  );
}
