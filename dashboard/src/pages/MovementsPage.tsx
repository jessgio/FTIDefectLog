import React from "react";
import { DefectGroupList } from "../components/DefectGroupList";
import { DEFECT_REASONS } from "../defectReasons";
import {
  defectGroupsToLines,
  syncDefectGroupsToQuantity,
  validateDefectGroups,
  type DefectGroupRowState,
} from "../defectForm";
import {
  formatExpiryDisplay,
  isNoExpiry,
  normalizeExpiryValue,
  toDateInputValue,
} from "../expiry";
import { ProductPicker } from "../components/ProductPicker";
import { useSkuLookup } from "../hooks/useSkuLookup";
import { formatPriceField, type SkuEntry } from "../skuList";
import { fetchInventoryLots } from "../inventory";
import { submitMovement } from "../movements";
import { useAuth } from "../context/AuthProvider";
import type { MovementDirection, MovementPayload, RejectRow } from "../types";

const DISPOSITIONS = [
  "Clearance sale",
  "Mid-year sale",
  "Allocated to customer",
  "Internal use",
  "Destroyed",
  "Other",
] as const;

type FormState = {
  direction: MovementDirection;
  logged_by: string;
  lot_key: string;
  product_name: string;
  sku: string;
  batch_code: string;
  expiry_date: string;
  quantity_pcs: string;
  defect_reason: string;
  disposition: string;
  notes: string;
  rsp_per_unit: string;
  cogs_per_unit: string;
};

const emptyForm = (direction: MovementDirection = "inbound"): FormState => ({
  direction,
  logged_by: "",
  lot_key: "",
  product_name: "",
  sku: "",
  batch_code: "",
  expiry_date: "",
  quantity_pcs: "",
  defect_reason: DEFECT_REASONS[0],
  disposition: DISPOSITIONS[0],
  notes: "",
  rsp_per_unit: "",
  cogs_per_unit: "",
});

function lotKey(r: RejectRow): string {
  return `${r.product_name}|||${r.batch_code}|||${r.expiry_date}|||${r.defect_reason ?? ""}`;
}

