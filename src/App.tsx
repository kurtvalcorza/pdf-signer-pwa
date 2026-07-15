import { useCallback, useEffect, useRef, useState } from 'react';
import { DocumentStage } from './components/DocumentStage';
import { GitHubLink } from './components/GitHubLink';
import { BottomSheet } from './components/BottomSheet';
import { SignatureOverlay } from './components/SignatureOverlay';
import { loadPdf } from './features/viewer/loadPdf';
import { renderPage } from './features/viewer/renderPage';
import { readImageFile } from './features/ingest/imageInput';
import { createPlacement, type Placement } from './features/placement/placement';
import { downloadPdf, exportVisualStamped } from './features/signing/export';
import { stampVisual } from './features/signing/stampVisual';
import { signFirst } from './features/signing/signFirst';
import { signIncremental } from './features/signing/signIncremental';
import { BadPasswordError, CertificationLockedError, type PlacementInput } from './features/signing/types';
import { CertSheet, type SignRequest } from './components/CertSheet';
import { CleanupSheet } from './components/CleanupSheet';
import { saveCertificate } from './features/persistence/certStore';
import {
  saveSignature,
  loadSignature,
  clearSignature,
  hasRememberedSignature,
} from './features/persistence/signatureStore';

interface ImageAsset {
  url: string;
  bytes: Uint8Array;
  format: 'png' | 'jpeg';
  originalBytes: Uint8Array;
}

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

interface Doc {
  bytes: Uint8Array;
  pageCount: number;
  name: string;
  /** True if the PDF already carries a signature — drives the invalidation warning
   * and routes certificate-signing through the incremental (non-invalidating) path. */
  hasExistingSignature: boolean;
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
  const [mode, setMode] = useState<'stamp' | 'cert' | 'clean'>('stamp');
  // Opt-in "remember my signature" (image only, on-device — Principle VI).
  const [rememberSig, setRememberSig] = useState(false);
  const [hasSavedSig, setHasSavedSig] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pdfInput = useRef<HTMLInputElement>(null);
  const imgInput = useRef<HTMLInputElement>(null);
  const camInput = useRef<HTMLInputElement>(null);
  const imageSeq = useRef(0);

  // Free any image asset no longer referenced by a placement (removed, or cleared on
  // opening a new PDF). Revokes its object URL so blobs don't leak for the session.
  useEffect(() => {
    const used = new Set(placements.map((p) => p.imageId));
    const orphanIds = Object.keys(images).filter((id) => !used.has(id));
    if (orphanIds.length === 0) return;
    // Revoke outside the setState updater (updaters must stay pure).
    for (const id of orphanIds) {
      if (images[id]?.url) URL.revokeObjectURL(images[id].url);
    }
    setImages((m) => {
      const next = { ...m };
      for (const id of orphanIds) delete next[id];
      return next;
    });
  }, [placements, images]);

  // Surface a previously remembered signature (opt-in) so "Use saved signature" appears.
  useEffect(() => {
    hasRememberedSignature().then(setHasSavedSig);
  }, []);

