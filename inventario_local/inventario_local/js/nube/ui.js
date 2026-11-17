// ui.js - Barra flotante (avisos, admin, estado de la nube) y ventana de cuenta.
import { S, esc } from './estado.js';
import { mountAvisos, renderBell, stopAvisos } from './avisos.js';
import { mountAdmin, refreshAdminButton } from './admin.js';
import { mountPanel, refreshPanelButton } from './panel.js';
import { mountAcceso, showGate } from './acceso.js';

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
    <div class="nube-row"><button data-a="sync">Sincronizar ahora</button><button data-a="out">Cerrar sesión</button><button data-a="close">Cerrar</button></div>`;
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
    else if (a === 'out') {
      S.offlineUser = null; S.offlinePass = ''; S.profile = null; stopAvisos();
      try { if (S.auth) await S.auth.signOut(); } catch (_) {}
      if (S.ui.resetAccess) S.ui.resetAccess();
      dlg.close(); showGate('login'); setState('nologin'); refreshDock();
    }
  });
  document.body.append(dock, dlg);
  mountAvisos(dock); mountAdmin(dock); mountPanel(dock, onSync); mountAcceso();
  S.ui.setState = setState; S.ui.refreshDock = refreshDock;
  setState(S.state, S.lastInfo);
}
