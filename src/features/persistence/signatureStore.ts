import { get, set, del } from 'idb-keyval';

/**
 * Opt-in signature-image persistence (contracts/persistence.md, Principle VI).
 * Stores ONLY the signature image bytes + format for the "remember my signature"
 * convenience — never a document, certificate, password, or key. Written solely on
 * an explicit, disclosed user opt-in and fully clearable.
 */
const KEY = 'pdf-signer:remembered-signature';

interface StoredSignature {
  bytes: Uint8Array;
  format: 'png' | 'jpeg';
  savedAt: number;
}

// Storage may be unavailable (private mode / denied / quota). Opt-in persistence
// is a convenience, so degrade to memory-only silently rather than erroring.
export async function saveSignature(bytes: Uint8Array, format: 'png' | 'jpeg'): Promise<void> {
  const record: StoredSignature = { bytes, format, savedAt: Date.now() };
  try {
    await set(KEY, record);
  } catch {
    /* storage unavailable — remain memory-only */
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

export async function clearSignature(): Promise<void> {
  try {
    await del(KEY);
  } catch {
    /* nothing to clear if storage is unavailable */
  }
}

export async function hasRememberedSignature(): Promise<boolean> {
  try {
    return (await get(KEY)) != null;
  } catch {
    return false;
  }
}
