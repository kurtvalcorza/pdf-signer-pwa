import { useState, type ReactNode } from 'react';

/**
 * Collapsing bottom sheet (spec FR-026). Reduces to a thin bar so the document
 * stays the dominant element. This is the primary controls surface.
 */
export function BottomSheet({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(true);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex justify-center">
      <div
        className="pointer-events-auto w-full max-w-2xl rounded-t-2xl bg-sheet text-white shadow-2xl transition-[height] duration-200"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? 'Collapse controls' : 'Expand controls'}
          className="flex w-full items-center justify-center py-2"
        >
          <span className="h-1 w-10 rounded-full bg-white/30" />
        </button>
        {open && <div className="px-4 pb-4">{children}</div>}
      </div>
    </div>
  );
}
