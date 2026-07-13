import type { ReactNode } from 'react';

/**
 * The document is the center (spec FR-002/FR-026). This stage fills the viewport
 * behind the bottom sheet; the PDF preview (T015) renders into `children`.
 */
export function DocumentStage({ children, empty }: { children?: ReactNode; empty?: boolean }) {
  return (
    <main className="absolute inset-0 flex items-center justify-center overflow-auto bg-stage p-4 pb-40">
      {empty ? (
        <div className="text-center text-white/60">
          <p className="text-lg font-medium">No document open</p>
          <p className="mt-1 text-sm">Open a PDF to start signing.</p>
        </div>
      ) : (
        children
      )}
    </main>
  );
}
