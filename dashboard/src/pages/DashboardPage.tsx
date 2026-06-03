import React from "react";
import { aggregateRows, type AggregateGroupBy } from "../aggregate";
import { aggregateByDefectType, computePcsByDefectReason } from "../defectAggregate";
import { AggregateTable } from "../components/AggregateTable";
import { DefectTypeTable } from "../components/DefectTypeTable";
import { compareExpiryAsc, formatExpiryDisplay } from "../expiry";
import { formatCurrencyIdr, formatInt, valueOrDash } from "../format";
import { computeMetrics } from "../metrics";
import { CategoryMetricBars } from "../components/CategoryMetricBars";
import { computeCogsByCategory, computePcsByCategory, skuListHasCategories } from "../skuList";
import { ProductThumb } from "../components/ProductThumb";
import { useSkuLookup } from "../hooks/useSkuLookup";
import { ProductDetailModal } from "../components/ProductDetailModal";
import { fetchInventoryLots } from "../inventory";
import { listMovements } from "../movements";
import { dashboardCopy } from "../copy/dashboard";
import type { MovementRecord, RejectRow } from "../types";

type TableView = "lot" | "product" | "sku" | "defect";

function dashCurrency(v: number | null): string {
  return valueOrDash(v, formatCurrencyIdr);
}

function sortByExpiryAsc(a: RejectRow, b: RejectRow): number {
  return compareExpiryAsc(a.expiry_date, b.expiry_date);
}

type SortKey =
  | "product_name"
  | "sku"
  | "defect_reason"
  | "batch_code"
  | "expiry_date"
  | "quantity_pcs"
  | "rsp_per_unit"
  | "cogs_per_unit";

type SortDir = "asc" | "desc";

function compareNullableString(a?: string, b?: string): number {
  const aa = (a ?? "").toLowerCase();
  const bb = (b ?? "").toLowerCase();
  return aa.localeCompare(bb);
}

function compareNullableNumber(a?: number, b?: number): number {
  const aa = typeof a === "number" && Number.isFinite(a) ? a : Number.NEGATIVE_INFINITY;
  const bb = typeof b === "number" && Number.isFinite(b) ? b : Number.NEGATIVE_INFINITY;
  return aa - bb;
}

function getCellValue(r: RejectRow, key: SortKey): string | number | undefined {
  switch (key) {
    case "product_name":
      return r.product_name;
    case "sku":
      return r.sku;
    case "defect_reason":
      return r.defect_reason;
    case "batch_code":
      return r.batch_code;
    case "expiry_date":
      return r.expiry_date;
    case "quantity_pcs":
      return r.quantity_pcs;
    case "rsp_per_unit":
      return r.rsp_per_unit;
    case "cogs_per_unit":
      return r.cogs_per_unit;
    default:
      return undefined;
  }
}

function matchesTextFilter(value: unknown, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  if (value == null) return false;
  return String(value).toLowerCase().includes(q);
}

