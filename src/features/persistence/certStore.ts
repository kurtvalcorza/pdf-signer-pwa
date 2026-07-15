import { get, set, del } from 'idb-keyval';

/**
 * Opt-in certificate persistence (contracts/persistence.md, Principle VI).
 * Stores ONLY the password-protected .p12 bytes — never the password or decrypted private-key material.
 */
const KEY = 'pdf-signer:remembered-certificate';

interface StoredCert {
  p12Bytes: Uint8Array;
  label: string;
  savedAt: number;
}

// Storage may be unavailable (private mode / denied / quota). Opt-in persistence
// is a convenience, so degrade to memory-only silently rather than erroring.
export async function saveCertificate(p12Bytes: Uint8Array, label: string): Promise<void> {
  const record: StoredCert = { p12Bytes, label, savedAt: Date.now() };
  try {
    await set(KEY, record);
  } catch {
    /* storage unavailable — remain memory-only */
  }
}

export async function loadCertificate(): Promise<{ p12Bytes: Uint8Array; label: string } | null> {
  try {
    const v = (await get(KEY)) as StoredCert | undefined;
    return v ? { p12Bytes: v.p12Bytes, label: v.label } : null;
  } catch {
    return null;
  }
}

export async function clearCertificate(): Promise<void> {
  try {
    await del(KEY);
  } catch {
    /* nothing to clear if storage is unavailable */
  }
}

export async function hasRememberedCertificate(): Promise<boolean> {
  try {
    return (await get(KEY)) != null;
  } catch {
    return false;
  }
}
