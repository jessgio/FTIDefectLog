/**
 * FTI Defect Stock — movements web app
 * Create, list, update, delete movements; keeps inventory tab in sync.
 */

const MOVEMENTS_SHEET_NAME = "Movements";
const SKU_LIST_SHEET_NAME = "SKUList";
const FALLBACK_INVENTORY_SHEET_NAME = "Inventory";
/** Bump when SKU list API shape changes (dashboard checks this). */
const SKU_LIST_API_VERSION = 4;

const MOVEMENT_HEADERS = [
  "movement_id",
  "inventory_sheet_name",
  "timestamp_utc",
  "direction",
  "logged_by",
  "product_name",
  "sku",
  "batch_code",
  "expiry_date",
  "quantity_pcs",
  "defect_reason",
  "disposition",
  "notes",
  "rsp_per_unit",
  "cogs_per_unit",
  "defect_breakdown",
];

function createSheetsIfNeeded() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheetWithHeaders_(ss, MOVEMENTS_SHEET_NAME, MOVEMENT_HEADERS);
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const action = String(payload.action || "create").toLowerCase();
    if (action === "delete") return jsonResponse_({ ok: true, ...deleteMovement_(payload) });
    if (action === "patch_photos") return jsonResponse_({ ok: true, ...patchMovementPhotos_(payload) });
    if (action === "update") return jsonResponse_({ ok: true, ...updateMovement_(payload) });
    return jsonResponse_({ ok: true, ...handleMovement_(payload) });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err.message || err) });
  }
}

function doGet(e) {
  const action = e && e.parameter ? String(e.parameter.action || "") : "";
  if (action === "list") {
    try {
      return jsonResponse_({ ok: true, movements: listMovements_() });
    } catch (err) {
      return jsonResponse_({ ok: false, error: String(err.message || err) });
    }
  }
  if (action === "sku_list") {
    try {
      const map = loadSkuMap_();
      return jsonResponse_({
        ok: true,
        sku_list: map.list,
        sku_list_api_version: SKU_LIST_API_VERSION,
        sku_list_meta: map.meta,
      });
    } catch (err) {
      return jsonResponse_({ ok: false, error: String(err.message || err) });
    }
  }
  if (action === "sku_list_debug") {
    try {
      const map = loadSkuMap_();
      return jsonResponse_({
        ok: true,
        sku_list_api_version: SKU_LIST_API_VERSION,
        sku_list_meta: map.meta,
        sample: map.list.slice(0, 3),
      });
    } catch (err) {
      return jsonResponse_({ ok: false, error: String(err.message || err) });
    }
  }
  if (action === "drive_image") {
    try {
      return serveDriveImage_(e.parameter.id);
    } catch (err) {
      return ContentService.createTextOutput(String(err.message || err)).setMimeType(
        ContentService.MimeType.TEXT,
      );
    }
  }
  return jsonResponse_({
    ok: true,
    message: "FTI movements endpoint is running.",
    hint: "Add ?action=sku_list or ?action=sku_list_debug to this URL.",
    api_version: typeof SKU_LIST_API_VERSION !== "undefined" ? SKU_LIST_API_VERSION : 0,
    actions: ["list", "sku_list", "sku_list_debug", "drive_image"],
  });
}

/**
 * Run from the Apps Script editor (▶) to verify category column detection
 * without using the web app URL. View → Execution log.
 */
function testSkuListDebug() {
  const map = loadSkuMap_();
  Logger.log(JSON.stringify({
    api_version: SKU_LIST_API_VERSION,
    meta: map.meta,
    sample: map.list.slice(0, 3),
  }, null, 2));
}

function serveDriveImage_(fileId) {
  const id = String(fileId || "").trim();
  if (!id) throw new Error("id is required");
  const file = DriveApp.getFileById(id);
  return ContentService.createBlobOutput(file.getBlob());
}

function listSkuMappings_() {
  const map = loadSkuMap_();
  return map.list;
}

function normalizeSheetHeader_(h) {
  return String(h || "")
    .replace(/^\uFEFF/, "")
    .replace(/\u00A0/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, " ");
}

function findHeaderRowIndex_(data) {
  for (let r = 0; r < Math.min(8, data.length); r++) {
    const headers = data[r].map(normalizeSheetHeader_);
    const hasSku = headers.indexOf("sku") >= 0 || headers.indexOf("sku code") >= 0;
    const hasProduct =
      headers.indexOf("product_name") >= 0 ||
      headers.indexOf("product") >= 0 ||
      headers.indexOf("product name") >= 0;
    if (hasSku && hasProduct) return r;
  }
  return 0;
}

function findCategoryColumnIndex_(headers) {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (!h) continue;
    if (h.indexOf("categ") >= 0) return i;
    if (h.indexOf("kategori") >= 0) return i;
    if (h === "product type" || h === "producttype") return i;
  }
  return -1;
}

function findBarcodeColumnIndex_(headers) {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (!h) continue;
    if (h === "barcode" || h === "bar code") return i;
    if (h.indexOf("barcode") >= 0) return i;
    if (h === "ean" || h === "upc" || h === "gtin") return i;
  }
  return -1;
}

function readBarcodeCell_(sheet, rowIndex, colIndex, rawValue) {
  let barcode = String(rawValue || "").trim();
  if (!barcode && colIndex >= 0) {
    barcode = String(sheet.getRange(rowIndex + 1, colIndex + 1).getDisplayValue() || "").trim();
  }
  return barcode;
}

