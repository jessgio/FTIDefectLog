import React from "react";
import { AttachPhotosDialog } from "../components/AttachPhotosDialog";
import { EditMovementDialog } from "../components/EditMovementDialog";
import { HistoryFilterBar } from "../components/HistoryFilterBar";
import { ProductThumb } from "../components/ProductThumb";
import { downloadMovementsExcel } from "../exportMovements";
import { formatExpiryDisplay } from "../expiry";
import { formatInt } from "../format";
import {
  collectDefectTypeOptions,
  collectDispositionOptions,
  collectSkuOptions,
  collectSourceTypeOptions,
  countActiveHistoryFilters,
  defectPieceQuantity,
  EMPTY_HISTORY_FILTERS,
  filterMovements,
  movementDetail,
  sumMovementQuantity,
  type MovementHistoryFilters,
} from "../historyFilters";
import { useSkuLookup } from "../hooks/useSkuLookup";
import { deleteMovement, listMovements } from "../movements";
import { formatRejectSource } from "../rejectSources";
import type { MovementRecord } from "../types";

function formatWhen(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function HistoryPage(): React.ReactElement {
  const [rows, setRows] = React.useState<MovementRecord[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [filters, setFilters] = React.useState<MovementHistoryFilters>({
    ...EMPTY_HISTORY_FILTERS,
    skus: [],
  });
  const [exporting, setExporting] = React.useState(false);
  const [editing, setEditing] = React.useState<MovementRecord | null>(null);
  const [attachingPhotos, setAttachingPhotos] = React.useState<MovementRecord | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const skuLookup = useSkuLookup(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listMovements();
      setRows(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const filtered = React.useMemo(() => filterMovements(rows, filters), [rows, filters]);
  const matchPcs = React.useMemo(() => sumMovementQuantity(filtered), [filtered]);
  const defectPcs = React.useMemo(() => {
    if (!filters.defectType.trim()) return null;
    return filtered.reduce(
      (sum, row) => sum + (defectPieceQuantity(row, filters.defectType) ?? row.quantity_pcs),
      0,
    );
  }, [filtered, filters.defectType]);
  const activeFilters = countActiveHistoryFilters(filters);
  const skuOptions = React.useMemo(
    () => collectSkuOptions(rows, skuLookup.entries),
    [rows, skuLookup.entries],
  );
  const defectTypes = React.useMemo(() => collectDefectTypeOptions(rows), [rows]);
  const dispositions = React.useMemo(() => collectDispositionOptions(rows), [rows]);
  const sourceTypes = React.useMemo(() => collectSourceTypeOptions(rows), [rows]);

  function clearFilters(): void {
    setFilters({ ...EMPTY_HISTORY_FILTERS, skus: [] });
  }

  async function onExport(): Promise<void> {
    if (!filtered.length || exporting) return;
    setExporting(true);
    setMessage(null);
    try {
      await downloadMovementsExcel(filtered, undefined, filters.defectType);
    } catch (e: unknown) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }

  async function onDelete(record: MovementRecord): Promise<void> {
    const ok = window.confirm(
      `Delete this ${record.direction} entry (${record.quantity_pcs} pcs of ${record.product_name})?\n\nInventory quantities will be adjusted to undo this entry.`,
    );
    if (!ok) return;
    setBusy(true);
    setMessage(null);
    try {
      await deleteMovement(record.movement_id);
      setMessage("Entry deleted and inventory updated.");
      await load();
    } catch (e: unknown) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="header">
        <div>
          <div className="title">Movement history</div>
          <div className="subtitle">
            Filter by date, type, SKU, defect, batch, and more, then export the matching entries
          </div>
        </div>
        <div className="right">
          <button
            type="button"
            className="secondaryBtn"
            onClick={() => void onExport()}
            disabled={loading || busy || exporting || filtered.length === 0}
            aria-label="Export filtered movement history to Excel"
            title={
              filtered.length
                ? `Export ${formatInt(filtered.length)} matching entries`
                : "Nothing to export"
            }
          >
            {exporting ? "Exporting…" : "Export Excel"}
          </button>
          <button type="button" className="secondaryBtn" onClick={() => void load()} disabled={loading || busy}>
            Refresh
          </button>
        </div>
      </header>

      {saveError ? (
        <div className="card error">
          <div className="mono">{saveError}</div>
        </div>
      ) : null}

      {message ? (
        <div className="card">
          <div className="hint">{message}</div>
        </div>
      ) : null}

      {error ? (
        <div className="card error">
          <div className="mono">{error}</div>
        </div>
      ) : null}

      <HistoryFilterBar
        filters={filters}
        onChange={setFilters}
        skuOptions={skuOptions}
        defectTypes={defectTypes}
        dispositions={dispositions}
        sourceTypes={sourceTypes}
      />

      <section className="card">
        <div className="tableSectionHead">
          <div className="cardTitle">{activeFilters ? "Matching entries" : "All entries"}</div>
          <button
            type="button"
            className="linkButton"
            onClick={clearFilters}
            disabled={activeFilters === 0}
          >
            Clear filters
          </button>
        </div>

        {loading ? (
          <div className="hint">Loading…</div>
        ) : (
          <div className="tableWrap tableWrap--stickyCols">
            <table className="table tableHistory">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Type</th>
                  <th
                    className="colProductImage colStickyImage"
                    aria-label="Product image"
                  />
                  <th>Product</th>
                  <th>SKU</th>
                  <th>Batch</th>
                  <th>Expiry</th>
                  <th className="num">Qty</th>
                  <th>Detail</th>
                  <th>Return source</th>
                  <th>By</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={12}>
                      <div className="hint">
                        {rows.length === 0
                          ? "No stock entries yet."
                          : "No entries match these filters."}
                      </div>
                    </td>
                  </tr>
                ) : null}
                {filtered.map((r) => (
                  <tr key={r.movement_id}>
                    <td className="mono">{formatWhen(r.timestamp_utc)}</td>
                    <td>{r.direction === "inbound" ? "Inbound" : "Outbound"}</td>
                    <td className="colProductImage colStickyImage">
                      <ProductThumb
                        productName={r.product_name}
                        imageUrl={skuLookup.lookupImage(r.product_name, r.sku)}
                      />
                    </td>
                    <td>{r.product_name}</td>
                    <td className="mono">{r.sku || "—"}</td>
                    <td className="mono">{r.batch_code}</td>
                    <td className="mono">{formatExpiryDisplay(r.expiry_date)}</td>
                    <td className="num">{formatInt(r.quantity_pcs)}</td>
                    <td>{movementDetail(r) || "—"}</td>
                    <td>
                      {r.direction === "inbound"
                        ? formatRejectSource(r.reject_source_type, r.reject_source_vendor) || "—"
                        : "—"}
                    </td>
                    <td>{r.logged_by}</td>
                    <td className="historyActions">
                      {r.direction === "inbound" ? (
                        <button
                          type="button"
                          className="linkButton"
                          disabled={busy}
                          onClick={() => setAttachingPhotos(r)}
                        >
                          Photos
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="linkButton"
                        disabled={busy}
                        onClick={() => setEditing(r)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="linkButton dangerLink"
                        disabled={busy}
                        onClick={() => void onDelete(r)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading ? (
          <div className="tableMeta">
            Showing <span className="mono">{formatInt(filtered.length)}</span>
            {activeFilters ? (
              <>
                {" "}
                of <span className="mono">{formatInt(rows.length)}</span>
              </>
            ) : null}{" "}
            entries · <span className="mono">{formatInt(matchPcs)}</span> pcs
            {defectPcs != null ? (
              <>
                {" "}
                · <span className="mono">{formatInt(defectPcs)}</span> pcs {filters.defectType}
              </>
            ) : null}
          </div>
        ) : null}
      </section>

      {attachingPhotos ? (
        <AttachPhotosDialog
          record={attachingPhotos}
          busy={busy}
          onClose={() => setAttachingPhotos(null)}
          onSaved={async (msg) => {
            setMessage(msg);
            setAttachingPhotos(null);
            await load();
          }}
          onError={(msg) => setMessage(msg)}
          setBusy={setBusy}
        />
      ) : null}

      {editing ? (
        <EditMovementDialog
          key={editing.movement_id}
          record={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSaved={async (msg) => {
            setSaveError(null);
            setMessage(msg);
            setEditing(null);
            await load();
          }}
          onError={(msg) => {
            setSaveError(msg);
            setMessage(null);
          }}
          setBusy={setBusy}
        />
      ) : null}
    </>
  );
}

