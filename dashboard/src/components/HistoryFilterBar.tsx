import React from "react";
import {
  countExtraHistoryFilters,
  dateRangePreset,
  isDateRangeInverted,
  matchingDatePreset,
  mergeSelectedSkus,
  type DateRangePresetId,
  type MovementHistoryFilters,
  type SkuOption,
} from "../historyFilters";

const PRESETS: { id: DateRangePresetId; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7", label: "Last 7 days" },
  { id: "30", label: "Last 30 days" },
  { id: "month", label: "This month" },
];

type Props = {
  filters: MovementHistoryFilters;
  onChange: (next: MovementHistoryFilters) => void;
  skuOptions: SkuOption[];
  defectTypes: string[];
  dispositions: string[];
  sourceTypes: string[];
};

function withCurrent(options: string[], current: string): string[] {
  const value = current.trim();
  if (!value || options.some((option) => option.toLowerCase() === value.toLowerCase())) {
    return options;
  }
  return [value, ...options];
}

export function HistoryFilterBar({
  filters,
  onChange,
  skuOptions,
  defectTypes,
  dispositions,
  sourceTypes,
}: Props): React.ReactElement {
  const [skuQuery, setSkuQuery] = React.useState("");
  const [skuOpen, setSkuOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const [moreOpen, setMoreOpen] = React.useState(() => countExtraHistoryFilters(filters) > 0);
  const skuWrapRef = React.useRef<HTMLDivElement>(null);
  const listId = React.useId();
  const extraCount = countExtraHistoryFilters(filters);
  const activePreset = matchingDatePreset(filters);
  const inverted = isDateRangeInverted(filters);

  function patch(partial: Partial<MovementHistoryFilters>): void {
    onChange({ ...filters, ...partial });
  }

  const suggestions = React.useMemo(() => {
    const q = skuQuery.trim().toLowerCase();
    const selected = new Set(filters.skus.map((sku) => sku.trim().toLowerCase()));
    return skuOptions
      .filter((option) => {
        if (selected.has(option.sku.toLowerCase())) return false;
        if (!q) return true;
        return (
          option.sku.toLowerCase().includes(q) || option.productName.toLowerCase().includes(q)
        );
      })
      .slice(0, 8);
  }, [filters.skus, skuOptions, skuQuery]);

  const showSkuList = skuOpen && (suggestions.length > 0 || skuQuery.trim().length > 0);

  React.useEffect(() => {
    function onDocClick(event: MouseEvent): void {
      if (!skuWrapRef.current?.contains(event.target as Node)) setSkuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  React.useEffect(() => {
    setActiveIndex(-1);
  }, [skuQuery, suggestions.length]);

  function addSkus(raw: string): void {
    const parts = raw.split(/[,;\n]+/u);
    const next = mergeSelectedSkus(filters.skus, parts, skuOptions);
    if (next.length !== filters.skus.length) patch({ skus: next });
    setSkuQuery("");
    setSkuOpen(false);
  }

  function removeSku(sku: string): void {
    patch({ skus: filters.skus.filter((selected) => selected !== sku) });
  }

  function onSkuKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSkuOpen(true);
      setActiveIndex((index) => Math.min(index + 1, Math.max(suggestions.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Escape") {
      setSkuOpen(false);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (activeIndex >= 0 && suggestions[activeIndex]) {
        addSkus(suggestions[activeIndex].sku);
        return;
      }
      const typed = skuQuery.trim();
      if (!typed) return;
      const exact = suggestions.find((option) => option.sku.toLowerCase() === typed.toLowerCase());
      if (exact) {
        addSkus(exact.sku);
        return;
      }
      if (suggestions.length === 1) {
        addSkus(suggestions[0].sku);
        return;
      }
      addSkus(typed);
    }
  }

  const defectOptions = withCurrent(defectTypes, filters.defectType);
  const dispositionOptions = withCurrent(dispositions, filters.disposition);
  const sourceOptions = withCurrent(sourceTypes, filters.sourceType);

  return (
    <section className="card historyFilters">
      <div className="tableSectionHead">
        <div className="cardTitle">Filters</div>
      </div>

      <div className="historyPresetRow" role="group" aria-label="Date presets">
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={activePreset === preset.id ? "dirBtn active" : "dirBtn"}
            aria-pressed={activePreset === preset.id}
            onClick={() => patch(dateRangePreset(preset.id))}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="historyFilterGrid">
        <label className="field">
          <span className="fieldLabel">From</span>
          <input
            className="fieldInput"
            type="date"
            value={filters.dateFrom}
            max={filters.dateTo || undefined}
            onChange={(event) => patch({ dateFrom: event.target.value })}
          />
        </label>
        <label className="field">
          <span className="fieldLabel">To</span>
          <input
            className="fieldInput"
            type="date"
            value={filters.dateTo}
            min={filters.dateFrom || undefined}
            onChange={(event) => patch({ dateTo: event.target.value })}
          />
        </label>
        <div className="field">
          <span className="fieldLabel">Type</span>
          <div className="directionToggle directionToggle--field" role="radiogroup" aria-label="Movement type">
            {(
              [
                ["", "All"],
                ["inbound", "Inbound"],
                ["outbound", "Outbound"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={label}
                type="button"
                className={filters.direction === value ? "dirBtn active" : "dirBtn"}
                aria-pressed={filters.direction === value}
                onClick={() => patch({ direction: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span className="fieldLabel">Defect type</span>
          <select
            className="fieldInput"
            value={filters.defectType}
            onChange={(event) => patch({ defectType: event.target.value })}
          >
            <option value="">All defect types</option>
            {defectOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="fieldLabel">Batch</span>
          <input
            className="fieldInput mono"
            value={filters.batch}
            onChange={(event) => patch({ batch: event.target.value })}
            placeholder="Contains…"
            aria-label="Filter batch"
          />
        </label>
        <label className="field">
          <span className="fieldLabel">Search</span>
          <input
            className="fieldInput"
            value={filters.query}
            onChange={(event) => patch({ query: event.target.value })}
            placeholder="Product, notes, person…"
            aria-label="Search history"
          />
        </label>
        <div className="field historyFilterSpan2">
          <span className="fieldLabel">SKUs</span>
          <div className="productPicker" ref={skuWrapRef}>
            <input
              className="fieldInput mono"
              value={skuQuery}
              placeholder={filters.skus.length ? "Add another SKU…" : "Search SKU or product, or paste a list"}
              aria-label="Filter SKUs"
              aria-expanded={showSkuList}
              aria-controls={listId}
              aria-autocomplete="list"
              role="combobox"
              onChange={(event) => {
                setSkuQuery(event.target.value);
                setSkuOpen(true);
              }}
              onFocus={() => setSkuOpen(true)}
              onKeyDown={onSkuKeyDown}
              onPaste={(event) => {
                const text = event.clipboardData.getData("text");
                if (!/[,;\n]/u.test(text)) return;
                event.preventDefault();
                addSkus(text);
              }}
            />
            {showSkuList ? (
              <ul className="productPickerDropdown" id={listId} role="listbox">
                {suggestions.map((option, index) => (
                  <li key={option.sku} role="presentation">
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === activeIndex}
                      className={
                        index === activeIndex ? "productPickerOption active" : "productPickerOption"
                      }
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => addSkus(option.sku)}
                    >
                      <span className="productPickerOptionName mono">{option.sku}</span>
                      {option.productName ? (
                        <span className="productPickerOptionSku">{option.productName}</span>
                      ) : null}
                    </button>
                  </li>
                ))}
                {suggestions.length === 0 ? (
                  <li className="historySkuEmpty">Press Enter to filter by “{skuQuery.trim()}”</li>
                ) : null}
              </ul>
            ) : null}
          </div>
          {filters.skus.length ? (
            <div className="skuChips">
              {filters.skus.map((sku) => (
                <span key={sku} className="skuChip">
                  <span className="mono">{sku}</span>
                  <button type="button" onClick={() => removeSku(sku)} aria-label={`Remove ${sku}`}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <span className="fieldHint">Leave empty to include every SKU. Paste a comma-separated list to add several.</span>
          )}
        </div>
      </div>

      {inverted ? (
        <p className="hint warnHint" role="alert">
          Start date is after the end date.
        </p>
      ) : null}

      {moreOpen ? (
        <div className="historyFilterGrid historyFilterGrid--more">
          <label className="field">
            <span className="fieldLabel">Product</span>
            <input
              className="fieldInput"
              value={filters.product}
              onChange={(event) => patch({ product: event.target.value })}
              placeholder="Contains…"
            />
          </label>
          <label className="field">
            <span className="fieldLabel">Logged by</span>
            <input
              className="fieldInput"
              value={filters.loggedBy}
              onChange={(event) => patch({ loggedBy: event.target.value })}
              placeholder="Contains…"
            />
          </label>
          <label className="field">
            <span className="fieldLabel">Return channel</span>
            <select
              className="fieldInput"
              value={filters.sourceType}
              onChange={(event) => patch({ sourceType: event.target.value })}
            >
              <option value="">All channels</option>
              {sourceOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="fieldLabel">Vendor</span>
            <input
              className="fieldInput"
              value={filters.vendor}
              onChange={(event) => patch({ vendor: event.target.value })}
              placeholder="Shopee, Watsons…"
            />
          </label>
          <label className="field">
            <span className="fieldLabel">Outbound reason</span>
            <select
              className="fieldInput"
              value={filters.disposition}
              onChange={(event) => patch({ disposition: event.target.value })}
            >
              <option value="">All reasons</option>
              {dispositionOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="fieldLabel">Expiry</span>
            <input
              className="fieldInput mono"
              value={filters.expiry}
              onChange={(event) => patch({ expiry: event.target.value })}
              placeholder="YYYY, YYYY-MM, or N/A"
            />
          </label>
          <label className="field historyFilterSpan2">
            <span className="fieldLabel">Notes</span>
            <input
              className="fieldInput"
              value={filters.notes}
              onChange={(event) => patch({ notes: event.target.value })}
              placeholder="Contains…"
            />
          </label>
        </div>
      ) : null}

      <div className="historyFilterBar">
        <button
          type="button"
          className="linkButton"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((open) => !open)}
        >
          {moreOpen ? "Hide extra filters" : extraCount ? `More filters (${extraCount})` : "More filters"}
        </button>
      </div>
    </section>
  );
}
