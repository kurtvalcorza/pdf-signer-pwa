import { describe, it, expect } from 'vitest';
import { imageDimensions, readImageFile } from '../../src/features/ingest/imageInput';
import { assertFileSize, assertPageCount, InputLimitError, LIMITS } from '../../src/lib/limits';

/** A PNG signature + IHDR claiming the given size: all the header check reads. */
function pngHeader(width: number, height: number): Uint8Array {
  return png(chunk('IHDR', dims(width, height)));
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function dims(width: number, height: number): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  return data;
}

/** A PNG chunk. Its CRC is left zero: nothing here checks it, and the decoder is not involved. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set([...type].map((c) => c.charCodeAt(0)), 4);
  out.set(data, 8);
  return out;
}

function png(...chunks: Uint8Array[]): Uint8Array {
  const parts = [Uint8Array.from(SIGNATURE), ...chunks];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
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

  it('refuses a PNG whose real size is hidden behind a decoy', () => {
    const real = chunk('IHDR', dims(10000, 6000));
    const decoy = chunk('tEXt', dims(1, 1));
    expect(imageDimensions(png(decoy, real), 'png')).toBeNull();
    expect(imageDimensions(png(chunk('IHDR', dims(1, 1)), real), 'png')).toBeNull();
  });

  it('refuses an animated PNG, whose frames all decode', () => {
    const header = chunk('IHDR', dims(100, 100));
    expect(imageDimensions(png(header, chunk('acTL', new Uint8Array(8))), 'png')).toBeNull();
    expect(imageDimensions(png(header, chunk('fcTL', new Uint8Array(26))), 'png')).toBeNull();
  });

  it('keeps reading a normal PNG past its metadata chunks', () => {
    const file = png(
      chunk('IHDR', dims(800, 600)),
      chunk('tEXt', new Uint8Array(10)),
      chunk('IDAT', new Uint8Array(20)),
      chunk('IEND', new Uint8Array(0)),
    );
    expect(imageDimensions(file, 'png')).toEqual({ width: 800, height: 600 });
  });

  it('reads a JPEG with fill bytes before its frame header', () => {
    const file = Uint8Array.of(0xff, 0xd8, 0xff, 0xff, 0xc0, 0, 17, 8, 0, 100, 0, 200, 3, ...new Array(30).fill(0));
    expect(imageDimensions(file, 'jpeg')).toEqual({ width: 200, height: 100 });
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
