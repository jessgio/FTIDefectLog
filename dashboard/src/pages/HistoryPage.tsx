import React from "react";
import { DEFECT_REASONS, MAX_DEFECT_LINES } from "../defectReasons";
import { formatExpiryDisplay, isNoExpiry, normalizeExpiryValue } from "../expiry";
import { formatInt } from "../format";
import { AttachPhotosDialog } from "../components/AttachPhotosDialog";
import { DefectGroupList } from "../components/DefectGroupList";
import { ProductThumb } from "../components/ProductThumb";
import {
  defectGroupsToLines,
  recordToDefectGroups,
  syncDefectGroupsToQuantity,
  validateDefectGroups,
  type DefectGroupRowState,
} from "../defectForm";
import { useSkuLookup } from "../hooks/useSkuLookup";
import { formatPriceField } from "../skuList";
import {
  deleteMovement,
  listMovements,
  updateMovement,
} from "../movements";
import type { DefectLine, MovementDirection, MovementRecord } from "../types";

const DISPOSITIONS = [
  "Clearance sale",
  "Mid-year sale",
  "Allocated to customer",
  "Internal use",
  "Destroyed",
  "Other",
] as const;

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
  const [filter, setFilter] = React.useState("");
  const [editing, setEditing] = React.useState<MovementRecord | null>(null);
  const [attachingPhotos, setAttachingPhotos] = React.useState<MovementRecord | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
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

  const filtered = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      return (
        r.product_name.toLowerCase().includes(q) ||
        (r.sku ?? "").toLowerCase().includes(q) ||
        (r.batch_code ?? "").toLowerCase().includes(q) ||
        (r.logged_by ?? "").toLowerCase().includes(q) ||
        r.direction.includes(q)
      );
    });
  }, [rows, filter]);

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
          <div className="subtitle">Edit or delete past stock entries (updates inventory automatically)</div>
        </div>
        <div className="right">
          <button type="button" className="secondaryBtn" onClick={() => void load()} disabled={loading || busy}>
            Refresh
          </button>
        </div>
      </header>

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

      <section className="card">
        <div className="tableSectionHead">
          <div className="cardTitle">All entries</div>
          <input
            className="thFilter tableToolbarSearch"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            aria-label="Filter history"
          />
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
                  <th>Batch</th>
                  <th>Expiry</th>
                  <th className="num">Qty</th>
                  <th>Detail</th>
                  <th>By</th>
                  <th />
                </tr>
              </thead>
              <tbody>
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
                    <td className="mono">{r.batch_code}</td>
                    <td className="mono">{formatExpiryDisplay(r.expiry_date)}</td>
                    <td className="num">{formatInt(r.quantity_pcs)}</td>
                    <td>
                      {r.direction === "inbound"
                        ? r.defect_reason || (r.defect_lines?.length ? "Defect breakdown" : "—")
                        : r.disposition || "—"}
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
            Showing <span className="mono">{formatInt(filtered.length)}</span> entries
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
          record={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSaved={async (msg) => {
            setMessage(msg);
            setEditing(null);
            await load();
          }}
          onError={(msg) => setMessage(msg)}
          setBusy={setBusy}
        />
      ) : null}
    </>
  );
}

type EditProps = {
  record: MovementRecord;
  busy: boolean;
  onClose: () => void;
  onSaved: (msg: string) => void | Promise<void>;
  onError: (msg: string) => void;
  setBusy: (v: boolean) => void;
};

