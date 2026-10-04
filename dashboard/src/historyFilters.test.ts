import assert from "node:assert/strict";
import { movementsToSheetRows } from "./exportMovements";
import {
  collectSkuOptions,
  countActiveHistoryFilters,
  dateRangePreset,
  EMPTY_HISTORY_FILTERS,
  filterMovements,
  isDateRangeInverted,
  mergeSelectedSkus,
  movementDetail,
  type MovementHistoryFilters,
} from "./historyFilters";
import type { MovementRecord } from "./types";

function atNoon(ymd: string): string {
  const [year, month, day] = ymd.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0).toISOString();
}

function entry(partial: Partial<MovementRecord> & Pick<MovementRecord, "movement_id">): MovementRecord {
  return {
    timestamp_utc: atNoon("2026-06-15"),
    direction: "inbound",
    logged_by: "Ayu",
    product_name: "Serum",
    sku: "SER-1",
    batch_code: "B100",
    expiry_date: "2027-01-01",
    quantity_pcs: 2,
    ...partial,
  };
}

const rows: MovementRecord[] = [
  entry({
    movement_id: "in-1",
    timestamp_utc: atNoon("2026-06-01"),
    sku: "SER-1",
    batch_code: "B100",
    quantity_pcs: 3,
    defect_lines: [
      { piece: 1, defect_reason: "Dented packaging" },
      { piece: 2, defect_reason: "Dented packaging" },
      { piece: 3, defect_reason: "Damaged product" },
    ],
    defect_reason: "Dented packaging (2); Damaged product (1)",
    reject_source_type: "E-commerce returns",
    reject_source_vendor: "Shopee",
    notes: "rain damage",
    logged_by: "Ayu",
  }),
  entry({
    movement_id: "in-2",
    timestamp_utc: atNoon("2026-06-20"),
    product_name: "Cleanser",
    sku: "CLN-9",
    batch_code: "B200",
    expiry_date: "",
    quantity_pcs: 1,
    defect_reason: "Dirty packaging",
    reject_source_type: "B2B returns",
    reject_source_vendor: "Watsons",
    logged_by: "Budi",
  }),
  entry({
    movement_id: "out-1",
    timestamp_utc: atNoon("2026-07-02"),
    direction: "outbound",
    sku: "SER-1",
    batch_code: "B100",
    quantity_pcs: 1,
    disposition: "Destroyed",
    logged_by: "Ayu",
    notes: "scrap",
  }),
  entry({
    movement_id: "in-nosku",
    timestamp_utc: atNoon("2026-06-20"),
    sku: undefined,
    batch_code: "B300",
    quantity_pcs: 4,
    defect_reason: "Other",
  }),
];

function filters(partial: Partial<MovementHistoryFilters>): MovementHistoryFilters {
  return { ...EMPTY_HISTORY_FILTERS, skus: [], ...partial };
}

const ids = (list: MovementRecord[]) => list.map((row) => row.movement_id);

assert.deepEqual(ids(filterMovements(rows, EMPTY_HISTORY_FILTERS)), [
  "in-1",
  "in-2",
  "out-1",
  "in-nosku",
]);

assert.deepEqual(
  ids(filterMovements(rows, filters({ dateFrom: "2026-06-20", dateTo: "2026-07-02" }))),
  ["in-2", "out-1", "in-nosku"],
);
assert.deepEqual(ids(filterMovements(rows, filters({ dateFrom: "2026-06-01", dateTo: "2026-06-01" }))), [
  "in-1",
]);
assert.equal(isDateRangeInverted(filters({ dateFrom: "2026-08-01", dateTo: "2026-01-01" })), true);
assert.deepEqual(ids(filterMovements(rows, filters({ dateFrom: "2026-08-01", dateTo: "2026-01-01" }))), []);

assert.deepEqual(ids(filterMovements(rows, filters({ direction: "outbound" }))), ["out-1"]);
assert.deepEqual(ids(filterMovements(rows, filters({ direction: "inbound" }))).includes("out-1"), false);

