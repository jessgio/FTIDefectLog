import React from "react";
import { formatInt } from "../format";
import type { DefectTypeRow } from "../defectAggregate";
import { ProductThumb } from "./ProductThumb";

type Props = {
  rows: DefectTypeRow[];
  getProductImage?: (productName: string, sku?: string) => string | undefined;
  onProductClick?: (productName: string) => void;
};

export function DefectTypeTable({
  rows,
  getProductImage,
  onProductClick,
}: Props): React.ReactElement {
  const [filter, setFilter] = React.useState("");
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const filtered = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.defect_reason.toLowerCase().includes(q) ||
        r.products.some(
          (p) =>
            p.product_name.toLowerCase().includes(q) ||
            (p.sku ?? "").toLowerCase().includes(q),
        ),
    );
  }, [rows, filter]);

  function toggleExpanded(defectReason: string): void {
    setExpanded((cur) => (cur === defectReason ? null : defectReason));
  }

  return (
    <>
      <div className="tableToolbar">
        <input
          className="thFilter tableToolbarSearch"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter defect type or product…"
          aria-label="Filter defect type rows"
        />
      </div>
      <div className="tableWrap">
        <table className="table tableDefectType">
          <thead>
            <tr>
              <th className="defectExpandCol" aria-label="Expand" />
              <th>Defect type</th>
              <th className="num">Products</th>
              <th className="num">Lots</th>
              <th className="num">Total pcs</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const isOpen = expanded === r.defect_reason;
              return (
                <React.Fragment key={r.defect_reason}>
                  <tr
                    className={isOpen ? "defectTypeRow defectTypeRow--open" : "defectTypeRow"}
                  >
                    <td className="defectExpandCol">
                      <button
                        type="button"
                        className="defectExpandBtn"
                        aria-expanded={isOpen}
                        aria-label={`${isOpen ? "Collapse" : "Expand"} ${r.defect_reason}`}
                        onClick={() => toggleExpanded(r.defect_reason)}
                      >
                        {isOpen ? "▼" : "▶"}
                      </button>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="defectTypeLink"
                        onClick={() => toggleExpanded(r.defect_reason)}
                      >
                        {r.defect_reason}
                      </button>
                    </td>
                    <td className="num">{formatInt(r.product_count)}</td>
                    <td className="num">{formatInt(r.lot_count)}</td>
                    <td className="num">{formatInt(r.total_pcs)}</td>
                  </tr>
                  {isOpen
                    ? r.products.map((p) => (
                        <tr
                          key={`${r.defect_reason}-${p.product_name}`}
                          className="defectProductSubrow"
                        >
                          <td className="defectExpandCol" />
                          <td colSpan={4}>
                            <div className="defectProductSubcell">
                              <ProductThumb
                                productName={p.product_name}
                                imageUrl={getProductImage?.(p.product_name, p.sku)}
                              />
                              <div className="defectProductSubmeta">
                                {onProductClick ? (
                                  <button
                                    type="button"
                                    className="productLink"
                                    onClick={() => onProductClick(p.product_name)}
                                  >
                                    {p.product_name}
                                  </button>
                                ) : (
                                  <span>{p.product_name}</span>
                                )}
                                <span className="mono defectProductSku">
                                  {p.sku ?? "—"}
                                </span>
                              </div>
                              <div className="defectProductSubqty">
                                <span className="defectProductSubqtyLabel">Qty</span>
                                <span className="num">{formatInt(p.total_pcs)}</span>
                                <span className="hint defectProductSublots">
                                  {formatInt(p.lot_count)} lot{p.lot_count === 1 ? "" : "s"}
                                </span>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ))
                    : null}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="tableMeta">
        Showing <span className="mono">{formatInt(filtered.length)}</span> defect types
        {expanded ? (
          <span className="hint">
            {" "}
            · expanded: <span className="mono">{expanded}</span>
          </span>
        ) : (
          <span className="hint"> · click a row to see products and quantities</span>
        )}
      </div>
    </>
  );
}
