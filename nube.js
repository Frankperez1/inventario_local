// nube.js - Sincronización con Firebase (Authentication + Firestore).
// - Si firebase-config.js no tiene datos, este archivo no hace nada (la app sigue 100 % local).
// - NO sube el catálogo de 105 000 bienes: solo los bienes REGISTRADOS (escaneados/verificados), uno por documento.
// - Clave estable de cada documento = código + ambiente (nombres local/área/ambiente), porque los ids internos de la app
//   son aleatorios en cada equipo.
// - Descarga solo lo nuevo (cursor por updatedAt) para gastar pocas lecturas del plan gratuito.
(function () {
  const noop = () => {};
  window.Nube = { init: noop, notify: noop, enabled: false };
  const cfg = window.FIREBASE_CONFIG;
  if (!cfg || !cfg.apiKey || !window.firebase || !firebase.firestore || !firebase.auth) return;

  const COL = 'inventario';
  const OVERLAP_MS = 2 * 60 * 1000;   // margen al leer, por si hay relojes/escrituras casi simultáneas
  const PUSH_DELAY_MS = 3000;         // espera tras guardar antes de subir (agrupa cambios)
  const BATCH = 400;                  // Firestore admite 500 operaciones por lote
  const ERROR_BACKOFF_MS = 60000;

  let ctx = null, fdb = null, auth = null, user = null, unsub = null, pushTimer = null;
  let errorUntil = 0, lastInfo = '', state = 'nologin';
  const pending = new Map();          // id de bien -> firma que está subiéndose (solo memoria)
  const FV = () => firebase.firestore.FieldValue;

  // ---------- utilidades puras (también usadas por las pruebas) ----------
  const cyrb = (str) => {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  };
  const H = (s) => ctx.header(s);
  const keyOf = (n) => [n.local, n.area, n.room].map(H).join('|');
  const docIdOf = (code, n) => `${String(code).replace(/[^A-Za-z0-9_-]/g, '_')}_${cyrb(keyOf(n))}`;
  function roomMaps(db) {
    const L = new Map(db.locals.map((x) => [x.id, x]));
    const A = new Map(db.areas.map((x) => [x.id, x]));
    const R = new Map(db.rooms.map((x) => [x.id, x]));
    return { L, A, R, names(roomId) {
      const r = R.get(roomId); if (!r) return null;
      const a = A.get(r.areaId); const l = a && L.get(a.localId);
      return a && l ? { local: l.name, area: a.name, room: r.name } : null;
    } };
  }
  const payloadOf = (a, n) => ({
    code: String(a.code), local: n.local, area: n.area, room: n.room,
    type: a.type || '', detail: a.detail || '', state: a.state || 'Bueno',
    registered: !!a.registered, isDuplicateClone: !!a.isDuplicateClone, areaMismatch: !!a.areaMismatch, fromExcel: !!a.fromExcel,
    registeredAt: a.registeredAt || null, encargados: a.encargados || '',
    sourceArea: a.sourceArea || '', sourceRoom: a.sourceRoom || '', grupo: a.grupo || ''
  });
  const sigOf = (p) => JSON.stringify(p);

  // Bienes con cambios locales que aún no están en la nube
  function collectDirty() {
    const db = ctx.getDb(); const m = roomMaps(db); const out = [];
    for (const a of db.assets) {
      if (!(a.registered || a._syncSig)) continue;
      const n = a.roomId && m.names(a.roomId); if (!n) continue;
      const p = payloadOf(a, n); const sig = sigOf(p);
      if (a._syncSig === sig || pending.get(a.id) === sig) continue;
      out.push({ a, p, sig, id: docIdOf(a.code, n) });
    }
    return out;
  }

  // ---------- subir ----------
  function notify() {
    if (!user) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushNow, PUSH_DELAY_MS);
  }
  function pushNow() {
    if (!user || !ctx || Date.now() < errorUntil) return;
    const items = collectDirty();
    if (!items.length) { if (pending.size === 0) setState(navigator.onLine ? 'ok' : 'offline'); return; }
    setState('sync', `${items.length} por subir`);
    for (let i = 0; i < items.length; i += BATCH) {
      const chunk = items.slice(i, i + BATCH);
      const batch = fdb.batch();
      chunk.forEach(({ a, p, sig, id }) => {
        const stamp = { updatedAt: FV().serverTimestamp(), updatedBy: user.email || '' };
        batch.set(fdb.collection(COL).doc(id), { ...p, ...stamp }, { merge: true });
        // si el bien cambió de ambiente, el registro anterior se marca como no registrado
        if (a._cloudId && a._cloudId !== id) batch.set(fdb.collection(COL).doc(a._cloudId), { registered: false, ...stamp }, { merge: true });
        pending.set(a.id, sig);
      });
      // Sin conexión, commit() queda esperando y Firestore guarda el lote; se envía solo al reconectar.
      batch.commit().then(() => {
        chunk.forEach(({ a, sig, id }) => { a._syncSig = sig; a._cloudId = id; pending.delete(a.id); });
        if (pending.size === 0) { ctx.persist(); setState('ok'); }
      }).catch((err) => {
        chunk.forEach(({ a }) => pending.delete(a.id));
        errorUntil = Date.now() + ERROR_BACKOFF_MS;
        const code = err && err.code;
        setState('error', code === 'permission-denied' ? 'Sin permiso: revise sesión y reglas de Firestore'
          : code === 'resource-exhausted' ? 'Se alcanzó el límite diario gratuito; se reintentará más tarde'
          : (err && err.message) || 'Error al subir');
        console.warn('Nube: error al subir', err);
      });
    }
  }

  // ---------- bajar ----------
  function ensureRoom(db, d, roomByKey, m) {
    const key = keyOf(d);
    let room = roomByKey.get(key);
    if (room || !d.registered) return room || null;
    let local = db.locals.find((x) => H(x.name) === H(d.local));
    if (!local) { local = { id: ctx.uid(), name: d.local }; db.locals.push(local); m.L.set(local.id, local); }
    let area = db.areas.find((x) => x.localId === local.id && H(x.name) === H(d.area));
    if (!area) { area = { id: ctx.uid(), localId: local.id, name: d.area }; db.areas.push(area); m.A.set(area.id, area); }
    room = db.rooms.find((x) => x.areaId === area.id && H(x.name) === H(d.room));
    if (!room) { room = { id: ctx.uid(), areaId: area.id, name: d.room }; db.rooms.push(room); m.R.set(room.id, room); }
    roomByKey.set(key, room);
    return room;
  }
  function applyBatch(docs) {
    const db = ctx.getDb(); const m = roomMaps(db);
    const roomByKey = new Map();
    db.rooms.forEach((r) => { const n = m.names(r.id); if (n) roomByKey.set(keyOf(n), r); });
    const byCode = new Map();
    db.assets.forEach((a) => { const k = String(a.code).toLowerCase(); (byCode.get(k) || byCode.set(k, []).get(k)).push(a); });
    let applied = 0;
    for (const { id, d } of docs) {
      if (!d || !d.code) continue;
      const room = ensureRoom(db, d, roomByKey, m); if (!room) continue;
      const list = byCode.get(String(d.code).toLowerCase()) || [];
      let a = list.find((x) => x.roomId === room.id);
      if (!a && d.registered) {
        a = d.isDuplicateClone ? null : list.find((x) => !x.isDuplicateClone && !x.registered);
        if (!a) {
          a = { id: ctx.uid(), code: String(d.code), type: d.type, detail: d.detail, fromExcel: !!d.fromExcel, sourceArea: d.sourceArea,
                sourceRoom: d.sourceRoom, grupo: d.grupo, isDuplicateClone: !!d.isDuplicateClone, state: d.state, registered: false };
          db.assets.push(a); list.push(a); byCode.set(String(d.code).toLowerCase(), list);
        }
      }
      if (!a) continue; // un "no registrado" de un ambiente donde este equipo no tiene el bien: se ignora
      const here = a.roomId && m.names(a.roomId);
      if (here && (a.registered || a._syncSig) && a._syncSig !== sigOf(payloadOf(a, here))) continue; // cambio local pendiente: gana el local
      a.roomId = room.id; a.registered = !!d.registered; a.state = d.state || a.state; a.detail = d.detail || a.detail;
      a.type = d.type || a.type; a.areaMismatch = !!d.areaMismatch; a.encargados = d.encargados || ''; a.isDuplicateClone = !!d.isDuplicateClone;
      if (d.registeredAt) a.registeredAt = d.registeredAt;
      if (a.registered && !a.registeredOrder) a.registeredOrder = (db.scanCounter = (db.scanCounter || 0) + 1);
      a._syncSig = sigOf(payloadOf(a, m.names(room.id))); a._cloudId = id;
      applied++;
    }
    return applied;
  }
  function startListener() {
    stopListener();
    const since = Math.max(0, (ctx.getDb().cloudCursor || 0) - OVERLAP_MS);
    unsub = fdb.collection(COL).where('updatedAt', '>', firebase.firestore.Timestamp.fromMillis(since)).orderBy('updatedAt')
      .onSnapshot((snap) => {
        const docs = []; let maxTs = ctx.getDb().cloudCursor || 0;
        snap.docChanges().forEach((c) => {
          if (c.type === 'removed' || c.doc.metadata.hasPendingWrites) return;
          const d = c.doc.data(); const ts = d.updatedAt && d.updatedAt.toMillis ? d.updatedAt.toMillis() : 0;
          if (ts > maxTs) maxTs = ts;
          docs.push({ id: c.doc.id, d });
        });
        if (!docs.length) return;
        const applied = applyBatch(docs);
        ctx.getDb().cloudCursor = maxTs;
        if (applied) ctx.refresh();
        ctx.persist();
      }, (err) => {
        console.warn('Nube: error al escuchar', err);
        setState('error', err && err.code === 'permission-denied' ? 'Sin permiso: revise sesión y reglas de Firestore' : ((err && err.message) || 'Error de lectura'));
      });
  }
  function stopListener() { if (unsub) { unsub(); unsub = null; } }

  // ---------- inicio de sesión (pantalla completa, con modo sin conexión) ----------
  // Cómo funciona sin internet:
  //  1) Si ya iniciaste sesión alguna vez en este equipo, Firebase guarda la sesión y la app entra SOLA, con o sin internet.
  //  2) Si cerraste sesión (o es otro navegador) y NO hay internet: al iniciar sesión con internet por primera vez se guarda
  //     una huella (hash) de tu clave en este equipo; con ella puedes entrar sin conexión. La clave nunca se guarda en claro.
  //  3) Al volver el internet, la sesión de la nube se retoma sola y se suben los cambios pendientes.
  const OFF_KEY = 'nube_offline_cred_v1';
  const LABEL = { nologin: '☁ Sin sesión', ok: '☁ Sincronizado', sync: '☁ Sincronizando…', offline: '☁ Sin conexión', error: '☁ Error de nube', local: '☁ Modo local' };
  const COLOR = { nologin: '#b45309', ok: '#166534', sync: '#1d4ed8', offline: '#4b5563', error: '#b91c1c', local: '#4b5563' };
  let btn, dlg, gate, offlineUser = null, offlinePass = '';

  const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  async function hashPass(email, pass, saltHex) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
    const salt = saltHex ? Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16))) : crypto.getRandomValues(new Uint8Array(16));
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 120000 }, key, 256);
    return { salt: toHex(salt), hash: toHex(bits) };
  }
  const getCreds = () => { try { return JSON.parse(localStorage.getItem(OFF_KEY) || '[]'); } catch { return []; } };
  async function rememberCred(email, pass) {
    try {
      const { salt, hash } = await hashPass(email, pass);
      const list = getCreds().filter((c) => c.email !== email); list.push({ email, salt, hash });
      localStorage.setItem(OFF_KEY, JSON.stringify(list));
    } catch (e) { console.warn('Nube: no se pudo guardar el acceso sin conexión', e); }
  }
  async function checkOfflineCred(email, pass) {
    const c = getCreds().find((x) => x.email === email); if (!c) return null;
    const { hash } = await hashPass(email, pass, c.salt);
    return hash === c.hash;
  }

  function setState(s, info) {
    state = offlineUser && !user ? 'local' : s; lastInfo = info || '';
    if (btn) { btn.textContent = LABEL[state] || '☁'; btn.style.background = COLOR[state] || '#4b5563'; btn.title = lastInfo || ''; }
    if (dlg && dlg.open) renderDialog();
  }
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function showGate(mode) { // mode: 'loading' | 'login'
    if (!gate) return;
    gate.hidden = false; document.body.style.overflow = 'hidden';
    gate.querySelector('.ng-loading').hidden = mode !== 'loading';
    gate.querySelector('.ng-form').hidden = mode !== 'login';
    updateNet();
  }
  function hideGate() { if (gate) { gate.hidden = true; document.body.style.overflow = ''; } }
  function updateNet() {
    if (!gate) return;
    const on = navigator.onLine, el = gate.querySelector('.ng-net');
    el.className = 'ng-net ' + (on ? 'on' : 'off');
    el.textContent = on ? '● Con conexión' : '● Sin conexión';
    gate.querySelector('.ng-hint').textContent = on
      ? 'Use el correo y la clave que le dio el administrador.'
      : 'Sin internet: puede entrar con su correo y clave si ya inició sesión antes en este equipo, o continuar en modo local.';
  }
  async function doLogin() {
    const mail = gate.querySelector('#ng-mail').value.trim().toLowerCase();
    const pass = gate.querySelector('#ng-pass').value;
    const err = gate.querySelector('.ng-err'), go = gate.querySelector('#ng-go');
    if (!mail || !pass) { err.textContent = 'Escriba su correo y su clave.'; return; }
    err.textContent = ''; go.disabled = true; go.textContent = 'Entrando…';
    try {
      if (navigator.onLine) {
        try {
          await auth.signInWithEmailAndPassword(mail, pass);   // onAuthStateChanged oculta la pantalla
          rememberCred(mail, pass);
          return;
        } catch (ex) {
          const c = (ex && ex.code) || '';
          if (c !== 'auth/network-request-failed') throw ex;     // clave mala, etc.
          // la red "parece" activa pero no hay internet real: se prueba el acceso local
        }
      }
      const ok = await checkOfflineCred(mail, pass);
      if (ok === null) err.textContent = 'Este equipo aún no tiene acceso sin conexión para ese correo. Inicie sesión una vez con internet, o use "Continuar sin conexión".';
      else if (!ok) err.textContent = 'Correo o clave incorrectos.';
      else { offlineUser = { email: mail }; offlinePass = pass; hideGate(); setState('offline', 'Sesión local. Se sincroniza al volver el internet'); }
    } catch (ex) {
      const c = (ex && ex.code) || '';
      err.textContent = /invalid|wrong|user-not-found|credential/i.test(c) ? 'Correo o clave incorrectos.'
        : c === 'auth/too-many-requests' ? 'Demasiados intentos. Espere unos minutos.'
        : ((c + ' ' + ((ex && ex.message) || '')).trim());
    } finally { go.disabled = false; go.textContent = 'Entrar'; }
  }
  function renderDialog() {
    const box = dlg.querySelector('div');
    const who = user ? user.email : (offlineUser ? offlineUser.email : '');
    box.innerHTML = `<h3>Nube (Firebase)</h3><p>Sesión: <b></b></p><p>Estado: <b>${LABEL[state] || ''}</b>${lastInfo ? '<br><small></small>' : ''}</p>
      <div class="nube-row"><button data-a="sync">Sincronizar ahora</button><button data-a="out">Cerrar sesión</button><button data-a="close">Cerrar</button></div>`;
    box.querySelector('b').textContent = who || 'Sin iniciar sesión';
    const sm = box.querySelector('small'); if (sm) sm.textContent = lastInfo;
  }
  function buildUI() {
    if (typeof document === 'undefined' || !document.body || btn) return;
    const st = document.createElement('style');
    st.textContent = `#nube-btn{position:fixed;right:14px;bottom:14px;z-index:9999;border:0;border-radius:999px;padding:9px 14px;font:600 13px system-ui,sans-serif;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer}
      #nube-dlg{border:0;border-radius:12px;padding:0;max-width:360px;width:92%}#nube-dlg::backdrop{background:rgba(0,0,0,.45)}#nube-dlg>div{padding:18px;font:14px system-ui,sans-serif}
      #nube-dlg h3{margin:0 0 8px}.nube-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.nube-row button{padding:8px 12px;font-size:14px;cursor:pointer}
      #nube-gate{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:18px;font-family:system-ui,'Segoe UI',sans-serif;color:#eef4ff;
        background:radial-gradient(900px 500px at 15% 10%,rgba(44,227,255,.18),transparent 60%),radial-gradient(800px 500px at 90% 95%,rgba(255,201,61,.14),transparent 60%),#03050b}
      #nube-gate[hidden]{display:none}
      .ng-card{width:100%;max-width:400px;padding:30px 26px;border-radius:20px;background:rgba(13,21,41,.78);backdrop-filter:blur(14px);border:1px solid rgba(120,200,255,.28);box-shadow:0 0 40px rgba(44,227,255,.14),0 20px 50px rgba(0,0,0,.5);text-align:center}
      .ng-logo{width:92px;height:auto;margin:0 auto 12px;display:block;filter:drop-shadow(0 0 14px rgba(255,201,61,.35))}
      .ng-card h1{margin:0;font-size:22px;letter-spacing:.3px}.ng-card h2{margin:4px 0 16px;font-size:13px;font-weight:500;color:#92a6cb}
      .ng-net{display:inline-block;font-size:12px;font-weight:600;padding:4px 10px;border-radius:999px;margin-bottom:14px}
      .ng-net.on{background:rgba(63,242,172,.12);color:#3ff2ac}.ng-net.off{background:rgba(255,201,61,.14);color:#ffc93d}
      .ng-hint{font-size:12.5px;color:#92a6cb;margin:0 0 14px;line-height:1.45}
      .ng-field{position:relative;margin-bottom:12px;text-align:left}
      .ng-field input{width:100%;box-sizing:border-box;padding:13px 44px 13px 14px;font-size:16px;color:#eef4ff;background:rgba(19,29,54,.8);border:1px solid rgba(120,190,255,.25);border-radius:12px;outline:none}
      .ng-field input:focus{border-color:#2ce3ff;box-shadow:0 0 0 3px rgba(44,227,255,.18)}
      .ng-eye{position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:0;color:#92a6cb;font-size:18px;cursor:pointer;padding:6px 8px}
      #ng-go{width:100%;padding:13px;margin-top:4px;border:0;border-radius:12px;font-size:16px;font-weight:700;color:#03121a;background:linear-gradient(90deg,#2ce3ff,#a7f3ff);cursor:pointer}
      #ng-go:disabled{opacity:.6;cursor:wait}
      .ng-link{display:block;width:100%;margin-top:12px;background:none;border:1px solid rgba(255,201,61,.45);color:#ffc93d;padding:11px;border-radius:12px;font-size:14px;font-weight:600;cursor:pointer}
      .ng-err{color:#ff4d70;font-size:13px;min-height:1.3em;margin:8px 0 0}.ng-loading{color:#92a6cb;padding:30px 0}`;
    document.head.appendChild(st);

    btn = document.createElement('button'); btn.id = 'nube-btn'; btn.type = 'button';
    btn.onclick = () => { renderDialog(); dlg.showModal(); };
    dlg = document.createElement('dialog'); dlg.id = 'nube-dlg'; dlg.appendChild(document.createElement('div'));
    dlg.addEventListener('click', async (e) => {
      const a = e.target && e.target.dataset && e.target.dataset.a; if (!a) return;
      if (a === 'close') dlg.close();
      else if (a === 'out') { offlineUser = null; offlinePass = ''; try { if (auth) await auth.signOut(); } catch (_) {} dlg.close(); showGate('login'); setState('nologin'); }
      else if (a === 'sync') { errorUntil = 0; pushNow(); if (ctx && user) startListener(); }
    });

    gate = document.createElement('div'); gate.id = 'nube-gate'; gate.hidden = true;
    gate.innerHTML = `<div class="ng-card">
      <img class="ng-logo" alt="UNCP">
      <h1>Inventario de Bienes</h1><h2>Universidad Nacional del Centro del Perú</h2>
      <p class="ng-loading">Verificando sesión…</p>
      <div class="ng-form" hidden>
        <span class="ng-net on">● Con conexión</span>
        <p class="ng-hint"></p>
        <div class="ng-field"><input id="ng-mail" type="email" placeholder="Correo" autocomplete="username"></div>
        <div class="ng-field"><input id="ng-pass" type="password" placeholder="Clave" autocomplete="current-password"><button type="button" class="ng-eye" title="Mostrar/ocultar">👁</button></div>
        <button id="ng-go" type="button">Entrar</button>
        <p class="ng-err"></p>
        <button class="ng-link" id="ng-local" type="button">Continuar sin conexión (solo local)</button>
      </div></div>`;
    gate.querySelector('.ng-logo').src = window.LOGO_DATA_URI || 'logo-uncp.png';
    gate.querySelector('#ng-go').onclick = doLogin;
    gate.querySelector('#ng-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    gate.querySelector('#ng-mail').addEventListener('keydown', (e) => { if (e.key === 'Enter') gate.querySelector('#ng-pass').focus(); });
    gate.querySelector('.ng-eye').onclick = () => { const i = gate.querySelector('#ng-pass'); i.type = i.type === 'password' ? 'text' : 'password'; };
    gate.querySelector('#ng-local').onclick = () => { offlineUser = { email: '' }; hideGate(); setState('offline', 'Modo local: los cambios quedan en este equipo. Inicie sesión luego para subirlos.'); };
    document.body.append(btn, dlg, gate);
    showGate('loading');
    setState(state, lastInfo);
  }

  // ---------- arranque ----------
  function init(options) {
    ctx = options; window.Nube.enabled = true;
    firebase.initializeApp(cfg);
    fdb = firebase.firestore(); auth = firebase.auth();
    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});
    fdb.enablePersistence({ synchronizeTabs: true }).catch((e) => console.warn('Nube: sin caché sin conexión', e && e.code));
    buildUI();
    window.addEventListener('online', () => {
      updateNet(); errorUntil = 0;
      // si se entró sin conexión con correo y clave, al volver el internet se retoma la sesión de la nube
      if (!user && offlineUser && offlineUser.email && offlinePass) {
        auth.signInWithEmailAndPassword(offlineUser.email, offlinePass).then(() => { offlinePass = ''; }).catch((e) => console.warn('Nube: no se pudo reconectar', e && e.code));
      } else notify();
    });
    window.addEventListener('offline', () => { updateNet(); setState('offline', 'Los cambios se enviarán al volver la conexión'); });
    // Seguro: si Firebase tarda en responder (sin internet), no dejar al usuario atascado en "Verificando…"
    const wait = setTimeout(() => { if (!user && gate && !gate.hidden && gate.querySelector('.ng-form').hidden) showGate('login'); }, 2500);
    auth.onAuthStateChanged((u) => {
      clearTimeout(wait);
      user = u;
      if (!u) { stopListener(); if (!offlineUser) { showGate('login'); setState('nologin'); } return; }
      offlineUser = null; hideGate();
      setState('sync', 'Preparando…');
      Promise.resolve(ctx.ready).then(() => { startListener(); pushNow(); });
    });
  }
  window.Nube = { init, notify, enabled: false, _t: { payloadOf, sigOf, docIdOf, collectDirty, applyBatch, setCtx: (c) => { ctx = c; }, pending } };
})();
