import { stampVisual } from './stampVisual';
import type { PlacementInput } from './types';

/** Trigger a client-side download of raw bytes. No network (Principle I). */
export function downloadBytes(bytes: Uint8Array, filename: string, mime: string): void {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Trigger a client-side download of PDF bytes. */
export function downloadPdf(bytes: Uint8Array, filename: string): void {
  downloadBytes(bytes, filename.endsWith('.pdf') ? filename : `${filename}.pdf`, 'application/pdf');
}

/** US1 export: apply all visual stamps and hand back a downloadable PDF (FR-010). */
export async function exportVisualStamped(
  pdf: Uint8Array,
  placements: PlacementInput[],
): Promise<Uint8Array> {
  return stampVisual(pdf, placements);
}
