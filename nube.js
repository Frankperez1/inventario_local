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

  // ---------- interfaz (botón flotante + ventana de inicio de sesión) ----------
  const LABEL = { nologin: '☁ Iniciar sesión', ok: '☁ Sincronizado', sync: '☁ Sincronizando…', offline: '☁ Sin conexión', error: '☁ Error de nube' };
  const COLOR = { nologin: '#b45309', ok: '#166534', sync: '#1d4ed8', offline: '#4b5563', error: '#b91c1c' };
  let btn, dlg;
  function setState(s, info) {
    state = s; lastInfo = info || '';
    if (btn) { btn.textContent = LABEL[s] || '☁'; btn.style.background = COLOR[s] || '#4b5563'; btn.title = lastInfo || ''; }
    if (dlg && dlg.open) renderDialog();
  }
  function renderDialog() {
    const box = dlg.querySelector('div');
    if (user) {
      box.innerHTML = `<h3>Nube (Firebase)</h3><p>Sesión: <b></b></p><p>Estado: <b>${LABEL[state] || ''}</b>${lastInfo ? `<br><small></small>` : ''}</p>
        <div class="nube-row"><button data-a="sync">Sincronizar ahora</button><button data-a="out">Cerrar sesión</button><button data-a="close">Cerrar</button></div>`;
      box.querySelector('b').textContent = user.email || '';
      const sm = box.querySelector('small'); if (sm) sm.textContent = lastInfo;
    } else {
      box.innerHTML = `<h3>Iniciar sesión en la nube</h3><p>Use el correo y la contraseña que le dio el administrador.</p>
        <input id="nube-mail" type="email" placeholder="Correo" autocomplete="username"><input id="nube-pass" type="password" placeholder="Contraseña" autocomplete="current-password">
        <p id="nube-err" style="color:#b91c1c;min-height:1.2em"></p><div class="nube-row"><button data-a="in">Entrar</button><button data-a="close">Cancelar</button></div>`;
    }
  }
  function buildUI() {
    if (typeof document === 'undefined' || !document.body || btn) return;
    const st = document.createElement('style');
    st.textContent = `#nube-btn{position:fixed;right:14px;bottom:14px;z-index:9999;border:0;border-radius:999px;padding:9px 14px;font:600 13px system-ui,sans-serif;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer}
      #nube-dlg{border:0;border-radius:12px;padding:0;max-width:360px;width:92%}#nube-dlg::backdrop{background:rgba(0,0,0,.45)}#nube-dlg>div{padding:18px;font:14px system-ui,sans-serif}
      #nube-dlg h3{margin:0 0 8px}#nube-dlg input{display:block;width:100%;box-sizing:border-box;margin:6px 0;padding:9px;font-size:15px}
      .nube-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.nube-row button{padding:8px 12px;font-size:14px;cursor:pointer}`;
    document.head.appendChild(st);
    btn = document.createElement('button'); btn.id = 'nube-btn'; btn.type = 'button';
    btn.onclick = () => { renderDialog(); dlg.showModal(); };
    dlg = document.createElement('dialog'); dlg.id = 'nube-dlg'; dlg.appendChild(document.createElement('div'));
    dlg.addEventListener('click', async (e) => {
      const a = e.target && e.target.dataset && e.target.dataset.a; if (!a) return;
      if (a === 'close') dlg.close();
      else if (a === 'out') { await auth.signOut(); dlg.close(); }
      else if (a === 'sync') { errorUntil = 0; pushNow(); if (ctx) startListener(); }
      else if (a === 'in') {
        const err = dlg.querySelector('#nube-err'); err.textContent = 'Entrando…';
        try { await auth.signInWithEmailAndPassword(dlg.querySelector('#nube-mail').value.trim(), dlg.querySelector('#nube-pass').value); dlg.close(); }
        catch (ex) { err.textContent = /invalid|wrong|user-not-found|credential/i.test(ex.code || ex.message) ? 'Correo o contraseña incorrectos.' : ((ex.code || '') + ' ' + (ex.message || '')); }
      }
    });
    document.body.append(btn, dlg);
    setState(state, lastInfo);
  }

  // ---------- arranque ----------
  function init(options) {
    ctx = options; window.Nube.enabled = true;
    firebase.initializeApp(cfg);
    fdb = firebase.firestore(); auth = firebase.auth();
    fdb.enablePersistence({ synchronizeTabs: true }).catch((e) => console.warn('Nube: sin caché sin conexión', e && e.code));
    buildUI();
    window.addEventListener('online', () => { errorUntil = 0; notify(); });
    window.addEventListener('offline', () => setState('offline', 'Los cambios se enviarán al volver la conexión'));
    auth.onAuthStateChanged((u) => {
      user = u;
      if (!u) { stopListener(); setState('nologin'); return; }
      setState('sync', 'Preparando…');
      Promise.resolve(ctx.ready).then(() => { startListener(); pushNow(); });
    });
  }
  window.Nube = { init, notify, enabled: false, _t: { payloadOf, sigOf, docIdOf, collectDirty, applyBatch, setCtx: (c) => { ctx = c; }, pending } };
})();
