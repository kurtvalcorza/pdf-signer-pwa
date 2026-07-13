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

/** Read an uploaded/captured image File into signable bytes. In-memory only. */
export async function readImageFile(file: File): Promise<IngestedImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { bytes, format: detectImageFormat(bytes, file.type) };
}
