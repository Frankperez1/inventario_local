// avisos.js - Avisos cuando alguien registra un bien en un ambiente distinto al que le corresponde.
// Los reciben los usuarios cuyo grupo (del Excel) es el dueño del bien (con aviso emergente) y el administrador (solo en la campana 🔔, sin emergentes).
// Es lo ÚNICO que se comparte entre usuarios: el inventario registrado de cada quien es independiente.
import { S, AV_COL, esc, isAdmin } from './estado.js';
import { roomMaps, docIdOf } from './utils.js';

let bellBtn, avDlg, toastBox;

// ---------- lógica ----------
export function avisoFor(a) {
  if (!a.registered) return null;
  const db = S.ctx.getDb();
  const orig = a.isDuplicateClone ? db.assets.find((x) => !x.isDuplicateClone && String(x.code) === String(a.code)) : a;
  if (!orig || !orig.homeRoomId || orig.homeRoomId === a.roomId) return null;
  const m = roomMaps(db); const home = m.names(orig.homeRoomId), here = m.names(a.roomId);
  if (!home || !here) return null;
  return {
    grupo: orig.grupo || '', tipo: orig.type || a.type || '',
    homeRoom: `${home.local} — ${home.area} — ${home.room}`, foundRoom: `${here.local} — ${here.area} — ${here.room}`,
    id: `${docIdOf(a.code, here)}_${S.user ? S.user.uid : ''}`   // un aviso por usuario que encuentra el bien
  };
}
const seenKey = () => 'nube_vistos_' + (S.user ? S.user.uid : '');
const getSeen = () => { try { return new Set(JSON.parse(localStorage.getItem(seenKey()) || '[]')); } catch { return new Set(); } };
const setSeen = (set) => { try { localStorage.setItem(seenKey(), JSON.stringify([...set].slice(-400))); } catch (_) {} };
const relevant = (av) => av && av.por !== (S.user && S.user.email) && (isAdmin() || ((S.profile && S.profile.grupos) || []).includes(av.grupo));
const unreadCount = () => { const s = getSeen(); return S.avisos.filter((a) => !s.has(a.id)).length; };

const avBuckets = new Map(); let avUnsubs = [];
const atMs = (x) => (x.at && x.at.toMillis ? x.at.toMillis() : 0);
function rebuild(fresh) {
  const all = new Map(); avBuckets.forEach((list) => list.forEach((a) => all.set(a.id, a)));
  S.avisos = [...all.values()].filter(relevant).sort((x, y) => atMs(y) - atMs(x)).slice(0, 150);
  renderBell(); fresh.forEach(toast);
  if (avDlg && avDlg.open) renderAvisos();
}
// Administrador: todos los avisos. Inventariador: solo los de cada uno de sus grupos (lo exigen las reglas de Firestore).
export function startAvisos() {
  stopAvisos();
  const col = S.fdb.collection(AV_COL);
  const scopes = isAdmin()
    ? [{ key: '*', q: col.orderBy('at', 'desc').limit(150) }]
    : (((S.profile && S.profile.grupos) || []).map((g) => ({ key: g, q: col.where('grupo', '==', g).orderBy('at', 'desc').limit(80) })));
  avUnsubs = scopes.map(({ key, q }) => {
    let first = true;
    return q.onSnapshot((snap) => {
      const seen = getSeen(); const fresh = [];
      avBuckets.set(key, snap.docs.filter((d) => !d.metadata.hasPendingWrites && d.data().at).map((d) => ({ id: d.id, ...d.data() })));
      if (!first) snap.docChanges().forEach((c) => {
        if (c.type !== 'added' || c.doc.metadata.hasPendingWrites) return;
        const av = { id: c.doc.id, ...c.doc.data() };
        if (relevant(av) && !seen.has(av.id) && !isAdmin()) fresh.push(av);   // el administrador no inventaría: sin ventanitas ni notificación de Chrome, solo la campana 🔔
      });
      first = false; rebuild(fresh);
    }, (err) => console.warn('Nube: avisos', err));
  });
}
export function stopAvisos() { avUnsubs.forEach((u) => u()); avUnsubs = []; avBuckets.clear(); S.avisos = []; renderBell(); }

