import { get, set, del } from 'idb-keyval';

/**
 * Opt-in signature-image persistence (contracts/persistence.md, Principle VI).
 * Stores ONLY the signature image bytes + format for the "remember my signature"
 * convenience — never a document, certificate, password, or key. Written solely on
 * an explicit, disclosed user opt-in and fully clearable.
 */
const KEY = 'pdf-signer:remembered-signature';

// Data-minimization (FR-021/SC-008): store ONLY what's needed to re-place the image —
// the bytes and how to embed them. No timestamps or other behavioral metadata.
interface StoredSignature {
  bytes: Uint8Array;
  format: 'png' | 'jpeg';
}

// Storage may be unavailable (private mode / denied / quota). Opt-in persistence
// is a convenience, so degrade to memory-only silently rather than erroring.
// Returns true only if the write actually landed, so the UI never advertises a
// remembered signature that isn't really there.
export async function saveSignature(bytes: Uint8Array, format: 'png' | 'jpeg'): Promise<boolean> {
  const record: StoredSignature = { bytes, format };
  try {
    await set(KEY, record);
    return true;
  } catch {
    return false; // storage unavailable — remain memory-only
  }
}

export async function loadSignature(): Promise<{ bytes: Uint8Array; format: 'png' | 'jpeg' } | null> {
  try {
    const v = (await get(KEY)) as StoredSignature | undefined;
    return v ? { bytes: v.bytes, format: v.format } : null;
  } catch {
    return null;
  }
}

// Returns true only once the key is confirmed gone, so "Forget" can't falsely report
// a signature cleared when the delete throws and it actually lingers in storage.
export async function clearSignature(): Promise<boolean> {
  try {
    await del(KEY);
    return (await get(KEY)) == null;
  } catch {
    return false;
  }
}

export async function hasRememberedSignature(): Promise<boolean> {
  try {
    return (await get(KEY)) != null;
  } catch {
    return false;
  }
}
