import { useEffect, useRef, useState } from 'react';
import { DisclosureBanner } from './DisclosureBanner';
import { loadCertificate, clearCertificate } from '../features/persistence/certStore';

export interface SignRequest {
  p12Bytes: Uint8Array;
  password: string;
  remember: boolean;
  label?: string;
}

interface Props {
  canSign: boolean;
  busy: boolean;
  onSign: (req: SignRequest) => void;
  onCancel: () => void;
}

/**
 * Certificate sheet (FR-005/015/016/021): pick a .p12, enter its password (never
 * persisted), optionally remember the certificate, and sign.
 */
export function CertSheet({ canSign, busy, onSign, onCancel }: Props) {
  const [p12Bytes, setP12Bytes] = useState<Uint8Array | null>(null);
  const [certLabel, setCertLabel] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [remembered, setRemembered] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Pre-fill from a remembered certificate (password still required, FR-022).
  useEffect(() => {
    loadCertificate().then((c) => {
      if (c) {
        setP12Bytes(c.p12Bytes);
        setCertLabel(c.label);
        setRemembered(true);
        setRemember(true);
      }
    });
  }, []);

  async function pickCert(file: File) {
    setP12Bytes(new Uint8Array(await file.arrayBuffer()));
    setCertLabel(file.name);
    setRemembered(false);
  }

  async function forget() {
    await clearCertificate();
    setP12Bytes(null);
    setCertLabel(null);
    setRemember(false);
    setRemembered(false);
  }

  const ready = !!p12Bytes && password.length > 0 && canSign && !busy;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="font-medium">Sign with a certificate</span>
        <button type="button" onClick={onCancel} className="text-sm text-white/50 hover:text-white">
          ← Back
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".p12,.pfx"
        hidden
        onChange={(e) => e.target.files?.[0] && pickCert(e.target.files[0])}
      />

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex-1 rounded-lg bg-white/10 px-4 py-3 text-left text-sm hover:bg-white/15"
        >
          {certLabel ? `📄 ${certLabel}` : 'Choose certificate (.p12 / .pfx)'}
        </button>
        {remembered && (
          <button type="button" onClick={forget} className="text-xs text-white/50 hover:text-white">
            Forget
          </button>
        )}
      </div>

      <input
        type="password"
        placeholder="Certificate password"
        value={password}
        autoComplete="off"
        onChange={(e) => setPassword(e.target.value)}
        className="rounded-lg bg-white/10 px-4 py-3 text-sm outline-none placeholder:text-white/30"
      />

      <label className="flex items-center gap-2 text-xs text-white/60">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Remember this certificate on this device (never the password)
      </label>

      <DisclosureBanner />

      <button
        type="button"
        disabled={!ready}
        onClick={() => p12Bytes && onSign({ p12Bytes, password, remember, label: certLabel ?? 'certificate' })}
        className="rounded-lg bg-blue-500 px-4 py-3 font-semibold hover:bg-blue-400 disabled:opacity-40"
      >
        {busy ? 'Signing…' : 'Sign & Download'}
      </button>
    </div>
  );
}