export function MovementsPage(): React.ReactElement {
  const { user } = useAuth();
  const skuLookup = useSkuLookup(true);
  const [stock, setStock] = React.useState<RejectRow[]>([]);
  const [stockError, setStockError] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<FormState>(() => emptyForm());
  const [defectGroups, setDefectGroups] = React.useState<DefectGroupRowState[]>([]);
  const [noExpiry, setNoExpiry] = React.useState(false);
  const [status, setStatus] = React.useState<"idle" | "submitting" | "success" | "error">("idle");
  const [message, setMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    fetchInventoryLots()
      .then(setStock)
      .catch((e: unknown) => {
        setStockError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  React.useEffect(() => {
    if (user?.email && !form.logged_by) {
      const name = user.user_metadata?.full_name ?? user.email.split("@")[0];
      setForm((f) => ({ ...f, logged_by: name }));
    }
  }, [user, form.logged_by]);

  const stockProductNames = React.useMemo(() => {
    const names = new Set<string>();
    for (const r of stock) names.add(r.product_name);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [stock]);

  function onProductNameChange(name: string): void {
    patch({
      product_name: name,
      lot_key: "",
    });
  }

  function onProductSelectEntry(entry: SkuEntry): void {
    patch({
      product_name: entry.product_name,
      lot_key: "",
      sku: entry.sku,
      rsp_per_unit: formatPriceField(entry.rsp_per_unit),
      cogs_per_unit: formatPriceField(entry.cogs_per_unit),
    });
  }

  const qtyParsed = Number(form.quantity_pcs);
  const qtyValid = Number.isFinite(qtyParsed) && qtyParsed > 0;

  React.useEffect(() => {
    if (form.direction !== "inbound") {
      setDefectGroups([]);
      return;
    }
    if (!qtyValid) {
      setDefectGroups([]);
      return;
    }
    setDefectGroups((prev) => syncDefectGroupsToQuantity(prev, qtyParsed, form.defect_reason));
  }, [form.direction, form.quantity_pcs, qtyParsed, qtyValid, form.defect_reason]);

  function patch(partial: Partial<FormState>): void {
    setForm((f) => ({ ...f, ...partial }));
  }

  function onDirectionChange(direction: MovementDirection): void {
    setForm(emptyForm(direction));
    setDefectGroups([]);
    setNoExpiry(false);
    setStatus("idle");
    setMessage(null);
  }

  function onQuantityChange(value: string): void {
    patch({ quantity_pcs: value });
  }

  function onLotPick(key: string): void {
    patch({ lot_key: key });
    if (!key) return;
    const row = stock.find((r) => lotKey(r) === key);
    if (!row) return;
    const noExp = isNoExpiry(row.expiry_date);
    setNoExpiry(noExp);
    const catalog = skuLookup.lookupEntry(row.product_name, row.sku);
    patch({
      product_name: row.product_name,
      sku: row.sku ?? catalog?.sku ?? "",
      batch_code: row.batch_code,
      expiry_date: noExp ? "" : toDateInputValue(row.expiry_date),
      rsp_per_unit:
        row.rsp_per_unit != null
          ? String(row.rsp_per_unit)
          : formatPriceField(catalog?.rsp_per_unit),
      cogs_per_unit:
        row.cogs_per_unit != null
          ? String(row.cogs_per_unit)
          : formatPriceField(catalog?.cogs_per_unit),
      defect_reason: row.defect_reason || DEFECT_REASONS[0],
    });
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setStatus("submitting");
    setMessage(null);

    const qty = Number(form.quantity_pcs);
    if (!form.logged_by.trim()) {
      setStatus("error");
      setMessage("Please enter your name.");
      return;
    }
    if (!form.product_name.trim() || !form.batch_code.trim()) {
      setStatus("error");
      setMessage("Product and batch are required.");
      return;
    }
    if (!noExpiry && !form.expiry_date.trim()) {
      setStatus("error");
      setMessage("Enter an expiry date, or check “No expiry” for tools / non-dated items.");
      return;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      setStatus("error");
      setMessage("Quantity must be a positive number.");
      return;
    }
    const payload: MovementPayload = {
      direction: form.direction,
      logged_by: form.logged_by.trim(),
      product_name: form.product_name.trim(),
      sku: form.sku.trim() || undefined,
      batch_code: form.batch_code.trim(),
      expiry_date: noExpiry ? "" : normalizeExpiryValue(form.expiry_date),
      quantity_pcs: qty,
      notes: form.notes.trim() || undefined,
    };

    if (form.direction === "inbound") {
      const defectErr = validateDefectGroups(defectGroups, qty);
      if (defectErr) {
        setStatus("error");
        setMessage(defectErr);
        return;
      }
      payload.defect_lines = defectGroupsToLines(defectGroups);
    } else {
      payload.disposition = form.disposition;
      if (form.defect_reason.trim()) payload.defect_reason = form.defect_reason.trim();
    }

    const rsp = Number(form.rsp_per_unit);
    if (form.rsp_per_unit.trim() && Number.isFinite(rsp)) payload.rsp_per_unit = rsp;
    const cogs = Number(form.cogs_per_unit);
    if (form.cogs_per_unit.trim() && Number.isFinite(cogs)) payload.cogs_per_unit = cogs;

    try {
      await submitMovement(payload);
      setStatus("success");
      setMessage(
        form.direction === "inbound"
          ? `Logged inbound: ${qty} pc(s) with defect breakdown.`
          : `Logged outbound: ${qty} pcs removed from defective stock.`,
      );
      setForm(emptyForm(form.direction));
      setDefectGroups([]);
      setNoExpiry(false);
      fetchInventoryLots()
        .then(setStock)
        .catch(() => {});
    } catch (err: unknown) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <header className="header">
        <div>
          <div className="title">Stock movements</div>
          <div className="subtitle">
            Log inbound (new defective stock) or outbound (sold, allocated, destroyed)
          </div>
        </div>
      </header>

      {!stockError ? null : (
        <div className="card">
          <div className="cardTitle">Stock list unavailable</div>
          <div className="hint">You can still submit manually. ({stockError})</div>
        </div>
      )}

      <form className="card formCard" onSubmit={onSubmit}>
        <div className="directionToggle" role="group" aria-label="Movement type">
          <button
            type="button"
            className={form.direction === "inbound" ? "dirBtn active" : "dirBtn"}
            onClick={() => onDirectionChange("inbound")}
          >
            Inbound
          </button>
          <button
            type="button"
            className={form.direction === "outbound" ? "dirBtn active" : "dirBtn"}
            onClick={() => onDirectionChange("outbound")}
          >
            Outbound
          </button>
        </div>

        <p className="formHint">
          {form.direction === "inbound"
            ? "Enter how many pcs have each defect type. Stock is grouped by defect on the same batch."
            : "Use when defective stock leaves the reject list (sale, allocation, destruction)."}
        </p>

        <div className="formGrid">
          <label className="field">
            <span className="fieldLabel">Logged by</span>
            <input
              className="fieldInput"
              value={form.logged_by}
              onChange={(e) => patch({ logged_by: e.target.value })}
              placeholder="Your name"
              required
            />
          </label>

          {stock.length > 0 ? (
            <label className="field fieldWide">
              <span className="fieldLabel">Pick from current stock (optional)</span>
              <select
                className="fieldInput"
                value={form.lot_key}
                onChange={(e) => onLotPick(e.target.value)}
              >
                <option value="">— Manual entry —</option>
                {stock.map((r) => {
                  const key = lotKey(r);
                  return (
                    <option key={key} value={key}>
                      {r.product_name} · {r.batch_code} · exp {formatExpiryDisplay(r.expiry_date)}
                      {r.defect_reason ? ` · ${r.defect_reason}` : ""} · qty {r.quantity_pcs}
                    </option>
                  );
                })}
              </select>
            </label>
          ) : null}

          <label className="field fieldWide">
            <span className="fieldLabel">Product name</span>
            <ProductPicker
              value={form.product_name}
              sku={form.sku}
              entries={skuLookup.entries}
              stockNames={stockProductNames}
              loading={skuLookup.loading}
              barcodeCount={skuLookup.barcodeCount}
              imageUrl={skuLookup.lookupImage(form.product_name, form.sku)}
              onChange={onProductNameChange}
              onSelectEntry={onProductSelectEntry}
              required
            />
          </label>

          <label className="field">
            <span className="fieldLabel">SKU</span>
            <input
              className="fieldInput mono"
              value={form.sku}
              onChange={(e) => patch({ sku: e.target.value })}
              placeholder={skuLookup.entries.length ? "From SKUList if matched" : "Optional"}
            />
          </label>

          <label className="field">
            <span className="fieldLabel">Batch code</span>
            <input
              className="fieldInput mono"
              value={form.batch_code}
              onChange={(e) => patch({ batch_code: e.target.value, lot_key: "" })}
              required
            />
          </label>

          <label className="field">
            <span className="fieldLabel">Expiry date</span>
            <input
              className="fieldInput mono"
              type="date"
              value={form.expiry_date}
              onChange={(e) => patch({ expiry_date: e.target.value, lot_key: "" })}
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
                  if (e.target.checked) patch({ expiry_date: "" });
                }}
              />
              <span>No expiry (tools / non-dated)</span>
            </label>
          </label>

          <label className="field">
            <span className="fieldLabel">Quantity (pcs)</span>
            <input
              className="fieldInput"
              type="number"
              min={1}
              step={1}
              value={form.quantity_pcs}
              onChange={(e) => onQuantityChange(e.target.value)}
              required
            />
          </label>

          {form.direction === "outbound" ? (
            <label className="field fieldWide">
              <span className="fieldLabel">Outbound reason</span>
              <select
                className="fieldInput"
                value={form.disposition}
                onChange={(e) => patch({ disposition: e.target.value })}
              >
                {DISPOSITIONS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="field">
            <span className="fieldLabel">RSP / unit (optional)</span>
            <input
              className="fieldInput"
              type="number"
              min={0}
              value={form.rsp_per_unit}
              onChange={(e) => patch({ rsp_per_unit: e.target.value })}
              placeholder={skuLookup.entries.length ? "From SKUList if matched" : undefined}
            />
          </label>

          <label className="field">
            <span className="fieldLabel">COGS / unit (optional)</span>
            <input
              className="fieldInput"
              type="number"
              min={0}
              value={form.cogs_per_unit}
              onChange={(e) => patch({ cogs_per_unit: e.target.value })}
              placeholder={skuLookup.entries.length ? "From SKUList if matched" : undefined}
            />
          </label>

          <label className="field fieldWide">
            <span className="fieldLabel">Notes</span>
            <textarea
              className="fieldInput fieldTextarea"
              rows={3}
              value={form.notes}
              onChange={(e) => patch({ notes: e.target.value })}
              placeholder="Optional details (PO, customer, location, etc.)"
            />
          </label>
        </div>

        {form.direction === "inbound" && qtyValid ? (
          <DefectGroupList
            totalQty={qtyParsed}
            groups={defectGroups}
            onChange={setDefectGroups}
            defaultReason={form.defect_reason}
            hint="Attach up to 2 photos per row (optional). Saved with this inbound entry."
          />
        ) : null}

        {message ? (
          <div className={status === "success" ? "formBanner success" : "formBanner error"}>
            {message}
          </div>
        ) : null}

        <div className="formActions">
          <button
            type="submit"
            className="primaryBtn"
            disabled={status === "submitting"}
          >
            {status === "submitting" ? "Uploading & saving…" : "Save movement"}
          </button>
        </div>
      </form>
    </>
  );
}