assert.deepEqual(ids(filterMovements(rows, filters({ skus: ["ser-1", "missing"] }))), ["in-1", "out-1"]);
assert.deepEqual(ids(filterMovements(rows, filters({ skus: ["CLN-9"] }))), ["in-2"]);

assert.deepEqual(ids(filterMovements(rows, filters({ defectType: "Damaged product" }))), ["in-1"]);
assert.deepEqual(ids(filterMovements(rows, filters({ defectType: "dirty packaging" }))), ["in-2"]);
assert.deepEqual(ids(filterMovements(rows, filters({ defectType: "Dented packaging", direction: "outbound" }))), []);

assert.deepEqual(ids(filterMovements(rows, filters({ batch: "b200" }))), ["in-2"]);
assert.deepEqual(ids(filterMovements(rows, filters({ product: "clean" }))), ["in-2"]);
assert.deepEqual(ids(filterMovements(rows, filters({ loggedBy: "budi" }))), ["in-2"]);
assert.deepEqual(ids(filterMovements(rows, filters({ sourceType: "E-commerce returns" }))), ["in-1"]);
assert.deepEqual(ids(filterMovements(rows, filters({ vendor: "shop" }))), ["in-1"]);
assert.deepEqual(ids(filterMovements(rows, filters({ disposition: "destroyed" }))), ["out-1"]);
assert.deepEqual(ids(filterMovements(rows, filters({ expiry: "n/a" }))), ["in-2"]);
assert.deepEqual(ids(filterMovements(rows, filters({ notes: "scrap" }))), ["out-1"]);
assert.deepEqual(ids(filterMovements(rows, filters({ query: "rain" }))), ["in-1"]);

assert.equal(
  countActiveHistoryFilters(
    filters({ dateFrom: "2026-06-01", skus: ["SER-1"], batch: "  ", query: "ayu" }),
  ),
  3,
);

const merged = mergeSelectedSkus(["SER-1"], ["ser-1", "cln-9", "NEW"], [
  { sku: "CLN-9", productName: "Cleanser" },
]);
assert.deepEqual(merged, ["SER-1", "CLN-9", "NEW"]);

const options = collectSkuOptions(rows, [{ sku: "NEW-1", product_name: "Toner" }]);
assert.deepEqual(
  options.map((option) => option.sku),
  ["CLN-9", "NEW-1", "SER-1"],
);

assert.equal(movementDetail(rows[0]), "Dented packaging (2); Damaged product");
assert.equal(movementDetail(rows[2]), "Destroyed");

const sheet = movementsToSheetRows([rows[0], rows[2]]);
assert.equal(sheet[0].SKU, "SER-1");
assert.equal(sheet[0].Type, "Inbound");
assert.equal(sheet[0].Qty, 3);
assert.equal(sheet[0]["Defect pcs"], 3);
assert.equal(movementsToSheetRows([rows[0]], "Damaged product")[0]["Defect pcs"], 1);
assert.equal(movementsToSheetRows([rows[1]])[0]["Defect pcs"], 1);
assert.equal(sheet[0].Detail, "Dented packaging (2); Damaged product");
assert.equal(sheet[0]["Return channel"], "E-commerce returns");
assert.equal(sheet[0].Vendor, "Shopee");
assert.equal(sheet[1].Type, "Outbound");
assert.equal(sheet[1].Detail, "Destroyed");
assert.equal(sheet[1]["Return channel"], "");
assert.equal(sheet[1]["Movement ID"], "out-1");

const presetNow = new Date(2026, 5, 15, 9, 0, 0);
assert.deepEqual(dateRangePreset("today", presetNow), { dateFrom: "2026-06-15", dateTo: "2026-06-15" });
assert.deepEqual(dateRangePreset("7", presetNow), { dateFrom: "2026-06-09", dateTo: "2026-06-15" });
assert.deepEqual(dateRangePreset("month", presetNow), { dateFrom: "2026-06-01", dateTo: "2026-06-15" });

console.log("history filter tests passed");
