import React from "react";
import { fetchSkuList } from "../movements";
import {
  countEntriesWithCategory,
  fetchSkuListFromPublishedCsvWithDiagnostics,
  mergeSkuEntries,
  type SkuCsvFetchAttempt,
} from "../skuListCsv";
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
  categorySource: "api" | "csv" | "none";
  loadError: string | null;
  csvAttempts: SkuCsvFetchAttempt[];
  applyCategoryCsv: (merged: SkuEntry[]) => void;
} {
  const [entries, setEntries] = React.useState<SkuEntry[]>([]);
  const [loading, setLoading] = React.useState(enabled);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [categorySource, setCategorySource] = React.useState<"api" | "csv" | "none">("none");
  const [csvAttempts, setCsvAttempts] = React.useState<SkuCsvFetchAttempt[]>([]);

  React.useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setCategorySource("none");
      return;
    }
    let cancelled = false;
    (async () => {
      let list: SkuEntry[] = [];
      let err: string | null = null;
      try {
        list = await fetchSkuList();
      } catch (e: unknown) {
        err = e instanceof Error ? e.message : String(e);
      }

      const hadApiCategories = skuListHasCategories(list);
      let source: "api" | "csv" | "none" = hadApiCategories ? "api" : "none";

      const { entries: fromCsv, attempts } = await fetchSkuListFromPublishedCsvWithDiagnostics();
      if (!cancelled) setCsvAttempts(attempts);

      if (fromCsv.length) {
        list = mergeSkuEntries(list, fromCsv);
        if (skuListHasCategories(list) && !hadApiCategories) source = "csv";
      }

      if (!skuListHasCategories(list) && !err) {
        const failed = attempts.find((a) => !a.ok);
        const noCat = attempts.find((a) => a.ok && a.withCategory === 0);
        if (failed) err = failed.detail;
        else if (noCat) err = noCat.detail;
        else if (!attempts.length) {
          err =
            "Set VITE_SKU_LIST_CSV_URL on Vercel to your SKUList Publish-to-web CSV link, then redeploy.";
        }
      }

      if (!cancelled) {
        setEntries(list);
        setLoadError(err);
        setCategorySource(source);
      }
    })().finally(() => {
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

  const categoryCount = React.useMemo(() => countEntriesWithCategory(entries), [entries]);

  const applyCategoryCsv = React.useCallback((merged: SkuEntry[]) => {
    setEntries(merged);
    setCategorySource("csv");
    setLoadError(null);
  }, []);

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
    categorySource,
    loadError,
    csvAttempts,
    applyCategoryCsv,
  };
}