function loadSkuMap_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SKU_LIST_SHEET_NAME);
  const byProduct = {};
  const bySku = {};
  const byBarcode = {};
  const list = [];
  const meta = {
    sheet_name: SKU_LIST_SHEET_NAME,
    sheet_found: Boolean(sheet),
    sheet_gid: sheet ? sheet.getSheetId() : null,
    api_version: SKU_LIST_API_VERSION,
    headers: [],
    category_column_index: -1,
    category_column_header: "",
    rows_with_category: 0,
    barcode_column_index: -1,
    barcode_column_header: "",
    rows_with_barcode: 0,
  };

  if (!sheet) return { byProduct: byProduct, bySku: bySku, byBarcode: byBarcode, list: list, meta: meta };

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return { byProduct: byProduct, bySku: bySku, byBarcode: byBarcode, list: list, meta: meta };

  const headerRow = findHeaderRowIndex_(data);
  const headers = data[headerRow].map(normalizeSheetHeader_);
  meta.headers = headers.slice();

  let iProduct = headers.indexOf("product_name");
  if (iProduct < 0) iProduct = headers.indexOf("product");
  if (iProduct < 0) iProduct = headers.indexOf("product name");

  let iSku = headers.indexOf("sku");
  if (iSku < 0) iSku = headers.indexOf("sku code");

  let iImage = headers.indexOf("image_url");
  if (iImage < 0) iImage = headers.indexOf("image url");
  if (iImage < 0) iImage = headers.indexOf("image");
  if (iImage < 0) iImage = headers.indexOf("product_image");
  if (iImage < 0) iImage = headers.indexOf("photo");
  if (iImage < 0) iImage = headers.indexOf("drive");
  if (iImage < 0) iImage = headers.indexOf("drive link");

  let iRsp = headers.indexOf("rsp");
  if (iRsp < 0) iRsp = headers.indexOf("rsp_per_unit");
  if (iRsp < 0) iRsp = headers.indexOf("retail price");

  let iCogs = headers.indexOf("cogs");
  if (iCogs < 0) iCogs = headers.indexOf("cogs_per_unit");
  if (iCogs < 0) iCogs = headers.indexOf("cost");

  const iCategory = findCategoryColumnIndex_(headers);
  meta.category_column_index = iCategory;
  if (iCategory >= 0) meta.category_column_header = String(data[headerRow][iCategory] || "");

  const iBarcode = findBarcodeColumnIndex_(headers);
  meta.barcode_column_index = iBarcode;
  if (iBarcode >= 0) meta.barcode_column_header = String(data[headerRow][iBarcode] || "");

  if (iProduct < 0 || iSku < 0) {
    throw new Error('SKUList tab must have "product_name" (or "product") and "sku" columns.');
  }

  for (let r = headerRow + 1; r < data.length; r++) {
    const product = String(data[r][iProduct] || "").trim();
    const sku = String(data[r][iSku] || "").trim();
    if (!product || !sku) continue;

    const imageRaw = iImage >= 0 ? readSheetCellUrl_(sheet, r, iImage) : "";
    const imageUrl = normalizeImageUrl_(imageRaw);
    const rsp = iRsp >= 0 ? parseSheetPrice_(data[r][iRsp]) : null;
    const cogs = iCogs >= 0 ? parseSheetPrice_(data[r][iCogs]) : null;
    let category = "";
    if (iCategory >= 0) {
      category = String(data[r][iCategory] || "").trim();
      if (!category) {
        const display = sheet.getRange(r + 1, iCategory + 1).getDisplayValue();
        category = String(display || "").trim();
      }
    }
    if (category) meta.rows_with_category += 1;

    const barcode = readBarcodeCell_(sheet, r, iBarcode, iBarcode >= 0 ? data[r][iBarcode] : "");
    if (barcode) meta.rows_with_barcode += 1;

    const catalog = { sku: sku, product_name: product };
    if (category) catalog.product_category = category;
    if (barcode) catalog.barcode = barcode;
    if (imageUrl) catalog.image_url = imageUrl;
    if (rsp != null) catalog.rsp_per_unit = rsp;
    if (cogs != null) catalog.cogs_per_unit = cogs;

    const key = normalizeProductKey_(product);
    byProduct[key] = catalog;
    bySku[sku.toLowerCase()] = catalog;
    if (barcode) {
      const codes = String(barcode).split(/[,;|\n]+/);
      for (let c = 0; c < codes.length; c++) {
        const code = String(codes[c] || "").trim().toLowerCase();
        if (code && !byBarcode[code]) byBarcode[code] = catalog;
      }
    }

    const entry = { product_name: product, sku: sku };
    if (category) entry.product_category = category;
    if (barcode) entry.barcode = barcode;
    if (imageUrl) entry.image_url = imageUrl;
    if (rsp != null) entry.rsp_per_unit = rsp;
    if (cogs != null) entry.cogs_per_unit = cogs;
    list.push(entry);
  }

  return { byProduct: byProduct, bySku: bySku, byBarcode: byBarcode, list: list, meta: meta };
}

function parseSheetPrice_(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && isFinite(value)) return value;
  const s = String(value).trim().replace(/,/g, "");
  if (!s) return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}

function lookupCatalogEntry_(productName, sku) {
  const map = loadSkuMap_();
  const product = String(productName || "").trim();
  const skuCode = String(sku || "").trim().toLowerCase();

  if (product) {
    const hit = map.byProduct[normalizeProductKey_(product)];
    if (hit) return hit;
  }
  if (skuCode) {
    const hit = map.bySku[skuCode];
    if (hit) return hit;
  }
  return null;
}

