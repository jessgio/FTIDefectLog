import React from "react";
import { fetchSkuList } from "../movements";
import {
  buildImageByProduct,
  buildSkuByProduct,
  lookupEntryFuzzy,
  lookupImageFuzzy,
  lookupSku,
  type SkuEntry,
} from "../skuList";

export function useSkuLookup(enabled: boolean): {
  entries: SkuEntry[];
  byProduct: Map<string, string>;
  byProductImage: Map<string, string>;
  loading: boolean;
  lookup: (productName: string) => string | undefined;
  lookupEntry: (productName: string, sku?: string) => SkuEntry | undefined;
  lookupImage: (productName: string, sku?: string) => string | undefined;
  imageCount: number;
  loadError: string | null;
} {
  const [entries, setEntries] = React.useState<SkuEntry[]>([]);
  const [loading, setLoading] = React.useState(enabled);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    fetchSkuList()
      .then((list) => {
        if (!cancelled) {
          setEntries(list);
          setLoadError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setEntries([]);
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const byProduct = React.useMemo(() => buildSkuByProduct(entries), [entries]);
  const byProductImage = React.useMemo(() => buildImageByProduct(entries), [entries]);

  const lookup = React.useCallback(
    (productName: string) => lookupSku(byProduct, productName),
    [byProduct],
  );

  const imageCount = React.useMemo(
    () => entries.filter((e) => (e.image_url ?? "").trim()).length,
    [entries],
  );

  const lookupEntryFn = React.useCallback(
    (productName: string, sku?: string) => lookupEntryFuzzy(entries, productName, sku),
    [entries],
  );

  const lookupImageFn = React.useCallback(
    (productName: string, sku?: string) =>
      lookupImageFuzzy(byProductImage, entries, productName, sku),
    [byProductImage, entries],
  );

  return {
    entries,
    byProduct,
    byProductImage,
    loading,
    lookup,
    lookupEntry: lookupEntryFn,
    lookupImage: lookupImageFn,
    imageCount,
    loadError,
  };
}