  // The "remember this signature" checkbox reflects a per-selection intent; reset it when
  // the selection changes so it never implies a different image is the saved one.
  useEffect(() => {
    setRememberSig(false);
  }, [selectedId]);

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
        setError(
          'Heads up: this PDF is already signed. “Stamp image & Download” rewrites the ' +
            'pages and would invalidate every existing signature (yours and other signers’). ' +
            'To add your signature without breaking theirs, use “Sign with a digital ' +
            'certificate” — it appends your signature without altering the signed pages.',
        );
      }
      setDoc({ bytes, pageCount: info.pageCount, name: file.name, hasExistingSignature: info.hasExistingSignature });
      setPlacements([]);
      setSelectedId(null);
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
        // Monotonic id: never reuse a number even after images are pruned, so a new
        // asset can't collide with an existing key.
        const id = `img_${++imageSeq.current}`;
        setImages((m) => ({ ...m, [id]: { url, bytes, format, originalBytes: bytes } }));
        const placement = createPlacement(id, pageIndex);
        setPlacements((ps) => [...ps, placement]);
        setSelectedId(placement.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [doc, pageIndex],
  );

  // Place the remembered signature onto the current page (opt-in convenience).
  const useSavedSignature = useCallback(async () => {
    if (!doc) return;
    setError(null);
    const saved = await loadSignature();
    if (!saved) {
      setHasSavedSig(false);
      return;
    }
    const url = URL.createObjectURL(new Blob([saved.bytes as BlobPart]));
    const id = `img_${++imageSeq.current}`;
    setImages((m) => ({
      ...m,
      [id]: { url, bytes: saved.bytes, format: saved.format, originalBytes: saved.bytes },
    }));
    const placement = createPlacement(id, pageIndex);
    setPlacements((ps) => [...ps, placement]);
    setSelectedId(placement.id);
  }, [doc, pageIndex]);

  // Toggle remembering the currently-selected signature image (explicit opt-in).
  const toggleRememberSignature = useCallback(
    async (on: boolean, asset: ImageAsset | null) => {
      setRememberSig(on); // reflect the toggle immediately (controlled input)
      if (on && asset) {
        const ok = await saveSignature(asset.bytes, asset.format);
        if (ok) {
          setHasSavedSig(true);
        } else {
          // The write didn't land. An OLDER record may still exist (a failed overwrite
          // doesn't delete it), so reconcile both flags to what is actually persisted
          // rather than to the attempted operation.
          setRememberSig(false);
          setHasSavedSig(await hasRememberedSignature());
        }
      } else if (await clearSignature()) {
        setHasSavedSig(false);
      } else {
        // The delete didn't land — the record persists, so reflect that truth instead
        // of an unchecked box that would hide a signature still sitting in storage.
        const stillSaved = await hasRememberedSignature();
        setRememberSig(stillSaved);
        setHasSavedSig(stillSaved);
      }
    },
    [],
  );

  const forgetSignature = useCallback(async () => {
    // Only drop the UI's saved state once the delete is confirmed (clearable promise).
    if (await clearSignature()) {
      setHasSavedSig(false);
      setRememberSig(false);
    }
  }, []);

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
        // The selected (or last) placement becomes the cryptographic signature.
        const crypto = placements.find((p) => p.id === selectedId) ?? placements[placements.length - 1];
        const cert = { p12Bytes: req.p12Bytes, password: req.password };

        let signed: Uint8Array;
        let note: string | null = null;
        if (doc.hasExistingSignature) {
          // The PDF already carries signatures. Append ours as a byte-level incremental
          // update so those earlier signatures stay valid — never re-serialize the signed
          // bytes (Principle III / FR-013). Trade-offs of this path: no image appearance on
          // the widget, extra visual-only stamps can't be baked in (they would rewrite
          // the signed pages) so they're skipped, and the signature field can only be
          // attached to page 1 (the incremental signer always targets the first page).
          if (crypto.pageIndex !== 0) {
            throw new Error(
              'On an already-signed PDF the new signature must be placed on page 1 — ' +
                'move your signature there and try again.',
            );
          }
          try {
            signed = await signIncremental(doc.bytes, toInput(crypto), cert);
          } catch (e) {
            if (e instanceof BadPasswordError || e instanceof CertificationLockedError) throw e;
            // The incremental signer can't parse every PDF structure (e.g. cross-reference
            // streams). Fail honestly rather than silently falling back to a path that would
            // invalidate the existing signatures.
            throw new Error(
              "This signed PDF's structure isn't supported for adding a signature without " +
                'invalidating the existing one(s). “Stamp image & Download” still works, but it ' +
                'would invalidate them.',
            );
          }
          const skipped = placements.length - 1;
          note =
            'Signed without invalidating the existing signature(s). Note: this appended a ' +
            'digital signature field without the image appearance' +
            (skipped > 0
              ? `, and ${skipped} extra stamp${skipped > 1 ? 's were' : ' was'} skipped ` +
                '(stamping an already-signed PDF would invalidate it).'
              : '.');
        } else {
          // Unsigned PDF: bake any additional placements as visual stamps FIRST (ordering
          // rule, FR-014), then apply the image-appearance signature.
          const visuals = placements.filter((p) => p.id !== crypto.id).map(toInput);
          const base = visuals.length ? await stampVisual(doc.bytes, visuals) : doc.bytes;
          signed = await signFirst(base, toInput(crypto), cert, {
            label: req.showLabel,
            date: req.showDate,
          });
        }

        if (req.remember) await saveCertificate(req.p12Bytes, req.label ?? 'certificate');
        downloadPdf(signed, doc.name.replace(/\.pdf$/i, '') + '-signed.pdf');
        setMode('stamp');
        if (note) setError(note);
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

  const applyCleaned = useCallback(
    async (cleaned: Uint8Array) => {
      const sel = placements.find((p) => p.id === selectedId);
      if (!sel) return;
      const imageId = sel.imageId;
      const replacedBytes = images[imageId]?.bytes;
      setImages((m) => {
        const prev = m[imageId];
        if (prev?.url) URL.revokeObjectURL(prev.url);
        return {
          ...m,
          [imageId]: {
            ...prev,
            url: URL.createObjectURL(new Blob([cleaned as BlobPart])),
            bytes: cleaned,
            format: 'png',
          },
        };
      });
      // If the bytes just replaced are exactly what the store holds — remembered this
      // session, or placed via "Use saved signature", regardless of what the UI flags
      // say (the checkbox resets on selection changes) — the stored copy is now stale:
      // drop it rather than let a later reuse restore the pre-cleanup image. The user
      // can re-opt-in to the cleaned signature (persistence stays explicit, never auto).
      // Comparing against the store itself also means cleaning some OTHER image never
      // touches a newer remembered signature. Reconcile to what actually persisted.
      const saved = replacedBytes ? await loadSignature() : null;
      if (saved && replacedBytes && bytesEqual(saved.bytes, replacedBytes)) {
        await clearSignature();
        setRememberSig(false);
        setHasSavedSig(await hasRememberedSignature());
      }
      setMode('stamp');
    },
    [selectedId, placements, images],
  );

  const selectedPlacement = placements.find((p) => p.id === selectedId) ?? null;
  const selectedAsset = selectedPlacement ? images[selectedPlacement.imageId] : null;
  const pagePlacements = placements.filter((p) => p.pageIndex === pageIndex);

  return (
    <div className="relative h-full w-full bg-black" ref={stageRef}>
      <DocumentStage empty={!doc}>
        {doc && (
          <div className="relative" style={{ width: pageSize.w || undefined }}>
            <canvas
              ref={canvasRef}
              className="block rounded shadow-lg"
              role="img"
              aria-label={`Page ${pageIndex + 1}${doc ? ` of ${doc.pageCount}` : ''} of ${doc?.name ?? 'the document'}`}
            />
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

      <GitHubLink />

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
        <input
          ref={camInput}
          type="file"
          accept="image/*"
          capture="environment"
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
        ) : mode === 'clean' && selectedAsset ? (
          <CleanupSheet
            originalBytes={selectedAsset.originalBytes}
            onApply={applyCleaned}
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

            <div className="flex gap-2">
              <button
                type="button"
                disabled={!doc}
                onClick={() => camInput.current?.click()}
                className="flex-1 rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/15 disabled:opacity-40"
              >
                📷 Take photo
              </button>
              <button
                type="button"
                disabled={!selectedAsset}
                onClick={() => setMode('clean')}
                className="flex-1 rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/15 disabled:opacity-40"
              >
                Clean up background
              </button>
            </div>

            {hasSavedSig && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!doc}
                  onClick={useSavedSignature}
                  className="flex-1 rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/15 disabled:opacity-40"
                >
                  ↺ Use saved signature
                </button>
                <button
                  type="button"
                  onClick={forgetSignature}
                  className="text-xs text-white/50 hover:text-white"
                >
                  Forget
                </button>
              </div>
            )}

            {selectedAsset && (
              <label className="flex items-center gap-2 px-1 text-xs text-white/60">
                <input
                  type="checkbox"
                  checked={rememberSig}
                  onChange={(e) => toggleRememberSignature(e.target.checked, selectedAsset)}
                />
                Remember this signature on this device (image only, never leaves your phone)
              </label>
            )}

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
              className="rounded-lg bg-blue-500 px-4 pb-1 pt-3 font-semibold hover:bg-blue-400 disabled:opacity-40"
            >
              {busy ? 'Preparing…' : `Stamp image & Download${placements.length ? ` (${placements.length})` : ''}`}
              <span className="block text-xs font-normal text-white/70">
                Visible image only — no digital certificate
              </span>
            </button>

            <button
              type="button"
              disabled={!doc || placements.length === 0 || busy}
              onClick={() => setMode('cert')}
              className="rounded-lg border border-white/15 px-4 pb-1 pt-3 text-sm font-medium hover:bg-white/5 disabled:opacity-40"
            >
              Sign with a digital certificate (.p12)…
              <span className="block text-xs font-normal text-white/50">
                Adds a verifiable digital signature you can validate in a PDF reader
              </span>
            </button>

            <p className="px-1 text-xs text-white/40">
              Private &amp; on-device — nothing leaves your phone. A visible stamp or an
              optional digital signature, not a legally-binding e-signature service.
            </p>
          </div>
        )}
      </BottomSheet>
    </div>
  );
}
