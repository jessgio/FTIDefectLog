#!/usr/bin/env python3
"""One-time migration: Google Sheets exports → Supabase.

Requires:
  pip install pandas requests python-dotenv

Environment (never commit):
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

Usage:
  python scripts/migrate_google_to_supabase.py \\
    --products samples/SKUList.csv \\
    --inventory samples/inventory.csv \\
    --movements samples/movements.csv \\
    --migrate-photos

Movements CSV must include columns from the Movements tab (incl. movement_id, defect_breakdown JSON).
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import pandas as pd
import requests

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None  # type: ignore


def env(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        raise SystemExit(f"Missing environment variable: {name}")
    return v


def jwt_role(api_key: str) -> str | None:
    """Decode Supabase JWT payload role claim (no signature verification)."""
    try:
        parts = api_key.strip().split(".")
        if len(parts) != 3:
            return None
        payload = parts[1]
        payload += "=" * (-len(payload) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload))
        role = data.get("role")
        return str(role) if role is not None else None
    except Exception:
        return None


def assert_service_role_key(key: str) -> None:
    role = jwt_role(key)
    if role == "service_role":
        return
    if role in (None, "anon", "authenticated"):
        raise SystemExit(
            "SUPABASE_SERVICE_ROLE_KEY is not the service_role secret.\n"
            "Supabase Dashboard → Project Settings → API → copy the "
            "service_role key (labeled 'secret' / service_role — NOT anon or publishable).\n"
            f"Detected JWT role: {role!r}"
        )
    raise SystemExit(
        f"Unexpected JWT role {role!r} — expected 'service_role' for migration."
    )


def normalize_header(h: Any) -> str:
    return (
        str(h or "")
        .replace("\ufeff", "")
        .strip()
        .lower()
        .replace("_", " ")
        .replace("  ", " ")
    )


def find_col(headers: list[str], *candidates: str) -> int | None:
    for i, h in enumerate(headers):
        for c in candidates:
            if c in h or h == c:
                return i
    return None


def to_number(v: Any) -> float | None:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(",", "")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def normalize_expiry(v: Any) -> str | None:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    s = str(v).strip()
    if not s:
        return None
    lower = s.lower()
    if lower in {"n/a", "na", "no expiry", "no-expiry", "none"}:
        return None
    if re.match(r"^\d{4}-\d{2}-\d{2}", s):
        return s[:10]
    try:
        ts = pd.to_datetime(s, errors="coerce")
        if pd.isna(ts):
            return None
        return ts.date().isoformat()
    except Exception:
        return None


def inventory_lot_key(row: dict[str, Any]) -> tuple[str, str, str, str]:
    """Match DB unique index inventory_lots_lot_key_idx."""
    expiry = row.get("expiry_date")
    expiry_key = expiry if expiry else "1000-01-01"
    return (
        str(row["product_name"]).strip().lower(),
        str(row["batch_code"]).strip().lower(),
        str(expiry_key),
        str(row.get("defect_reason") or "").strip().lower(),
    )


def dedupe_inventory_lots(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """Merge CSV rows that share the same lot key (sum quantity_pcs)."""
    merged: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    for row in rows:
        key = inventory_lot_key(row)
        if key not in merged:
            merged[key] = dict(row)
            continue
        existing = merged[key]
        existing["quantity_pcs"] = int(existing["quantity_pcs"]) + int(row["quantity_pcs"])
        for field in ("sku", "rsp_per_unit", "cogs_per_unit", "source_file", "parsed_on"):
            if existing.get(field) in (None, "") and row.get(field) not in (None, ""):
                existing[field] = row[field]
    out = list(merged.values())
    return out, len(rows) - len(out)


def unify_row_keys(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """PostgREST requires every object in a batch to have the same keys."""
    if not rows:
        return rows
    all_keys: list[str] = []
    seen: set[str] = set()
    for row in rows:
        for key in row:
            if key not in seen:
                seen.add(key)
                all_keys.append(key)
    return [{key: row.get(key) for key in all_keys} for row in rows]


class SupabaseRest:
    def __init__(self, url: str, service_key: str) -> None:
        self.base = url.rstrip("/")
        self.headers = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        }

    def upsert(self, table: str, rows: list[dict[str, Any]], on_conflict: str | None = None) -> None:
        if not rows:
            return
        rows = unify_row_keys(rows)
        params = {}
        if on_conflict:
            params["on_conflict"] = on_conflict
        r = requests.post(
            f"{self.base}/rest/v1/{table}",
            headers={**self.headers, "Prefer": "resolution=merge-duplicates,return=minimal"},
            params=params,
            json=rows,
            timeout=120,
        )
        if r.status_code >= 400:
            hint = ""
            if r.status_code in (401, 403) or "row-level security" in r.text.lower():
                hint = (
                    " Hint: use SUPABASE_SERVICE_ROLE_KEY (service_role secret), not the anon key."
                )
            raise RuntimeError(
                f"Upsert {table} failed ({r.status_code}): {r.text[:500]}{hint}"
            )

    def insert(self, table: str, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        rows = unify_row_keys(rows)
        r = requests.post(
            f"{self.base}/rest/v1/{table}",
            headers=self.headers,
            json=rows,
            timeout=120,
        )
        if r.status_code >= 400:
            hint = ""
            if r.status_code in (401, 403) or "row-level security" in r.text.lower():
                hint = (
                    " Hint: use SUPABASE_SERVICE_ROLE_KEY (service_role secret), not the anon key."
                )
            raise RuntimeError(
                f"Insert {table} failed ({r.status_code}): {r.text[:500]}{hint}"
            )

    def clear_table(self, table: str) -> None:
        """Delete all rows (service_role only)."""
        r = requests.delete(
            f"{self.base}/rest/v1/{table}",
            headers=self.headers,
            params={"id": "not.is.null"},
            timeout=120,
        )
        if r.status_code >= 400:
            raise RuntimeError(f"Clear {table} failed ({r.status_code}): {r.text[:500]}")

    def upload_storage(self, bucket: str, path: str, content: bytes, content_type: str) -> None:
        r = requests.post(
            f"{self.base}/storage/v1/object/{bucket}/{path}",
            headers={
                **self.headers,
                "Content-Type": content_type,
                "x-upsert": "true",
            },
            data=content,
            timeout=120,
        )
        if r.status_code >= 400:
            raise RuntimeError(f"Storage upload failed ({r.status_code}): {r.text[:300]}")


def load_csv(path: Path) -> pd.DataFrame:
    return pd.read_csv(path, dtype=str, keep_default_na=False)


def migrate_products(df: pd.DataFrame) -> list[dict[str, Any]]:
    headers = [normalize_header(c) for c in df.columns.tolist()]
    col = {name: i for i, name in enumerate(headers)}

    def cell(row: list[str], *names: str) -> str:
        for n in names:
            idx = col.get(n)
            if idx is not None:
                return str(row[idx] or "").strip()
        return ""

    rows: list[dict[str, Any]] = []
    for _, series in df.iterrows():
        row = series.tolist()
        sku = cell(row, "sku", "sku code")
        product = cell(row, "product name", "product_name", "product")
        if not sku or not product:
            continue
        out: dict[str, Any] = {
            "sku": sku,
            "product_name": product,
        }
        barcode = cell(row, "barcode", "bar code", "ean", "upc", "gtin")
        category = cell(row, "product category", "product_category", "category")
        image = cell(row, "image url", "image_url", "image", "product_image", "photo")
        rsp = to_number(cell(row, "rsp", "rsp per unit", "rsp_per_unit", "retail price"))
        cogs = to_number(cell(row, "cogs", "cogs per unit", "cogs_per_unit", "cost"))
        if barcode:
            out["barcode"] = barcode
        if category:
            out["product_category"] = category
        if image:
            out["image_url"] = image
        if rsp is not None:
            out["rsp_per_unit"] = rsp
        if cogs is not None:
            out["cogs_per_unit"] = cogs
        rows.append(out)
    return rows


def migrate_inventory(df: pd.DataFrame) -> list[dict[str, Any]]:
    headers = [normalize_header(c) for c in df.columns.tolist()]
    col = {name: i for i, name in enumerate(headers)}

    def cell(row: list[str], *names: str) -> str:
        for n in names:
            idx = col.get(n)
            if idx is not None:
                return str(row[idx] or "").strip()
        return ""

    rows: list[dict[str, Any]] = []
    for _, series in df.iterrows():
        row = series.tolist()
        product = cell(row, "product name", "product_name")
        batch = cell(row, "batch code", "batch_code", "batch")
        qty = to_number(cell(row, "quantity pcs", "quantity_pcs", "quantity"))
        if not product or not batch or qty is None or qty <= 0:
            continue
        out: dict[str, Any] = {
            "product_name": product,
            "batch_code": batch,
            "quantity_pcs": int(qty),
            "defect_reason": cell(row, "defect reason", "defect_reason") or "",
        }
        sku = cell(row, "sku")
        expiry = normalize_expiry(cell(row, "expiry date", "expiry_date"))
        rsp = to_number(cell(row, "rsp per unit", "rsp_per_unit"))
        cogs = to_number(cell(row, "cogs per unit", "cogs_per_unit"))
        source = cell(row, "source file", "source_file")
        parsed = normalize_expiry(cell(row, "parsed on", "parsed_on"))
        if sku:
            out["sku"] = sku
        if expiry:
            out["expiry_date"] = expiry
        if rsp is not None:
            out["rsp_per_unit"] = rsp
        if cogs is not None:
            out["cogs_per_unit"] = cogs
        if source:
            out["source_file"] = source
        if parsed:
            out["parsed_on"] = parsed
        rows.append(out)
    return rows


def parse_defect_lines(raw: str) -> list[dict[str, Any]]:
    if not raw or not str(raw).strip():
        return []
    try:
        data = json.loads(raw)
        if isinstance(data, list):
            return data
    except json.JSONDecodeError:
        pass
    return []


def migrate_movements(df: pd.DataFrame) -> list[dict[str, Any]]:
    headers = [normalize_header(c) for c in df.columns.tolist()]
    col = {name: i for i, name in enumerate(headers)}

    def cell(row: list[str], *names: str) -> str:
        for n in names:
            idx = col.get(n)
            if idx is not None:
                return str(row[idx] or "").strip()
        return ""

    rows: list[dict[str, Any]] = []
    for _, series in df.iterrows():
        row = series.tolist()
        movement_id = cell(row, "movement id", "movement_id") or str(uuid.uuid4())
        direction = cell(row, "direction").lower()
        if direction not in {"inbound", "outbound"}:
            continue
        product = cell(row, "product name", "product_name")
        batch = cell(row, "batch code", "batch_code")
        qty = to_number(cell(row, "quantity pcs", "quantity_pcs"))
        logged_by = cell(row, "logged by", "logged_by")
        if not product or not batch or qty is None or qty <= 0 or not logged_by:
            continue

        ts = cell(row, "timestamp utc", "timestamp_utc", "created_at")
        if ts:
            try:
                created_at = pd.to_datetime(ts, utc=True).isoformat()
            except Exception:
                created_at = datetime.utcnow().isoformat() + "Z"
        else:
            created_at = datetime.utcnow().isoformat() + "Z"

        defect_lines = parse_defect_lines(cell(row, "defect breakdown", "defect_breakdown"))

        out: dict[str, Any] = {
            "id": movement_id,
            "direction": direction,
            "logged_by": logged_by,
            "product_name": product,
            "batch_code": batch,
            "quantity_pcs": int(qty),
            "defect_lines": defect_lines,
            "created_at": created_at,
        }
        sku = cell(row, "sku")
        expiry = normalize_expiry(cell(row, "expiry date", "expiry_date"))
        defect_reason = cell(row, "defect reason", "defect_reason")
        disposition = cell(row, "disposition")
        notes = cell(row, "notes")
        rsp = to_number(cell(row, "rsp per unit", "rsp_per_unit"))
        cogs = to_number(cell(row, "cogs per unit", "cogs_per_unit"))
        if sku:
            out["sku"] = sku
        if expiry:
            out["expiry_date"] = expiry
        if defect_reason:
            out["defect_reason"] = defect_reason
        if disposition:
            out["disposition"] = disposition
        if notes:
            out["notes"] = notes
        if rsp is not None:
            out["rsp_per_unit"] = rsp
        if cogs is not None:
            out["cogs_per_unit"] = cogs
        rows.append(out)
    return rows


def is_downloadable_url(url: str) -> bool:
    try:
        p = urlparse(url)
        return p.scheme in {"http", "https"}
    except Exception:
        return False


def migrate_photos(api: SupabaseRest, movements: list[dict[str, Any]], report: Path) -> None:
    failures: list[str] = []
    for m in movements:
        mid = str(m["id"])
        lines = m.get("defect_lines") or []
        if not isinstance(lines, list):
            continue
        changed = False
        for line in lines:
            urls = line.get("photo_urls") or []
            if not isinstance(urls, list):
                continue
            new_urls: list[str] = []
            piece = int(line.get("piece") or 1)
            for i, url in enumerate(urls[:2]):
                u = str(url or "").strip()
                if not u:
                    continue
                if u.startswith("defect-photos/"):
                    new_urls.append(u)
                    continue
                if not is_downloadable_url(u):
                    failures.append(f"{mid} pc{piece}: not a URL {u[:80]}")
                    continue
                try:
                    resp = requests.get(u, timeout=60)
                    resp.raise_for_status()
                    ctype = resp.headers.get("Content-Type", "image/jpeg").split(";")[0]
                    ext = "jpg" if "jpeg" in ctype else "png" if "png" in ctype else "jpg"
                    path = f"{mid}/pc{piece}-{i + 1}.{ext}"
                    api.upload_storage("defect-photos", path, resp.content, ctype)
                    new_urls.append(f"defect-photos/{path}")
                    changed = True
                except Exception as e:
                    failures.append(f"{mid} pc{piece}: {e}")
            if new_urls:
                line["photo_urls"] = new_urls
        if changed:
            m["defect_lines"] = lines

    report.write_text("\n".join(failures) if failures else "All photos migrated OK.\n", encoding="utf-8")
    if failures:
        print(f"Photo migration: {len(failures)} issue(s) — see {report}")


def main() -> None:
    if load_dotenv:
        load_dotenv()
        load_dotenv("dashboard/.env")

    parser = argparse.ArgumentParser(description="Migrate Google Sheets CSV exports to Supabase")
    parser.add_argument("--products", type=Path, help="SKUList tab CSV")
    parser.add_argument("--inventory", type=Path, help="Inventory tab CSV")
    parser.add_argument("--movements", type=Path, help="Movements tab CSV")
    parser.add_argument("--migrate-photos", action="store_true", help="Download Drive URLs → Storage")
    parser.add_argument("--photo-report", type=Path, default=Path("out/photo_migration_report.txt"))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--fresh",
        action="store_true",
        help="Clear inventory_lots and movements before insert (safe re-run)",
    )
    args = parser.parse_args()

    if not any([args.products, args.inventory, args.movements]):
        parser.error("Provide at least one of --products, --inventory, --movements")

    url = env("SUPABASE_URL") if not args.dry_run else os.environ.get("SUPABASE_URL", "http://local")
    key = env("SUPABASE_SERVICE_ROLE_KEY") if not args.dry_run else "dry-run"
    if not args.dry_run:
        assert_service_role_key(key)
        print(f"Using service_role key for {url}")
    api = SupabaseRest(url, key)

    if args.products:
        rows = migrate_products(load_csv(args.products))
        print(f"Products: {len(rows)} rows")
        if not args.dry_run:
            api.upsert("products", rows, on_conflict="sku")

    if args.inventory:
        raw_rows = migrate_inventory(load_csv(args.inventory))
        rows, merged = dedupe_inventory_lots(raw_rows)
        print(f"Inventory lots: {len(rows)} rows", end="")
        if merged:
            print(f" (merged {merged} duplicate CSV row(s))", end="")
        print()
        if not args.dry_run:
            if args.fresh:
                print("Clearing inventory_lots…")
                api.clear_table("inventory_lots")
            api.insert("inventory_lots", rows)

    movement_rows: list[dict[str, Any]] = []
    if args.movements:
        movement_rows = migrate_movements(load_csv(args.movements))
        print(f"Movements: {len(movement_rows)} rows")
        if args.migrate_photos and movement_rows:
            args.photo_report.parent.mkdir(parents=True, exist_ok=True)
            if not args.dry_run:
                migrate_photos(api, movement_rows, args.photo_report)
        if not args.dry_run:
            if args.fresh:
                print("Clearing movements…")
                api.clear_table("movements")
            api.insert("movements", movement_rows)

    print("Done.")


if __name__ == "__main__":
    main()