function EditMovementDialog({
  record,
  busy,
  onClose,
  onSaved,
  onError,
  setBusy,
}: EditProps): React.ReactElement {
  const [direction, setDirection] = React.useState<MovementDirection>(record.direction);
  const [loggedBy, setLoggedBy] = React.useState(record.logged_by);
  const [productName, setProductName] = React.useState(record.product_name);
  const [sku, setSku] = React.useState(record.sku ?? "");
  const [batchCode, setBatchCode] = React.useState(record.batch_code);
  const [expiryDate, setExpiryDate] = React.useState(
    isNoExpiry(record.expiry_date) ? "" : record.expiry_date,
  );
  const [noExpiry, setNoExpiry] = React.useState(isNoExpiry(record.expiry_date));
  const [quantity, setQuantity] = React.useState(String(record.quantity_pcs));
  const [disposition, setDisposition] = React.useState(record.disposition || DISPOSITIONS[0]);
  const [defectReason, setDefectReason] = React.useState(record.defect_reason || DEFECT_REASONS[0]);
  const [notes, setNotes] = React.useState(record.notes ?? "");
  const [rspPerUnit, setRspPerUnit] = React.useState(
    record.rsp_per_unit != null ? String(record.rsp_per_unit) : "",
  );
  const [cogsPerUnit, setCogsPerUnit] = React.useState(
    record.cogs_per_unit != null ? String(record.cogs_per_unit) : "",
  );
  const [defectGroups, setDefectGroups] = React.useState<DefectGroupRowState[]>(() =>
    recordToDefectGroups(record),
  );
  const skuLookup = useSkuLookup(true);

  const qty = Number(quantity);
  const qtyValid = Number.isFinite(qty) && qty > 0;

  React.useEffect(() => {
    if (direction !== "inbound" || !qtyValid) return;
    if (qty > MAX_DEFECT_LINES) return;
    setDefectGroups((prev) => syncDefectGroupsToQuantity(prev, qty, defectReason));
  }, [direction, quantity, qtyValid, defectReason]);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!loggedBy.trim() || !productName.trim() || !batchCode.trim()) {
      onError("Please fill all required fields.");
      return;
    }
    if (!noExpiry && !expiryDate.trim()) {
      onError("Enter an expiry date, or check “No expiry”.");
      return;
    }
    if (!qtyValid) {
      onError("Quantity must be positive.");
      return;
    }
    if (direction === "inbound" && qty > MAX_DEFECT_LINES) {
      onError(`Max ${MAX_DEFECT_LINES} pieces per entry.`);
      return;
    }

    const payload = {
      direction,
      logged_by: loggedBy.trim(),
      product_name: productName.trim(),
      sku: sku.trim() || undefined,
      batch_code: batchCode.trim(),
      expiry_date: noExpiry ? "" : normalizeExpiryValue(expiryDate),
      quantity_pcs: qty,
      notes: notes.trim() || undefined,
    } as Parameters<typeof updateMovement>[1];

    const rsp = Number(rspPerUnit);
    if (rspPerUnit.trim() && Number.isFinite(rsp)) payload.rsp_per_unit = rsp;
    const cogs = Number(cogsPerUnit);
    if (cogsPerUnit.trim() && Number.isFinite(cogs)) payload.cogs_per_unit = cogs;

    if (direction === "inbound") {
      const defectErr = validateDefectGroups(defectGroups, qty);
      if (defectErr) {
        onError(defectErr);
        return;
      }
      payload.defect_lines = defectGroupsToLines(defectGroups);
    } else {
      payload.disposition = disposition;
      if (defectReason.trim()) payload.defect_reason = defectReason.trim();
    }

    setBusy(true);
    try {
      await updateMovement(record.movement_id, payload);
      await onSaved("Entry updated and inventory adjusted.");
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modalBackdrop" role="presentation" onClick={onClose}>
      <div
        className="modalCard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-movement-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="edit-movement-title" className="modalTitle">
          Edit entry
        </h2>
        <p className="formHint">
          Saving reverses the old entry on inventory, then applies the updated values.
        </p>

        <form onSubmit={onSubmit}>
          <div className="formGrid">
            <label className="field">
              <span className="fieldLabel">Type</span>
              <select
                className="fieldInput"
                value={direction}
                onChange={(e) => setDirection(e.target.value as MovementDirection)}
              >
                <option value="inbound">Inbound</option>
                <option value="outbound">Outbound</option>
              </select>
            </label>
            <label className="field">
              <span className="fieldLabel">Logged by</span>
              <input
                className="fieldInput"
                value={loggedBy}
                onChange={(e) => setLoggedBy(e.target.value)}
                required
              />
            </label>
            <label className="field fieldWide">
              <span className="fieldLabel">Product</span>
              <div className="productFieldRow">
                {productName.trim() ? (
                  <ProductThumb
                    productName={productName}
                    imageUrl={skuLookup.lookupImage(productName)}
                    size="md"
                  />
                ) : null}
                <input
                  className="fieldInput"
                  list="edit-product-list"
                  value={productName}
                  onChange={(e) => {
                    const name = e.target.value;
                    setProductName(name);
                    const entry = skuLookup.lookupEntry(name);
                    if (entry) {
                      setSku(entry.sku);
                      if (entry.rsp_per_unit != null) setRspPerUnit(formatPriceField(entry.rsp_per_unit));
                      if (entry.cogs_per_unit != null) setCogsPerUnit(formatPriceField(entry.cogs_per_unit));
                    }
                  }}
                  required
                />
              </div>
              <datalist id="edit-product-list">
                {skuLookup.entries.map((e) => (
                  <option key={e.product_name} value={e.product_name}>
                    {e.sku}
                  </option>
                ))}
              </datalist>
            </label>
            <label className="field">
              <span className="fieldLabel">SKU</span>
              <input className="fieldInput mono" value={sku} onChange={(e) => setSku(e.target.value)} />
            </label>
            <label className="field">
              <span className="fieldLabel">Batch</span>
              <input
                className="fieldInput mono"
                value={batchCode}
                onChange={(e) => setBatchCode(e.target.value)}
                required
              />
            </label>
            <label className="field">
              <span className="fieldLabel">Expiry</span>
              <input
                className="fieldInput mono"
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
                disabled={noExpiry}
                required={!noExpiry}
              />
            </label>
            <label className="field fieldCheck">
              <span className="fieldLabel">&nbsp;</span>
              <label className="checkRow">
                <input
                  type="checkbox"
                  checked={noExpiry}
                  onChange={(e) => {
                    setNoExpiry(e.target.checked);
                    if (e.target.checked) setExpiryDate("");
                  }}
                />
                <span>No expiry (tools)</span>
              </label>
            </label>
            <label className="field">
              <span className="fieldLabel">Quantity</span>
              <input
                className="fieldInput"
                type="number"
                min={1}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                required
              />
            </label>
            <label className="field">
              <span className="fieldLabel">RSP / unit (optional)</span>
              <input
                className="fieldInput"
                type="number"
                min={0}
                value={rspPerUnit}
                onChange={(e) => setRspPerUnit(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="fieldLabel">COGS / unit (optional)</span>
              <input
                className="fieldInput"
                type="number"
                min={0}
                value={cogsPerUnit}
                onChange={(e) => setCogsPerUnit(e.target.value)}
              />
            </label>
            {direction === "outbound" ? (
              <>
                <label className="field fieldWide">
                  <span className="fieldLabel">Outbound reason</span>
                  <select
                    className="fieldInput"
                    value={disposition}
                    onChange={(e) => setDisposition(e.target.value)}
                  >
                    {DISPOSITIONS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field fieldWide">
                  <span className="fieldLabel">Inventory defect (for stock match)</span>
                  <input
                    className="fieldInput"
                    value={defectReason}
                    onChange={(e) => setDefectReason(e.target.value)}
                  />
                </label>
              </>
            ) : null}
          </div>

          {direction === "inbound" && qtyValid && qty <= MAX_DEFECT_LINES ? (
            <DefectGroupList
              totalQty={qty}
              groups={defectGroups}
              onChange={setDefectGroups}
              defaultReason={defectReason}
              hint="1–2 photos per row (optional)."
            />
          ) : null}

          <label className="field fieldWide">
            <span className="fieldLabel">Notes</span>
            <textarea
              className="fieldInput fieldTextarea"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>

          <div className="formActions">
            <button type="button" className="secondaryBtn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="primaryBtn" disabled={busy}>
              {busy ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
