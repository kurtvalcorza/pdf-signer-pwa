import { useEffect, useRef, useState } from 'react';
import { DisclosureBanner } from './DisclosureBanner';
import { loadCertificate, clearCertificate } from '../features/persistence/certStore';
import { generateSelfSignedP12 } from '../features/signing/generateCert';
import { downloadBytes } from '../features/signing/export';

export interface SignRequest {
  p12Bytes: Uint8Array;
  password: string;
  remember: boolean;
  label?: string;
  /** Show "Digitally signed by {name}" in the appearance. */
  showLabel: boolean;
  /** Show the "Date: …" line in the appearance. */
  showDate: boolean;
}

interface Props {
  canSign: boolean;
  busy: boolean;
  onSign: (req: SignRequest) => void;
  onCancel: () => void;
}

export function CertSheet({ canSign, busy, onSign, onCancel }: Props) {
  const [p12Bytes, setP12Bytes] = useState<Uint8Array | null>(null);
  const [certLabel, setCertLabel] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [remembered, setRemembered] = useState(false);
  const [showLabel, setShowLabel] = useState(true);
  const [showDate, setShowDate] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  // Create-a-certificate state.
  const [creating, setCreating] = useState(false);
  const [fullName, setFullName] = useState('');
  const [org, setOrg] = useState('');
  const [unit, setUnit] = useState('');
  const [email, setEmail] = useState('');
  const [certDer, setCertDer] = useState<Uint8Array | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

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
    setCertDer(null);
  }

  async function forget() {
    await clearCertificate();
    setP12Bytes(null);
    setCertLabel(null);
    setRemember(false);
    setRemembered(false);
  }

  function createCert() {
    setGenError(null);
    try {
      const { p12Bytes: p12, certDer: der } = generateSelfSignedP12(
        {
          commonName: fullName.trim(),
          organization: org.trim() || undefined,
          organizationalUnit: unit.trim() || undefined,
          email: email.trim() || undefined,
        },
        password,
      );
      setP12Bytes(p12);
      setCertDer(der);
      setCertLabel(`${fullName.trim()}.p12`);
      setRemembered(false);
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e));
    }
  }

  const ready = !!p12Bytes && password.length > 0 && canSign && !busy;
  const canCreate = creating && fullName.trim().length > 0 && password.length > 0 && !certDer;

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

      {!creating ? (
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
      ) : (
        <div className="flex flex-col gap-2 rounded-lg bg-white/5 p-3">
          <span className="text-xs font-medium text-white/70">Create a certificate</span>
          <input
            type="text"
            placeholder="Full name (e.g. Kurt Valcorza) — required"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="rounded-lg bg-white/10 px-3 py-2 text-sm outline-none placeholder:text-white/30"
          />
          <input
            type="text"
            placeholder="Organization (optional)"
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            className="rounded-lg bg-white/10 px-3 py-2 text-sm outline-none placeholder:text-white/30"
          />
          <input
            type="text"
            placeholder="Division / unit (optional)"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            className="rounded-lg bg-white/10 px-3 py-2 text-sm outline-none placeholder:text-white/30"
          />
          <input
            type="email"
            placeholder="Email address (optional)"
            value={email}
            autoComplete="off"
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-lg bg-white/10 px-3 py-2 text-sm outline-none placeholder:text-white/30"
          />
          <p className="text-xs text-white/40">
            The password below protects the new certificate. Choose one you’ll remember.
          </p>
          {genError && <p className="text-xs text-amber-200">{genError}</p>}
          {!certDer ? (
            <button
              type="button"
              disabled={!canCreate}
              onClick={createCert}
              className="rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/15 disabled:opacity-40"
            >
              Create certificate
            </button>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-green-300">✓ Certificate created — ready to sign.</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => p12Bytes && downloadBytes(p12Bytes, certLabel ?? 'certificate.p12', 'application/x-pkcs12')}
                  className="flex-1 rounded-lg bg-white/10 px-3 py-2 text-xs hover:bg-white/15"
                >
                  ⬇ Save .p12 (Digital ID)
                </button>
                <button
                  type="button"
                  onClick={() => downloadBytes(certDer, `${fullName.trim() || 'certificate'}.cer`, 'application/x-x509-ca-cert')}
                  className="flex-1 rounded-lg bg-white/10 px-3 py-2 text-xs hover:bg-white/15"
                >
                  ⬇ Save public .cer
                </button>
              </div>
              <p className="text-xs text-white/40">
                Keep the .p12 private (it signs). Share the .cer so others can trust your signature.
              </p>
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => {
          setCreating((v) => !v);
          setCertDer(null);
        }}
        className="self-start text-xs text-blue-300 hover:text-blue-200"
      >
        {creating ? 'Use an existing certificate' : "Don't have a certificate? Create one"}
      </button>

      <input
        type="password"
        placeholder="Certificate password"
        value={password}
        autoComplete="off"
        onChange={(e) => setPassword(e.target.value)}
        className="rounded-lg bg-white/10 px-4 py-3 text-sm outline-none placeholder:text-white/30"
      />

      {!creating && (
        <label className="flex items-center gap-2 text-xs text-white/60">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember this certificate on this device (never the password)
        </label>
      )}

      <div className="flex flex-col gap-1 rounded-lg bg-white/5 p-3">
        <span className="text-xs font-medium text-white/70">Signature appearance</span>
        <label className="flex items-center gap-2 text-xs text-white/60">
          <input type="checkbox" checked={showLabel} onChange={(e) => setShowLabel(e.target.checked)} />
          Show “Digitally signed by {'{name}'}”
        </label>
        <label className="flex items-center gap-2 text-xs text-white/60">
          <input type="checkbox" checked={showDate} onChange={(e) => setShowDate(e.target.checked)} />
          Show date
        </label>
        <span className="text-white/30 text-[11px]">Off = just your signature image, no text.</span>
      </div>

      <DisclosureBanner />

      <button
        type="button"
        disabled={!ready}
        onClick={() =>
          p12Bytes &&
          onSign({ p12Bytes, password, remember, label: certLabel ?? 'certificate', showLabel, showDate })
        }
        className="rounded-lg bg-blue-500 px-4 py-3 font-semibold hover:bg-blue-400 disabled:opacity-40"
      >
        {busy ? 'Signing…' : 'Sign & Download'}
      </button>
    </div>
  );
}
