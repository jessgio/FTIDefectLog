import React from "react";

type Props = {
  onScan: (code: string) => void;
  onClose: () => void;
};

export function BarcodeScannerModal({ onScan, onClose }: Props): React.ReactElement {
  const readerId = React.useId().replace(/:/g, "");
  const scannerRef = React.useRef<{ stop: () => Promise<void> } | null>(null);
  const handledRef = React.useRef(false);
  const [error, setError] = React.useState<string | null>(null);
  const [starting, setStarting] = React.useState(true);

  const onScanRef = React.useRef(onScan);
  onScanRef.current = onScan;

  React.useEffect(() => {
    let cancelled = false;
    handledRef.current = false;

    (async () => {
      try {
        const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import("html5-qrcode");
        if (cancelled) return;

        const scanner = new Html5Qrcode(readerId, false);
        scannerRef.current = scanner;

        const formats = [
          Html5QrcodeSupportedFormats.QR_CODE,
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39,
          Html5QrcodeSupportedFormats.UPC_A,
          Html5QrcodeSupportedFormats.UPC_E,
        ];

        await scanner.start(
          { facingMode: "environment" },
          {
            fps: 10,
            qrbox: (w, h) => {
              const edge = Math.min(w, h);
              const width = Math.floor(edge * 0.82);
              return { width, height: Math.floor(width * 0.42) };
            },
            formatsToSupport: formats,
          },
          (decoded) => {
            if (handledRef.current) return;
            handledRef.current = true;
            onScanRef.current(decoded);
          },
          () => {
            /* scan attempt — ignore */
          },
        );

        if (!cancelled) setStarting(false);
      } catch (e: unknown) {
        if (!cancelled) {
          setStarting(false);
          setError(
            e instanceof Error
              ? e.message
              : "Could not open camera. Allow camera access or type the SKU manually.",
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      const s = scannerRef.current;
      scannerRef.current = null;
      if (s) {
        void s
          .stop()
          .then(() => s.clear())
          .catch(() => {
            /* ignore cleanup errors */
          });
      }
    };
  }, [readerId]);

  return (
    <div
      className="modalBackdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="barcode-scanner-title"
      onClick={onClose}
    >
      <div className="modalCard barcodeScannerCard" onClick={(e) => e.stopPropagation()}>
        <div className="barcodeScannerHead">
          <div>
            <div className="cardTitle" id="barcode-scanner-title">
              Scan barcode
            </div>
            <p className="formHint barcodeScannerHint">
              Scan the product barcode. It is matched to the <strong>barcode</strong> column in
              SKUList, which maps to SKU.
            </p>
          </div>
          <button type="button" className="secondaryBtn barcodeScannerClose" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="barcodeScannerViewportWrap">
          <div id={readerId} className="barcodeScannerViewport" />
          {starting && !error ? <div className="barcodeScannerLoading">Starting camera…</div> : null}
        </div>

        {error ? <div className="formBanner error">{error}</div> : null}
      </div>
    </div>
  );
}
