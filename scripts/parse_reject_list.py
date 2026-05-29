from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Optional

import pandas as pd


@dataclass(frozen=True)
class ParsedSheet:
    rows: pd.DataFrame
    header_row_index: int


def _find_header_row(df: pd.DataFrame) -> int:
    # We expect a row containing "PRODUCT", "BATCH", "EXP DATE", "QUANTITY"
    # (case-insensitive) in adjacent columns.
    def norm_cell(v: Any) -> str:
        if v is None or (isinstance(v, float) and pd.isna(v)):
            return ""
        return str(v).strip().lower()

    # pandas 3.x removed DataFrame.applymap; use per-column map instead.
    lowered = df.apply(lambda col: col.map(norm_cell))
    for i in range(len(lowered)):
        row = lowered.iloc[i].tolist()
        joined = " | ".join(row)
        if "product" in joined and "batch" in joined and "exp date" in joined and "quantity" in joined:
            return i
    raise ValueError("Could not find header row (expected PRODUCT/BATCH/EXP DATE/QUANTITY).")


def _parse_sheet(path: Path, sheet_name: str) -> ParsedSheet:
    raw = pd.read_excel(path, sheet_name=sheet_name, header=None)
    header_idx = _find_header_row(raw)
    header = raw.iloc[header_idx].tolist()
    body = raw.iloc[header_idx + 1 :].copy()
    body.columns = header
    return ParsedSheet(rows=body, header_row_index=header_idx)


def _to_iso_date(v: Any) -> Optional[str]:
    if pd.isna(v):
        return None
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    # Try parse strings like 2028-11-28 00:00:00
    s = str(v).strip()
    if not s:
        return None
    try:
        dt = pd.to_datetime(s, errors="raise")
        if pd.isna(dt):
            return None
        if isinstance(dt, pd.Timestamp):
            return dt.date().isoformat()
    except Exception:
        return None
    return None


def _normalize(df: pd.DataFrame) -> pd.DataFrame:
    # Only keep the "left table" columns; the sample file also contains a pivot-like summary on the right.
    # We keep any matching columns if they exist.
    cols = list(df.columns)

    def pick_idx(col: str) -> Optional[int]:
        for idx, c in enumerate(cols):
            if isinstance(c, str) and c.strip().lower() == col.lower():
                return idx
        return None

    i_product = pick_idx("PRODUCT")
    i_batch = pick_idx("BATCH")
    i_exp = pick_idx("EXP DATE")
    i_qty = pick_idx("QUANTITY")
    i_months = pick_idx("MONTHS UNTIL EXP")
    i_rsp = pick_idx("RSP")

    if not all([i_product is not None, i_batch is not None, i_qty is not None]):
        raise ValueError(
            "Missing required columns. Need at least PRODUCT, BATCH, QUANTITY (EXP DATE optional)."
        )

    if i_exp is not None:
        expiry_series = df.iloc[:, i_exp].map(_to_iso_date).fillna("")
    else:
        expiry_series = pd.Series([""] * len(df), index=df.index)

    out = pd.DataFrame(
        {
            "product_name": df.iloc[:, i_product],
            "sku": None,  # to be filled from a SKU master later
            "defect_reason": None,  # to be filled by warehouse team
            "batch_code": df.iloc[:, i_batch],
            "expiry_date": expiry_series,
            "quantity_pcs": pd.to_numeric(df.iloc[:, i_qty], errors="coerce"),
            "rsp_per_unit": pd.to_numeric(df.iloc[:, i_rsp], errors="coerce") if i_rsp is not None else None,
            "months_until_exp": pd.to_numeric(df.iloc[:, i_months], errors="coerce") if i_months is not None else None,
            "cogs_per_unit": None,  # to be filled from finance/SKU master
        }
    )

    out["product_name"] = out["product_name"].astype(str).str.strip()
    out["batch_code"] = out["batch_code"].astype(str).str.strip()

    # Drop empty rows / trailing notes
    out = out[(out["product_name"] != "") & (out["product_name"].str.lower() != "nan")]
    out = out[out["quantity_pcs"].notna()]
    out["quantity_pcs"] = out["quantity_pcs"].astype(int)

    # Deterministic ordering: soonest expiry first
    out["_expiry_sort"] = pd.to_datetime(out["expiry_date"], errors="coerce")
    out = out.sort_values(["_expiry_sort", "product_name", "batch_code"], na_position="last").drop(
        columns=["_expiry_sort"]
    )

    return out.reset_index(drop=True)


def _today_iso() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def main() -> None:
    ap = argparse.ArgumentParser(description="Parse FTI Reject List Excel into normalized CSV for Google Sheets.")
    ap.add_argument("--input", required=True, help="Path to Excel file")
    ap.add_argument("--sheet", default="Sheet1", help="Sheet name to parse (default: Sheet1)")
    ap.add_argument("--output", required=True, help="Output CSV path")
    args = ap.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    parsed = _parse_sheet(input_path, args.sheet)
    normalized = _normalize(parsed.rows)

    # Add provenance columns helpful for Sheets users
    normalized.insert(0, "source_file", input_path.name)
    normalized.insert(1, "parsed_on", _today_iso())

    normalized.to_csv(output_path, index=False, encoding="utf-8-sig")
    print(f"Wrote {len(normalized)} rows -> {output_path}")


if __name__ == "__main__":
    main()

