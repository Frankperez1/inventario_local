// perfil.js - Perfil del usuario (usuarios/{uid}): rol, grupos asignados y si está activo.
import { S, US_COL, AS_COL, FV } from './estado.js';
import { showNoGroup } from './acceso.js';

// Correos que son administrador desde el primer ingreso (no hace falta crear nada a mano en Firestore).
// El correo admin@gmail.com es SIEMPRE administrador; se pueden agregar más en window.FIREBASE_ADMINS.
export const ADMIN_POR_DEFECTO = 'admin@gmail.com';
export const ADMINS = [ADMIN_POR_DEFECTO, ...(window.FIREBASE_ADMINS || [])].map((x) => String(x).trim().toLowerCase());
const esAdminCorreo = (email) => ADMINS.includes(String(email || '').toLowerCase());

export const perfilDeAsignacion = (email, as) => ({ email, nombre: (as && as.nombre) || email, rol: 'inventariador', grupos: (as && as.grupos) || [], activo: !as || as.activo !== false });
const leerAsignacion = async (email) => { const s = await S.fdb.collection(AS_COL).doc(String(email || '').toLowerCase()).get(); return s.exists ? s.data() : null; };
export const accessKeyOf = (p) => (p ? p.rol + '|' + [...(p.grupos || [])].sort().join(',') : '');

export async function loadProfile(u) {
  const ref = S.fdb.collection(US_COL).doc(u.uid); let p = null;
  try {
    const snap = await ref.get();
    if (snap.exists) {
      p = snap.data();
      if (esAdminCorreo(u.email) && p.rol !== 'admin') { p.rol = 'admin'; ref.set({ rol: 'admin' }, { merge: true }).catch(() => {}); }
    }
    else if (esAdminCorreo(u.email)) {
      p = { email: u.email, nombre: u.email.split('@')[0], rol: 'admin', grupos: [], activo: true };
      await ref.set({ ...p, creadoEn: FV().serverTimestamp() });
    } else {
      // El correo ya existe en Authentication pero el administrador aún no lo registró como usuario:
      // sus grupos pueden venir de la asignación por correo (colección asignaciones).
      const as = await leerAsignacion(u.email);
      p = perfilDeAsignacion(u.email, as);
    }
    guardarPerfil(u.uid, p);
  } catch (e) {
    // Sin conexión: se usa el último perfil guardado en este equipo.
    try { p = JSON.parse(localStorage.getItem('nube_perfil_' + u.uid) || 'null'); } catch (_) {}
    if (!p) p = { email: u.email, nombre: u.email, rol: esAdminCorreo(u.email) ? 'admin' : 'inventariador', grupos: [], activo: true };
  }
  return p;
}

// ---------- acceso por grupo ----------
// Guarda el perfil en este equipo para poder aplicar el mismo filtro de grupos sin conexión.
function guardarPerfil(uid, p) {
  try { localStorage.setItem('nube_perfil_' + uid, JSON.stringify(p)); localStorage.setItem('nube_perfil_ultimo', JSON.stringify(p)); } catch (_) {}
}
function perfilLocal(email) {
  try {
    if (!email) return JSON.parse(localStorage.getItem('nube_perfil_ultimo') || 'null');
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i); if (!k || !k.startsWith('nube_perfil_')) continue;
      const p = JSON.parse(localStorage.getItem(k) || 'null');
      if (p && String(p.email || '').toLowerCase() === email) return p;
    }
  } catch (_) {}
  return null;
}
// null = sin restricción (administrador). Arreglo = solo esos grupos (vacío = no ve ningún ambiente).
// undefined = todavía no se sabe (perfil cargando o sin sesión): no se toca la pantalla.
export function accessGroups() {
  if (S.user) { if (!S.profile) return undefined; return S.profile.rol === 'admin' ? null : (S.profile.grupos || []); }
  if (S.offlineUser) {
    const email = String(S.offlineUser.email || '').toLowerCase();
    if (email && esAdminCorreo(email)) return null;
    const p = perfilLocal(email);
    if (!p) return email ? [] : null;           // sin cuenta (modo local) y sin perfil previo en el equipo: sin restricción
    return p.rol === 'admin' ? null : (p.grupos || []);
  }
  return undefined;
}
export function applyAccess() {
  if (!S.ctx || !S.ctx.setAccess) return;
  const g = accessGroups(); if (g === undefined) return;
  S.ctx.setAccess(g);
  showNoGroup(Array.isArray(g) && g.length === 0);
}
export function resetAccess() { if (S.ctx && S.ctx.setAccess) S.ctx.setAccess([]); showNoGroup(false); }

// Escucha el perfil en vivo: cuando el administrador cambia los grupos (o desactiva al usuario),
// la pantalla se actualiza sola sin cerrar sesión.
let unsubPerfil = null;
export function stopWatchProfile() { if (unsubPerfil) { unsubPerfil(); unsubPerfil = null; } }
export function watchProfile(u, onChange) {
  stopWatchProfile();
  let us, as;   // undefined = todavía no llegó
  const emit = () => {
    if (us === undefined || as === undefined) return;
    let p = us || (as ? perfilDeAsignacion(u.email, as) : null);
    if (!p) return;   // sin documentos: se mantiene lo que había
    if (esAdminCorreo(u.email)) p = { ...p, rol: 'admin' };
    S.profile = p; guardarPerfil(u.uid, p); onChange(p);
  };
  const u1 = S.fdb.collection(US_COL).doc(u.uid).onSnapshot((snap) => { us = snap.exists ? snap.data() : null; emit(); }, (e) => { console.warn('Nube: perfil', e && e.code); us = null; emit(); });
  const u2 = S.fdb.collection(AS_COL).doc(String(u.email || '').toLowerCase()).onSnapshot((snap) => { as = snap.exists ? snap.data() : null; emit(); }, () => { as = null; emit(); });
  unsubPerfil = () => { u1(); u2(); };
}
