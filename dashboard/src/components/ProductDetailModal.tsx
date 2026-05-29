import React from "react";
import { formatExpiryDisplay } from "../expiry";
import { formatCurrencyIdr, formatInt } from "../format";
import {
  buildDefectEvidence,
  filterLotsForProduct,
  filterMovementsForProduct,
  type DefectEvidenceGroup,
} from "../productDefects";
import { ResolvedImage } from "./ResolvedImage";
import { productDetailCopy } from "../copy/productDetail";
import type { MovementRecord, RejectRow } from "../types";
import { ProductThumb } from "./ProductThumb";

type Props = {
  productName: string;
  lots: RejectRow[];
  movements: MovementRecord[];
  productImageUrl?: string;
  sku?: string;
  onClose: () => void;
};

function formatWhen(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function DefectGallery({ group }: { group: DefectEvidenceGroup }): React.ReactElement {
  const [lightbox, setLightbox] = React.useState<string | null>(null);

  return (
    <div className="defectEvidenceGroup">
      <div className="defectEvidenceHead">
        <strong>{group.defect_reason}</strong>
        <span className="hint">
          {formatInt(group.piece_count)} pc logged · {formatInt(group.photo_count)} photo
          {group.photo_count === 1 ? "" : "s"}
        </span>
      </div>
      {group.photos.length ? (
        <div className="defectPhotoGrid">
          {group.photos.map((p, i) => (
            <button
              key={`${p.movement_id}-${p.piece}-${i}`}
              type="button"
              className="defectPhotoGridItem"
              onClick={() => setLightbox(p.url)}
            >
              <ResolvedImage className="defectPhotoGridImg" url={p.url} />
              <span className="defectPhotoCaption">
                Pc {p.piece ?? "—"} · {p.batch_code}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="hint">No photos for this defect type yet.</p>
      )}
      {lightbox ? (
        <div
          className="lightboxBackdrop"
          role="presentation"
          onClick={() => setLightbox(null)}
        >
          <ResolvedImage
            className="lightboxImage"
            url={lightbox}
            alt=""
          />
        </div>
      ) : null}
    </div>
  );
}

export function ProductDetailModal({
  productName,
  lots,
  movements,
  productImageUrl,
  sku,
  onClose,
}: Props): React.ReactElement {
  const productLots = React.useMemo(
    () => filterLotsForProduct(lots, productName),
    [lots, productName],
  );
  const productMovements = React.useMemo(
    () => filterMovementsForProduct(movements, productName),
    [movements, productName],
  );
  const evidence = React.useMemo(
    () => buildDefectEvidence(productMovements),
    [productMovements],
  );

  const totalPcs = productLots.reduce((s, r) => s + r.quantity_pcs, 0);

  return (
    <div className="modalBackdrop" role="presentation" onClick={onClose}>
      <div
        className="modalCard modalCardWide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-detail-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="productDetailHead">
          <ProductThumb productName={productName} imageUrl={productImageUrl} size="md" />
          <div>
            <h2 id="product-detail-title" className="modalTitle">
              {productName}
            </h2>
            {sku ? (
              <div className="hint mono">
                SKU: {sku}
              </div>
            ) : null}
            <div className="hint">
              {formatInt(productLots.length)} lot{productLots.length === 1 ? "" : "s"} ·{" "}
              {formatInt(totalPcs)} pcs on hand
            </div>
          </div>
          <button type="button" className="linkButton modalClose" onClick={onClose}>
            Close
          </button>
        </div>

        <section className="productDetailSection">
          <h3 className="productDetailSectionTitle">Current stock lots</h3>
          {productLots.length ? (
            <div className="tableWrap">
              <table className="table tableCompact">
                <thead>
                  <tr>
                    <th>Defect</th>
                    <th>Batch</th>
                    <th>Expiry</th>
                    <th className="num">Qty</th>
                    <th className="num">RSP</th>
                  </tr>
                </thead>
                <tbody>
                  {productLots.map((r, i) => (
                    <tr key={`${r.batch_code}-${r.expiry_date}-${i}`}>
                      <td>{r.defect_reason ?? "—"}</td>
                      <td className="mono">{r.batch_code}</td>
                      <td className="mono">{formatExpiryDisplay(r.expiry_date)}</td>
                      <td className="num">{formatInt(r.quantity_pcs)}</td>
                      <td className="num">
                        {typeof r.rsp_per_unit === "number"
                          ? formatCurrencyIdr(r.rsp_per_unit)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="hint">{productDetailCopy.noLots}</p>
          )}
        </section>

        <section className="productDetailSection">
          <h3 className="productDetailSectionTitle">Defect evidence (from inbound logs)</h3>
          <p className="hint productDetailHint">
            Photos attached when warehouse logged defective stock. Grouped by defect type.
          </p>
          {evidence.length ? (
            evidence.map((g) => <DefectGallery key={g.defect_reason} group={g} />)
          ) : (
            <p className="hint">{productDetailCopy.noDefectPhotos}</p>
          )}
        </section>

        {productMovements.length ? (
          <section className="productDetailSection">
            <h3 className="productDetailSectionTitle">Recent movements</h3>
            <ul className="movementMiniList">
              {productMovements.slice(0, 8).map((m) => (
                <li key={m.movement_id}>
                  <span className="mono">{formatWhen(m.timestamp_utc)}</span>
                  {" · "}
                  {m.direction === "inbound" ? "Inbound" : "Outbound"}
                  {" · "}
                  {formatInt(m.quantity_pcs)} pcs
                  {m.batch_code ? (
                    <>
                      {" · batch "}
                      <span className="mono">{m.batch_code}</span>
                    </>
                  ) : null}
                  {m.logged_by ? <> · {m.logged_by}</> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
