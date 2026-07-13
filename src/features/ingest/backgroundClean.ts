/**
 * Optional background cleanup for a photographed signature (US4, FR-024/029).
 * A naive luminance threshold: near-white pixels become transparent. Kept simple
 * and optional — never on the critical signing path (Principle: honest limits).
 */

/** Pure pixel op (testable, no DOM): pixels brighter than `threshold` → transparent. */
export function removeBackground(
  rgba: Uint8ClampedArray,
  threshold = 240,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba);
  for (let i = 0; i < out.length; i += 4) {
    const lum = 0.299 * out[i] + 0.587 * out[i + 1] + 0.114 * out[i + 2];
    if (lum >= threshold) out[i + 3] = 0;
  }
  return out;
}

/** Decode image bytes into a canvas via an <img> element (works where createImageBitmap doesn't). */
async function decodeToCanvas(bytes: Uint8Array): Promise<HTMLCanvasElement> {
  const type =
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'image/jpeg' : 'image/png';
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('The signature image could not be decoded.'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || 1;
    canvas.height = img.naturalHeight || 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable.');
    ctx.drawImage(img, 0, 0);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Browser wrapper: decode image bytes → strip background → transparent PNG bytes. */
export async function cleanImageBackground(
  bytes: Uint8Array,
  threshold = 240,
): Promise<Uint8Array> {
  const canvas = await decodeToCanvas(bytes);
  const ctx = canvas.getContext('2d')!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  img.data.set(removeBackground(img.data, threshold));
  ctx.putImageData(img, 0, 0);

  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('Could not produce a cleaned image.');
  return new Uint8Array(await blob.arrayBuffer());
}
