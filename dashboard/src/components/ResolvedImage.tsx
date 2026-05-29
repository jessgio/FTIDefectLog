import React from "react";
import { useDisplayImageUrl } from "../productImage";

export function ResolvedImage({
  url,
  className,
  alt = "",
}: {
  url: string;
  className?: string;
  alt?: string;
}): React.ReactElement {
  const { src, loading } = useDisplayImageUrl(url);

  if (!src || loading) {
    return <span className={`${className ?? ""} productThumbPlaceholder`} aria-hidden="true" />;
  }

  return (
    <img className={className} src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" />
  );
}
