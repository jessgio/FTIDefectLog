import React from "react";
import { formatExpiryDisplay } from "../expiry";
import { formatCurrencyIdr, formatInt, valueOrDash } from "../format";
import type { AggregateGroupBy, AggregateRow } from "../aggregate";
import { ProductThumb } from "./ProductThumb";

type AggSortKey =
  | "label"
  | "product_name"
  | "sku"
  | "lot_count"
  | "total_pcs"
  | "earliest_expiry"
  | "expiring_soon_pcs"
  | "total_rsp_value"
  | "total_cogs_value";

type SortDir = "asc" | "desc";

function dashCurrency(v: number | null): string {
  return valueOrDash(v, formatCurrencyIdr);
}

type Props = {
  rows: AggregateRow[];
  groupBy: AggregateGroupBy;
  getProductImage?: (productName: string, sku?: string) => string | undefined;
  onProductClick?: (productName: string) => void;
};

export function AggregateTable({
  rows,
  groupBy,
  getProductImage,
  onProductClick,
}: Props): React.ReactElement {
  const [sort, setSort] = React.useState<{ key: AggSortKey; dir: SortDir }>({
    key: "total_pcs",
    dir: "desc",
  });
  const [filter, setFilter] = React.useState("");

  const sorted = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? rows.filter(
          (r) =>
            r.label.toLowerCase().includes(q) ||
            r.product_name.toLowerCase().includes(q) ||
            (r.sku ?? "").toLowerCase().includes(q),
        )
      : rows;

    const dir = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = a[sort.key as keyof AggregateRow];
      const bv = b[sort.key as keyof AggregateRow];
      if (typeof av === "number" && typeof bv === "number") return dir * (av - bv);
      return dir * String(av ?? "").localeCompare(String(bv ?? ""));
    });
  }, [rows, sort, filter]);

  function toggleSort(key: AggSortKey): void {
    setSort((s) => ({
      key,
      dir: s.key === key && s.dir === "desc" ? "asc" : "desc",
    }));
  }

  function sortMark(key: AggSortKey): string | null {
    if (sort.key !== key) return null;
    return sort.dir === "asc" ? " ▲" : " ▼";
  }

  return (
    <>
      <div className="tableToolbar">
        <input
          className="thFilter tableToolbarSearch"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={groupBy === "sku" ? "Filter SKU or product…" : "Filter product…"}
          aria-label="Filter aggregate rows"
        />
      </div>
      <div className="tableWrap">
        <table className="table tableAggregate">
          <thead>
            <tr>
              <th className="colProductImage" aria-label="Product image" />
              <th>
                <button type="button" className="thButton" onClick={() => toggleSort("label")}>
                  {groupBy === "sku" ? "SKU" : "Product"}
                  {sortMark("label")}
                </button>
              </th>
              {groupBy === "sku" ? (
                <th>
                  <button
                    type="button"
                    className="thButton"
                    onClick={() => toggleSort("product_name")}
                  >
                    Product name
                    {sortMark("product_name")}
                  </button>
                </th>
              ) : (
                <th>
                  <button type="button" className="thButton" onClick={() => toggleSort("sku")}>
                    SKU
                    {sortMark("sku")}
                  </button>
                </th>
              )}
              <th className="num">
                <button type="button" className="thButton thNum" onClick={() => toggleSort("lot_count")}>
                  Lots
                  {sortMark("lot_count")}
                </button>
              </th>
              <th className="num">
                <button type="button" className="thButton thNum" onClick={() => toggleSort("total_pcs")}>
                  Total pcs
                  {sortMark("total_pcs")}
                </button>
              </th>
              <th>
                <button
                  type="button"
                  className="thButton"
                  onClick={() => toggleSort("earliest_expiry")}
                >
                  Earliest expiry
                  {sortMark("earliest_expiry")}
                </button>
              </th>
              <th className="num">
                <button
                  type="button"
                  className="thButton thNum"
                  onClick={() => toggleSort("expiring_soon_pcs")}
                >
                  Pcs &lt; 1 yr
                  {sortMark("expiring_soon_pcs")}
                </button>
              </th>
              <th className="num">
                <button
                  type="button"
                  className="thButton thNum"
                  onClick={() => toggleSort("total_rsp_value")}
                >
                  Value (RSP)
                  {sortMark("total_rsp_value")}
                </button>
              </th>
              <th className="num">
                <button
                  type="button"
                  className="thButton thNum"
                  onClick={() => toggleSort("total_cogs_value")}
                >
                  Value (COGS)
                  {sortMark("total_cogs_value")}
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.group_key}>
                <td className="colProductImage">
                  <ProductThumb
                    productName={r.product_name}
                    imageUrl={getProductImage?.(r.product_name, r.sku)}
                  />
                </td>
                <td>
                  {groupBy === "sku" ? (
                    <span className="mono">{r.label}</span>
                  ) : onProductClick ? (
                    <button
                      type="button"
                      className="productLink"
                      onClick={() => onProductClick(r.product_name)}
                    >
                      {r.label}
                    </button>
                  ) : (
                    r.label
                  )}
                </td>
                <td>
                  {groupBy === "sku" ? (
                    onProductClick ? (
                      <button
                        type="button"
                        className="productLink"
                        onClick={() => onProductClick(r.product_name)}
                      >
                        {r.product_name}
                      </button>
                    ) : (
                      r.product_name
                    )
                  ) : (
                    <span className="mono">{r.sku ?? "—"}</span>
                  )}
                </td>
                <td className="num">{formatInt(r.lot_count)}</td>
                <td className="num">{formatInt(r.total_pcs)}</td>
                <td className="mono">
                  {r.earliest_expiry ? formatExpiryDisplay(r.earliest_expiry) : "—"}
                </td>
                <td className="num">{formatInt(r.expiring_soon_pcs)}</td>
                <td className="num">{dashCurrency(r.total_rsp_value)}</td>
                <td className="num">{dashCurrency(r.total_cogs_value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="tableMeta">
        Showing <span className="mono">{formatInt(sorted.length)}</span>{" "}
        {groupBy === "sku" ? "SKUs" : "products"}
      </div>
    </>
  );
}
