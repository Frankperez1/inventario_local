// panel.js - "Mi panel": interfaz del usuario (perfil, grupo, avance por área y avisos recientes).
import { S, esc, isAdmin } from './estado.js';
import { groupList } from './admin.js';
import { openAvisos } from './avisos.js';

let btn, dlg, rowsHtml = () => '';

const grupos = () => (isAdmin() ? groupList() : ((S.profile && S.profile.grupos) || []));
function stats(gs) {
  const set = new Set(gs), areas = new Map(); let total = 0, reg = 0;
  for (const a of S.ctx.getDb().assets) {
    if (!a.fromExcel || a.isDuplicateClone || !set.has(a.grupo) || String(a.condicion || '').toUpperCase() === 'B') continue;
    total++; const k = a.sourceArea || 'Sin área';
    const r = areas.get(k) || { total: 0, reg: 0, grupo: a.grupo }; r.total++; if (a.registered) { r.reg++; reg++; } areas.set(k, r);
  }
  return { total, reg, areas };
}
const initials = (n) => (String(n || '?').trim().split(/\s+/).slice(0, 2).map((x) => x[0]).join('') || '?').toUpperCase();
const pctOf = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const fmtN = (n) => n.toLocaleString('es-PE');

function render() {
  const box = dlg.querySelector('div');
  const p = S.profile || {}, email = S.user ? S.user.email : (S.offlineUser && S.offlineUser.email) || '';
  const nombre = p.nombre || email || 'Usuario', rol = p.rol === 'admin' ? 'Administrador' : 'Inventariador';
  const gs = grupos(), st = stats(gs), pct = pctOf(st.reg, st.total);
  const pend = st.total - st.reg;
  const ordered = [...st.areas.entries()].sort((a, b) => a[0].localeCompare(b[0], 'es'));
  rowsHtml = (q) => ordered.filter(([k]) => k.toLowerCase().includes(q)).map(([k, r]) => {
    const x = pctOf(r.reg, r.total);
    return `<tr><td>${esc(k)}${isAdmin() ? `<br><small>${esc(r.grupo)}</small>` : ''}</td><td class="n">${fmtN(r.reg)} / ${fmtN(r.total)}</td>
      <td><div class="nb-bar"><i style="width:${x}%"></i></div></td><td class="n">${x}%</td></tr>`;
  }).join('') || '<tr><td colspan="4" class="nb-empty">Sin resultados.</td></tr>';
  const recientes = S.avisos.slice(0, 3);
  box.innerHTML = `<div class="up-head"><div class="up-avatar">${esc(initials(nombre))}</div>
      <div><h3>${esc(nombre)}</h3><small>${esc(email)}</small><div class="up-tags"><span class="up-role">${rol}</span>${navigator.onLine ? '<span class="up-on">● En línea</span>' : '<span class="up-off">● Sin conexión</span>'}</div></div>
      <button data-a="up-close" class="nb-x up-x">✕</button></div>
    ${gs.length ? `<div class="nb-chips">${gs.map((g) => `<span class="nb-chip">👥 ${esc(g)}</span>`).join('')}</div>
    <div class="up-kpis"><div><b>${fmtN(st.total)}</b><span>Bienes ${isAdmin() ? 'del inventario' : 'de mi grupo'}</span></div><div><b>${fmtN(st.reg)}</b><span>Registrados</span></div>
      <div><b>${fmtN(pend)}</b><span>Pendientes</span></div><div><b>${pct}%</b><span>Avance</span></div></div>
    <div class="nb-bar big"><i style="width:${pct}%"></i></div>
    <h4 class="up-h">Avance por área</h4><input id="up-q" type="text" placeholder="Buscar área…">
    <div class="nb-scroll up-areas"><table class="nb-t"><thead><tr><th>Área</th><th>Registrados</th><th>Progreso</th><th></th></tr></thead><tbody id="up-rows">${rowsHtml('')}</tbody></table></div>`
    : `<div class="nb-card"><b>Aún no tiene un grupo asignado.</b><br><small>Pida al administrador que le asigne su grupo para ver el avance de sus áreas y recibir avisos.</small></div>`}
    <h4 class="up-h">Avisos recientes</h4>
    ${recientes.length ? recientes.map((av) => `<div class="nb-item"><b>${esc(av.tipo || 'Bien')} · ${esc(av.code)}</b><span>Le pertenece a: ${esc(av.homeRoom)}</span><span>Encontrado en: ${esc(av.foundRoom)}</span></div>`).join('') : '<p class="nb-empty">No hay avisos por ahora.</p>'}
    <div class="nube-row"><button data-a="up-av">🔔 Ver todos los avisos</button><button data-a="up-sync" class="primary">Sincronizar ahora</button><button data-a="up-close">Cerrar</button></div>`;
  const q = box.querySelector('#up-q');
  if (q) q.addEventListener('input', () => { box.querySelector('#up-rows').innerHTML = rowsHtml(q.value.trim().toLowerCase()); });
}
export const refreshPanelButton = () => { if (btn) btn.hidden = !(S.user || S.offlineUser); };
export function mountPanel(dock, onSync) {
  btn = document.createElement('button'); btn.id = 'nube-panel'; btn.type = 'button'; btn.hidden = true; btn.textContent = '👤 Mi panel';
  btn.onclick = () => { render(); if (!dlg.open) dlg.showModal(); };
  dlg = document.createElement('dialog'); dlg.id = 'nube-panel-dlg'; dlg.appendChild(document.createElement('div'));
  dlg.addEventListener('click', (e) => {
    const a = e.target && e.target.dataset && e.target.dataset.a; if (!a) return;
    if (a === 'up-close') dlg.close();
    else if (a === 'up-av') { dlg.close(); openAvisos(); }
    else if (a === 'up-sync') { onSync(); render(); }
  });
  dock.prepend(btn); document.body.appendChild(dlg);
}
