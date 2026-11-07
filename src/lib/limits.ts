/**
 * Input ceilings, one set for the web and desktop builds. Every file is read fully into memory on
 * this device, so these keep a hostile or simply oversized input from exhausting it (SEC-08). The
 * sizes are checked BEFORE a file is read.
 */
const MB = 1024 * 1024;

export const LIMITS = {
  pdfBytes: 100 * MB,
  pdfPages: 5000,
  imageBytes: 20 * MB,
  imagePixels: 40_000_000,
  certificateBytes: 1 * MB,
  /** One rendered page, in canvas pixels: width is capped, so only an extreme aspect ratio reaches this. */
  canvasPixels: 64_000_000,
  renderMs: 30_000,
} as const;

/** An input refused for its size. The message is shown to the user as-is. */
export class InputLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputLimitError';
  }
}

const inMb = (bytes: number) => `${Math.round(bytes / MB)} MB`;

export function assertFileSize(file: Pick<File, 'size'>, limit: number, what: string): void {
  if (file.size > limit) {
    throw new InputLimitError(`This ${what} is too large. The limit is ${inMb(limit)}.`);
  }
}

export function assertPageCount(pages: number): void {
  if (pages > LIMITS.pdfPages) {
    throw new InputLimitError(`This PDF has too many pages. The limit is ${LIMITS.pdfPages}.`);
  }
}
