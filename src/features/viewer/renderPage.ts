import * as pdfjsLib from 'pdfjs-dist';
// Bundle the worker locally (no CDN — Principle I/II, research R2).
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

export interface RenderedPage {
  /** Unrotated page size in PDF points (used for placement→PDF mapping, research R6). */
  widthPt: number;
  heightPt: number;
  rotation: 0 | 90 | 180 | 270;
}

/** Number of pages, read from an in-memory copy (pdf.js detaches the buffer). */
export async function getPageCount(bytes: Uint8Array): Promise<number> {
  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const n = doc.numPages;
  await doc.destroy();
  return n;
}

/** Render one page into a canvas at a target CSS width; returns page geometry. */
export async function renderPage(
  bytes: Uint8Array,
  pageIndex: number,
  canvas: HTMLCanvasElement,
  cssWidth: number,
): Promise<RenderedPage> {
  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  try {
    const page = await doc.getPage(pageIndex + 1);
    const base = page.getViewport({ scale: 1 });
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const scale = cssWidth / base.width;
    const viewport = page.getViewport({ scale: scale * dpr });

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable.');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${viewport.height / dpr}px`;

    await page.render({ canvasContext: ctx, viewport }).promise;

    return {
      widthPt: base.width,
      heightPt: base.height,
      rotation: (page.rotate % 360) as RenderedPage['rotation'],
    };
  } finally {
    await doc.destroy();
  }
}
