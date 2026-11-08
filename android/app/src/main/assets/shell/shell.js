// PDF Signer Android shell: contracts/shell-bridge.md §2. Injected at document start, app origin
// only. It records blob URLs and turns the shared app's blob: download clicks into save requests
// over the `pdfSignerShell` channel. It never reads or modifies the app's state, storage, React
// tree or #root, and never touches fetch, XMLHttpRequest, WebSocket or workers.
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
      } catch (_) {
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
})();
