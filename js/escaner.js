// escaner.js - Lector de cámara para celular, pensado para no "quedarse pegado".
//  - Libera la cámara al salir de la pantalla y la reabre al volver (el celular la congela en segundo plano).
//  - Vigilante: si el video se congela o la cámara se corta, la reinicia sola.
//  - Resolución alta + enfoque continuo + linterna + zoom (cuando el celular lo permite).
//  - Lectura inteligente (OCR): si en unos segundos no se lee el código de barras (etiqueta dañada, borrosa,
//    barras cortadas), se lee el NÚMERO impreso y se valida contra el catálogo antes de aceptarlo.
// Usa Html5Qrcode (ya incluido en libs/). El OCR (Tesseract.js) se descarga solo la primera vez que hace falta.
(function () {
  const OCR_LOCAL = 'libs/tesseract/tesseract.min.js';                       // opcional: copia local para trabajar sin internet
  const OCR_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  const OCR_IDLE_MS = 3000;      // sin lectura de barras durante este tiempo -> se intenta con OCR
  const OCR_EVERY_MS = 1500;
  const WATCH_MS = 2000;
  const FROZEN_MS = 5000;

  let h5 = null, cfg = null, wanted = false, starting = false, failures = 0;
  let track = null, caps = {}, watch = null, ocrTimer = null;
  let lastTime = -1, lastTimeAt = 0, lastReadAt = 0, startedAt = 0, last = { code: '', time: 0 };
  let ocrBusy = false, ocrWorker = null, ocrLoading = null, ocrFailed = false, actx = null;
  let ocrVotes = new Map(), ocrVotesAt = 0;
  // Un código del catálogo se acepta cuando el OCR lo lee igual DOS veces seguidas (evita que un dígito mal leído caiga en otro bien existente).
  function vote(code) {
    const now = Date.now(); if (now - ocrVotesAt > 8000) ocrVotes.clear(); ocrVotesAt = now;
    const n = (ocrVotes.get(code) || 0) + 1; ocrVotes.set(code, n); return n;
  }

  const root = () => document.getElementById(cfg.elementId);
  const video = () => { const r = cfg && root(); return r ? r.querySelector('video') : null; };
  const status = (t) => { try { cfg && cfg.onStatus && cfg.onStatus(t); } catch (_) {} };

  function beep() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = 1100; g.gain.value = 0.08; o.connect(g); g.connect(actx.destination);
      o.start(); o.stop(actx.currentTime + 0.08);
    } catch (_) {}
    try { if (navigator.vibrate) navigator.vibrate(60); } catch (_) {}
  }

  // Detiene todo de forma segura: nunca lanza error y siempre deja la cámara liberada.
  async function release() {
    clearInterval(watch); watch = null; clearInterval(ocrTimer); ocrTimer = null;
    const inst = h5; h5 = null; track = null;
    if (inst) {
      try { await inst.stop(); } catch (_) {}
      try { inst.clear(); } catch (_) {}
    }
    const r = cfg && root();
    if (r) {
      r.querySelectorAll('video').forEach((v) => { try { if (v.srcObject) v.srcObject.getTracks().forEach((t) => t.stop()); } catch (_) {} });
      r.innerHTML = '';
    }
  }

  function onDecoded(text) {
    const now = Date.now();
    if (text === last.code && now - last.time < cfg.cooldown) return;
    last = { code: text, time: now }; lastReadAt = now;
    beep(); status('✔ Leído'); cfg.onCode(text, 'barcode');
  }

  async function begin() {
    if (starting || !cfg) return;
    starting = true;
    try {
      const make = () => new Html5Qrcode(cfg.elementId, { verbose: false, useBarCodeDetectorIfSupported: true, experimentalFeatures: { useBarCodeDetectorIfSupported: true } });
      const base = {
        fps: 12, disableFlip: true,
        qrbox: (w, h) => ({ width: Math.max(80, Math.floor(Math.min(w * 0.92, 420))), height: Math.max(80, Math.floor(Math.min(h * 0.55, 180))) })
      };
      const hi = { ...base, videoConstraints: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } };
      h5 = make();
      try { await h5.start({ facingMode: 'environment' }, hi, onDecoded, () => {}); }
      catch (e1) {
        // algunas versiones de la librería no aceptan videoConstraints: se reintenta con la configuración simple
        try { await h5.stop(); } catch (_) {} try { h5.clear(); } catch (_) {}
        h5 = make(); await h5.start({ facingMode: 'environment' }, base, onDecoded, () => {});
      }
      const v = video();
      track = v && v.srcObject && v.srcObject.getVideoTracks ? v.srcObject.getVideoTracks()[0] : null;
      caps = track && track.getCapabilities ? (track.getCapabilities() || {}) : {};
      if (track && caps.focusMode && caps.focusMode.includes && caps.focusMode.includes('continuous')) {
        track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      }
      startedAt = Date.now(); lastTimeAt = startedAt; lastTime = -1; failures = 0;
      status('Apunte al código de barras');
      if (cfg.onReady) cfg.onReady({ torch: !!caps.torch, zoom: caps.zoom ? { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 } : null });
      watch = setInterval(watchdog, WATCH_MS);
      if (!cfg.noOcr) ocrTimer = setInterval(ocrTick, OCR_EVERY_MS);
    } finally { starting = false; }
  }

  async function restart(msg) {
    if (!wanted || starting) return;
    status(msg);
    await release();
    try { await begin(); }
    catch (e) {
      failures++;
      if (failures >= 3) { wanted = false; await release(); if (cfg.onStop) cfg.onStop('No se pudo reiniciar la cámara. Ciérrela y ábrala de nuevo.'); }
      else setTimeout(() => restart('Reintentando cámara…'), 1200);
    }
  }

  function watchdog() {
    if (!wanted || starting || document.hidden) return;
    const v = video(), now = Date.now();
    if (v && v.paused) v.play().catch(() => {});
    if (v && v.currentTime !== lastTime) { lastTime = v.currentTime; lastTimeAt = now; }
    const ended = !track || track.readyState === 'ended';
    const frozen = v && now - lastTimeAt > FROZEN_MS;
    if (!v || ended || frozen) restart('La cámara se detuvo. Reiniciando…');
  }

  // ---------- lectura inteligente (OCR) ----------
  const loadScript = (src) => new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('No cargó ' + src)); document.head.appendChild(s);
  });
  async function getWorker() {
    if (ocrWorker) return ocrWorker;
    if (ocrFailed) return null;
    if (!ocrLoading) {
      ocrLoading = (async () => {
        let local = false;
        if (!window.Tesseract) {
          try { await loadScript(OCR_LOCAL); local = true; } catch (_) { await loadScript(OCR_CDN); }
        }
        const opts = local ? { workerPath: 'libs/tesseract/worker.min.js', corePath: 'libs/tesseract/', langPath: 'libs/tesseract/' } : {};
        let w;
        try { w = await Tesseract.createWorker('eng', 1, opts); }
        catch (e) { if (!local) throw e; w = await Tesseract.createWorker('eng', 1, {}); }   // faltan archivos locales: se usan los de internet
        await w.setParameters({ tessedit_char_whitelist: '0123456789-', tessedit_pageseg_mode: '6' });
        return w;
      })().catch((e) => { ocrFailed = true; console.warn('Lectura inteligente no disponible:', e); return null; });
    }
    ocrWorker = await ocrLoading;
    return ocrWorker;
  }
  // Escala de grises + estiramiento de contraste (percentiles 2-98). Hecho a mano porque ctx.filter no existe en Safari/iPhone.
  function enhance(ctx, w, h) {
    const img = ctx.getImageData(0, 0, w, h), d = img.data, n = w * h, hist = new Uint32Array(256);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const g = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8; d[p] = g; hist[g]++;
    }
    let acc = 0, lo = 0, hi = 255;
    for (let g = 0; g < 256; g++) { acc += hist[g]; if (acc >= n * 0.02) { lo = g; break; } }
    acc = 0; for (let g = 255; g >= 0; g--) { acc += hist[g]; if (acc >= n * 0.02) { hi = g; break; } }
    const k = hi > lo + 10 ? 255 / (hi - lo) : 1;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const g = Math.max(0, Math.min(255, (d[p] - lo) * k)); d[p] = d[p + 1] = d[p + 2] = g; d[p + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }
  function ocrTick() {
    if (!wanted || starting || ocrBusy || document.hidden || !cfg.match) return;
    if (Date.now() - Math.max(lastReadAt, startedAt) < OCR_IDLE_MS) return;
    runOcr();
  }
  async function runOcr(manual) {
    const v = video(); if (!v || !v.videoWidth) return;
    ocrBusy = true; let miss = '', pending = '';
    try {
      status('🤖 Leyendo el número…');
      const w = await getWorker();
      if (!w) { status(manual ? 'La lectura por IA necesita internet la primera vez.' : 'Apunte al código de barras'); return; }
      const vw = v.videoWidth, vh = v.videoHeight;
      // El número impreso puede estar abajo, arriba o al costado de las barras: se prueban varios recortes
      // (cuadro completo, mitad inferior y franja central). En lectura automática solo los dos primeros, para ir rápido.
      const crops = [[0, 0, 1, 1], [0, 0.4, 1, 0.6], [0.04, 0.25, 0.92, 0.5]];
      let hit = null;
      for (const [fx, fy, fw, fh] of (manual ? crops : crops.slice(0, 2))) {
        const cw = Math.floor(vw * fw), ch = Math.floor(vh * fh), sx = Math.floor(vw * fx), sy = Math.floor(vh * fy);
        const sc = Math.min(2, 1800 / cw);   // se agranda (máx. 1800 px de ancho): los dígitos impresos son pequeños
        const c = document.createElement('canvas'); c.width = Math.floor(cw * sc); c.height = Math.floor(ch * sc);
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(v, sx, sy, cw, ch, 0, 0, c.width, c.height);
        enhance(ctx, c.width, c.height);
        // dos modos de lectura: bloque de texto y texto disperso
        for (const psm of ['6', '11']) {
          await w.setParameters({ tessedit_pageseg_mode: psm });
          const { data } = await w.recognize(c);
          const h = cfg.match((data && data.text) || '');
          if (h && h.exact) {
            if (vote(h.code) >= 2) { hit = h; break; }
            pending = h.code; status('🤖 Confirmando lectura…');
          } else if (h && h.miss) miss = h.miss;
          if (!wanted) return;
        }
        if (hit) break;
      }
      if (hit && wanted) {
        ocrVotes.clear();
        const now = Date.now();
        if (hit.code === last.code && now - last.time < cfg.cooldown) return;
        last = { code: hit.code, time: now }; lastReadAt = now; beep();
        status('✔ Leído por IA');
        cfg.onCode(hit.code, 'ocr');
      } else if (pending) status('🤖 Mantenga firme la cámara para confirmar el número…');
      else if (miss) status(`🤖 Leyó ${miss}: no figura en la base de datos.`);
      else status(manual ? 'No se pudo leer el número de 12 dígitos. Acérquese y enfoque la numeración.' : 'Apunte al código de barras');
    } catch (e) { console.warn('OCR:', e); }
    finally { ocrBusy = false; }
  }

  // ---------- visibilidad: el celular congela la cámara en segundo plano ----------
  document.addEventListener('visibilitychange', async () => {
    if (!wanted || !cfg) return;
    if (document.hidden) { await release(); }
    else { try { await begin(); } catch (_) { restart('Reabriendo la cámara…'); } }
  });
  window.addEventListener('pagehide', () => { if (h5) release(); });

  window.Escaner = {
    isActive: () => wanted,
    async start(options) {
      cfg = { cooldown: 2500, ...options }; wanted = true; ocrFailed = false; last = { code: '', time: 0 }; lastReadAt = 0;
      try { await begin(); }
      catch (e) { wanted = false; await release(); throw e; }
    },
    async stop() { wanted = false; await release(); status(''); },
    // lectura inmediata del número impreso (botón "Leer número")
    readNow() { if (!wanted || ocrBusy || !cfg || !cfg.match) return; runOcr(true); },
    async setTorch(on) { if (!track) return false; try { await track.applyConstraints({ advanced: [{ torch: !!on }] }); return true; } catch (_) { return false; } },
    async setZoom(z) { if (!track) return false; try { await track.applyConstraints({ advanced: [{ zoom: Number(z) }] }); return true; } catch (_) { return false; } }
  };
})();
