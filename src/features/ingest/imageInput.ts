import { assertFileSize, InputLimitError, LIMITS } from '../../lib/limits';

export interface IngestedImage {
  bytes: Uint8Array;
  format: 'png' | 'jpeg';
}

/** Detect PNG/JPEG from magic bytes, falling back to the MIME type (FR-004). */
export function detectImageFormat(bytes: Uint8Array, mime = ''): 'png' | 'jpeg' {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpeg';
  throw new Error('Unsupported image. Please use a PNG or JPEG signature.');
}

const ANIMATION_CHUNKS = new Set(['acTL', 'fcTL', 'fdAT']);

/**
 * The size pdf-lib's decoder will actually use. It honours the real IHDR wherever it sits and decodes
 * every APNG frame, so the whole file is walked: IHDR must come first and be the only one, and an
 * animated PNG is refused, since its decoded size is not its header size.
 */
function pngDimensions(bytes: Uint8Array, view: DataView): { width: number; height: number } | null {
  let size: { width: number; height: number } | null = null;
  for (let i = 8; i + 8 <= bytes.length; i += 12 + view.getUint32(i)) {
    const type = String.fromCharCode(...bytes.subarray(i + 4, i + 8));
    if (ANIMATION_CHUNKS.has(type)) return null;
    if ((type === 'IHDR') !== (i === 8)) return null;
    if (type === 'IHDR') {
      if (i + 16 > bytes.length) return null;
      size = { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (type === 'IEND') break;
  }
  return size;
}

function jpegDimensions(bytes: Uint8Array, view: DataView): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte before a marker
    } else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2; // standalone marker, no length
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
    } else if (marker === 0xda) {
      return null; // scan data before any frame header
    } else {
      i += 2 + view.getUint16(i + 2);
    }
  }
  return null;
}

/** Width and height from the file structure, without decoding the image; null if unreadable. */
export function imageDimensions(
  bytes: Uint8Array,
  format: 'png' | 'jpeg',
): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return format === 'png' ? pngDimensions(bytes, view) : jpegDimensions(bytes, view);
}

/** Read an uploaded/captured image File into signable bytes. In-memory only. */
export async function readImageFile(file: File): Promise<IngestedImage> {
  assertFileSize(file, LIMITS.imageBytes, 'image');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = detectImageFormat(bytes, file.type);
  // The header decides: decoded size is what exhausts memory, and it dwarfs the file size.
  const size = imageDimensions(bytes, format);
  if (!size) throw new InputLimitError('This image could not be read.');
  if (size.width * size.height > LIMITS.imagePixels) {
    throw new InputLimitError(
      `This image is too large. The limit is ${LIMITS.imagePixels / 1_000_000} megapixels.`,
    );
  }
  return { bytes, format };
}
