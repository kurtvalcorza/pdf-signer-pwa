// PDF Signer Android shell: contracts/shell-bridge.md §2. Injected at document start, app origin
// only. It does exactly three things: records blob URLs, turns the shared app's blob: download
// clicks into save requests over the `pdfSignerShell` channel, and shows the shell's own About
// panel and engine notice outside #root. It never reads or modifies the app's state, storage,
// React tree or #root, and never touches fetch, XMLHttpRequest, WebSocket or workers.
/* global window, document, URL, Blob, btoa, HTMLAnchorElement */
(() => {
  'use strict';
  if (window.__pdfSignerShell) return;
  Object.defineProperty(window, '__pdfSignerShell', { value: true });

  // 1. Blob registry. Return values are unchanged.
  const blobs = new Map();
  const create = URL.createObjectURL.bind(URL);
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    const url = create(obj);
    if (obj instanceof Blob) blobs.set(url, obj);
    return url;
  };
  URL.revokeObjectURL = function (url) {
    blobs.delete(url);
    return revoke(url);
  };

  // 2. Download interception.
  const CHUNK = 1024 * 1024;
  function toBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function send(channel, id, name, blob) {
    blob.arrayBuffer().then((buf) => {
      channel.postMessage(
        JSON.stringify({
          type: 'save-begin',
          id,
          name,
          mime: blob.type || 'application/octet-stream',
          size: buf.byteLength,
        }),
      );
      try {
        channel.postMessage(buf);
      } catch {
        // No ArrayBuffer messages on this WebView: base64 chunks of at most 1 MB, in order.
        const bytes = new Uint8Array(buf);
        for (let seq = 0, i = 0; i < bytes.length; seq++, i += CHUNK) {
          channel.postMessage(
            JSON.stringify({
              type: 'save-chunk',
              id,
              seq,
              data: toBase64(bytes.subarray(i, i + CHUNK)),
            }),
          );
        }
        channel.postMessage(JSON.stringify({ type: 'save-end', id }));
      }
    });
  }

  let nextId = 1;
  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const href = this.href || '';
    const blob = blobs.get(href);
    const channel = window.pdfSignerShell;
    if (this.download && href.startsWith('blob:') && blob && channel) {
      send(channel, nextId++, this.download, blob);
      return;
    }
    return originalClick.call(this);
  };

  // 3. Notices (contract §5): the shell's own "About this app" button and panel, and the engine
  // notice, in a closed shadow root on a node outside #root. Native code supplies all text, and
  // it is set with textContent only.
  const STYLE = `
    :host { all: initial; }
    .btn { position: fixed; top: 6px; left: 6px; z-index: 2147483646; width: 36px; height: 36px;
      border-radius: 18px; border: 1px solid #8886; background: #fffd; color: #333;
      font: 600 18px/34px system-ui, sans-serif; text-align: center; padding: 0; }
    .banner { position: fixed; left: 48px; right: 6px; top: 6px; z-index: 2147483645;
      background: #fff4d6; color: #4a3800; border: 1px solid #e0b84a; border-radius: 8px;
      padding: 6px 10px; font: 13px/1.35 system-ui, sans-serif; }
    .overlay { position: fixed; inset: 0; z-index: 2147483647; background: #0008; display: flex;
      align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; }
    .card { background: #fff; color: #222; max-height: 100%; overflow: auto; border-radius: 12px;
      padding: 16px 18px; font: 14px/1.45 system-ui, sans-serif; box-sizing: border-box; }
    h2 { font-size: 17px; margin: 0 0 8px; }
    ul { padding-left: 18px; margin: 0 0 12px; }
    li { margin: 0 0 8px; }
    .close { font: 600 15px system-ui, sans-serif; padding: 8px 16px; border-radius: 8px;
      border: 1px solid #888; background: #f4f4f4; color: #222; }`;

  function mountNotices(info) {
    if (document.getElementById('pdf-signer-shell') || !document.body) return;
    const host = document.createElement('div');
    host.id = 'pdf-signer-shell';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);

    const button = document.createElement('button');
    button.className = 'btn';
    button.type = 'button';
    button.textContent = 'i';
    button.setAttribute('aria-label', 'About this app');
    root.appendChild(button);

    if (typeof info.banner === 'string' && info.banner) {
      const banner = document.createElement('div');
      banner.className = 'banner';
      banner.setAttribute('role', 'status');
      banner.textContent = info.banner;
      root.appendChild(banner);
    }

    let overlay = null;
    const close = () => {
      if (overlay) overlay.remove();
      overlay = null;
      button.focus();
    };
    button.addEventListener('click', () => {
      if (overlay) return;
      overlay = document.createElement('div');
      overlay.className = 'overlay';
      const card = document.createElement('div');
      card.className = 'card';
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      card.setAttribute('aria-label', 'About this app');
      const h = document.createElement('h2');
      h.textContent = String(info.title || 'About this app');
      const list = document.createElement('ul');
      for (const line of Array.isArray(info.lines) ? info.lines : []) {
        const li = document.createElement('li');
        li.textContent = String(line);
        list.appendChild(li);
      }
      const done = document.createElement('button');
      done.className = 'close';
      done.type = 'button';
      done.textContent = 'Close';
      done.addEventListener('click', close);
      card.append(h, list, done);
      overlay.appendChild(card);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
      });
      root.appendChild(overlay);
      done.focus();
    });

    document.body.appendChild(host);
  }

  function requestAbout() {
    const channel = window.pdfSignerShell;
    if (!channel) return;
    channel.onmessage = (event) => {
      let msg = null;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg && msg.type === 'about') mountNotices(msg);
    };
    channel.postMessage(JSON.stringify({ type: 'about-request' }));
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', requestAbout, { once: true });
  } else {
    requestAbout();
  }
})();
