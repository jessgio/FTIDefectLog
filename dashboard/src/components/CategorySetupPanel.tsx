import React from "react";
import {
  SKU_LIST_CSV_LS_KEY,
  countEntriesWithCategory,
  mergeSkuEntries,
  parseSkuListFromCsvText,
  type SkuCsvFetchAttempt,
} from "../skuListCsv";
import type { SkuEntry } from "../skuList";

const LS_KEY = SKU_LIST_CSV_LS_KEY;

type ScriptProbe = {
  baseHasNewApi: boolean;
  skuListCount: number;
  skuListWithCategory: number;
};

async function probeScriptUrl(scriptUrl: string): Promise<ScriptProbe> {
  const base = scriptUrl.replace(/\/exec\/?$/, "/exec");
  const baseRes = await fetch(base, { cache: "no-store" });
  const rawBase = await baseRes.text();
  let baseHasNewApi = false;
  try {
    const j = JSON.parse(rawBase) as { hint?: string; api_version?: number };
    baseHasNewApi = Boolean(j.hint) || j.api_version === 3;
  } catch {
    /* ignore */
  }

  const listRes = await fetch(`${base}?action=sku_list`, { cache: "no-store" });
  const listText = await listRes.text();
  let skuListCount = 0;
  let skuListWithCategory = 0;
  try {
    const j = JSON.parse(listText) as { sku_list?: SkuEntry[] };
    const list = j.sku_list ?? [];
    skuListCount = list.length;
    skuListWithCategory = list.filter((e) => (e.product_category ?? "").trim()).length;
  } catch {
    /* ignore */
  }

  return { baseHasNewApi, skuListCount, skuListWithCategory };
}

type Props = {
  scriptUrl: string | null;
  entries: SkuEntry[];
  csvAttempts: SkuCsvFetchAttempt[];
  onEntriesUpdated: (entries: SkuEntry[]) => void;
};

export function CategorySetupPanel({
  scriptUrl,
  entries,
  csvAttempts,
  onEntriesUpdated,
}: Props): React.ReactElement {
  const [csvUrl, setCsvUrl] = React.useState(
    () => localStorage.getItem(LS_KEY) ?? "",
  );
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [probe, setProbe] = React.useState<ScriptProbe | null>(null);

  React.useEffect(() => {
    if (!scriptUrl) return;
    let cancelled = false;
    probeScriptUrl(scriptUrl)
      .then((p) => {
        if (!cancelled) setProbe(p);
      })
      .catch(() => {
        if (!cancelled) setProbe(null);
      });
    return () => {
      cancelled = true;
    };
  }, [scriptUrl]);

  async function loadFromCsvUrl(url: string): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      const trimmed = url.trim();
      localStorage.setItem(LS_KEY, trimmed);

      const res = await fetch(trimmed, { cache: "no-store", redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.trimStart().startsWith("<")) {
        throw new Error("Got HTML instead of CSV — publish the SKUList tab or check the URL");
      }

      const fromCsv = parseSkuListFromCsvText(text);
      if (!fromCsv.length) throw new Error("CSV has no product/SKU rows");

      const merged = mergeSkuEntries(entries, fromCsv);
      const n = countEntriesWithCategory(merged);
      if (n === 0) {
        throw new Error(
          'No category column found. Header should contain "category" or "product_category".',
        );
      }
      onEntriesUpdated(merged);
      setMsg(`Loaded ${n} SKUs with categories. The chart should update below.`);
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="categorySetup">
      {probe && !probe.baseHasNewApi ? (
        <p className="warnHint">
          Your Apps Script web app is still an <strong>old deployment</strong> (the base URL does
          not return <span className="mono">hint</span> or{" "}
          <span className="mono">api_version: 3</span>). Use the CSV loader below — you do not
          need to fix Apps Script first.
        </p>
      ) : null}

      <p className="formHint">
        <strong>Load categories from published SKUList CSV:</strong>
      </p>
      <ol className="categorySetupSteps">
        <li>Open Google Sheets → <strong>SKUList</strong> tab.</li>
        <li>
          <strong>File → Share → Publish to web</strong> → worksheet <strong>SKUList</strong> →
          CSV → Publish.
        </li>
        <li>Copy the published link and paste it below → <strong>Load categories</strong>.</li>
      </ol>

      <div className="categorySetupRow">
        <input
          className="fieldInput"
          type="url"
          value={csvUrl}
          onChange={(e) => setCsvUrl(e.target.value)}
          placeholder="Published CSV URL for SKUList tab"
          aria-label="Published SKUList CSV URL"
        />
        <button
          type="button"
          className="primaryBtn"
          disabled={busy || !csvUrl.trim()}
          onClick={() => void loadFromCsvUrl(csvUrl)}
        >
          {busy ? "Loading…" : "Load categories"}
        </button>
      </div>

      {msg ? (
        <p className={msg.includes("Loaded") ? "formBanner success" : "formBanner error"}>
          {msg}
        </p>
      ) : null}

      {csvAttempts.length ? (
        <details className="categorySetupDetails" open>
          <summary>CSV load attempts (automatic)</summary>
          <ul className="csvAttemptList">
            {csvAttempts.map((a, i) => (
              <li key={i} className={a.ok && a.withCategory > 0 ? "csvAttemptOk" : "csvAttemptFail"}>
                <span className="mono csvAttemptUrl">{a.url}</span>
                <span>{a.detail}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <p className="hint">
        On Vercel set <span className="mono">VITE_SKU_LIST_CSV_URL</span> and redeploy, or edit{" "}
        <span className="mono">dashboard/public/sku-list-config.json</span> with the{" "}
        <strong>Publish to web → CSV</strong> link for the SKUList tab (not the inventory tab).
      </p>
    </div>
  );
}