export function DashboardPage(): React.ReactElement {
  const [rows, setRows] = React.useState<RejectRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<{ key: SortKey; dir: SortDir }>({
    key: "expiry_date",
    dir: "asc",
  });
  const [filters, setFilters] = React.useState<Partial<Record<SortKey, string>>>({});
  const [tableView, setTableView] = React.useState<TableView>("lot");
  const skuLookup = useSkuLookup(true);
  const [movements, setMovements] = React.useState<MovementRecord[]>([]);
  const [detailProduct, setDetailProduct] = React.useState<string | null>(null);

  const getProductImage = React.useCallback(
    (productName: string, rowImage?: string, sku?: string) =>
      skuLookup.lookupImage(productName, sku) ?? rowImage,
    [skuLookup],
  );

  React.useEffect(() => {
    let cancelled = false;
    fetchInventoryLots()
      .then((r) => {
        if (cancelled) return;
        setRows(r.sort(sortByExpiryAsc));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    listMovements()
      .then((data) => {
        if (!cancelled) setMovements(data);
      })
      .catch(() => {
        if (!cancelled) setMovements([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function openProductDetail(productName: string): void {
    setDetailProduct(productName);
  }

  const detailSku = React.useMemo(() => {
    if (!detailProduct) return undefined;
    return skuLookup.lookup(detailProduct);
  }, [detailProduct, skuLookup]);

  const filtered = React.useMemo(() => {
    if (!rows) return null;
    const q = query.trim().toLowerCase();
    const searched = !q
      ? rows
      : rows.filter((r) => {
          return (
            r.product_name.toLowerCase().includes(q) ||
            (r.sku ?? "").toLowerCase().includes(q) ||
            (r.batch_code ?? "").toLowerCase().includes(q) ||
            (r.defect_reason ?? "").toLowerCase().includes(q)
          );
        });

    const withColumnFilters = searched.filter((r) => {
      // Text filters
      if (!matchesTextFilter(r.product_name, filters.product_name ?? "")) return false;
      if (!matchesTextFilter(r.sku ?? "", filters.sku ?? "")) return false;
      if (!matchesTextFilter(r.defect_reason ?? "", filters.defect_reason ?? "")) return false;
      if (!matchesTextFilter(r.batch_code, filters.batch_code ?? "")) return false;
      if (!matchesTextFilter(r.expiry_date, filters.expiry_date ?? "")) return false;

      // Numeric ">= X" filters (treat empty as pass)
      const qtyMin = Number((filters.quantity_pcs ?? "").trim());
      if ((filters.quantity_pcs ?? "").trim() && Number.isFinite(qtyMin)) {
        if (r.quantity_pcs < qtyMin) return false;
      }
      const rspMin = Number((filters.rsp_per_unit ?? "").trim());
      if ((filters.rsp_per_unit ?? "").trim() && Number.isFinite(rspMin)) {
        const v = r.rsp_per_unit;
        if (typeof v !== "number" || !Number.isFinite(v) || v < rspMin) return false;
      }
      const cogsMin = Number((filters.cogs_per_unit ?? "").trim());
      if ((filters.cogs_per_unit ?? "").trim() && Number.isFinite(cogsMin)) {
        const v = r.cogs_per_unit;
        if (typeof v !== "number" || !Number.isFinite(v) || v < cogsMin) return false;
      }

      return true;
    });

    const dirMul = sort.dir === "asc" ? 1 : -1;
    const sorted = [...withColumnFilters].sort((a, b) => {
      const av = getCellValue(a, sort.key);
      const bv = getCellValue(b, sort.key);
      if (sort.key === "quantity_pcs") return dirMul * (Number(av) - Number(bv));
      if (sort.key === "expiry_date") return dirMul * compareExpiryAsc(String(av), String(bv));
      if (sort.key === "rsp_per_unit" || sort.key === "cogs_per_unit") {
        return dirMul * compareNullableNumber(av as number | undefined, bv as number | undefined);
      }
      return dirMul * compareNullableString(av as string | undefined, bv as string | undefined);
    });

    return sorted;
  }, [rows, query, filters, sort]);
  

  const metrics = React.useMemo(() => {
    return filtered ? computeMetrics(filtered) : null;
  }, [filtered]);

  const pcsByCategory = React.useMemo(() => {
    if (!filtered) return null;
    return computePcsByCategory(filtered, skuLookup.entries);
  }, [filtered, skuLookup.entries]);

  const categoryRowsPcs = React.useMemo(() => {
    if (!pcsByCategory || !metrics) return [];
    return Object.entries(pcsByCategory).sort(([, a], [, b]) => b - a);
  }, [pcsByCategory, metrics]);

  const cogsByCategory = React.useMemo(() => {
    if (!filtered) return null;
    return computeCogsByCategory(filtered, skuLookup.entries);
  }, [filtered, skuLookup.entries]);

  const categoryRowsCogs = React.useMemo(() => {
    if (!cogsByCategory) return [];
    return Object.entries(cogsByCategory).sort(([, a], [, b]) => b - a);
  }, [cogsByCategory]);

  const totalCategoryCogs = React.useMemo(
    () => categoryRowsCogs.reduce((sum, [, v]) => sum + v, 0),
    [categoryRowsCogs],
  );

  const pcsByDefectReason = React.useMemo(() => {
    if (!filtered) return null;
    return computePcsByDefectReason(filtered);
  }, [filtered]);

  const defectTypeRows = React.useMemo(() => {
    if (!pcsByDefectReason) return [];
    return Object.entries(pcsByDefectReason).sort(([, a], [, b]) => b - a);
  }, [pcsByDefectReason]);

  const aggregateGroupBy: AggregateGroupBy | null =
    tableView === "product" ? "product_name" : tableView === "sku" ? "sku" : null;

  const aggregated = React.useMemo(() => {
    if (!filtered || !aggregateGroupBy) return null;
    return aggregateRows(filtered, aggregateGroupBy);
  }, [filtered, aggregateGroupBy]);

  const byDefectType = React.useMemo(() => {
    if (!filtered) return null;
    return aggregateByDefectType(filtered);
  }, [filtered]);

  return (
    <>
      <header className="header">
        <div>
          <div className="title">FTI Defective Stock</div>
          <div className="subtitle">{dashboardCopy.subtitle}</div>
        </div>
        <div className="right">
          <input
            className="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search product / SKU / batch / reason"
            aria-label="Search"
          />
        </div>
      </header>

      {error ? (
        <div className="card error">
          <div className="cardTitle">Could not load inventory</div>
          <div className="mono">{error}</div>
          <div className="hint">{dashboardCopy.loadErrorHint}</div>
        </div>
      ) : null}

      {!metrics ? (
        !error ? (
          <div aria-busy="true" aria-label="Loading dashboard">
            <section className="grid">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="card">
                  <div className="skeleton skeletonLine skeletonSm" />
                  <div className="skeleton skeletonLine skeletonLg" />
                  <div className="skeleton skeletonLine skeletonMd" />
                </div>
              ))}
            </section>
            <section className="card">
              <div className="skeleton skeletonLine skeletonSm" />
              <div className="barWrap">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="skeleton skeletonBar" />
                ))}
              </div>
            </section>
            <section className="card">
              <div className="skeleton skeletonLine skeletonSm" />
              <div className="skeleton skeletonTable" />
            </section>
          </div>
        ) : null
      ) : (
        <>
          <section className="grid">
            <div className="card">
              <div className="cardTitle">Total pcs</div>
              <div className="big">{formatInt(metrics.totalPcs)}</div>
              <div className="hint">
                {formatInt(metrics.totalLots)} lots •{" "}
                {formatInt(metrics.totalDistinctProducts)} products
              </div>
            </div>
            <div className="card">
              <div className="cardTitle">Expiring &lt; 1 year</div>
              <div className="big">
                {formatInt(metrics.expiringInLessThan365DaysPcs)}
              </div>
              <div className="hint">
                {formatInt(metrics.expiringInLessThan365DaysLots)} lots
              </div>
            </div>
            <div className="card">
              <div className="cardTitle">Total value (RSP)</div>
              <div className="big">{dashCurrency(metrics.totalRspValue)}</div>
              <div className="hint">Auto if `rsp_per_unit` is filled</div>
            </div>
            <div className="card">
              <div className="cardTitle">Total value (COGS)</div>
              <div className="big">{dashCurrency(metrics.totalCogsValue)}</div>
              <div className="hint">Auto if `cogs_per_unit` is filled</div>
            </div>
          </section>

          <section className="card defectMetricsCard">
            <div className="cardTitle">By defect type</div>
            {defectTypeRows.length ? (
              <CategoryMetricBars
                title="Quantity (pcs)"
                rows={defectTypeRows}
                total={metrics.totalPcs}
                formatValue={formatInt}
                ariaLabel="Defective stock quantity by defect type"
              />
            ) : (
              <p className="hint">No defective stock in the current filter.</p>
            )}
            {defectTypeRows.length > 0 ? (
              <div className="hint">
                {formatInt(defectTypeRows.length)} defect type
                {defectTypeRows.length === 1 ? "" : "s"} · use{" "}
                <span className="mono">By defect type</span> below to see products per type
              </div>
            ) : null}
          </section>

          <section className="card">
            <div className="cardTitle">Expiry distribution (pcs)</div>
            <div className="barWrap" role="img" aria-label="Expiry year bars">
              {Object.entries(metrics.pcsByExpiryYear)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([year, pcs]) => {
                  const pct = metrics.totalPcs ? (pcs / metrics.totalPcs) * 100 : 0;
                  return (
                    <div key={year} className="barRow">
                      <div className="barLabel">{year}</div>
                      <div className="bar">
                        <div className="barFill" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="barValue">{formatInt(pcs)}</div>
                    </div>
                  );
                })}
            </div>
          </section>

          <section className="card categoryMetricsCard">
            <div className="cardTitle">By category</div>
            {skuLookup.loading ? (
              <p className="hint">Loading product categories…</p>
            ) : !skuListHasCategories(skuLookup.entries) ? (
              <p className="hint">
                No product categories in the catalog yet. Add{" "}
                <span className="mono">product_category</span> on rows in the{" "}
                <span className="mono">products</span> table.
              </p>
            ) : categoryRowsPcs.length ? (
              <div className="categoryMetricsGrid">
                <CategoryMetricBars
                  title="Quantity (pcs)"
                  rows={categoryRowsPcs}
                  total={metrics.totalPcs}
                  formatValue={formatInt}
                  ariaLabel="Defective stock quantity by product category"
                />
                <CategoryMetricBars
                  title="Value (COGS)"
                  rows={categoryRowsCogs}
                  total={totalCategoryCogs}
                  formatValue={formatCurrencyIdr}
                  ariaLabel="Defective stock COGS value by product category"
                  emptyHint={dashboardCopy.cogsEmptyHint}
                />
              </div>
            ) : (
              <p className="hint">No defective stock in the current filter.</p>
            )}
            {skuListHasCategories(skuLookup.entries) && categoryRowsPcs.length > 0 ? (
              <div className="hint">
                From product catalog · {skuLookup.categoryCount} SKUs · unmapped → Uncategorized
              </div>
            ) : null}
          </section>

          <section className="card">
            <div className="tableSectionHead">
              <div className="cardTitle">
                {tableView === "lot"
                  ? "Reject lots (by batch)"
                  : tableView === "product"
                    ? "Aggregate by product"
                    : tableView === "sku"
                      ? "Aggregate by SKU"
                      : "By defect type"}
              </div>
              <div className="directionToggle viewToggle" role="group" aria-label="Table view">
                <button
                  type="button"
                  className={tableView === "lot" ? "dirBtn active" : "dirBtn"}
                  onClick={() => setTableView("lot")}
                >
                  By batch
                </button>
                <button
                  type="button"
                  className={tableView === "product" ? "dirBtn active" : "dirBtn"}
                  onClick={() => setTableView("product")}
                >
                  By product
                </button>
                <button
                  type="button"
                  className={tableView === "sku" ? "dirBtn active" : "dirBtn"}
                  onClick={() => setTableView("sku")}
                >
                  By SKU
                </button>
                <button
                  type="button"
                  className={tableView === "defect" ? "dirBtn active" : "dirBtn"}
                  onClick={() => setTableView("defect")}
                >
                  By defect type
                </button>
              </div>
            </div>

            {byDefectType && tableView === "defect" ? (
              <DefectTypeTable
                rows={byDefectType}
                getProductImage={(name, sku) => getProductImage(name, undefined, sku)}
                onProductClick={openProductDetail}
              />
            ) : aggregated && aggregateGroupBy ? (
              <AggregateTable
                rows={aggregated}
                groupBy={aggregateGroupBy}
                getProductImage={(name, sku) => getProductImage(name, undefined, sku)}
                onProductClick={openProductDetail}
              />
            ) : (
            <>
            <div className="tableWrap tableWrap--stickyCols">
              <table className="table">
                <thead>
                  <tr>
                    <th
                      className="colProductImage colStickyImage"
                      aria-label="Product image"
                    />
                    <th>
                      <button
                        type="button"
                        className="thButton"
                        onClick={() =>
                          setSort((s) => ({
                            key: "product_name",
                            dir: s.key === "product_name" && s.dir === "asc" ? "desc" : "asc",
                          }))
                        }
                      >
                        Product
                        {sort.key === "product_name" ? (sort.dir === "asc" ? " ▲" : " ▼") : null}
                      </button>
                    </th>
                    <th>
                      <button
                        type="button"
                        className="thButton"
                        onClick={() =>
                          setSort((s) => ({
                            key: "sku",
                            dir: s.key === "sku" && s.dir === "asc" ? "desc" : "asc",
                          }))
                        }
                      >
                        SKU{sort.key === "sku" ? (sort.dir === "asc" ? " ▲" : " ▼") : null}
                      </button>
                    </th>
                    <th>
                      <button
                        type="button"
                        className="thButton"
                        onClick={() =>
                          setSort((s) => ({
                            key: "defect_reason",
                            dir: s.key === "defect_reason" && s.dir === "asc" ? "desc" : "asc",
                          }))
                        }
                      >
                        Reason
                        {sort.key === "defect_reason" ? (sort.dir === "asc" ? " ▲" : " ▼") : null}
                      </button>
                    </th>
                    <th>
                      <button
                        type="button"
                        className="thButton"
                        onClick={() =>
                          setSort((s) => ({
                            key: "batch_code",
                            dir: s.key === "batch_code" && s.dir === "asc" ? "desc" : "asc",
                          }))
                        }
                      >
                        Batch
                        {sort.key === "batch_code" ? (sort.dir === "asc" ? " ▲" : " ▼") : null}
                      </button>
                    </th>
                    <th>
                      <button
                        type="button"
                        className="thButton"
                        onClick={() =>
                          setSort((s) => ({
                            key: "expiry_date",
                            dir: s.key === "expiry_date" && s.dir === "asc" ? "desc" : "asc",
                          }))
                        }
                      >
                        Expiry
                        {sort.key === "expiry_date" ? (sort.dir === "asc" ? " ▲" : " ▼") : null}
                      </button>
                    </th>
                    <th className="num">
                      <button
                        type="button"
                        className="thButton thNum"
                        onClick={() =>
                          setSort((s) => ({
                            key: "quantity_pcs",
                            dir: s.key === "quantity_pcs" && s.dir === "asc" ? "desc" : "asc",
                          }))
                        }
                      >
                        Qty
                        {sort.key === "quantity_pcs" ? (sort.dir === "asc" ? " ▲" : " ▼") : null}
                      </button>
                    </th>
                    <th className="num">
                      <button
                        type="button"
                        className="thButton thNum"
                        onClick={() =>
                          setSort((s) => ({
                            key: "rsp_per_unit",
                            dir: s.key === "rsp_per_unit" && s.dir === "asc" ? "desc" : "asc",
                          }))
                        }
                      >
                        RSP
                        {sort.key === "rsp_per_unit" ? (sort.dir === "asc" ? " ▲" : " ▼") : null}
                      </button>
                    </th>
                    <th className="num">
                      <button
                        type="button"
                        className="thButton thNum"
                        onClick={() =>
                          setSort((s) => ({
                            key: "cogs_per_unit",
                            dir: s.key === "cogs_per_unit" && s.dir === "asc" ? "desc" : "asc",
                          }))
                        }
                      >
                        COGS
                        {sort.key === "cogs_per_unit" ? (sort.dir === "asc" ? " ▲" : " ▼") : null}
                      </button>
                    </th>
                  </tr>
                  <tr>
                    <th className="colProductImage colStickyImage" />
                    <th>
                      <input
                        className="thFilter"
                        value={filters.product_name ?? ""}
                        onChange={(e) => setFilters((f) => ({ ...f, product_name: e.target.value }))}
                        placeholder="Filter…"
                        aria-label="Filter product"
                      />
                    </th>
                    <th>
                      <input
                        className="thFilter mono"
                        value={filters.sku ?? ""}
                        onChange={(e) => setFilters((f) => ({ ...f, sku: e.target.value }))}
                        placeholder="Filter…"
                        aria-label="Filter SKU"
                      />
                    </th>
                    <th>
                      <input
                        className="thFilter"
                        value={filters.defect_reason ?? ""}
                        onChange={(e) =>
                          setFilters((f) => ({ ...f, defect_reason: e.target.value }))
                        }
                        placeholder="Filter…"
                        aria-label="Filter reason"
                      />
                    </th>
                    <th>
                      <input
                        className="thFilter mono"
                        value={filters.batch_code ?? ""}
                        onChange={(e) => setFilters((f) => ({ ...f, batch_code: e.target.value }))}
                        placeholder="Filter…"
                        aria-label="Filter batch"
                      />
                    </th>
                    <th>
                      <input
                        className="thFilter mono"
                        value={filters.expiry_date ?? ""}
                        onChange={(e) => setFilters((f) => ({ ...f, expiry_date: e.target.value }))}
                        placeholder="YYYY or YYYY-MM"
                        aria-label="Filter expiry"
                      />
                    </th>
                    <th className="num">
                      <input
                        className="thFilter thFilterNum"
                        value={filters.quantity_pcs ?? ""}
                        onChange={(e) =>
                          setFilters((f) => ({ ...f, quantity_pcs: e.target.value }))
                        }
                        placeholder=">= e.g. 10"
                        aria-label="Filter quantity"
                      />
                    </th>
                    <th className="num">
                      <input
                        className="thFilter thFilterNum"
                        value={filters.rsp_per_unit ?? ""}
                        onChange={(e) =>
                          setFilters((f) => ({ ...f, rsp_per_unit: e.target.value }))
                        }
                        placeholder=">= e.g. 100000"
                        aria-label="Filter RSP"
                      />
                    </th>
                    <th className="num">
                      <input
                        className="thFilter thFilterNum"
                        value={filters.cogs_per_unit ?? ""}
                        onChange={(e) =>
                          setFilters((f) => ({ ...f, cogs_per_unit: e.target.value }))
                        }
                        placeholder=">= e.g. 50000"
                        aria-label="Filter COGS"
                      />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered?.map((r, idx) => (
                    <tr key={`${r.product_name}-${r.batch_code}-${r.expiry_date}-${idx}`}>
                      <td className="colProductImage colStickyImage">
                        <ProductThumb
                          productName={r.product_name}
                          imageUrl={getProductImage(r.product_name, r.image_url, r.sku)}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="productLink"
                          onClick={() => openProductDetail(r.product_name)}
                        >
                          {r.product_name}
                        </button>
                      </td>
                      <td className="mono">{r.sku ?? "—"}</td>
                      <td>{r.defect_reason ?? "—"}</td>
                      <td className="mono">{r.batch_code}</td>
                      <td className="mono">{formatExpiryDisplay(r.expiry_date)}</td>
                      <td className="num">{formatInt(r.quantity_pcs)}</td>
                      <td className="num">
                        {typeof r.rsp_per_unit === "number"
                          ? formatCurrencyIdr(r.rsp_per_unit)
                          : "—"}
                      </td>
                      <td className="num">
                        {typeof r.cogs_per_unit === "number"
                          ? formatCurrencyIdr(r.cogs_per_unit)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="tableMeta">
              Showing <span className="mono">{formatInt(filtered?.length ?? 0)}</span> lots
              {skuLookup.loadError ? (
                <span className="hint warnHint"> · Product catalog unavailable: {skuLookup.loadError}</span>
              ) : skuLookup.imageCount > 0 ? (
                <span className="hint">
                  {" "}
                  · <span className="mono">{skuLookup.imageCount}</span> product photos in catalog
                </span>
              ) : !skuLookup.loading ? (
                <span className="hint"> · No product images in catalog yet</span>
              ) : null}
              <button
                type="button"
                className="linkButton"
                onClick={() => setFilters({})}
                disabled={!Object.values(filters).some((v) => (v ?? "").trim().length)}
              >
                Clear filters
              </button>
            </div>
            </>
            )}
          </section>
        </>
      )}

      {detailProduct && rows ? (
        <ProductDetailModal
          productName={detailProduct}
          lots={rows}
          movements={movements}
          productImageUrl={getProductImage(detailProduct, undefined, detailSku)}
          sku={detailSku}
          onClose={() => setDetailProduct(null)}
        />
      ) : null}

      <footer className="footer">
        <div>{dashboardCopy.footer}</div>
      </footer>
    </>
  );
}

