import { describe, it, expect } from 'vitest';
import { imageDimensions, readImageFile } from '../../src/features/ingest/imageInput';
import { assertFileSize, assertPageCount, InputLimitError, LIMITS } from '../../src/lib/limits';

/** A PNG signature + IHDR claiming the given size: all the header check reads. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** SOI, an APP0 segment to skip, then a baseline frame header. */
function jpegHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(40);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  const view = new DataView(bytes.buffer);
  view.setUint16(13, height);
  view.setUint16(15, width);
  return bytes;
}

const file = (bytes: Uint8Array, type: string) => new File([bytes as BlobPart], 'x', { type });

describe('input limits (SEC-08)', () => {
  it('reads dimensions from headers without decoding', () => {
    expect(imageDimensions(pngHeader(800, 600), 'png')).toEqual({ width: 800, height: 600 });
    expect(imageDimensions(jpegHeader(800, 600), 'jpeg')).toEqual({ width: 800, height: 600 });
  });

  it('reports an unreadable header rather than guessing', () => {
    expect(imageDimensions(new Uint8Array(4), 'png')).toBeNull();
    expect(imageDimensions(Uint8Array.of(0xff, 0xd8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), 'jpeg')).toBeNull();
  });

  it('accepts an image at the pixel limit and refuses one over it', async () => {
    await expect(readImageFile(file(pngHeader(8000, 5000), 'image/png'))).resolves.toBeTruthy();
    await expect(readImageFile(file(pngHeader(8001, 5000), 'image/png'))).rejects.toThrow(
      InputLimitError,
    );
    await expect(readImageFile(file(jpegHeader(65535, 65535), 'image/jpeg'))).rejects.toThrow(
      /megapixels/,
    );
  });

  it('refuses an oversized file without reading it', async () => {
    let read = false;
    const huge = {
      size: LIMITS.imageBytes + 1,
      type: 'image/png',
      arrayBuffer: async () => {
        read = true;
        return new ArrayBuffer(0);
      },
    } as unknown as File;
    await expect(readImageFile(huge)).rejects.toThrow(/too large/);
    expect(read).toBe(false);
  });

  it('applies size and page ceilings at the boundary', () => {
    expect(() => assertFileSize({ size: LIMITS.pdfBytes }, LIMITS.pdfBytes, 'PDF')).not.toThrow();
    expect(() => assertFileSize({ size: LIMITS.pdfBytes + 1 }, LIMITS.pdfBytes, 'PDF')).toThrow(
      /100 MB/,
    );
    expect(() => assertPageCount(LIMITS.pdfPages)).not.toThrow();
    expect(() => assertPageCount(LIMITS.pdfPages + 1)).toThrow(/5000/);
  });
});
