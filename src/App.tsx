import { useCallback, useEffect, useRef, useState } from 'react';
import { DocumentStage } from './components/DocumentStage';
import { BottomSheet } from './components/BottomSheet';
import { SignatureOverlay } from './components/SignatureOverlay';
import { loadPdf } from './features/viewer/loadPdf';
import { renderPage } from './features/viewer/renderPage';
import { readImageFile } from './features/ingest/imageInput';
import { createPlacement, type Placement } from './features/placement/placement';
import { downloadPdf, exportVisualStamped } from './features/signing/export';
import { stampVisual } from './features/signing/stampVisual';
import { signFirst } from './features/signing/signFirst';
import { BadPasswordError, type PlacementInput } from './features/signing/types';
import { CertSheet, type SignRequest } from './components/CertSheet';
import { saveCertificate } from './features/persistence/certStore';

interface ImageAsset {
  url: string;
  bytes: Uint8Array;
  format: 'png' | 'jpeg';
}

interface Doc {
  bytes: Uint8Array;
  pageCount: number;
  name: string;
}

export default function App() {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [images, setImages] = useState<Record<string, ImageAsset>>({});
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'stamp' | 'cert'>('stamp');

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pdfInput = useRef<HTMLInputElement>(null);
  const imgInput = useRef<HTMLInputElement>(null);

  // Render the current page whenever the doc or page changes.
  useEffect(() => {
    if (!doc || !canvasRef.current) return;
    let cancelled = false;
    const cssWidth = Math.min((stageRef.current?.clientWidth ?? 360) - 32, 700);
    renderPage(doc.bytes, pageIndex, canvasRef.current, cssWidth)
      .then(() => {
        if (cancelled || !canvasRef.current) return;
        const rect = canvasRef.current.getBoundingClientRect();
        setPageSize({ w: rect.width, h: rect.height });
      })
      .catch((e) => !cancelled && setError(String(e?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [doc, pageIndex]);

  const openPdf = useCallback(async (file: File) => {
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const info = await loadPdf(bytes);
      if (info.hasExistingSignature) {
        setError('Heads up: this PDF is already signed. Adding a visible stamp changes the page and would invalidate that signature.');
      }
      setDoc({ bytes, pageCount: info.pageCount, name: file.name });
      setPlacements([]);
      setPageIndex(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const addSignature = useCallback(
    async (file: File) => {
      if (!doc) return;
      setError(null);
      try {
        const { bytes, format } = await readImageFile(file);
        const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
        const id = `img_${Object.keys(images).length + 1}`;
        setImages((m) => ({ ...m, [id]: { url, bytes, format } }));
        const placement = createPlacement(id, pageIndex);
        setPlacements((ps) => [...ps, placement]);
        setSelectedId(placement.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [doc, images, pageIndex],
  );

  const updatePlacement = useCallback((p: Placement) => {
    setPlacements((ps) => ps.map((x) => (x.id === p.id ? p : x)));
  }, []);

  const removePlacement = useCallback((id: string) => {
    setPlacements((ps) => ps.filter((x) => x.id !== id));
    setSelectedId(null);
  }, []);

  const applyAndDownload = useCallback(async () => {
    if (!doc || placements.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const inputs: PlacementInput[] = placements.map((p) => ({
        imageBytes: images[p.imageId].bytes,
        format: images[p.imageId].format,
        pageIndex: p.pageIndex,
        nx: p.nx,
        ny: p.ny,
        nw: p.nw,
        nh: p.nh,
      }));
      const out = await exportVisualStamped(doc.bytes, inputs);
      downloadPdf(out, doc.name.replace(/\.pdf$/i, '') + '-signed.pdf');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [doc, placements, images]);

  const signWithCert = useCallback(
    async (req: SignRequest) => {
      if (!doc || placements.length === 0) return;
      setBusy(true);
      setError(null);
      try {
        const toInput = (p: Placement): PlacementInput => ({
          imageBytes: images[p.imageId].bytes,
          format: images[p.imageId].format,
          pageIndex: p.pageIndex,
          nx: p.nx,
          ny: p.ny,
          nw: p.nw,
          nh: p.nh,
        });
        // The selected (or last) placement becomes the cryptographic signature;
        // any others are baked in as visual stamps FIRST (ordering rule, FR-014).
        const crypto = placements.find((p) => p.id === selectedId) ?? placements[placements.length - 1];
        const visuals = placements.filter((p) => p.id !== crypto.id).map(toInput);
        const base = visuals.length ? await stampVisual(doc.bytes, visuals) : doc.bytes;
        const signed = await signFirst(base, toInput(crypto), {
          p12Bytes: req.p12Bytes,
          password: req.password,
        });
        if (req.remember) await saveCertificate(req.p12Bytes, req.label ?? 'certificate');
        downloadPdf(signed, doc.name.replace(/\.pdf$/i, '') + '-signed.pdf');
        setMode('stamp');
      } catch (e) {
        setError(
          e instanceof BadPasswordError
            ? 'Incorrect certificate password.'
            : e instanceof Error
              ? e.message
              : String(e),
        );
      } finally {
        setBusy(false);
      }
    },
    [doc, placements, images, selectedId],
  );

  const pagePlacements = placements.filter((p) => p.pageIndex === pageIndex);

  return (
    <div className="relative h-full w-full bg-black" ref={stageRef}>
      <DocumentStage empty={!doc}>
        {doc && (
          <div className="relative" style={{ width: pageSize.w || undefined }}>
            <canvas ref={canvasRef} className="block rounded shadow-lg" />
            {pageSize.w > 0 &&
              pagePlacements.map((p) => (
                <SignatureOverlay
                  key={p.id}
                  placement={p}
                  imageUrl={images[p.imageId].url}
                  pageW={pageSize.w}
                  pageH={pageSize.h}
                  selected={selectedId === p.id}
                  onChange={updatePlacement}
                  onSelect={() => setSelectedId(p.id)}
                  onRemove={() => removePlacement(p.id)}
                />
              ))}
          </div>
        )}
      </DocumentStage>

      <BottomSheet>
        <input
          ref={pdfInput}
          type="file"
          accept=".pdf"
          hidden
          onChange={(e) => e.target.files?.[0] && openPdf(e.target.files[0])}
        />
        <input
          ref={imgInput}
          type="file"
          accept="image/png,image/jpeg"
          hidden
          onChange={(e) => e.target.files?.[0] && addSignature(e.target.files[0])}
        />

        {error && <p className="mb-2 rounded bg-amber-500/20 px-3 py-2 text-xs text-amber-200">{error}</p>}

        {mode === 'cert' ? (
          <CertSheet
            canSign={!!doc && placements.length > 0}
            busy={busy}
            onSign={signWithCert}
            onCancel={() => setMode('stamp')}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => pdfInput.current?.click()}
                className="flex-1 rounded-lg bg-white/10 px-4 py-3 font-medium hover:bg-white/15"
              >
                {doc ? 'Open different PDF' : 'Open PDF'}
              </button>
              <button
                type="button"
                disabled={!doc}
                onClick={() => imgInput.current?.click()}
                className="flex-1 rounded-lg bg-white/10 px-4 py-3 font-medium hover:bg-white/15 disabled:opacity-40"
              >
                Add signature
              </button>
            </div>

            {doc && doc.pageCount > 1 && (
              <div className="flex items-center justify-center gap-4 text-sm">
                <button
                  type="button"
                  onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
                  disabled={pageIndex === 0}
                  className="rounded px-3 py-1 hover:bg-white/10 disabled:opacity-40"
                >
                  ‹ Prev
                </button>
                <span className="text-white/60">
                  Page {pageIndex + 1} / {doc.pageCount}
                </span>
                <button
                  type="button"
                  onClick={() => setPageIndex((i) => Math.min(doc.pageCount - 1, i + 1))}
                  disabled={pageIndex >= doc.pageCount - 1}
                  className="rounded px-3 py-1 hover:bg-white/10 disabled:opacity-40"
                >
                  Next ›
                </button>
              </div>
            )}

            <button
              type="button"
              disabled={!doc || placements.length === 0 || busy}
              onClick={applyAndDownload}
              className="rounded-lg bg-blue-500 px-4 py-3 font-semibold hover:bg-blue-400 disabled:opacity-40"
            >
              {busy ? 'Preparing…' : `Apply & Download${placements.length ? ` (${placements.length})` : ''}`}
            </button>

            <button
              type="button"
              disabled={!doc || placements.length === 0 || busy}
              onClick={() => setMode('cert')}
              className="rounded-lg border border-white/15 px-4 py-3 text-sm font-medium hover:bg-white/5 disabled:opacity-40"
            >
              Sign with a certificate (.p12)…
            </button>

            <p className="px-1 text-xs text-white/40">
              Private &amp; on-device — nothing leaves your phone. A visible signature or an
              optional digital signature, not a legally-binding e-signature service.
            </p>
          </div>
        )}
      </BottomSheet>
    </div>
  );
}
