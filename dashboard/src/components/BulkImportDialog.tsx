import React from "react";
import {
  downloadBulkImportTemplate,
  importBulkRows,
  parseBulkImportFile,
  type BulkImportResult,
  type BulkImportRow,
  type ParsedBulkRow,
} from "../bulkImport";
import { submitMovement } from "../movements";
import { formatExpiryDisplay } from "../expiry";

type Props = {
  loggedBy: string;
  onClose: () => void;
  onImported: () => void;
};

type Phase = "pick" | "preview" | "importing" | "done";

export function BulkImportDialog({ loggedBy, onClose, onImported }: Props): React.ReactElement {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [phase, setPhase] = React.useState<Phase>("pick");
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [parsed, setParsed] = React.useState<ParsedBulkRow[]>([]);
  const [parseError, setParseError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState({ done: 0, total: 0 });
  const [results, setResults] = React.useState<BulkImportResult[]>([]);

  const validRows = React.useMemo(
    () => parsed.filter((p): p is { ok: true; row: BulkImportRow } => p.ok).map((p) => p.row),
    [parsed],
  );
  const invalidRows = React.useMemo(
    () =>
      parsed.filter(
        (p): p is { ok: false; rowNumber: number; errors: string[]; raw: Record<string, string> } =>
          !p.ok,
      ),
    [parsed],
  );

  async function onDownloadTemplate(): Promise<void> {
    setBusy(true);
    setParseError(null);
    try {
      await downloadBulkImportTemplate();
    } catch (err: unknown) {
      setParseError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onFileChosen(file: File | null): Promise<void> {
    if (!file) return;
    setBusy(true);
    setParseError(null);
    setFileName(file.name);
    setResults([]);
    try {
      const rows = await parseBulkImportFile(file);
      if (!rows.length) {
        setParsed([]);
        setParseError("No data rows found. Use the template and keep the header row.");
        setPhase("pick");
        return;
      }
      setParsed(rows);
      setPhase("preview");
    } catch (err: unknown) {
      setParsed([]);
      setParseError(err instanceof Error ? err.message : String(err));
      setPhase("pick");
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function onConfirmImport(): Promise<void> {
    if (!loggedBy.trim()) {
      setParseError("Logged-by name is required before importing.");
      return;
    }
    if (!validRows.length) return;

    setPhase("importing");
    setBusy(true);
    setParseError(null);
    setProgress({ done: 0, total: validRows.length });
    try {
      const importResults = await importBulkRows(
        validRows,
        loggedBy.trim(),
        submitMovement,
        (done, total) => setProgress({ done, total }),
      );
      setResults(importResults);
      setPhase("done");
      if (importResults.some((r) => r.ok)) onImported();
    } catch (err: unknown) {
      setParseError(err instanceof Error ? err.message : String(err));
      setPhase("preview");
    } finally {
      setBusy(false);
    }
  }

  const successCount = results.filter((r) => r.ok).length;
  const failCount = results.filter((r) => !r.ok).length;

  return (
    <div
      className="modalBackdrop modalBackdrop--elevated"
      role="presentation"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="modalCard modalCardWide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-import-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="bulk-import-title" className="modalTitle">
          Bulk import defective stock
        </h2>
        <p className="formHint">
          Download the template, fill one inbound lot per row, then upload the file. Each valid row
          is saved as an inbound movement (photos can be attached later from History).
        </p>

        {parseError ? (
          <div className="formBanner error" role="alert">
            {parseError}
          </div>
        ) : null}

        {phase === "pick" || phase === "preview" ? (
          <div className="bulkImportActions">
            <button
              type="button"
              className="secondaryBtn"
              onClick={() => void onDownloadTemplate()}
              disabled={busy}
            >
              Download template
            </button>
            <label className={busy ? "secondaryBtn bulkImportFileBtn disabled" : "secondaryBtn bulkImportFileBtn"}>
              Upload CSV / Excel
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                hidden
                disabled={busy}
                onChange={(e) => void onFileChosen(e.target.files?.[0] ?? null)}
              />
            </label>
            {fileName ? <span className="hint mono">{fileName}</span> : null}
          </div>
        ) : null}

        {phase === "preview" ? (
          <>
            <div className="bulkImportSummary">
              <span>
                {validRows.length} ready
                {invalidRows.length ? ` · ${invalidRows.length} need fixing` : ""}
              </span>
              <span className="hint">Logged as {loggedBy.trim() || "—"}</span>
            </div>

            {invalidRows.length ? (
              <div className="bulkImportSection">
                <div className="cardTitle">Rows with errors</div>
                <div className="tableWrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Product</th>
                        <th>Errors</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invalidRows.map((row) => (
                        <tr key={`err-${row.rowNumber}`}>
                          <td className="mono">{row.rowNumber}</td>
                          <td>{row.raw.product_name || "—"}</td>
                          <td className="bulkImportErrors">{row.errors.join(" ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            {validRows.length ? (
              <div className="bulkImportSection">
                <div className="cardTitle">Rows to import</div>
                <div className="tableWrap bulkImportPreview">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Product</th>
                        <th>Batch</th>
                        <th>Expiry</th>
                        <th>Qty</th>
                        <th>Defect</th>
                        <th>Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {validRows.map((row) => (
                        <tr key={`ok-${row.rowNumber}`}>
                          <td className="mono">{row.rowNumber}</td>
                          <td>
                            {row.product_name}
                            {row.sku ? <div className="hint mono">{row.sku}</div> : null}
                          </td>
                          <td className="mono">{row.batch_code}</td>
                          <td className="mono">{formatExpiryDisplay(row.expiry_date)}</td>
                          <td>{row.quantity_pcs}</td>
                          <td>{row.defect_reason}</td>
                          <td>
                            {row.reject_source_type}
                            {row.reject_source_vendor ? (
                              <div className="hint">{row.reject_source_vendor}</div>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {phase === "importing" ? (
          <div className="formBanner">
            Importing {progress.done} of {progress.total}…
          </div>
        ) : null}

        {phase === "done" ? (
          <>
            <div
              className={
                failCount === 0 ? "formBanner success" : successCount === 0 ? "formBanner error" : "formBanner"
              }
            >
              Imported {successCount} of {results.length}
              {failCount ? ` (${failCount} failed)` : ""}.
            </div>
            {failCount ? (
              <div className="tableWrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Product</th>
                      <th>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results
                      .filter((r) => !r.ok)
                      .map((r) => (
                        <tr key={`fail-${r.rowNumber}`}>
                          <td className="mono">{r.rowNumber}</td>
                          <td>
                            {r.product_name} · {r.batch_code}
                          </td>
                          <td className="bulkImportErrors">{r.error}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        ) : null}

        <div className="formActions">
          <button type="button" className="secondaryBtn" onClick={onClose} disabled={busy}>
            {phase === "done" ? "Close" : "Cancel"}
          </button>
          {phase === "preview" ? (
            <button
              type="button"
              className="primaryBtn"
              disabled={busy || !validRows.length || !loggedBy.trim()}
              onClick={() => void onConfirmImport()}
            >
              Import {validRows.length} row{validRows.length === 1 ? "" : "s"}
            </button>
          ) : null}
          {phase === "done" && invalidRows.length === 0 && failCount > 0 ? (
            <button
              type="button"
              className="secondaryBtn"
              onClick={() => {
                setPhase("pick");
                setParsed([]);
                setResults([]);
                setFileName(null);
              }}
            >
              Try another file
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
