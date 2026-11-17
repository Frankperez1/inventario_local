// sync.js - Sincronización de bienes registrados con Firestore (subir / bajar).
// - Cada usuario tiene su PROPIO inventario en la nube (documentos con su uid): no ve ni mezcla lo de los demás.
//   Lo único compartido entre usuarios son los avisos (avisos.js).
// - NO sube el catálogo completo: solo los bienes REGISTRADOS (escaneados/verificados), uno por documento.
// - Descarga solo lo nuevo (cursor por updatedAt) para gastar pocas lecturas del plan gratuito.
import { S, COL, AV_COL, BATCH, PUSH_DELAY_MS, ERROR_BACKOFF_MS, OVERLAP_MS, FV } from './estado.js';
import { H, keyOf, cloudIdOf, roomMaps, payloadOf, sigOf } from './utils.js';
import { avisoFor } from './avisos.js';

// Bienes con cambios locales que aún no están en la nube
export function collectDirty() {
  const db = S.ctx.getDb(); const m = roomMaps(db); const out = [];
  for (const a of db.assets) {
    if (!(a.registered || a._syncSig)) continue;
    const n = a.roomId && m.names(a.roomId); if (!n) continue;
    const p = payloadOf(a, n); const sig = sigOf(p);
    if (a._syncSig === sig || S.pending.get(a.id) === sig) continue;
    out.push({ a, p, sig, id: cloudIdOf(a.code, n) });
  }
  return out;
}

// Una sola vez por equipo: antes los bienes eran compartidos (un documento por bien y ambiente, sin dueño).
// Ahora cada usuario guarda el suyo: se marcan como "por subir" los bienes ya registrados en este equipo para que
// queden en el espacio del usuario actual, y se ajustan las claves de avisos para no repetir los ya enviados.
function migrateOwnSpace() {
  const db = S.ctx.getDb(); if (!S.user || db.cloudSchema === 2) return;
  const suffix = '_' + S.user.uid;
  for (const a of db.assets) {
    delete a._syncSig; delete a._cloudId;
    if (a._avisoKey && !String(a._avisoKey).endsWith(suffix)) a._avisoKey = a._avisoKey + suffix;
  }
  delete db.cloudCursor; db.cloudCursors = {}; db.cloudSchema = 2; S.ctx.persist();
}

