(function () {
  'use strict';

  const canvas     = document.getElementById('screen');
  const ctx        = canvas.getContext('2d');
  const overlay    = document.getElementById('overlay');
  const overlayMsg = document.getElementById('overlay-msg');
  const urlInput   = document.getElementById('url-input');
  const pingEl     = document.getElementById('ping');
  const btnBack    = document.getElementById('btn-back');
  const btnFwd     = document.getElementById('btn-fwd');
  const btnReload  = document.getElementById('btn-reload');
  const viewport   = document.getElementById('viewport');

  let ws        = null;
  let connected = false;
  let vpW = 0, vpH = 0;
  let pingTime  = 0;

  // ── Helpers ──────────────────────────────────────────────────────────────

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN)
      ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }

  function viewportSize() {
    return { w: viewport.clientWidth, h: viewport.clientHeight };
  }

  function scaleCoords(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - rect.left) * (vpW / rect.width)),
      y: Math.round((e.clientY - rect.top)  * (vpH / rect.height)),
    };
  }

  function modifiers(e) {
    return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  }

  const BUTTONS = ['left', 'middle', 'right', 'back', 'forward'];

  // ── WebSocket ─────────────────────────────────────────────────────────────

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      connected = true;
      overlay.style.display = 'none';
      canvas.focus();
      const { w, h } = viewportSize();
      vpW = w; vpH = h;
      canvas.width = w; canvas.height = h;
      send({ t: 'resize', w, h });
    };

    ws.onmessage = async (ev) => {
      if (typeof ev.data !== 'string') {
        try {
          const bitmap = await createImageBitmap(new Blob([ev.data], { type: 'image/jpeg' }));
          ctx.drawImage(bitmap, 0, 0, vpW, vpH);
          bitmap.close();
        } catch {}
        return;
      }
      const msg = JSON.parse(ev.data);
      if      (msg.t === 'url')   { urlInput.value = msg.url; }
      else if (msg.t === 'title') { if (msg.title) document.title = msg.title + ' – Chrome'; }
      else if (msg.t === 'pong')  { pingEl.textContent = (Date.now() - pingTime) + ' ms'; }
      else if (msg.t === 'download_start') { showDownloadPending(msg.filename); }
      else if (msg.t === 'download_ready') { triggerDownload(msg.filename, msg.data); }
    };

    ws.onclose = () => {
      connected = false;
      overlay.style.display = 'flex';
      overlayMsg.textContent = 'Disconnected. Reconnecting…';
      setTimeout(connect, 2000);
    };

    ws.onerror = () => ws.close();
  }

  setInterval(() => {
    if (!connected) return;
    pingTime = Date.now();
    send({ t: 'ping' });
  }, 5000);

  // ── Mouse ─────────────────────────────────────────────────────────────────

  let lastMoveTime = 0;
  // Track click count manually so Chrome gets clickCount:2 on double-clicks
  // without the dblclick handler sending duplicate events on top of mousedown/mouseup.
  let lastClickTime = 0, lastClickX = 0, lastClickY = 0, clickCount = 0;

  canvas.addEventListener('mousemove', e => {
    if (!connected) return;
    const now = Date.now();
    if (now - lastMoveTime < 16) return;
    lastMoveTime = now;
    const { x, y } = scaleCoords(e);
    send({ t: 'mouse', d: { type: 'mouseMoved', x, y, modifiers: modifiers(e) } });
  });

  canvas.addEventListener('mousedown', e => {
    e.preventDefault();
    canvas.focus();
    if (!connected) return;
    const { x, y } = scaleCoords(e);
    const now = Date.now();
    const sameSpot = Math.abs(x - lastClickX) < 4 && Math.abs(y - lastClickY) < 4;
    clickCount = (now - lastClickTime < 500 && sameSpot) ? 2 : 1;
    lastClickTime = now; lastClickX = x; lastClickY = y;
    send({ t: 'mouse', d: { type: 'mousePressed', x, y, button: BUTTONS[e.button] || 'none', clickCount, modifiers: modifiers(e) } });
  });

  canvas.addEventListener('mouseup', e => {
    if (!connected) return;
    const { x, y } = scaleCoords(e);
    send({ t: 'mouse', d: { type: 'mouseReleased', x, y, button: BUTTONS[e.button] || 'none', clickCount, modifiers: modifiers(e) } });
  });

  canvas.addEventListener('contextmenu', e => e.preventDefault());

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    if (!connected) return;
    const { x, y } = scaleCoords(e);
    send({ t: 'wheel', x, y, dx: e.deltaX, dy: e.deltaY, mod: modifiers(e) });
  }, { passive: false });

  // ── Keyboard ──────────────────────────────────────────────────────────────

  canvas.setAttribute('tabindex', '0');

  canvas.addEventListener('keydown', e => {
    if (!connected) return;
    if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I')) return;
    e.preventDefault();
    send({ t: 'keydown', d: {
      key: e.key, code: e.code, modifiers: modifiers(e),
      windowsVirtualKeyCode: e.keyCode, nativeVirtualKeyCode: e.keyCode,
    }});
  });

  canvas.addEventListener('keyup', e => {
    if (!connected) return;
    if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I')) return;
    e.preventDefault();
    send({ t: 'keyup', d: {
      key: e.key, code: e.code, modifiers: modifiers(e),
      windowsVirtualKeyCode: e.keyCode, nativeVirtualKeyCode: e.keyCode,
    }});
  });

  // ── Toolbar ───────────────────────────────────────────────────────────────

  function navigate() {
    let url = urlInput.value.trim();
    if (!url) return;
    if (!url.match(/^https?:\/\//)) url = 'https://' + url;
    send({ t: 'nav', url });
    canvas.focus();
  }

  btnBack.addEventListener('click',   () => { send({ t: 'back' });   canvas.focus(); });
  btnFwd.addEventListener('click',    () => { send({ t: 'fwd' });    canvas.focus(); });
  btnReload.addEventListener('click', () => { send({ t: 'reload' }); canvas.focus(); });

  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') navigate(); e.stopPropagation(); });
  urlInput.addEventListener('focus',   () => urlInput.select());

  // ── Resize ────────────────────────────────────────────────────────────────

  const resizeObserver = new ResizeObserver(() => {
    if (!connected) return;
    const { w, h } = viewportSize();
    if (w === vpW && h === vpH) return;
    vpW = w; vpH = h;
    canvas.width = w; canvas.height = h;
    send({ t: 'resize', w, h });
  });
  resizeObserver.observe(viewport);

  // ── Paste from host clipboard ─────────────────────────────────────────────
  // When the canvas is focused, Ctrl+V is forwarded to Chrome as a keydown event
  // and Chrome handles paste natively. This handler covers the case where the user
  // pastes while a local input (e.g. the URL bar) is focused instead.

  document.addEventListener('paste', e => {
    if (!connected || document.activeElement === canvas) return;
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    for (const ch of text) {
      send({ t: 'keydown', d: { key: ch, code: '', modifiers: 0,
        windowsVirtualKeyCode: ch.charCodeAt(0), nativeVirtualKeyCode: ch.charCodeAt(0) } });
    }
  });

  // ── Downloads ─────────────────────────────────────────────────────────────

  const dlBanner = document.createElement('div');
  dlBanner.id = 'dl-banner';
  dlBanner.style.cssText = [
    'position:fixed', 'bottom:16px', 'right:16px', 'z-index:9999',
    'background:#2d2d2d', 'color:#eee', 'padding:10px 16px',
    'border-radius:8px', 'font-size:13px', 'font-family:Arial,sans-serif',
    'box-shadow:0 2px 8px rgba(0,0,0,.5)', 'display:none',
  ].join(';');
  document.body.appendChild(dlBanner);

  let dlBannerTimer = null;

  function showDownloadPending(filename) {
    dlBanner.textContent = 'Downloading: ' + filename + '…';
    dlBanner.style.display = 'block';
    if (dlBannerTimer) clearTimeout(dlBannerTimer);
  }

  function triggerDownload(filename, base64data) {
    const bytes = Uint8Array.from(atob(base64data), c => c.charCodeAt(0));
    const blob  = new Blob([bytes]);
    const url   = URL.createObjectURL(blob);
    const a     = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    dlBanner.textContent = 'Downloaded: ' + filename;
    if (dlBannerTimer) clearTimeout(dlBannerTimer);
    dlBannerTimer = setTimeout(() => { dlBanner.style.display = 'none'; dlBannerTimer = null; }, 3000);
  }

  connect();
})();
