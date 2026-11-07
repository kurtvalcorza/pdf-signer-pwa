import * as pdfjsLib from 'pdfjs-dist';
// Bundle the worker locally (no CDN — Principle I/II, research R2).
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { InputLimitError, LIMITS } from '../../lib/limits';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

export interface RenderedPage {
  /** Unrotated page size in PDF points (used for placement→PDF mapping, research R6). */
  widthPt: number;
  heightPt: number;
  rotation: 0 | 90 | 180 | 270;
}

export interface RenderHandle {
  promise: Promise<RenderedPage>;
  /** Stop this render. It rejects with RenderCancelledError and never touches the canvas. */
  cancel(): void;
}

export class RenderCancelledError extends Error {
  constructor() {
    super('Render cancelled.');
    this.name = 'RenderCancelledError';
  }
}

/**
 * Render one page into a canvas at a target CSS width.
 *
 * The page is drawn offscreen and copied to `canvas` only once complete, so the visible canvas always
 * shows one whole page, and a cancelled render cannot paint over a newer one (SEC-09).
 */
export function renderPage(
  bytes: Uint8Array,
  pageIndex: number,
  canvas: HTMLCanvasElement,
  cssWidth: number,
): RenderHandle {
  const loading = pdfjsLib.getDocument({ data: bytes.slice() });
  let task: { cancel(): void } | null = null;
  let cancelled = false;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    cancelled = true;
    task?.cancel();
    void loading.destroy();
  };

  const limitTo = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      cancel();
    }, ms);
  };

  const draw = async (): Promise<RenderedPage> => {
    const doc = await loading.promise;
    const page = await doc.getPage(pageIndex + 1);
    limitTo(LIMITS.renderMs);
    const base = page.getViewport({ scale: 1 });
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr });
    const width = Math.floor(viewport.width);
    const height = Math.floor(viewport.height);
    if (width * height > LIMITS.canvasPixels) {
      throw new InputLimitError('This page is too large to display.');
    }

    const offscreen = document.createElement('canvas');
    offscreen.width = width;
    offscreen.height = height;
    const offscreenCtx = offscreen.getContext('2d');
    if (!offscreenCtx) throw new Error('Canvas 2D context unavailable.');
    if (cancelled) throw new RenderCancelledError();

    const render = page.render({ canvasContext: offscreenCtx, viewport });
    task = render;
    await render.promise;
    if (cancelled) throw new RenderCancelledError();

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable.');
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${viewport.height / dpr}px`;
    ctx.drawImage(offscreen, 0, 0);

    return {
      widthPt: base.width,
      heightPt: base.height,
      rotation: (page.rotate % 360) as RenderedPage['rotation'],
    };
  };

  limitTo(LIMITS.loadMs);

  const promise = draw()
    .catch((e: unknown) => {
      if (timedOut) throw new InputLimitError('This page took too long to display. Open the PDF again to retry.');
      if (cancelled) throw new RenderCancelledError();
      throw e;
    })
    .finally(() => {
      clearTimeout(timer);
      void loading.destroy();
    });

  return { promise, cancel };
}
