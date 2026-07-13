/**
 * Honest disclosure shown before cryptographic signing (FR-016, Principle IV):
 * self-signed → "validity unknown", and signatures are not timestamped.
 */
export function DisclosureBanner() {
  return (
    <div className="rounded-lg bg-white/5 p-3 text-xs leading-relaxed text-white/60">
      <p className="mb-1 font-medium text-white/80">Before you sign</p>
      <ul className="list-disc space-y-1 pl-4">
        <li>
          If your certificate is self-signed, readers will show the signature as “validity
          unknown” until they trust it — this is normal.
        </li>
        <li>Signatures are not timestamped (the app is fully offline), so they have no long-term validation.</li>
        <li>Your certificate and password stay on this device and are never uploaded.</li>
      </ul>
    </div>
  );
}
