import React from "react";

type Props = {
  title: string;
  rows: [string, number][];
  total: number;
  formatValue: (n: number) => string;
  ariaLabel: string;
  emptyHint?: string;
};

export function CategoryMetricBars({
  title,
  rows,
  total,
  formatValue,
  ariaLabel,
  emptyHint,
}: Props): React.ReactElement {
  const denom = total > 0 ? total : 1;

  return (
    <div className="categoryMetricPanel">
      <div className="categoryMetricTitle">{title}</div>
      {rows.length ? (
        <div className="barWrap barWrapCompact" role="img" aria-label={ariaLabel}>
          {rows.map(([label, value]) => {
            const pct = (value / denom) * 100;
            return (
              <div key={label} className="barRow barRowCategoryCompact">
                <div className="barLabel" title={label}>
                  {label}
                </div>
                <div className="bar">
                  <div className="barFill" style={{ width: `${pct}%` }} />
                </div>
                <div className="barValue">{formatValue(value)}</div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="hint categoryMetricEmpty">{emptyHint ?? "No data in current filter."}</p>
      )}
    </div>
  );
}
