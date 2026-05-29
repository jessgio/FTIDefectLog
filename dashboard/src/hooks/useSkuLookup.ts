import React from "react";
import { countEntriesWithBarcode } from "../barcode";
import { fetchProducts } from "../api/movements";
import {
  buildImageByProduct,
  buildSkuByProduct,
  lookupEntryFuzzy,
  lookupImageFuzzy,
  lookupSku,
  skuListHasCategories,
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
  categoryCount: number;
  barcodeCount: number;
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
    (async () => {
      try {
        const list = await fetchProducts();
        if (!cancelled) {
          setEntries(list);
          setLoadError(null);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setEntries([]);
          setLoadError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
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

  const categoryCount = React.useMemo(
    () => entries.filter((e) => (e.product_category ?? "").trim()).length,
    [entries],
  );
  const barcodeCount = React.useMemo(() => countEntriesWithBarcode(entries), [entries]);

  return {
    entries,
    byProduct,
    byProductImage,
    loading,
    lookup,
    lookupEntry: lookupEntryFn,
    lookupImage: lookupImageFn,
    imageCount,
    categoryCount,
    barcodeCount,
    loadError,
  };
}