function normalizeProductKey_(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function extractGoogleDriveFileId_(url) {
  const u = String(url || "").trim();
  if (!u) return "";

  const filePath = u.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (filePath) return filePath[1];

  const openMatch = u.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (openMatch && u.indexOf("google.com") >= 0) return openMatch[1];

  const ucMatch = u.match(/\/uc\?(?:export=[^&]+&)?id=([a-zA-Z0-9_-]+)/);
  if (ucMatch) return ucMatch[1];

  const thumbMatch = u.match(/thumbnail\?id=([a-zA-Z0-9_-]+)/);
  if (thumbMatch) return thumbMatch[1];

  return "";
}

function normalizeImageUrl_(url) {
  const u = String(url || "").trim();
  if (!u) return "";

  const fileId = extractGoogleDriveFileId_(u);
  if (fileId) return "https://drive.google.com/thumbnail?id=" + fileId + "&sz=w400";

  const freeImage = u.match(/freeimage\.host\/i\/([A-Za-z0-9]+)/i);
  if (freeImage) return "https://iili.io/" + freeImage[1] + ".jpg";

  return u;
}

/** Read URL from cell value, hyperlink formula, or rich-text link (common for pasted Drive URLs). */
function readSheetCellUrl_(sheet, rowIndex, colIndex) {
  if (colIndex < 0) return "";

  const range = sheet.getRange(rowIndex + 1, colIndex + 1);
  const value = String(range.getValue() || "").trim();
  const display = String(range.getDisplayValue() || "").trim();
  const formula = range.getFormula();

  if (formula) {
    const hyperlink = formula.match(/HYPERLINK\s*\(\s*"([^"]+)"/i);
    if (hyperlink) return String(hyperlink[1]).trim();
    const imageFormula = formula.match(/IMAGE\s*\(\s*"([^"]+)"/i);
    if (imageFormula) return String(imageFormula[1]).trim();
  }

  try {
    const rich = range.getRichTextValue();
    if (rich) {
      const runs = rich.getRuns();
      for (let i = 0; i < runs.length; i++) {
        const link = runs[i].getLinkUrl();
        if (link) return String(link).trim();
      }
    }
  } catch (e) {
    // ignore
  }

  if (value.indexOf("http") === 0) return value;
  if (display.indexOf("http") === 0) return display;
  return value || display;
}

const DEFECT_PHOTOS_FOLDER_NAME = "FTI Defect Stock Photos";
const MAX_PHOTOS_PER_DEFECT_LINE = 2;

function getDefectPhotosFolder_() {
  const folders = DriveApp.getFoldersByName(DEFECT_PHOTOS_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(DEFECT_PHOTOS_FOLDER_NAME);
}

function isDataUrl_(url) {
  return String(url || "").indexOf("data:") === 0;
}

function uploadDefectPhotoDataUrl_(dataUrl, fileName) {
  const s = String(dataUrl || "");
  const match = s.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return s.trim();

  const mime = match[1];
  const b64 = match[2];
  const ext = mime.indexOf("png") >= 0 ? "png" : mime.indexOf("webp") >= 0 ? "webp" : "jpg";
  const blob = Utilities.newBlob(Utilities.base64Decode(b64), mime, fileName + "." + ext);
  const file = getDefectPhotosFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return "https://drive.google.com/uc?export=view&id=" + file.getId();
}

function processDefectLinesPhotos_(lines, movementId) {
  if (!lines || !lines.length) return lines;

  return lines.map(function (line, idx) {
    const piece = Number(line.piece) || idx + 1;
    const out = {
      piece: piece,
      defect_reason: String(line.defect_reason || "").trim(),
    };

    const raw = line.photo_urls || [];
    const urls = [];
    for (let i = 0; i < raw.length && i < MAX_PHOTOS_PER_DEFECT_LINE; i++) {
      let u = String(raw[i] || "").trim();
      if (!u) continue;
      if (isDataUrl_(u)) {
        u = uploadDefectPhotoDataUrl_(u, movementId + "-pc" + piece + "-" + (i + 1));
      }
      urls.push(normalizeImageUrl_(u));
    }
    if (urls.length) out.photo_urls = urls;
    return out;
  });
}

/** Fill missing sku, product_name, rsp, cogs from SKUList before writing inventory. */
function resolveSkuOnPayload_(payload) {
  const map = loadSkuMap_();
  let product = String(payload.product_name || "").trim();
  let sku = String(payload.sku || "").trim();
  let catalog = null;

  if (product) catalog = map.byProduct[normalizeProductKey_(product)];

  if (!sku && catalog) sku = catalog.sku;

  if (!product && sku) {
    catalog = map.bySku[sku.toLowerCase()];
    if (catalog) product = catalog.product_name;
  }

  if (!catalog && product) catalog = map.byProduct[normalizeProductKey_(product)];
  if (!catalog && sku) catalog = map.bySku[sku.toLowerCase()];

  payload.product_name = product;
  payload.sku = sku;

  if (!catalog) return;

  if (
    (payload.rsp_per_unit == null || payload.rsp_per_unit === "") &&
    catalog.rsp_per_unit != null
  ) {
    payload.rsp_per_unit = catalog.rsp_per_unit;
  }
  if (
    (payload.cogs_per_unit == null || payload.cogs_per_unit === "") &&
    catalog.cogs_per_unit != null
  ) {
    payload.cogs_per_unit = catalog.cogs_per_unit;
  }
}

function listMovements_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  createSheetsIfNeeded();
  const sheet = ss.getSheetByName(MOVEMENTS_SHEET_NAME);
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  const col = buildMovementsColumnMap_(data[0]);
  backfillMovementIds_(sheet, data, col);

  const rows = [];
  for (let r = 1; r < data.length; r++) {
    const rec = rowToMovementRecord_(data[r], col);
    if (rec) rows.push(rec);
  }
  rows.sort(function (a, b) {
    return String(b.timestamp_utc).localeCompare(String(a.timestamp_utc));
  });
  return rows;
}

function backfillMovementIds_(sheet, data, col) {
  if (col.movement_id < 0) return;
  for (let r = 1; r < data.length; r++) {
    const id = String(data[r][col.movement_id] || "").trim();
    if (!id) {
      const newId = Utilities.getUuid();
      sheet.getRange(r + 1, col.movement_id + 1).setValue(newId);
      data[r][col.movement_id] = newId;
    }
  }
}

function deleteMovement_(payload) {
  const movementId = String(payload.movement_id || "").trim();
  if (!movementId) throw new Error("movement_id is required");

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const found = findMovementRow_(ss, movementId);
  const record = rowToMovementRecord_(found.data[found.rowIndex], found.col);
  if (!record) throw new Error("Movement not found");

  const sheetName = record.inventory_sheet_name || resolveInventorySheetName_(payload);
  const invSheet = ss.getSheetByName(sheetName);
  if (!invSheet) throw new Error('Inventory tab not found: "' + sheetName + '"');

  reverseMovementEffect_(invSheet, recordToPayload_(record));
  found.sheet.deleteRow(found.rowIndex + 1);
  return { deleted: movementId };
}

function patchMovementPhotos_(payload) {
  const movementId = String(payload.movement_id || "").trim();
  if (!movementId) throw new Error("movement_id is required");

  const linesIn = payload.defect_lines;
  if (!linesIn || !linesIn.length) {
    throw new Error("defect_lines is required");
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const found = findMovementRow_(ss, movementId);
  const record = rowToMovementRecord_(found.data[found.rowIndex], found.col);
  if (!record) throw new Error("Movement not found");
  if (String(record.direction).toLowerCase() !== "inbound") {
    throw new Error("Photos can only be added to inbound entries.");
  }

  const qty = Number(record.quantity_pcs);
  if (linesIn.length !== qty) {
    throw new Error("defect_lines length must match entry quantity (" + qty + ").");
  }

  const processed = processDefectLinesPhotos_(linesIn, movementId);

  if (found.col.defect_breakdown >= 0) {
    found.sheet
      .getRange(found.rowIndex + 1, found.col.defect_breakdown + 1)
      .setValue(JSON.stringify(processed));
  }
  if (found.col.defect_reason >= 0) {
    found.sheet
      .getRange(found.rowIndex + 1, found.col.defect_reason + 1)
      .setValue(summarizeDefectLines_({ defect_lines: processed }));
  }

  return { patched: movementId };
}

function updateMovement_(payload) {
  const movementId = String(payload.movement_id || "").trim();
  if (!movementId) throw new Error("movement_id is required");

  resolveSkuOnPayload_(payload);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const found = findMovementRow_(ss, movementId);
  const oldRecord = rowToMovementRecord_(found.data[found.rowIndex], found.col);
  if (!oldRecord) throw new Error("Movement not found");

  const sheetName = resolveInventorySheetName_(payload) || oldRecord.inventory_sheet_name;
  const invSheet = ss.getSheetByName(sheetName);
  if (!invSheet) throw new Error('Inventory tab not found: "' + sheetName + '"');

  reverseMovementEffect_(invSheet, recordToPayload_(oldRecord));

  const newPayload = Object.assign({}, payload);
  newPayload.inventory_sheet_name = sheetName;
  if (newPayload.defect_lines && newPayload.defect_lines.length) {
    newPayload.defect_lines = processDefectLinesPhotos_(newPayload.defect_lines, movementId);
  }
  applyMovementEffect_(invSheet, newPayload);

  writeMovementRowValues_(found.sheet, found.rowIndex + 1, found.col, newPayload, movementId, sheetName);
  return { updated: movementId };
}

function handleMovement_(payload) {
  const direction = String(payload.direction || "").toLowerCase();
  if (direction !== "inbound" && direction !== "outbound") {
    throw new Error("direction must be inbound or outbound");
  }

  const loggedBy = String(payload.logged_by || "").trim();
  let product = String(payload.product_name || "").trim();
  const skuHint = String(payload.sku || "").trim();
  const batch = String(payload.batch_code || "").trim();
  const expiry = normalizeExpiry_(payload.expiry_date);
  const qty = Number(payload.quantity_pcs);

  if (!loggedBy) throw new Error("logged_by is required");
  if (!batch) throw new Error("batch_code is required");
  if (!product && !skuHint) {
    throw new Error("product_name or sku is required");
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error("quantity_pcs must be a positive number");
  }

  resolveSkuOnPayload_(payload);
  product = String(payload.product_name || "").trim();
  if (!product) throw new Error("product_name is required (or provide a known SKU).");

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  createSheetsIfNeeded();

  const sheetName = resolveInventorySheetName_(payload);
  const invSheet = ss.getSheetByName(sheetName);
  if (!invSheet) {
    throw new Error(
      'Worksheet "' +
        sheetName +
        '" not found. Set VITE_INVENTORY_SHEET_NAME in dashboard/.env.',
    );
  }

  const movementId = appendMovementRow_(ss, direction, payload, loggedBy, product, batch, expiry, qty, sheetName);
  const inventoryResult = applyMovementEffect_(invSheet, payload);

  return {
    movement_id: movementId,
    direction: direction,
    quantity_pcs: qty,
    inventory_sheet: sheetName,
    inventory: inventoryResult,
  };
}

function applyMovementEffect_(sheet, payload) {
  const direction = String(payload.direction || "").toLowerCase();
  const product = String(payload.product_name || "").trim();
  const batch = String(payload.batch_code || "").trim();
  const expiry = normalizeExpiry_(payload.expiry_date);
  const qty = Number(payload.quantity_pcs);

  if (direction === "inbound" && payload.defect_lines && payload.defect_lines.length > 0) {
    if (payload.defect_lines.length !== qty) {
      throw new Error("defect_lines length must match quantity_pcs (" + qty + ").");
    }
    return applyInboundByDefectLines_(sheet, payload, product, batch, expiry, payload.defect_lines);
  }
  return applyInventoryChange_(sheet, direction, payload, product, batch, expiry, qty);
}

function reverseMovementEffect_(sheet, payload) {
  const product = String(payload.product_name || "").trim();
  const batch = String(payload.batch_code || "").trim();
  const expiry = normalizeExpiry_(payload.expiry_date);

  if (payload.direction === "inbound" && payload.defect_lines && payload.defect_lines.length) {
    subtractInboundByDefectLines_(sheet, payload, product, batch, expiry, payload.defect_lines);
    return;
  }

  const reversed = Object.assign({}, payload, {
    direction: payload.direction === "inbound" ? "outbound" : "inbound",
  });
  applyMovementEffect_(sheet, reversed);
}

function subtractInboundByDefectLines_(sheet, payload, product, batch, expiry, lines) {
  const counts = {};
  for (let i = 0; i < lines.length; i++) {
    const d = String((lines[i] && lines[i].defect_reason) || "").trim();
    if (!d) continue;
    counts[d] = (counts[d] || 0) + 1;
  }
  for (const defect in counts) {
    const count = counts[defect];
    const slice = Object.assign({}, payload, {
      direction: "outbound",
      quantity_pcs: count,
      defect_reason: defect,
      defect_lines: [],
    });
    applyInventoryChange_(sheet, "outbound", slice, product, batch, expiry, count);
  }
}

function recordToPayload_(record) {
  return {
    inventory_sheet_name: record.inventory_sheet_name,
    direction: record.direction,
    logged_by: record.logged_by,
    product_name: record.product_name,
    sku: record.sku || "",
    batch_code: record.batch_code,
    expiry_date: record.expiry_date,
    quantity_pcs: record.quantity_pcs,
    defect_reason: record.defect_reason || "",
    disposition: record.disposition || "",
    notes: record.notes || "",
    rsp_per_unit: record.rsp_per_unit,
    cogs_per_unit: record.cogs_per_unit,
    defect_lines: record.defect_lines || [],
  };
}

function rowToMovementRecord_(row, col) {
  const movementId = col.movement_id >= 0 ? String(row[col.movement_id] || "").trim() : "";
  const product = col.product_name >= 0 ? String(row[col.product_name] || "").trim() : "";
  if (!movementId && !product) return null;

  let defectLines = [];
  if (col.defect_breakdown >= 0 && row[col.defect_breakdown]) {
    try {
      defectLines = JSON.parse(String(row[col.defect_breakdown]));
    } catch (e) {
      defectLines = [];
    }
  }

  return {
    movement_id: movementId || Utilities.getUuid(),
    inventory_sheet_name:
      col.inventory_sheet_name >= 0 ? String(row[col.inventory_sheet_name] || "").trim() : "",
    timestamp_utc: col.timestamp_utc >= 0 ? String(row[col.timestamp_utc] || "") : "",
    direction: col.direction >= 0 ? String(row[col.direction] || "").trim() : "",
    logged_by: col.logged_by >= 0 ? String(row[col.logged_by] || "").trim() : "",
    product_name: product,
    sku: col.sku >= 0 ? String(row[col.sku] || "").trim() : "",
    batch_code: col.batch_code >= 0 ? String(row[col.batch_code] || "").trim() : "",
    expiry_date:
      col.expiry_date >= 0 ? normalizeExpiry_(row[col.expiry_date]) : "",
    quantity_pcs: col.quantity_pcs >= 0 ? Number(row[col.quantity_pcs]) || 0 : 0,
    defect_reason: col.defect_reason >= 0 ? String(row[col.defect_reason] || "").trim() : "",
    disposition: col.disposition >= 0 ? String(row[col.disposition] || "").trim() : "",
    notes: col.notes >= 0 ? String(row[col.notes] || "").trim() : "",
    rsp_per_unit:
      col.rsp_per_unit >= 0 && row[col.rsp_per_unit] !== "" ? Number(row[col.rsp_per_unit]) : undefined,
    cogs_per_unit:
      col.cogs_per_unit >= 0 && row[col.cogs_per_unit] !== ""
        ? Number(row[col.cogs_per_unit])
        : undefined,
    defect_lines: defectLines,
  };
}

function findMovementRow_(ss, movementId) {
  const sheet = ss.getSheetByName(MOVEMENTS_SHEET_NAME);
  if (!sheet) throw new Error("Movements sheet not found");
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) throw new Error("Movement not found");

  const col = buildMovementsColumnMap_(data[0]);
  if (col.movement_id < 0) throw new Error("Movements sheet missing movement_id column");

  for (let r = 1; r < data.length; r++) {
    if (String(data[r][col.movement_id] || "").trim() === movementId) {
      return { sheet: sheet, data: data, rowIndex: r, col: col };
    }
  }
  throw new Error("Movement not found: " + movementId);
}

function resolveInventorySheetName_(payload) {
  const fromClient = String(payload.inventory_sheet_name || "").trim();
  if (fromClient) return fromClient;
  return FALLBACK_INVENTORY_SHEET_NAME;
}

function appendMovementRow_(ss, direction, payload, loggedBy, product, batch, expiry, qty, sheetName) {
  const sheet = ss.getSheetByName(MOVEMENTS_SHEET_NAME);
  const movementId = Utilities.getUuid();
  if (payload.defect_lines && payload.defect_lines.length) {
    payload.defect_lines = processDefectLinesPhotos_(payload.defect_lines, movementId);
  }
  const col = buildMovementsColumnMap_(ensureMovementHeaders_(sheet));

  const width = Math.max(sheet.getLastColumn(), MOVEMENT_HEADERS.length);
  const row = new Array(width).fill("");

  const summaryDefect =
    direction === "inbound" ? summarizeDefectLines_(payload) || String(payload.defect_reason || "") : "";
  const inventoryDefect =
    direction === "outbound" ? String(payload.defect_reason || "") : summaryDefect;

  if (col.movement_id >= 0) row[col.movement_id] = movementId;
  if (col.inventory_sheet_name >= 0) row[col.inventory_sheet_name] = sheetName;
  if (col.timestamp_utc >= 0) row[col.timestamp_utc] = new Date().toISOString();
  if (col.direction >= 0) row[col.direction] = direction;
  if (col.logged_by >= 0) row[col.logged_by] = loggedBy;
  if (col.product_name >= 0) row[col.product_name] = product;
  if (col.sku >= 0) row[col.sku] = String(payload.sku || "");
  if (col.batch_code >= 0) row[col.batch_code] = batch;
  if (col.expiry_date >= 0) row[col.expiry_date] = expiry;
  if (col.quantity_pcs >= 0) row[col.quantity_pcs] = qty;
  if (col.defect_reason >= 0) row[col.defect_reason] = inventoryDefect;
  if (col.disposition >= 0) row[col.disposition] = direction === "outbound" ? String(payload.disposition || "") : "";
  if (col.notes >= 0) row[col.notes] = String(payload.notes || "");
  if (col.rsp_per_unit >= 0 && payload.rsp_per_unit != null && payload.rsp_per_unit !== "") {
    row[col.rsp_per_unit] = Number(payload.rsp_per_unit);
  }
  if (col.cogs_per_unit >= 0 && payload.cogs_per_unit != null && payload.cogs_per_unit !== "") {
    row[col.cogs_per_unit] = Number(payload.cogs_per_unit);
  }
  if (col.defect_breakdown >= 0 && payload.defect_lines && payload.defect_lines.length) {
    row[col.defect_breakdown] = JSON.stringify(payload.defect_lines);
  }

  sheet.appendRow(row);
  return movementId;
}

function writeMovementRowValues_(sheet, rowNumber, col, payload, movementId, sheetName) {
  const direction = String(payload.direction || "").toLowerCase();
  const summaryDefect =
    direction === "inbound" ? summarizeDefectLines_(payload) || String(payload.defect_reason || "") : "";
  const inventoryDefect =
    direction === "outbound" ? String(payload.defect_reason || "") : summaryDefect;

  if (col.inventory_sheet_name >= 0) {
    sheet.getRange(rowNumber, col.inventory_sheet_name + 1).setValue(sheetName);
  }
  if (col.timestamp_utc >= 0) {
    sheet.getRange(rowNumber, col.timestamp_utc + 1).setValue(new Date().toISOString());
  }
  if (col.direction >= 0) sheet.getRange(rowNumber, col.direction + 1).setValue(direction);
  if (col.logged_by >= 0) sheet.getRange(rowNumber, col.logged_by + 1).setValue(String(payload.logged_by || ""));
  if (col.product_name >= 0) {
    sheet.getRange(rowNumber, col.product_name + 1).setValue(String(payload.product_name || ""));
  }
  if (col.sku >= 0) sheet.getRange(rowNumber, col.sku + 1).setValue(String(payload.sku || ""));
  if (col.batch_code >= 0) sheet.getRange(rowNumber, col.batch_code + 1).setValue(String(payload.batch_code || ""));
  if (col.expiry_date >= 0) {
    sheet.getRange(rowNumber, col.expiry_date + 1).setValue(normalizeExpiry_(payload.expiry_date));
  }
  if (col.quantity_pcs >= 0) sheet.getRange(rowNumber, col.quantity_pcs + 1).setValue(Number(payload.quantity_pcs));
  if (col.defect_reason >= 0) sheet.getRange(rowNumber, col.defect_reason + 1).setValue(inventoryDefect);
  if (col.disposition >= 0) {
    sheet.getRange(rowNumber, col.disposition + 1).setValue(
      direction === "outbound" ? String(payload.disposition || "") : "",
    );
  }
  if (col.notes >= 0) sheet.getRange(rowNumber, col.notes + 1).setValue(String(payload.notes || ""));
  if (col.rsp_per_unit >= 0) {
    sheet.getRange(rowNumber, col.rsp_per_unit + 1).setValue(
      payload.rsp_per_unit != null && payload.rsp_per_unit !== "" ? Number(payload.rsp_per_unit) : "",
    );
  }
  if (col.cogs_per_unit >= 0) {
    sheet.getRange(rowNumber, col.cogs_per_unit + 1).setValue(
      payload.cogs_per_unit != null && payload.cogs_per_unit !== "" ? Number(payload.cogs_per_unit) : "",
    );
  }
  if (col.defect_breakdown >= 0) {
    sheet.getRange(rowNumber, col.defect_breakdown + 1).setValue(
      payload.defect_lines && payload.defect_lines.length ? JSON.stringify(payload.defect_lines) : "",
    );
  }
  if (col.movement_id >= 0) sheet.getRange(rowNumber, col.movement_id + 1).setValue(movementId);
}

function ensureMovementHeaders_(sheet) {
  MOVEMENT_HEADERS.forEach(function (h) {
    ensureOptionalHeader_(sheet, h);
  });
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  return headers;
}

function buildMovementsColumnMap_(headerRow) {
  const headers = headerRow.map(function (h) {
    return String(h).trim().toLowerCase();
  });
  function idx(name) {
    return headers.indexOf(name);
  }
  return {
    movement_id: idx("movement_id"),
    inventory_sheet_name: idx("inventory_sheet_name"),
    timestamp_utc: idx("timestamp_utc"),
    direction: idx("direction"),
    logged_by: idx("logged_by"),
    product_name: idx("product_name"),
    sku: idx("sku"),
    batch_code: idx("batch_code"),
    expiry_date: idx("expiry_date"),
    quantity_pcs: idx("quantity_pcs"),
    defect_reason: idx("defect_reason"),
    disposition: idx("disposition"),
    notes: idx("notes"),
    rsp_per_unit: idx("rsp_per_unit"),
    cogs_per_unit: idx("cogs_per_unit"),
    defect_breakdown: idx("defect_breakdown"),
  };
}

function summarizeDefectLines_(payload) {
  if (!payload.defect_lines || !payload.defect_lines.length) return "";
  const counts = {};
  for (let i = 0; i < payload.defect_lines.length; i++) {
    const d = String((payload.defect_lines[i] && payload.defect_lines[i].defect_reason) || "").trim();
    if (!d) continue;
    counts[d] = (counts[d] || 0) + 1;
  }
  const parts = [];
  for (const key in counts) {
    parts.push(key + " (" + counts[key] + ")");
  }
  return parts.join("; ");
}

function applyInboundByDefectLines_(sheet, payload, product, batch, expiry, lines) {
  const data = sheet.getDataRange().getValues();
  const col = buildColumnMap_(data[0].map(function (h) {
    return String(h).trim().toLowerCase();
  }));
  const pricing = resolveLotPricing_(data, col, product, batch, expiry, payload);

  const counts = {};
  for (let i = 0; i < lines.length; i++) {
    const d = String((lines[i] && lines[i].defect_reason) || "").trim();
    if (!d) throw new Error("Each piece must have a defect reason (piece " + (i + 1) + ").");
    counts[d] = (counts[d] || 0) + 1;
  }

  const results = [];
  for (const defect in counts) {
    const count = counts[defect];
    let matchRow = findInventoryRow_(data, col, product, batch, expiry, defect);
    if (matchRow >= 0) {
      const current = Number(data[matchRow][col.quantity_pcs]) || 0;
      const next = current + count;
      sheet.getRange(matchRow + 1, col.quantity_pcs + 1).setValue(next);
      data[matchRow][col.quantity_pcs] = next;
      backfillLotPricing_(sheet, data, col, matchRow, pricing);
      results.push({ defect: defect, action: "updated", added: count, new_quantity: next });
    } else {
      writeInventoryRow_(sheet, col, {
        product_name: product,
        sku: String(payload.sku || ""),
        defect_reason: defect,
        batch_code: batch,
        expiry_date: expiry,
        quantity_pcs: count,
        rsp_per_unit: pricing.rsp_per_unit,
        cogs_per_unit: pricing.cogs_per_unit,
      });
      results.push({ defect: defect, action: "created", added: count });
    }
  }
  return { mode: "by_piece", lines: lines.length, groups: results };
}

function applyInventoryChange_(sheet, direction, payload, product, batch, expiry, qty) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 1) throw new Error('Sheet "' + sheet.getName() + '" has no header row.');

  const col = buildColumnMap_(
    data[0].map(function (h) {
      return String(h).trim().toLowerCase();
    }),
  );

  const defectForMatch =
    direction === "outbound"
      ? String(payload.defect_reason || "")
      : String(payload.defect_reason || summarizeDefectLines_(payload) || "");

  const matchRow = findInventoryRow_(data, col, product, batch, expiry, defectForMatch);

  if (direction === "inbound") {
    const pricing = resolveLotPricing_(data, col, product, batch, expiry, payload);
    if (matchRow >= 0) {
      const current = Number(data[matchRow][col.quantity_pcs]) || 0;
      sheet.getRange(matchRow + 1, col.quantity_pcs + 1).setValue(current + qty);
      backfillLotPricing_(sheet, data, col, matchRow, pricing);
      return { action: "updated", row: matchRow + 1, new_quantity: current + qty };
    }
    writeInventoryRow_(sheet, col, {
      product_name: product,
      sku: String(payload.sku || ""),
      defect_reason: defectForMatch,
      batch_code: batch,
      expiry_date: expiry,
      quantity_pcs: qty,
      rsp_per_unit: pricing.rsp_per_unit,
      cogs_per_unit: pricing.cogs_per_unit,
    });
    return { action: "created", row: sheet.getLastRow() };
  }

  if (matchRow < 0) {
    throw new Error(
      'No matching lot on tab "' +
        sheet.getName() +
        '" (product + batch + expiry' +
        (defectForMatch ? " + defect" : "") +
        ").",
    );
  }
  const current = Number(data[matchRow][col.quantity_pcs]) || 0;
  if (qty > current) {
    throw new Error("Outbound quantity exceeds available stock (" + current + " pcs).");
  }
  const remaining = current - qty;
  sheet.getRange(matchRow + 1, col.quantity_pcs + 1).setValue(remaining);
  return { action: "updated", row: matchRow + 1, new_quantity: remaining };
}

