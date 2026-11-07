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

/** Width and height from the PNG or JPEG header, without decoding the image; null if unreadable. */
export function imageDimensions(
  bytes: Uint8Array,
  format: 'png' | 'jpeg',
): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (format === 'png') {
    if (bytes.length < 24) return null;
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrameHeader) return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
    i += 2 + view.getUint16(i + 2);
  }
  return null;
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
