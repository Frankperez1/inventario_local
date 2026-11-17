// ui.js - Barra flotante (avisos, admin, estado de la nube) y ventana de cuenta.
import { S, esc, CL_COL, FV } from './estado.js';
import { mountAvisos, renderBell, stopAvisos, showToast } from './avisos.js';
import { countLocalOnly } from './sync.js';
import { mountAdmin, refreshAdminButton } from './admin.js';
import { mountPanel, refreshPanelButton } from './panel.js';
import { mountAcceso, showGate, gateIsOpen, rememberCred } from './acceso.js';

const LABEL = { nologin: '☁ Sin sesión', ok: '☁ Sincronizado', sync: '☁ Sincronizando…', offline: '☁ Sin conexión', error: '☁ Error de nube', local: '☁ Modo local' };
const COLOR = { nologin: '#b45309', ok: '#166534', sync: '#1d4ed8', offline: '#4b5563', error: '#b91c1c', local: '#4b5563' };
let btn, dlg;

export function setState(s, info) {
  S.state = S.offlineUser && !S.user ? 'local' : s; S.lastInfo = info || '';
  if (btn) { btn.textContent = LABEL[S.state] || '☁'; btn.style.background = COLOR[S.state] || '#4b5563'; btn.title = S.lastInfo; }
  if (dlg && dlg.open) renderDialog();
}
function renderDialog() {
  const who = S.user ? S.user.email : (S.offlineUser ? S.offlineUser.email : '');
  const rol = S.profile ? (S.profile.rol === 'admin' ? 'Administrador' : 'Inventariador') : '';
  const grupos = (S.profile && S.profile.grupos) || [];
  dlg.querySelector('div').innerHTML = `<h3>Nube (Firebase)</h3>
    <p>Sesión: <b>${esc(who || 'Sin iniciar sesión')}</b>${rol ? ' · ' + rol : ''}</p>
    ${grupos.length ? `<p>Grupo(s): <b>${esc(grupos.join(', '))}</b></p>` : ''}
    <p>Estado: <b>${LABEL[S.state] || ''}</b>${S.lastInfo ? `<br><small>${esc(S.lastInfo)}</small>` : ''}</p>
    <div class="nube-row"><button data-a="sync">Sincronizar ahora</button>${S.user ? '<button data-a="pass">🔑 Cambiar mi clave</button>' : ''}<button data-a="out">Cerrar sesión</button><button data-a="close">Cerrar</button></div>`;
}
// Advertencia cuando hay internet pero no se ha iniciado sesión: los registros solo están en este equipo.
let warn, warnTimer;
export function checkLoginWarning(announce) {
  clearTimeout(warnTimer);
  warnTimer = setTimeout(() => {
    if (!warn) return;
    const n = S.user ? 0 : countLocalOnly();
    const show = !S.user && !!S.offlineUser && navigator.onLine && n > 0 && !gateIsOpen();
    warn.hidden = !show;
    if (!show) { if (S.user || !navigator.onLine) S.warnedLogin = false; return; }
    warn.querySelector('span').textContent = `⚠ ${n} registro(s) están solo en este equipo. Necesita iniciar sesión para guardarlos en la nube y no perder sus datos.`;
    if (!S.warnedLogin) {
      S.warnedLogin = true;
      showToast('⚠ Necesita iniciar sesión', 'Hay internet, pero no ha iniciado sesión. Inicie sesión para no perder sus datos.', 'warn');
    }
  }, announce ? 0 : 1000);
}
// ---------- cambiar la clave propia ----------
let pdlg;
function openPass() {
  pdlg.querySelector('div').innerHTML = `<h3>🔑 Cambiar mi clave</h3>
    <p class="nb-sub">Escriba su clave actual y la nueva (mínimo 6 caracteres). Necesita internet.</p>
    <input id="pw-old" type="password" placeholder="Clave actual" autocomplete="current-password">
    <input id="pw-new" type="password" placeholder="Nueva clave" autocomplete="new-password">
    <input id="pw-new2" type="password" placeholder="Repita la nueva clave" autocomplete="new-password">
    <p class="nb-msg" style="min-height:1.2em"></p>
    <div class="nube-row"><button data-a="pw-save" class="primary">Guardar clave</button><button data-a="pw-close">Cerrar</button></div>`;
  pdlg.showModal();
}
async function savePass() {
  const q = (s) => pdlg.querySelector(s), msg = q('.nb-msg'), go = q('[data-a="pw-save"]');
  const old = q('#pw-old').value, n1 = q('#pw-new').value, n2 = q('#pw-new2').value;
  if (!S.user) { msg.textContent = 'Inicie sesión para cambiar su clave.'; return; }
  if (!navigator.onLine) { msg.textContent = 'Sin internet: inténtelo cuando vuelva la conexión.'; return; }
  if (!old) { msg.textContent = 'Escriba su clave actual.'; return; }
  if (n1.length < 6) { msg.textContent = 'La nueva clave debe tener al menos 6 caracteres.'; return; }
  if (n1 !== n2) { msg.textContent = 'Las claves nuevas no coinciden.'; return; }
  if (n1 === old) { msg.textContent = 'La nueva clave debe ser distinta de la actual.'; return; }
  go.disabled = true; msg.textContent = 'Guardando…';
  try {
    await S.user.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(S.user.email, old));
    await S.user.updatePassword(n1);
    await rememberCred(String(S.user.email).toLowerCase(), n1);   // para que el acceso sin conexión use la clave nueva
    S.fdb.collection(CL_COL).doc(String(S.user.email).toLowerCase()).set({ email: S.user.email, clave: n1, at: FV().serverTimestamp() }).catch(() => {});   // el administrador podrá cambiarla luego
    q('#pw-old').value = q('#pw-new').value = q('#pw-new2').value = '';
    msg.textContent = '✔ Clave cambiada. Úsela la próxima vez que inicie sesión.';
  } catch (ex) {
    const c = (ex && ex.code) || '';
    msg.textContent = /wrong-password|invalid-credential|invalid-login/i.test(c) ? 'La clave actual no es correcta.'
      : c === 'auth/weak-password' ? 'La nueva clave es muy débil.'
      : c === 'auth/too-many-requests' ? 'Demasiados intentos. Espere unos minutos.'
      : c === 'auth/network-request-failed' ? 'No hay internet.' : ((c + ' ' + ((ex && ex.message) || '')).trim());
  } finally { go.disabled = false; }
}
export function refreshDock() { renderBell(); refreshAdminButton(); refreshPanelButton(); }

