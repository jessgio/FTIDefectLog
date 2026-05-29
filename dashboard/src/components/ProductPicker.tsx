import React from "react";
import { ProductThumb } from "./ProductThumb";
import { BarcodeScannerModal } from "./BarcodeScannerModal";
import {
  findEntryByBarcode,
  findExactCatalogEntry,
  searchProducts,
  type ProductSearchHit,
} from "../productSearch";
import type { SkuEntry } from "../skuList";

type Props = {
  value: string;
  sku: string;
  entries: SkuEntry[];
  stockNames: string[];
  loading?: boolean;
  barcodeCount?: number;
  imageUrl?: string;
  onChange: (productName: string) => void;
  onSelectEntry: (entry: SkuEntry) => void;
  onScanUnknown?: (code: string) => void;
  required?: boolean;
};

export function ProductPicker({
  value,
  sku,
  entries,
  stockNames,
  loading,
  barcodeCount = 0,
  imageUrl,
  onChange,
  onSelectEntry,
  onScanUnknown,
  required,
}: Props): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const [scanOpen, setScanOpen] = React.useState(false);
  const [scanMsg, setScanMsg] = React.useState<string | null>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listId = React.useId();

  const suggestions = React.useMemo(
    () => searchProducts(entries, stockNames, value, 10),
    [entries, stockNames, value],
  );

  const showList = open && suggestions.length > 0 && !loading;

  React.useEffect(() => {
    function onDocClick(e: MouseEvent): void {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  React.useEffect(() => {
    setActiveIndex(-1);
  }, [value, suggestions.length]);

  function selectHit(hit: ProductSearchHit): void {
    if (hit.kind === "catalog") {
      onSelectEntry(hit.entry);
    } else {
      onChange(hit.name);
    }
    setOpen(false);
    setScanMsg(null);
  }

  function onInputChange(text: string): void {
    setScanMsg(null);
    onChange(text);
    setOpen(true);
    const exact = findExactCatalogEntry(entries, text);
    if (exact) onSelectEntry(exact);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (!showList) {
      if (e.key === "ArrowDown" && suggestions.length) {
        e.preventDefault();
        setOpen(true);
        setActiveIndex(0);
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      selectHit(suggestions[activeIndex]!);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  function onBarcodeScan(code: string): void {
    setScanOpen(false);
    const entry = findEntryByBarcode(entries, code);
    if (entry) {
      onSelectEntry(entry);
      setScanMsg(`Matched ${entry.product_name} (${entry.sku})`);
      setOpen(false);
      return;
    }
    setScanMsg(
      `No match for “${code}”. Add this barcode to the product catalog for the correct SKU.`,
    );
    onScanUnknown?.(code);
  }

  return (
    <>
      <div className="productPicker" ref={wrapRef}>
        <div className="productFieldRow productPickerRow">
          {value.trim() ? (
            <ProductThumb productName={value} imageUrl={imageUrl} size="md" />
          ) : null}
          <div className="productPickerInputWrap">
            <input
              ref={inputRef}
              className="fieldInput productPickerInput"
              value={value}
              onChange={(e) => onInputChange(e.target.value)}
              onFocus={() => setOpen(true)}
              onKeyDown={onKeyDown}
              role="combobox"
              aria-expanded={showList}
              aria-controls={listId}
              aria-autocomplete="list"
              autoComplete="off"
              placeholder="Type name or SKU…"
              required={required}
            />
            <button
              type="button"
              className="productPickerScanBtn"
              onClick={() => setScanOpen(true)}
              aria-label="Scan barcode"
              title="Scan barcode"
            >
              Scan
            </button>
          </div>
        </div>

        {showList ? (
          <ul className="productPickerDropdown" id={listId} role="listbox">
            {suggestions.map((hit, i) => {
              const isActive = i === activeIndex;
              const label = hit.kind === "catalog" ? hit.entry.product_name : hit.name;
              const sub =
                hit.kind === "catalog"
                  ? hit.entry.sku
                  : entries.find((e) => e.product_name === hit.name)?.sku ?? "From stock";
              return (
                <li key={`${hit.kind}-${label}-${sub}`} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    className={isActive ? "productPickerOption active" : "productPickerOption"}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => selectHit(hit)}
                  >
                    <span className="productPickerOptionName">{label}</span>
                    <span className="productPickerOptionSku mono">{sub}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}

        {loading ? (
          <span className="fieldHint">Loading SKU list…</span>
        ) : entries.length ? (
          barcodeCount > 0 ? (
            <span className="fieldHint">
              Scan matches <strong>barcode</strong> in catalog ({barcodeCount} mapped).
              {sku ? ` SKU: ${sku}` : ""}
            </span>
          ) : (
            <span className="fieldHint warnHint">
              Product catalog loaded but no <strong>barcode</strong> values yet.
            </span>
          )
        ) : (
          <span className="fieldHint">Product catalog not loaded — you can still type product names.</span>
        )}

        {scanMsg ? (
          <span className={`fieldHint ${scanMsg.startsWith("Matched") ? "" : "warnHint"}`}>
            {scanMsg}
          </span>
        ) : null}
      </div>

      {scanOpen ? (
        <BarcodeScannerModal onScan={onBarcodeScan} onClose={() => setScanOpen(false)} />
      ) : null}
    </>
  );
}
