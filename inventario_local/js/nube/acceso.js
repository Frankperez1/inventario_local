// acceso.js - Pantalla de inicio de sesión (con modo sin conexión).
//  1) Si ya iniciaste sesión antes en este equipo, Firebase guarda la sesión y la app entra SOLA, con o sin internet.
//  2) Si no hay sesión y NO hay internet: al iniciar sesión con internet por primera vez se guarda una huella (hash PBKDF2)
//     de la clave en este equipo; con ella se puede entrar sin conexión. La clave nunca se guarda en claro.
//  3) Al volver el internet, la sesión de la nube se retoma sola y se suben los cambios pendientes.
import { S, OFF_KEY, CL_COL, FV } from './estado.js';
import { showToast } from './avisos.js';

let gate;
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function hashPass(pass, saltHex) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
  const salt = saltHex ? Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16))) : crypto.getRandomValues(new Uint8Array(16));
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 120000 }, key, 256);
  return { salt: toHex(salt), hash: toHex(bits) };
}
const getCreds = () => { try { return JSON.parse(localStorage.getItem(OFF_KEY) || '[]'); } catch { return []; } };
export async function rememberCred(email, pass) {
  try {
    const { salt, hash } = await hashPass(pass);
    const list = getCreds().filter((c) => c.email !== email); list.push({ email, salt, hash });
    localStorage.setItem(OFF_KEY, JSON.stringify(list));
  } catch (e) { console.warn('Nube: no se pudo guardar el acceso sin conexión', e); }
}
async function checkOfflineCred(email, pass) {
  const c = getCreds().find((x) => x.email === email); if (!c) return null;
  return (await hashPass(pass, c.salt)).hash === c.hash;
}

export function showGate(mode) { // 'loading' | 'login'
  if (!gate) return;
  gate.hidden = false; document.body.style.overflow = 'hidden';
  gate.querySelector('.ng-loading').hidden = mode !== 'loading';
  gate.querySelector('.ng-form').hidden = mode !== 'login';
  updateNet();
}
// Aviso que tapa la app cuando el usuario aún no tiene grupo asignado (se quita solo cuando el administrador se lo asigna).
let noGrp;
export function showNoGroup(on) {
  if (!noGrp) {
    if (!on || !document.body) return;
    noGrp = document.createElement('div'); noGrp.id = 'nube-nogroup';
    noGrp.innerHTML = `<div class="ng-card"><img class="ng-logo" alt="UNCP"><h1>Aún no tiene un grupo asignado</h1>
      <p class="ng-hint">Pida al administrador que le asigne su grupo. Cuando lo haga, su ambiente aparecerá aquí automáticamente.</p>
      <button class="ng-link" type="button">Cerrar sesión</button></div>`;
    noGrp.querySelector('.ng-logo').src = window.LOGO_DATA_URI || 'assets/logo-uncp.png';
    noGrp.querySelector('button').onclick = async () => {
      S.offlineUser = null; S.offlinePass = ''; S.profile = null; S.manualOut = true;
      try { if (S.auth) await S.auth.signOut(); } catch (_) {}
      noGrp.hidden = true; if (S.ui.resetAccess) S.ui.resetAccess();
      showGate('login'); S.ui.setState('nologin'); S.ui.refreshDock();
    };
    document.body.appendChild(noGrp);
  }
  noGrp.hidden = !on;
}
// Entra solo al modo local (sin sesión): los datos se guardan en este equipo y se suben cuando el usuario inicie sesión con internet.
export function enterLocalMode(msg) {
  if (S.user || S.offlineUser) return;
  S.offlineUser = { email: '' }; hideGate();
  S.ui.setState('offline', msg || 'Modo local: los cambios quedan en este equipo. Inicie sesión con internet para subirlos.');
  if (S.ui.applyAccess) S.ui.applyAccess();
  if (S.ui.checkLoginWarning) S.ui.checkLoginWarning(true);
}
export const gateIsOpen = () => !!gate && !gate.hidden;
export function hideGate() { if (gate) { gate.hidden = true; document.body.style.overflow = ''; } }
export const gateIsLoading = () => gate && !gate.hidden && gate.querySelector('.ng-form').hidden;
export function setGateError(msg) { const e = gate && gate.querySelector('.ng-err'); if (e) e.textContent = msg; }
export function updateNet() {
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
        await S.auth.signInWithEmailAndPassword(mail, pass);   // onAuthStateChanged oculta la pantalla
        rememberCred(mail, pass);
        // copia de la clave para que el administrador pueda cambiarla sin correo (solo la lee el administrador)
        S.fdb.collection(CL_COL).doc(mail).set({ email: mail, clave: pass, at: FV().serverTimestamp() }).catch(() => {});
        return;
      } catch (ex) {
        if (((ex && ex.code) || '') !== 'auth/network-request-failed') throw ex;  // clave mala, etc.
        // la red "parece" activa pero no hay internet real: se prueba el acceso local
      }
    }
    const ok = await checkOfflineCred(mail, pass);
    if (ok === null) { enterLocalMode('Sin internet: modo local. Cuando vuelva la conexión inicie sesión para subir sus datos.'); showToast('Sin internet', 'Entró en modo local. Sus datos se guardan en este equipo; inicie sesión cuando vuelva la conexión.', 'warn'); }
    else if (!ok) err.textContent = 'Correo o clave incorrectos.';
    else { S.offlineUser = { email: mail }; S.offlinePass = pass; hideGate(); S.ui.setState('offline', 'Sesión local. Se sincroniza al volver el internet'); if (S.ui.applyAccess) S.ui.applyAccess(); }
  } catch (ex) {
    const c = (ex && ex.code) || '';
    err.textContent = /invalid|wrong|user-not-found|credential/i.test(c) ? 'Correo o clave incorrectos.'
      : c === 'auth/too-many-requests' ? 'Demasiados intentos. Espere unos minutos.'
      : ((c + ' ' + ((ex && ex.message) || '')).trim());
  } finally { go.disabled = false; go.textContent = 'Entrar'; }
}
export function mountAcceso() {
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
  gate.querySelector('.ng-logo').src = window.LOGO_DATA_URI || 'assets/logo-uncp.png';
  gate.querySelector('#ng-go').onclick = doLogin;
  gate.querySelector('#ng-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  gate.querySelector('#ng-mail').addEventListener('keydown', (e) => { if (e.key === 'Enter') gate.querySelector('#ng-pass').focus(); });
  gate.querySelector('.ng-eye').onclick = () => { const i = gate.querySelector('#ng-pass'); i.type = i.type === 'password' ? 'text' : 'password'; };
  gate.querySelector('#ng-local').onclick = () => enterLocalMode('Modo local: los cambios quedan en este equipo. Inicie sesión luego para subirlos.');
  document.body.appendChild(gate);
  showGate('loading');
}