// onSync: función que fuerza una sincronización (la entrega index.js para evitar dependencias circulares).
export function buildUI(onSync) {
  if (!document.body || btn) return;
  const dock = document.createElement('div'); dock.id = 'nube-dock';
  btn = document.createElement('button'); btn.id = 'nube-btn'; btn.type = 'button';
  btn.onclick = () => { renderDialog(); dlg.showModal(); };
  dock.appendChild(btn);
  dlg = document.createElement('dialog'); dlg.id = 'nube-dlg'; dlg.appendChild(document.createElement('div'));
  dlg.addEventListener('click', async (e) => {
    const a = e.target && e.target.dataset && e.target.dataset.a; if (!a) return;
    if (a === 'close') dlg.close();
    else if (a === 'sync') onSync();
    else if (a === 'pass') { dlg.close(); openPass(); }
    else if (a === 'out') {
      S.offlineUser = null; S.offlinePass = ''; S.profile = null; S.manualOut = true; stopAvisos();
      try { if (S.auth) await S.auth.signOut(); } catch (_) {}
      if (S.ui.resetAccess) S.ui.resetAccess();
      dlg.close(); showGate('login'); setState('nologin'); refreshDock();
    }
  });
  pdlg = document.createElement('dialog'); pdlg.id = 'nube-pass'; pdlg.appendChild(document.createElement('div'));
  pdlg.addEventListener('click', (e) => { const a = e.target && e.target.dataset && e.target.dataset.a; if (a === 'pw-close') pdlg.close(); else if (a === 'pw-save') savePass(); });
  document.body.append(dock, dlg, pdlg);
  warn = document.createElement('div'); warn.id = 'nube-warn'; warn.hidden = true;
  warn.innerHTML = '<span></span><button type="button">Iniciar sesión</button>';
  warn.querySelector('button').onclick = () => { warn.hidden = true; showGate('login'); };
  document.body.appendChild(warn);
  mountAvisos(dock); mountAdmin(dock); mountPanel(dock, onSync); mountAcceso();
  S.ui.setState = setState; S.ui.refreshDock = refreshDock; S.ui.checkLoginWarning = checkLoginWarning;
  setState(S.state, S.lastInfo);
}