function hasPricingValue_(v) {
  return v !== "" && v != null && !isNaN(Number(v));
}

function resolveLotPricing_(data, col, product, batch, expiry, payload) {
  let rsp =
    payload.rsp_per_unit != null && payload.rsp_per_unit !== "" ? Number(payload.rsp_per_unit) : null;
  let cogs =
    payload.cogs_per_unit != null && payload.cogs_per_unit !== "" ? Number(payload.cogs_per_unit) : null;

  const p = product.toLowerCase();
  const b = batch.toLowerCase();
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const rp = String(row[col.product_name] || "").trim().toLowerCase();
    const rb = String(row[col.batch_code] || "").trim().toLowerCase();
    const re = normalizeExpiry_(row[col.expiry_date]);
    if (rp !== p || rb !== b || re !== expiry) continue;

    if (rsp == null && col.rsp_per_unit >= 0 && hasPricingValue_(row[col.rsp_per_unit])) {
      rsp = Number(row[col.rsp_per_unit]);
    }
    if (cogs == null && col.cogs_per_unit >= 0 && hasPricingValue_(row[col.cogs_per_unit])) {
      cogs = Number(row[col.cogs_per_unit]);
    }
  }

  if (rsp == null || cogs == null) {
    const catalog = lookupCatalogEntry_(product, String(payload.sku || ""));
    if (catalog) {
      if (rsp == null && catalog.rsp_per_unit != null) rsp = catalog.rsp_per_unit;
      if (cogs == null && catalog.cogs_per_unit != null) cogs = catalog.cogs_per_unit;
    }
  }

  return {
    rsp_per_unit: rsp != null ? rsp : "",
    cogs_per_unit: cogs != null ? cogs : "",
  };
}

