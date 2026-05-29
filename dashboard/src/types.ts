export type RejectRow = {
  source_file?: string;
  parsed_on?: string;

  product_name: string;
  sku?: string;
  /** Optional per-lot image URL from inventory sheet (else from SKUList) */
  image_url?: string;
  defect_reason?: string;
  batch_code: string;
  /** ISO YYYY-MM-DD, or empty for tools / non-dated products */
  expiry_date: string;
  quantity_pcs: number;
  rsp_per_unit?: number;
  months_until_exp?: number;
  cogs_per_unit?: number;
};

export type MovementDirection = "inbound" | "outbound";

/** One row per physical piece (inbound). */
export type DefectLine = {
  piece: number;
  defect_reason: string;
  /** Up to 2 HTTPS URLs (or data URLs during upload; Apps Script stores in Drive) */
  photo_urls?: string[];
};

export type MovementPayload = {
  action?: "create" | "update" | "delete";
  movement_id?: string;
  /** Worksheet tab name — must match the tab published for the dashboard */
  inventory_sheet_name?: string;
  direction: MovementDirection;
  logged_by: string;
  product_name: string;
  sku?: string;
  batch_code: string;
  expiry_date: string;
  quantity_pcs: number;
  /** Inbound: one entry per pc; length must equal quantity_pcs */
  defect_lines?: DefectLine[];
  defect_reason?: string;
  disposition?: string;
  notes?: string;
  rsp_per_unit?: number;
  cogs_per_unit?: number;
};

export type MovementRecord = {
  movement_id: string;
  inventory_sheet_name: string;
  timestamp_utc: string;
  direction: MovementDirection;
  logged_by: string;
  product_name: string;
  sku?: string;
  batch_code: string;
  expiry_date: string;
  quantity_pcs: number;
  defect_reason?: string;
  disposition?: string;
  notes?: string;
  rsp_per_unit?: number;
  cogs_per_unit?: number;
  defect_lines?: DefectLine[];
};
