import type { ReactNode } from 'react';

/**
 * The document is the center (spec FR-002/FR-026). This stage fills the viewport
 * behind the bottom sheet; the PDF preview (T015) renders into `children`.
 */
export function DocumentStage({ children, empty }: { children?: ReactNode; empty?: boolean }) {
  return (
    // The scroll area starts at top-16, below the strip occupied by the fixed
    // top-right GitHubLink, so the editable document (and its signature overlays)
    // can never sit under it — even when a tall page overflows or is scrolled.
    // m-auto (not items/justify-center) centers the child only when it fits;
    // an overflowing child stays flush with the scrollport instead of being
    // centered into negative free space above it.
    <main className="absolute inset-0 bg-stage">
      <div className="absolute inset-x-0 bottom-0 top-16 flex overflow-auto px-4 pb-40">
        <div className="m-auto">
          {empty ? (
            <div className="text-center text-white/60">
              <p className="text-lg font-medium">No document open</p>
              <p className="mt-1 text-sm">Open a PDF to start signing.</p>
            </div>
          ) : (
            children
          )}
        </div>
      </div>
    </main>
  );
}
