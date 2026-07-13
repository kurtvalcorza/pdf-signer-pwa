import { useEffect, useRef, useState } from 'react';
import { cleanImageBackground } from '../features/ingest/backgroundClean';

interface Props {
  originalBytes: Uint8Array;
  onApply: (cleaned: Uint8Array) => void;
  onCancel: () => void;
}

/**
 * Optional signature background cleanup (US4, FR-029). Adjust a threshold to strip
 * the paper background; skippable. Never required to place a signature.
 */
export function CleanupSheet({ originalBytes, onApply, onCancel }: Props) {
  const [threshold, setThreshold] = useState(240);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [cleaned, setCleaned] = useState<Uint8Array | null>(null);
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  // Revoke the last preview URL when the sheet unmounts (Back/Cancel).
  useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    setWorking(true);
    setErr(null);
    cleanImageBackground(originalBytes, threshold)
      .then((bytes) => {
        if (cancelled) return;
        setCleaned(bytes);
        setPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          const next = URL.createObjectURL(new Blob([bytes as BlobPart]));
          previewUrlRef.current = next;
          return next;
        });
      })
      .catch((e) => !cancelled && setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setWorking(false));
    return () => {
      cancelled = true;
    };
  }, [originalBytes, threshold]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="font-medium">Clean up signature</span>
        <button type="button" onClick={onCancel} className="text-sm text-white/50 hover:text-white">
          ← Back
        </button>
      </div>

      <div
        className="flex h-32 items-center justify-center rounded-lg"
        style={{
          backgroundImage:
            'linear-gradient(45deg,#666 25%,transparent 25%),linear-gradient(-45deg,#666 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#666 75%),linear-gradient(-45deg,transparent 75%,#666 75%)',
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0,0 8px,8px -8px,-8px 0',
        }}
      >
        {previewUrl && <img src={previewUrl} alt="cleaned preview" className="max-h-full max-w-full object-contain" />}
      </div>

      {err && <p className="rounded bg-amber-500/20 px-3 py-2 text-xs text-amber-200">cleanup: {err}</p>}

      <label className="text-xs text-white/60">
        Background removal strength {working && <span className="text-white/40">· updating…</span>}
        <input
          type="range"
          min={100}
          max={255}
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          className="mt-1 w-full"
        />
      </label>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-lg bg-white/10 px-4 py-3 text-sm hover:bg-white/15"
        >
          Keep original
        </button>
        <button
          type="button"
          disabled={!cleaned}
          onClick={() => cleaned && onApply(cleaned)}
          className="flex-1 rounded-lg bg-blue-500 px-4 py-3 text-sm font-semibold hover:bg-blue-400 disabled:opacity-40"
        >
          Use cleaned
        </button>
      </div>
    </div>
  );
}
