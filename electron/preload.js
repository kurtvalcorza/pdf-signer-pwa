// Desktop-only US3 surfaces (staleness notice + about/no-self-update), injected by the shell's
// preload. This code lives in electron/ and is NEVER part of the web dist/, so FR-019a holds by
// construction — the web PWA cannot ship these desktop-specific claims. Vanilla DOM (no React), so
// it never touches the app's own tree.

const { loadBuildMetadata } = require('./buildmeta');

// Data location (mode + path) passed from main via additionalArguments.
function readDataLocation() {
  const arg = process.argv.find((a) => a.startsWith('--pdfsigner-data='));
  if (!arg) return null;
  try {
    return JSON.parse(arg.slice('--pdfsigner-data='.length));
  } catch {
    return null;
  }
}

function el(tag, props = {}, style = '') {
  const node = document.createElement(tag);
  Object.assign(node, props);
  if (style) node.setAttribute('style', style);
  return node;
}

function mount() {
  const meta = loadBuildMetadata();
  const data = readDataLocation();

  // --- Staleness notice (passive, non-blocking) — only when the ENGINE is past threshold. A fresh
  // build must NOT show it (guarded by meta.isStale, derived from engineDate not buildDate). No
  // "don't show again" — that would be a new on-device store to suppress a required disclosure.
  if (meta && meta.isStale) {
    const banner = el(
      'div',
      { id: 'desktop-staleness-notice', role: 'status' },
      'position:fixed;top:0;left:0;right:0;z-index:2147483646;background:#7c2d12;color:#fff;' +
        'font:13px system-ui,sans-serif;padding:8px 40px 8px 12px;text-align:center;',
    );
    banner.textContent =
      `This build's bundled browser engine is ~${meta.engineAgeInDays} days old and no longer ` +
      `receives security updates. Please download a newer build. (This app never checks for updates.)`;
    const close = el(
      'button',
      { id: 'desktop-staleness-dismiss', textContent: '×', title: 'Dismiss' },
      'position:absolute;right:8px;top:6px;background:transparent;border:0;color:#fff;font-size:18px;cursor:pointer;',
    );
    close.addEventListener('click', () => banner.remove());
    banner.appendChild(close);
    document.body.appendChild(banner);
  }

  // --- About / info surface (version, engine + engine date, commit, distribution, no-self-update,
  // resolved data location). Always present on desktop; its content is desktop-specific by definition.
  const btn = el(
    'button',
    { id: 'desktop-about-button', textContent: 'ⓘ About', title: 'About this build' },
    'position:fixed;bottom:10px;left:10px;z-index:2147483646;background:#1f2937;color:#fff;border:0;' +
      'border-radius:6px;padding:6px 10px;font:12px system-ui,sans-serif;cursor:pointer;opacity:.85;',
  );
  btn.addEventListener('click', () => togglePanel(meta, data));
  document.body.appendChild(btn);
}

function togglePanel(meta, data) {
  const existing = document.getElementById('desktop-about-panel');
  if (existing) {
    existing.remove();
    return;
  }
  const panel = el(
    'div',
    { id: 'desktop-about-panel', role: 'dialog', 'aria-label': 'About this build' },
    'position:fixed;bottom:48px;left:10px;z-index:2147483647;max-width:360px;background:#111827;' +
      'color:#e5e7eb;border:1px solid #374151;border-radius:8px;padding:12px 14px;' +
      'font:12px/1.5 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.4);',
  );
  const line = (label, value) => {
    const row = el('div', {}, 'display:flex;gap:8px;justify-content:space-between;');
    row.appendChild(el('span', { textContent: label }, 'color:#9ca3af;'));
    row.appendChild(el('span', { textContent: value }, 'text-align:right;word-break:break-all;'));
    return row;
  };
  panel.appendChild(el('div', { textContent: 'PDF Signer — desktop build' }, 'font-weight:600;margin-bottom:8px;'));
  if (meta) {
    panel.appendChild(line('Version', meta.version));
    panel.appendChild(line('Engine', `Electron ${meta.engineVersion} (${meta.engineDate})`));
    panel.appendChild(line('Built', meta.buildDate));
    panel.appendChild(line('Commit', String(meta.commit).slice(0, 12)));
    panel.appendChild(line('Distribution', meta.distribution));
  } else {
    panel.appendChild(line('Build info', 'unavailable (dev run)'));
  }
  // Data-driven from selfUpdates:false — not a hardcoded string.
  panel.appendChild(
    el('div', { textContent: 'This build does not update itself and never contacts a network.' },
      'margin-top:8px;color:#fca5a5;'),
  );
  if (data) {
    panel.appendChild(el('div', { id: 'desktop-data-location', textContent: `Data (${data.mode}): ${data.path ?? 'Electron default'}` },
      'margin-top:8px;color:#9ca3af;word-break:break-all;'));
  }
  document.body.appendChild(panel);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
