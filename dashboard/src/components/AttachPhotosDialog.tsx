import React from "react";
import { DEFECT_REASONS } from "../defectReasons";
import {
  defectRowsToLines,
  recordToDefectRows,
  type DefectRowState,
} from "../defectForm";
import { patchMovementPhotos } from "../movements";
import type { MovementRecord } from "../types";
import { DefectPhotoPicker } from "./DefectPhotoPicker";

type Props = {
  record: MovementRecord;
  busy: boolean;
  onClose: () => void;
  onSaved: (msg: string) => void | Promise<void>;
  onError: (msg: string) => void;
  setBusy: (v: boolean) => void;
};

export function AttachPhotosDialog({
  record,
  busy,
  onClose,
  onSaved,
  onError,
  setBusy,
}: Props): React.ReactElement {
  const [defectRows, setDefectRows] = React.useState<DefectRowState[]>(() =>
    recordToDefectRows(record),
  );

  function setDefectAt(index: number, partial: Partial<DefectRowState>): void {
    setDefectRows((rows) => {
      const next = [...rows];
      next[index] = { ...next[index], ...partial };
      return next;
    });
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (defectRows.length !== record.quantity_pcs) {
      onError("Defect rows do not match entry quantity.");
      return;
    }
    const lines = defectRowsToLines(defectRows);
    if (lines.some((l) => !l.defect_reason.trim())) {
      onError("Every piece needs a defect type.");
      return;
    }

    setBusy(true);
    try {
      await patchMovementPhotos(record.movement_id, lines);
      await onSaved("Photos saved. They will appear on the dashboard product detail view.");
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modalBackdrop" role="presentation" onClick={onClose}>
      <div
        className="modalCard modalCardWide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="attach-photos-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="attach-photos-title" className="modalTitle">
          Add defect photos
        </h2>
        <p className="formHint">
          <strong>{record.product_name}</strong> · batch{" "}
          <span className="mono">{record.batch_code}</span> · {record.quantity_pcs} pcs · logged{" "}
          {new Date(record.timestamp_utc).toLocaleString()}
        </p>
        <p className="formHint">
          Attach up to 2 photos per piece. This updates the history record only — inventory
          quantities are not changed.
        </p>

        <form onSubmit={onSubmit}>
          <div className="defectListScroll">
            <table className="defectListTable">
              <thead>
                <tr>
                  <th className="defectPcCol">Pc #</th>
                  <th>Defect type</th>
                  <th>Photos (max 2)</th>
                </tr>
              </thead>
              <tbody>
                {defectRows.map((row, i) => (
                  <tr key={i}>
                    <td className="defectPcCol mono">{i + 1}</td>
                    <td>
                      <select
                        className="fieldInput"
                        value={row.defect_reason}
                        onChange={(e) => setDefectAt(i, { defect_reason: e.target.value })}
                        required
                      >
                        {DEFECT_REASONS.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <DefectPhotoPicker
                        photos={row.photos}
                        onChange={(photos) => setDefectAt(i, { photos })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="formActions">
            <button type="button" className="secondaryBtn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="primaryBtn" disabled={busy}>
              {busy ? "Uploading…" : "Save photos"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
