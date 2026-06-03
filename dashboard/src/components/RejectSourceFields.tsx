import React from "react";
import { REJECT_SOURCE_TYPES } from "../rejectSources";

type Props = {
  sourceType: string;
  sourceVendor: string;
  onSourceTypeChange: (value: string) => void;
  onSourceVendorChange: (value: string) => void;
  required?: boolean;
  vendorPlaceholder?: string;
};

export function RejectSourceFields({
  sourceType,
  sourceVendor,
  onSourceTypeChange,
  onSourceVendorChange,
  required = true,
  vendorPlaceholder = "e.g. Shopee, Sociolla, Watsons, AEON",
}: Props): React.ReactElement {
  return (
    <>
      <label className="field fieldWide">
        <span className="fieldLabel">
          Where rejects came from{required ? "" : " (optional)"}
        </span>
        <select
          className="fieldInput"
          value={sourceType}
          onChange={(e) => onSourceTypeChange(e.target.value)}
          required={required}
        >
          <option value="">Select channel…</option>
          {REJECT_SOURCE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label className="field fieldWide">
        <span className="fieldLabel">Vendor / partner name</span>
        <input
          className="fieldInput"
          value={sourceVendor}
          onChange={(e) => onSourceVendorChange(e.target.value)}
          placeholder={vendorPlaceholder}
          list="reject-source-vendors"
        />
        <datalist id="reject-source-vendors">
          {["Shopee", "Tokopedia", "Sociolla", "Watsons", "AEON", "Alfamart", "Indomaret"].map(
            (name) => (
              <option key={name} value={name} />
            ),
          )}
        </datalist>
      </label>
    </>
  );
}
