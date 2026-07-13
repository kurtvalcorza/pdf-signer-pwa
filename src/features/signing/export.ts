import { stampVisual } from './stampVisual';
import type { PlacementInput } from './types';

/** Trigger a client-side download of PDF bytes. No network (Principle I). */
export function downloadPdf(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.endsWith('.pdf') ? filename : `${filename}.pdf`;
    a.rel = 'noopener';
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** US1 export: apply all visual stamps and hand back a downloadable PDF (FR-010). */
export async function exportVisualStamped(
  pdf: Uint8Array,
  placements: PlacementInput[],
): Promise<Uint8Array> {
  return stampVisual(pdf, placements);
}
