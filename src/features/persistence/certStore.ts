import { get, set, del } from 'idb-keyval';
import { persistenceAvailable } from '../../lib/desktopPersistence';

/**
 * Opt-in certificate persistence (contracts/persistence.md, Principle VI).
 * Stores ONLY the password-protected .p12 bytes — never the password or decrypted private-key material.
 *
 * A stored .p12 is privacy-affecting state, so outcomes are reported rather than swallowed: save and
 * clear return true only when the storage operation is confirmed. Callers MUST surface a false result.
 */
const KEY = 'pdf-signer:remembered-certificate';

interface StoredCert {
  p12Bytes: Uint8Array;
  label: string;
  savedAt: number;
}

/**
 * True only if the write landed. On false, any record already stored is unchanged. Refuses to write
 * on desktop read-only media (FR-011b), so that guarantee does not depend on every caller.
 */
export async function saveCertificate(p12Bytes: Uint8Array, label: string): Promise<boolean> {
  if (!persistenceAvailable()) return false;
  const record: StoredCert = { p12Bytes, label, savedAt: Date.now() };
  try {
    await set(KEY, record);
    return true;
  } catch {
    return false;
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

/** True only once the key is confirmed gone, so "Forget" can never falsely report success. */
export async function clearCertificate(): Promise<boolean> {
  try {
    await del(KEY);
    return (await get(KEY)) == null;
  } catch {
    return false;
  }
}

export async function hasRememberedCertificate(): Promise<boolean> {
  try {
    return (await get(KEY)) != null;
  } catch {
    return false;
  }
}