function backfillLotPricing_(sheet, data, col, rowIndex, pricing) {
  const rowNumber = rowIndex + 1;
  if (col.rsp_per_unit >= 0 && pricing.rsp_per_unit !== "") {
    const existing = data[rowIndex][col.rsp_per_unit];
    if (!hasPricingValue_(existing)) {
      sheet.getRange(rowNumber, col.rsp_per_unit + 1).setValue(pricing.rsp_per_unit);
      data[rowIndex][col.rsp_per_unit] = pricing.rsp_per_unit;
    }
  }
  if (col.cogs_per_unit >= 0 && pricing.cogs_per_unit !== "") {
    const existing = data[rowIndex][col.cogs_per_unit];
    if (!hasPricingValue_(existing)) {
      sheet.getRange(rowNumber, col.cogs_per_unit + 1).setValue(pricing.cogs_per_unit);
      data[rowIndex][col.cogs_per_unit] = pricing.cogs_per_unit;
    }
  }
}

function inventoryRowWidth_(sheet, col) {
  let width = Math.max(sheet.getLastColumn(), 1);
  for (const key in col) {
    if (col[key] >= 0) width = Math.max(width, col[key] + 1);
  }
  return width;
}

function writeInventoryRow_(sheet, col, values) {
  const width = inventoryRowWidth_(sheet, col);
  const row = new Array(width).fill("");

  row[col.product_name] = values.product_name;
  if (col.sku >= 0) row[col.sku] = values.sku;
  if (col.defect_reason >= 0) row[col.defect_reason] = values.defect_reason;
  row[col.batch_code] = values.batch_code;
  row[col.expiry_date] = values.expiry_date;
  row[col.quantity_pcs] = values.quantity_pcs;
  if (col.rsp_per_unit >= 0 && values.rsp_per_unit !== "") row[col.rsp_per_unit] = values.rsp_per_unit;
  if (col.cogs_per_unit >= 0 && values.cogs_per_unit !== "") row[col.cogs_per_unit] = values.cogs_per_unit;
  if (col.parsed_on >= 0) {
    row[col.parsed_on] = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  }

  sheet.appendRow(row);
}