// ---------- vistas ----------
export function renderBell() {
  if (!bellBtn) return;
  const n = S.user ? unreadCount() : 0;
  bellBtn.hidden = !S.user;
  bellBtn.innerHTML = '🔔' + (n ? `<span class="nb-badge">${n > 99 ? '99+' : n}</span>` : '');
  bellBtn.title = n ? `${n} aviso(s) sin leer` : 'Avisos';
}
function toast(av) {
  if (!toastBox) return;
  const el = document.createElement('div'); el.className = 'nb-toast';
  el.innerHTML = '<b>🔔 Se encontró un bien de su grupo</b><span></span><small></small>';
  el.querySelector('span').textContent = `${av.tipo || 'Bien'} · ${av.code}`;
  el.querySelector('small').textContent = `Le pertenece a: ${av.homeRoom}. Encontrado en: ${av.foundRoom}${av.porNombre ? ' por ' + av.porNombre : ''}`;
  el.onclick = () => { el.remove(); openAvisos(); };
  toastBox.appendChild(el); setTimeout(() => el.remove(), 12000);
  try { if ('Notification' in window && Notification.permission === 'granted') new Notification('Bien encontrado: ' + av.code, { body: `${av.tipo || ''} — le pertenece a ${av.homeRoom}` }); } catch (_) {}
}
// Notificación genérica (kind: 'ok' | 'warn' | '')
export function showToast(title, text, kind) {
  if (!toastBox) return;
  const el = document.createElement('div'); el.className = 'nb-toast' + (kind ? ' ' + kind : '');
  el.innerHTML = '<b></b><span></span>';
  el.querySelector('b').textContent = title; el.querySelector('span').textContent = text || '';
  el.onclick = () => el.remove();
  toastBox.appendChild(el); setTimeout(() => el.remove(), 9000);
}
export function openAvisos() {
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (_) {}
  renderAvisos(); if (!avDlg.open) avDlg.showModal();
}
function renderAvisos() {
  const seen = getSeen(); const box = avDlg.querySelector('div');
  const fmt = (av) => { const t = av.at && av.at.toDate ? av.at.toDate() : null; return t ? t.toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' }) : ''; };
  box.innerHTML = `<h3>🔔 Avisos de bienes encontrados</h3><p class="nb-sub">Bienes de su grupo que otra persona registró en un ambiente distinto al del Excel.</p>
    <div class="nb-list">${S.avisos.length ? S.avisos.map((av) => `<div class="nb-item ${seen.has(av.id) ? '' : 'new'}"><b>${esc(av.tipo || 'Bien')} · ${esc(av.code)}</b>
      <span>Le pertenece a: ${esc(av.homeRoom)}</span><span>Encontrado en: ${esc(av.foundRoom)}</span>
      <small>${esc(av.porNombre || av.por || '')} · ${esc(fmt(av))}${av.grupo ? ' · Grupo ' + esc(av.grupo) : ''}</small></div>`).join('') : '<p class="nb-empty">No hay avisos por ahora.</p>'}</div>
    <div class="nube-row"><button data-a="av-read">Marcar todo como leído</button><button data-a="av-close">Cerrar</button></div>`;
}
export function mountAvisos(dock) {
  bellBtn = document.createElement('button'); bellBtn.id = 'nube-bell'; bellBtn.type = 'button'; bellBtn.hidden = true; bellBtn.onclick = openAvisos;
  avDlg = document.createElement('dialog'); avDlg.id = 'nube-av'; avDlg.appendChild(document.createElement('div'));
  toastBox = document.createElement('div'); toastBox.id = 'nube-toasts';
  avDlg.addEventListener('click', (e) => {
    const a = e.target && e.target.dataset && e.target.dataset.a; if (!a) return;
    if (a === 'av-close') avDlg.close();
    if (a === 'av-read') { const s = getSeen(); S.avisos.forEach((x) => s.add(x.id)); setSeen(s); renderBell(); renderAvisos(); }
  });
  dock.prepend(bellBtn); document.body.append(avDlg, toastBox);
}
