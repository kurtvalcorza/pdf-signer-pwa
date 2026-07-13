import { useRef, useState } from 'react';
import { DocumentStage } from './components/DocumentStage';
import { BottomSheet } from './components/BottomSheet';

/**
 * App shell (task T016): document-dominant stage + collapsing bottom sheet.
 * Viewer rendering (T015), placement (T024), and signing (US2) wire in here.
 */
export default function App() {
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <div className="relative h-full w-full bg-black">
      <DocumentStage empty={!fileName}>
        {fileName && (
          <div className="rounded bg-white/90 px-6 py-10 text-center text-sm text-black shadow">
            {fileName}
            <div className="mt-1 text-xs text-black/50">(page preview lands in T015)</div>
          </div>
        )}
      </DocumentStage>

      <BottomSheet>
        <input
          ref={fileInput}
          type="file"
          accept=".pdf"
          hidden
          onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
        />
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="rounded-lg bg-white/10 px-4 py-3 text-left font-medium hover:bg-white/15"
          >
            Open PDF
          </button>
          <p className="px-1 text-xs text-white/40">
            Private &amp; on-device. Nothing leaves your phone. Not a legally-binding signature
            service.
          </p>
        </div>
      </BottomSheet>
    </div>
  );
}
