import React from "react";
import {
  defectGroupsToLines,
  recordToDefectGroups,
  validateDefectGroups,
  type DefectGroupRowState,
} from "../defectForm";
import { patchMovementPhotos } from "../movements";
import type { MovementRecord } from "../types";
import { DefectGroupList } from "./DefectGroupList";

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
  const [defectGroups, setDefectGroups] = React.useState<DefectGroupRowState[]>(() =>
    recordToDefectGroups(record),
  );

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const defectErr = validateDefectGroups(defectGroups, record.quantity_pcs);
    if (defectErr) {
      onError(defectErr);
      return;
    }
    const lines = defectGroupsToLines(defectGroups);

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
          Attach up to 2 photos per defect group. This updates the history record only — inventory
          quantities are not changed.
        </p>

        <form onSubmit={onSubmit}>
          <DefectGroupList
            totalQty={record.quantity_pcs}
            groups={defectGroups}
            onChange={setDefectGroups}
            defaultReason={defectGroups[0]?.defect_reason ?? "Other"}
            title="Defect breakdown"
            hint="Adjust quantities or defect types if needed, then add photos."
          />

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