function findInventoryRow_(data, col, product, batch, expiry, defectReason) {
  const p = product.toLowerCase();
  const b = batch.toLowerCase();
  const d = defectReason ? String(defectReason).trim().toLowerCase() : "";
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const rp = String(row[col.product_name] || "").trim().toLowerCase();
    const rb = String(row[col.batch_code] || "").trim().toLowerCase();
    const re = normalizeExpiry_(row[col.expiry_date]);
    if (rp !== p || rb !== b || re !== expiry) continue;
    if (d && col.defect_reason >= 0) {
      const rd = String(row[col.defect_reason] || "").trim().toLowerCase();
      if (rd !== d) continue;
    }
    return r;
  }
  return -1;
}

function buildColumnMap_(headers) {
  function req(name) {
    const i = headers.indexOf(name);
    if (i < 0) throw new Error('Missing required column "' + name + '" in header row.');
    return i;
  }
  function opt(name) {
    return headers.indexOf(name);
  }
  return {
    product_name: req("product_name"),
    batch_code: req("batch_code"),
    expiry_date: req("expiry_date"),
    quantity_pcs: req("quantity_pcs"),
    sku: opt("sku"),
    defect_reason: opt("defect_reason"),
    rsp_per_unit: opt("rsp_per_unit"),
    cogs_per_unit: opt("cogs_per_unit"),
    source_file: opt("source_file"),
    parsed_on: opt("parsed_on"),
    months_until_exp: opt("months_until_exp"),
  };
}

/** Empty string = no expiry (tools / non-dated products). */
function normalizeExpiry_(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  const lower = s.toLowerCase();
  if (lower === "n/a" || lower === "na" || lower === "no expiry" || lower === "no-expiry" || lower === "none") {
    return "";
  }
  return normalizeDate_(value);
}

function normalizeDate_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  const s = String(value || "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return s;
}

function ensureOptionalHeader_(sheet, headerName) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  for (let i = 0; i < headers.length; i++) {
    if (String(headers[i]).trim().toLowerCase() === headerName.toLowerCase()) return;
  }
  sheet.getRange(1, headers.length + 1).setValue(headerName);
}

function ensureSheetWithHeaders_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    headers.forEach(function (h) {
      ensureOptionalHeader_(sheet, h);
    });
  }
  return sheet;
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
