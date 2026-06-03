import React from "react";
import { DefectPhotoPicker } from "./DefectPhotoPicker";
import { defectReasonOptions, normalizeDefectLabel } from "../defectReasons";
import {
  assignedDefectQuantity,
  emptyDefectGroup,
  type DefectGroupRowState,
} from "../defectForm";

type Props = {
  totalQty: number;
  groups: DefectGroupRowState[];
  onChange: (groups: DefectGroupRowState[]) => void;
  defaultReason: string;
  title?: string;
  hint?: string;
};

export function DefectGroupList({
  totalQty,
  groups,
  onChange,
  defaultReason,
  title = "Defect breakdown",
  hint = "Enter how many pcs have each defect type. Optional: up to 2 photos per row (stored on the first pc in that group).",
}: Props): React.ReactElement {
  const assigned = assignedDefectQuantity(groups);
  const remaining = totalQty - assigned;
  const reasonOptions = React.useMemo(
    () => defectReasonOptions(groups.map((g) => g.defect_reason).join(";")),
    [groups],
  );

  function setGroupAt(index: number, partial: Partial<DefectGroupRowState>): void {
    onChange(
      groups.map((row, i) => (i === index ? { ...row, ...partial } : row)),
    );
  }

  function addGroup(): void {
    const qty = remaining > 0 ? remaining : 1;
    onChange([...groups, emptyDefectGroup(defaultReason, qty)]);
  }

  function removeGroup(index: number): void {
    if (groups.length <= 1) return;
    onChange(groups.filter((_, i) => i !== index));
  }

  function applySingleDefect(reason: string): void {
    onChange([emptyDefectGroup(reason, totalQty)]);
  }

  return (
    <div className="defectListCard">
      <div className="defectListHead">
        <div>
          <div className="cardTitle">{title}</div>
          <p className="formHint">{hint}</p>
          <p
            className={
              assigned === totalQty ? "defectQtySummary defectQtySummaryOk" : "defectQtySummary"
            }
          >
            {assigned} of {totalQty} pcs assigned
            {remaining !== 0 ? ` (${remaining > 0 ? `${remaining} unassigned` : `${-remaining} over`})` : ""}
          </p>
        </div>
        <label className="applyAllField">
          <span className="fieldLabel">All same defect</span>
          <select
            className="fieldInput"
            value=""
            onChange={(e) => {
              if (e.target.value) applySingleDefect(e.target.value);
            }}
          >
            <option value="">Choose defect…</option>
            {reasonOptions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="defectListScroll">
        <table className="defectListTable defectGroupTable">
          <thead>
            <tr>
              <th>Defect type</th>
              <th className="defectQtyCol">Qty</th>
              <th>Photos (max 2)</th>
              <th className="defectActionCol" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {groups.map((row, i) => (
              <tr key={i}>
                <td>
                  <select
                    className="fieldInput"
                    value={
                      reasonOptions.includes(row.defect_reason)
                        ? row.defect_reason
                        : normalizeDefectLabel(row.defect_reason) || reasonOptions[0]
                    }
                    onChange={(e) => setGroupAt(i, { defect_reason: e.target.value })}
                    required
                  >
                    {defectReasonOptions(row.defect_reason).map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="defectQtyCol">
                  <input
                    className="fieldInput"
                    type="number"
                    min={1}
                    max={totalQty}
                    value={row.quantity}
                    onChange={(e) =>
                      setGroupAt(i, { quantity: Math.max(1, Number(e.target.value) || 1) })
                    }
                    required
                  />
                </td>
                <td>
                  <DefectPhotoPicker
                    photos={row.photos}
                    onChange={(photos) => setGroupAt(i, { photos })}
                  />
                </td>
                <td className="defectActionCol">
                  <button
                    type="button"
                    className="defectRowRemove"
                    onClick={() => removeGroup(i)}
                    disabled={groups.length <= 1}
                    aria-label={`Remove defect row ${i + 1}`}
                    title={groups.length <= 1 ? "At least one row required" : "Remove row"}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="defectListFooter">
        <button type="button" className="secondaryBtn" onClick={addGroup}>
          + Add defect type
        </button>
      </div>
    </div>
  );
}
