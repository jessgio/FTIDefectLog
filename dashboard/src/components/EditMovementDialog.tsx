import React from "react";
import { DEFECT_REASONS } from "../defectReasons";
import { isNoExpiry, normalizeExpiryValue, toDateInputValue } from "../expiry";
import { RejectSourceFields } from "./RejectSourceFields";
import { REJECT_SOURCE_TYPES } from "../rejectSources";
import { DefectGroupList } from "./DefectGroupList";
import { ProductThumb } from "./ProductThumb";
import {
  defectGroupsToLines,
  recordToDefectGroups,
  syncDefectGroupsToQuantity,
  validateDefectGroups,
  type DefectGroupRowState,
} from "../defectForm";
import { useSkuLookup } from "../hooks/useSkuLookup";
import { formatPriceField } from "../skuList";
import { updateMovement } from "../movements";
import type { MovementDirection, MovementRecord } from "../types";

const DISPOSITIONS = [
  "Clearance sale",
  "Mid-year sale",
  "Allocated to customer",
  "Internal use",
  "Destroyed",
  "Other",
] as const;

export type EditMovementDialogProps = {
  record: MovementRecord;
  busy: boolean;
  onClose: () => void;
  onSaved: (msg: string) => void | Promise<void>;
  onError: (msg: string) => void;
  setBusy: (v: boolean) => void;
};

export function EditMovementDialog({
  record,
  busy,
  onClose,
  onSaved,
  onError,
  setBusy,
}: EditMovementDialogProps): React.ReactElement {
  const [direction, setDirection] = React.useState<MovementDirection>(record.direction);
  const [loggedBy, setLoggedBy] = React.useState(record.logged_by);
  const [productName, setProductName] = React.useState(record.product_name);
  const [sku, setSku] = React.useState(record.sku ?? "");
  const [batchCode, setBatchCode] = React.useState(() => record.batch_code ?? "");
  const [expiryDate, setExpiryDate] = React.useState(() => toDateInputValue(record.expiry_date));
  const [noExpiry, setNoExpiry] = React.useState(() => isNoExpiry(record.expiry_date));
  const [quantity, setQuantity] = React.useState(String(record.quantity_pcs));
  const [disposition, setDisposition] = React.useState(record.disposition || DISPOSITIONS[0]);
  const [defectReason, setDefectReason] = React.useState(record.defect_reason || DEFECT_REASONS[0]);
  const [notes, setNotes] = React.useState(record.notes ?? "");
  const [rejectSourceType, setRejectSourceType] = React.useState(
    record.reject_source_type || REJECT_SOURCE_TYPES[0],
  );
  const [rejectSourceVendor, setRejectSourceVendor] = React.useState(
    record.reject_source_vendor ?? "",
  );
  const [rspPerUnit, setRspPerUnit] = React.useState(
    record.rsp_per_unit != null ? String(record.rsp_per_unit) : "",
  );
  const [cogsPerUnit, setCogsPerUnit] = React.useState(
    record.cogs_per_unit != null ? String(record.cogs_per_unit) : "",
  );
  const [defectGroups, setDefectGroups] = React.useState<DefectGroupRowState[]>(() =>
    recordToDefectGroups(record),
  );
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const skuLookup = useSkuLookup(true);

  const qty = Number(quantity);
  const qtyValid = Number.isFinite(qty) && qty > 0;

  const recordExpiry = isNoExpiry(record.expiry_date)
    ? ""
    : normalizeExpiryValue(record.expiry_date);

  function isExpiryOnlyChange(nextExpiry: string, nextNoExpiry: boolean): boolean {
    const next = nextNoExpiry ? "" : normalizeExpiryValue(nextExpiry);
    return (
      direction === record.direction &&
      productName.trim() === record.product_name.trim() &&
      batchCode.trim() === record.batch_code.trim() &&
      qty === record.quantity_pcs &&
      next !== recordExpiry
    );
  }

  React.useEffect(() => {
    if (direction !== "inbound" || !qtyValid) return;
    setDefectGroups((prev) => syncDefectGroupsToQuantity(prev, qty, defectReason));
  }, [direction, quantity, qty, qtyValid, defectReason]);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSaveError(null);
    if (!loggedBy.trim() || !productName.trim() || !batchCode.trim()) {
      const msg = "Please fill all required fields.";
      setSaveError(msg);
      onError(msg);
      return;
    }
    if (!noExpiry && !expiryDate.trim()) {
      const msg = "Enter an expiry date, or check “No expiry”.";
      setSaveError(msg);
      onError(msg);
      return;
    }
    if (!qtyValid) {
      const msg = "Quantity must be positive.";
      setSaveError(msg);
      onError(msg);
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
      if (!rejectSourceType.trim()) {
        const msg = "Select where the rejects came from (return channel).";
        setSaveError(msg);
        onError(msg);
        return;
      }
      const defectErr = validateDefectGroups(defectGroups, qty);
      if (defectErr) {
        setSaveError(defectErr);
        onError(defectErr);
        return;
      }
      payload.reject_source_type = rejectSourceType.trim();
      const vendor = rejectSourceVendor.trim();
      if (vendor) payload.reject_source_vendor = vendor;
      const expiryOnly = isExpiryOnlyChange(expiryDate, noExpiry);
      if (expiryOnly && record.defect_lines?.length) {
        payload.defect_lines = record.defect_lines;
      } else {
        payload.defect_lines = defectGroupsToLines(defectGroups);
      }
    } else {
      payload.disposition = disposition;
      if (defectReason.trim()) payload.defect_reason = defectReason.trim();
    }

    setBusy(true);
    try {
      await updateMovement(record.movement_id, payload);
      await onSaved("Entry updated and inventory adjusted.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(msg);
      onError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modalBackdrop modalBackdrop--elevated" role="presentation" onClick={onClose}>
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

        {saveError ? (
          <div className="card error">
            <div className="mono">{saveError}</div>
          </div>
        ) : null}

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
                onChange={(e) => {
                  const v = e.target.value;
                  setExpiryDate(v);
                  if (v) setNoExpiry(false);
                }}
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
            ) : (
              <RejectSourceFields
                sourceType={rejectSourceType}
                sourceVendor={rejectSourceVendor}
                onSourceTypeChange={setRejectSourceType}
                onSourceVendorChange={setRejectSourceVendor}
              />
            )}
          </div>

          {direction === "inbound" && qtyValid ? (
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