// ---------- subir ----------
export function notify() {
  if (!S.user) return;
  clearTimeout(S.pushTimer);
  S.pushTimer = setTimeout(pushNow, PUSH_DELAY_MS);
}
export function pushNow() {
  if (!S.user || !S.ctx || Date.now() < S.errorUntil) return;
  migrateOwnSpace();
  const items = collectDirty();
  if (!items.length) { if (S.pending.size === 0) S.ui.setState(navigator.onLine ? 'ok' : 'offline'); return; }
  S.ui.setState('sync', `${items.length} por subir`);
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const batch = S.fdb.batch();
    chunk.forEach(({ a, p, sig, id }) => {
      const stamp = { updatedAt: FV().serverTimestamp(), updatedBy: S.user.email || '' };
      // uid = dueño del registro: cada usuario solo lee y escribe los suyos (lo exigen las reglas de Firestore)
      batch.set(S.fdb.collection(COL).doc(id), { ...p, ...stamp, uid: S.user.uid }, { merge: true });
      // si el bien cambió de ambiente, el registro anterior (propio) se marca como no registrado
      if (a._cloudId && a._cloudId !== id && a._cloudId.startsWith(S.user.uid + '_')) batch.set(S.fdb.collection(COL).doc(a._cloudId), { registered: false, ...stamp, uid: S.user.uid }, { merge: true });
      S.pending.set(a.id, sig);
      // aviso para el grupo dueño del bien si se registró en un ambiente que no le corresponde
      const av = avisoFor(a);
      if (av && a._avisoKey !== av.id) {
        batch.set(S.fdb.collection(AV_COL).doc(av.id), {
          code: String(a.code), tipo: av.tipo, grupo: av.grupo, homeRoom: av.homeRoom, foundRoom: av.foundRoom,
          por: S.user.email || '', uid: S.user.uid, porNombre: (S.profile && S.profile.nombre) || S.user.email || '', at: FV().serverTimestamp()
        });
        a._avisoNext = av.id;
      }
    });
    // Sin conexión, commit() queda esperando y Firestore guarda el lote; se envía solo al reconectar.
    batch.commit().then(() => {
      chunk.forEach(({ a, sig, id }) => {
        a._syncSig = sig; a._cloudId = id; S.pending.delete(a.id);
        if (a._avisoNext) { a._avisoKey = a._avisoNext; delete a._avisoNext; }
      });
      if (S.pending.size === 0) { S.ctx.persist(); S.ui.setState('ok'); }
    }).catch((err) => {
      chunk.forEach(({ a }) => S.pending.delete(a.id));
      S.errorUntil = Date.now() + ERROR_BACKOFF_MS;
      const code = err && err.code;
      S.ui.setState('error', code === 'permission-denied' ? 'Sin permiso: revise sesión y reglas de Firestore'
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
  if (!local) { local = { id: S.ctx.uid(), name: d.local }; db.locals.push(local); m.L.set(local.id, local); }
  let area = db.areas.find((x) => x.localId === local.id && H(x.name) === H(d.area));
  if (!area) { area = { id: S.ctx.uid(), localId: local.id, name: d.area }; db.areas.push(area); m.A.set(area.id, area); }
  room = db.rooms.find((x) => x.areaId === area.id && H(x.name) === H(d.room));
  if (!room) { room = { id: S.ctx.uid(), areaId: area.id, name: d.room }; db.rooms.push(room); m.R.set(room.id, room); }
  roomByKey.set(key, room);
  return room;
}
export function applyBatch(docs) {
  const db = S.ctx.getDb(); const m = roomMaps(db);
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
        a = { id: S.ctx.uid(), code: String(d.code), type: d.type, detail: d.detail, fromExcel: !!d.fromExcel, sourceArea: d.sourceArea,
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
// Cada usuario (administrador incluido) descarga solo SU inventario: los documentos con su uid.
// El avance global de todos los usuarios lo calcula el administrador a pedido (admin.js).
export function startListener() {
  stopListener();
  if (!S.profile || !S.user) return;
  migrateOwnSpace();
  const db = S.ctx.getDb(); db.cloudCursors = db.cloudCursors || {};
  const key = 'u:' + S.user.uid;
  const since = Math.max(0, (db.cloudCursors[key] || 0) - OVERLAP_MS);
  S.unsub = S.fdb.collection(COL).where('uid', '==', S.user.uid)
    .where('updatedAt', '>', firebase.firestore.Timestamp.fromMillis(since)).orderBy('updatedAt')
    .onSnapshot((snap) => {
      const docs = []; let maxTs = db.cloudCursors[key] || 0;
      snap.docChanges().forEach((c) => {
        if (c.type === 'removed' || c.doc.metadata.hasPendingWrites) return;
        const d = c.doc.data(); const ts = d.updatedAt && d.updatedAt.toMillis ? d.updatedAt.toMillis() : 0;
        if (ts > maxTs) maxTs = ts;
        docs.push({ id: c.doc.id, d });
      });
      if (!docs.length) return;
      const applied = applyBatch(docs);
      db.cloudCursors[key] = maxTs;
      if (applied) S.ctx.refresh();
      S.ctx.persist();
    }, (err) => {
      console.warn('Nube: error al escuchar', err);
      const c = err && err.code;
      S.ui.setState('error', c === 'permission-denied' ? 'Sin permiso: revise sesión y reglas de Firestore'
        : c === 'failed-precondition' ? 'Falta crear un índice en Firestore (abra la consola F12 y use el enlace, o vea el README)'
        : ((err && err.message) || 'Error de lectura'));
    });
}
export function stopListener() { if (S.unsub) { S.unsub(); S.unsub = null; } }
