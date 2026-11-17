// admin.js - Panel del administrador: usuarios, roles, grupos del Excel y avance por grupo.
import { S, US_COL, AS_COL, COL, FV, esc, isAdmin } from './estado.js';

let adminBtn, adDlg, adminUsers = [], adminAsign = [], adminTab = 'usuarios', adminNote = '', adminGlobal = null;

// Los grupos salen del Excel (columna GRUPO de cada bien).
export const groupList = () => {
  const s = new Set(); S.ctx.getDb().assets.forEach((a) => { if (a.fromExcel && !a.isDuplicateClone && a.grupo && a.grupo !== 'GRUPO') s.add(a.grupo); });
  return [...s].sort((a, b) => a.localeCompare(b, 'es'));
};
function groupStats() {
  const m = new Map();
  S.ctx.getDb().assets.forEach((a) => {
    if (!a.fromExcel || a.isDuplicateClone || !a.grupo || a.grupo === 'GRUPO' || String(a.condicion || '').toUpperCase() === 'B') return;
    const g = m.get(a.grupo) || { total: 0, reg: 0, areas: new Set() };
    g.total++; if (a.registered) g.reg++; if (a.sourceArea) g.areas.add(a.sourceArea); m.set(a.grupo, g);
  });
  // Avance GLOBAL (todos los usuarios): bienes distintos registrados por cualquiera, calculado a pedido.
  // Un bien hallado fuera de su área NO cuenta como avance de su grupo: se muestra aparte (g.otra).
  if (adminGlobal) m.forEach((g, nombre) => {
    const ok = adminGlobal.byGroup.get(nombre) || new Set(), mis = adminGlobal.byGroupMis.get(nombre) || new Set();
    g.reg = ok.size; g.otra = [...mis].filter((c) => !ok.has(c)).length;
  });
  return m;
}
async function loadUsers() {
  const snap = await S.fdb.collection(US_COL).get();
  adminUsers = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
  // correos asignados que todavía no tienen perfil propio (la persona aún no entró, o se asignó solo por correo)
  const as = await S.fdb.collection(AS_COL).get();
  const conPerfil = new Set(adminUsers.map((u) => String(u.email || '').toLowerCase()));
  adminAsign = as.docs.filter((d) => !conPerfil.has(d.id)).map((d) => ({ uid: '', asig: d.id, email: d.id, rol: 'inventariador', ...d.data() }));
  adminUsers = [...adminUsers, ...adminAsign].sort((a, b) => String(a.nombre || a.email).localeCompare(String(b.nombre || b.email), 'es'));
}
const chips = (sel, name) => groupList().map((g) => `<label class="nb-chip"><input type="checkbox" name="${name}" value="${esc(g)}" ${sel.includes(g) ? 'checked' : ''}>${esc(g)}</label>`).join('');

async function openAdmin() {
  adDlg.querySelector('div').innerHTML = '<h3>🛡 Administración</h3><p class="nb-sub">Cargando usuarios…</p>'; if (!adDlg.open) adDlg.showModal();
  try { await loadUsers(); }
  catch (e) { adDlg.querySelector('div').innerHTML = `<h3>🛡 Administración</h3><p class="nb-err">No se pudo cargar: ${esc(e.code || e.message)}. Revise las reglas de Firestore.</p><div class="nube-row"><button data-a="ad-close">Cerrar</button></div>`; return; }
  renderAdmin();
}
function renderAdmin() {
  const box = adDlg.querySelector('div'); const stats = groupStats();
  const tabs = `<div class="nb-tabs"><button data-a="ad-tab" data-t="usuarios" class="${adminTab === 'usuarios' ? 'on' : ''}">👥 Usuarios</button><button data-a="ad-tab" data-t="grupos" class="${adminTab === 'grupos' ? 'on' : ''}">📊 Avance por grupo</button><button data-a="ad-close" class="nb-x">✕</button></div>`;
  let body = '';
  if (adminTab === 'usuarios') {
    body = `<div class="nb-card"><h4>Asignar grupo a un correo que ya existe en Firebase</h4>
      <small>Use el mismo correo con el que la persona inicia sesión. Si ya tiene perfil, se actualizan sus grupos; si no, queda asignado y se aplica apenas entre.</small>
      <div class="nb-grid"><input id="as-mail" type="email" placeholder="Correo"><input id="as-nombre" type="text" placeholder="Nombre (opcional)"></div>
      <div class="nb-chips">${chips([], 'as-g') || '<small>Los grupos aparecen cuando el catálogo termina de cargar.</small>'}</div>
      <div class="nube-row"><button data-a="ad-asig" class="primary">Asignar grupo</button><span id="as-msg" class="nb-msg">${esc(adminNote)}</span></div></div>
      <div class="nb-card"><h4>Nuevo usuario (crear cuenta desde aquí)</h4><div class="nb-grid">
      <input id="nu-nombre" type="text" placeholder="Nombre completo"><input id="nu-mail" type="email" placeholder="Correo"><input id="nu-pass" type="text" placeholder="Clave temporal (mín. 6)">
      <select id="nu-rol"><option value="inventariador">Inventariador</option><option value="admin">Administrador</option></select></div>
      <div class="nb-chips">${chips([], 'nu-g') || '<small>Los grupos aparecen cuando el catálogo termina de cargar.</small>'}</div>
      <div class="nube-row"><button data-a="ad-create" class="primary">Crear usuario</button><span id="nu-msg" class="nb-msg"></span></div></div>
      <div class="nb-card"><h4>Usuarios (${adminUsers.length})</h4><div class="nb-scroll"><table class="nb-t"><thead><tr><th>Nombre / correo</th><th>Rol</th><th>Grupos asignados</th><th>Activo</th><th></th></tr></thead><tbody>
      ${adminUsers.map((u) => `<tr data-uid="${esc(u.uid)}" data-email="${esc(u.email || '')}"><td><b>${esc(u.nombre || '')}</b><br><small>${esc(u.email || '')}${u.asig ? ' · asignado, aún no entra' : ''}</small></td>
        <td><select class="u-rol"><option value="inventariador" ${u.rol !== 'admin' ? 'selected' : ''}>Inventariador</option><option value="admin" ${u.rol === 'admin' ? 'selected' : ''}>Administrador</option></select></td>
        <td><div class="nb-chips">${chips(u.grupos || [], 'g-' + (u.uid || u.asig))}</div></td>
        <td><input type="checkbox" class="u-act" ${u.activo === false ? '' : 'checked'}></td><td><button data-a="ad-save" data-u="${esc(u.uid)}" data-e="${esc(u.email || '')}">Guardar</button>${u.asig ? `<button data-a="ad-del" data-e="${esc(u.email)}">Quitar</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="nb-empty">Aún no hay usuarios registrados.</td></tr>'}
      </tbody></table></div><small>Un usuario desactivado no puede entrar a la app. Para eliminar la cuenta por completo use la consola de Firebase.</small></div>`;
  } else {
    body = `<div class="nb-card"><h4>Avance por grupo (según inventario.xlsx)</h4><small>${adminGlobal ? `Avance global de todos los usuarios, calculado a las ${esc(adminGlobal.at.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }))}.` : 'Mostrando solo lo registrado en este equipo. Pulse «Calcular avance global» para sumar a todos los usuarios.'}</small>${[...stats.entries()].sort((a, b) => a[0].localeCompare(b[0], 'es')).map(([g, s]) => {
      const pct = s.total ? Math.round((s.reg / s.total) * 100) : 0;
      const members = adminUsers.filter((u) => (u.grupos || []).includes(g) && u.activo !== false).map((u) => u.nombre || u.email);
      return `<div class="nb-grp"><div class="nb-grp-h"><b>${esc(g)}</b><span>${s.reg.toLocaleString('es-PE')} / ${s.total.toLocaleString('es-PE')} bienes · ${s.areas.size} áreas · ${pct}%${s.otra ? ` · ⚠ ${s.otra.toLocaleString('es-PE')} hallados en otra área` : ''}</span></div>
        <div class="nb-bar"><i style="width:${pct}%"></i></div><small>${members.length ? 'Integrantes: ' + esc(members.join(', ')) : 'Sin integrantes asignados'}</small></div>`;
    }).join('') || '<p class="nb-empty">El catálogo aún no se cargó.</p>'}</div>
      <div class="nb-card"><h4>Avance global de todos los usuarios</h4><small>Cada usuario guarda su propio inventario; aquí se reúne lo registrado por todos (un bien repetido cuenta una vez; los hallados fuera de su área se muestran aparte y no suman al avance de su grupo). Hace una lectura por cada bien registrado, así que úselo cuando lo necesite.</small>
      <div class="nube-row"><button data-a="ad-global" class="primary">Calcular avance global</button><span id="gl-msg" class="nb-msg"></span></div>
      ${adminGlobal ? `<div class="nb-scroll"><table class="nb-t"><thead><tr><th>Usuario</th><th>Bienes registrados</th></tr></thead><tbody>${[...adminGlobal.byUser.entries()].sort((x, y) => y[1] - x[1]).map(([u, n]) => `<tr><td>${esc(u)}</td><td>${n.toLocaleString('es-PE')}</td></tr>`).join('') || '<tr><td colspan="2" class="nb-empty">Aún no hay registros.</td></tr>'}</tbody></table></div>` : ''}</div>`;
  }
  box.innerHTML = `<h3>🛡 Administración</h3>${tabs}${body}`;
}
async function adminCreate() {
  const q = (s) => adDlg.querySelector(s), msg = q('#nu-msg');
  const nombre = q('#nu-nombre').value.trim(), mail = q('#nu-mail').value.trim().toLowerCase(), pass = q('#nu-pass').value, rol = q('#nu-rol').value;
  const grupos = [...adDlg.querySelectorAll('input[name="nu-g"]:checked')].map((x) => x.value);
  if (!nombre || !mail || pass.length < 6) { msg.textContent = 'Complete nombre, correo y una clave de al menos 6 caracteres.'; return; }
  msg.textContent = 'Creando…';
  try {
    // Se usa una segunda instancia de Firebase para no cerrar la sesión del administrador.
    const sec = firebase.apps.find((x) => x.name === 'sec') || firebase.initializeApp(S.cfg, 'sec');
    const cred = await sec.auth().createUserWithEmailAndPassword(mail, pass); await sec.auth().signOut();
    await S.fdb.collection(US_COL).doc(cred.user.uid).set({ email: mail, nombre, rol, grupos, activo: true, creadoPor: S.user.email, creadoEn: FV().serverTimestamp() });
    await loadUsers(); renderAdmin(); adDlg.querySelector('#nu-msg').textContent = '✔ Usuario creado: ' + mail;
  } catch (ex) {
    msg.textContent = ex.code === 'auth/email-already-in-use' ? 'Ese correo ya tiene cuenta.' : ex.code === 'auth/weak-password' ? 'La clave es muy débil.' : ((ex.code || '') + ' ' + (ex.message || ''));
  }
}
async function adminSave(uid, email) {
  const tr = adDlg.querySelector(`tr[data-uid="${CSS.escape(uid)}"][data-email="${CSS.escape(email)}"]`); if (!tr) return;
  const grupos = [...tr.querySelectorAll('input[type=checkbox][name^="g-"]:checked')].map((x) => x.value);
  const data = { rol: tr.querySelector('.u-rol').value, activo: tr.querySelector('.u-act').checked, grupos };
  if (uid && uid === S.user.uid && data.rol !== 'admin') { alert('No puede quitarse a sí mismo el rol de administrador.'); return; }
  try {
    if (uid) await S.fdb.collection(US_COL).doc(uid).set(data, { merge: true });
    else await S.fdb.collection(AS_COL).doc(email.toLowerCase()).set({ grupos: data.grupos, activo: data.activo }, { merge: true });   // por correo solo se asignan grupos
    await loadUsers(); renderAdmin();
  } catch (ex) { alert('No se pudo guardar: ' + (ex.code || ex.message)); }
}
// Asignar grupos a un correo que ya existe en Firebase Authentication (no hace falta crear la cuenta de nuevo).
async function adminAsignar() {
  const q = (s) => adDlg.querySelector(s), msg = q('#as-msg');
  const mail = q('#as-mail').value.trim().toLowerCase(), nombre = q('#as-nombre').value.trim();
  const grupos = [...adDlg.querySelectorAll('input[name="as-g"]:checked')].map((x) => x.value);
  if (!/^\S+@\S+\.\S+$/.test(mail)) { msg.textContent = 'Escriba un correo válido.'; return; }
  if (!grupos.length) { msg.textContent = 'Marque al menos un grupo.'; return; }
  msg.textContent = 'Guardando…';
  try {
    const u = adminUsers.find((x) => x.uid && String(x.email || '').toLowerCase() === mail);
    if (u) await S.fdb.collection(US_COL).doc(u.uid).set({ grupos, activo: true }, { merge: true });
    else await S.fdb.collection(AS_COL).doc(mail).set({ email: mail, ...(nombre ? { nombre } : {}), grupos, activo: true, creadoPor: S.user.email, creadoEn: FV().serverTimestamp() }, { merge: true });
    adminNote = '✔ Grupo asignado a ' + mail + ': ' + grupos.join(', ');
    await loadUsers(); renderAdmin();
  } catch (ex) { msg.textContent = ex.code === 'permission-denied' ? 'Sin permiso: publique las reglas de Firestore del README.' : ((ex.code || '') + ' ' + (ex.message || '')); }
}
async function adminQuitar(email) {
  if (!confirm('¿Quitar la asignación de ' + email + '?')) return;
  try { await S.fdb.collection(AS_COL).doc(email.toLowerCase()).delete(); await loadUsers(); renderAdmin(); }
  catch (ex) { alert('No se pudo quitar: ' + (ex.code || ex.message)); }
}
// Avance global: cada usuario guarda su propio inventario, así que el administrador lo reúne leyendo los registros
// (una lectura por bien registrado; por eso se hace solo al pulsar el botón). Un bien registrado por varios
// usuarios cuenta una sola vez.
async function adminGlobalCalc() {
  const msg = adDlg.querySelector('#gl-msg'); if (msg) msg.textContent = 'Calculando…';
  try {
    const snap = await S.fdb.collection(COL).where('registered', '==', true).get();
    const byGroup = new Map(), byGroupMis = new Map(), byUser = new Map();
    snap.docs.forEach((d) => {
      const x = d.data();
      if (x.uid) { const k = x.updatedBy || x.uid; byUser.set(k, (byUser.get(k) || 0) + 1); }
      if (!x.fromExcel || x.isDuplicateClone || !x.grupo) return;
      const dest = x.areaMismatch ? byGroupMis : byGroup;   // registrado en otra área distinta a la suya -> aparte
      const set = dest.get(x.grupo) || dest.set(x.grupo, new Set()).get(x.grupo); set.add(String(x.code));
    });
    adminGlobal = { byGroup, byGroupMis, byUser, docs: snap.size, at: new Date() }; renderAdmin();
  } catch (ex) { const m2 = adDlg.querySelector('#gl-msg'); if (m2) m2.textContent = 'No se pudo: ' + (ex.code || ex.message); }
}
export const refreshAdminButton = () => { if (adminBtn) adminBtn.hidden = !isAdmin(); };
export function mountAdmin(dock) {
  adminBtn = document.createElement('button'); adminBtn.id = 'nube-adm'; adminBtn.type = 'button'; adminBtn.hidden = true;
  adminBtn.textContent = '🛡 Admin'; adminBtn.onclick = openAdmin;
  adDlg = document.createElement('dialog'); adDlg.id = 'nube-adm-dlg'; adDlg.appendChild(document.createElement('div'));
  adDlg.addEventListener('click', (e) => {
    const t = e.target, a = t && t.dataset && t.dataset.a; if (!a) return;
    if (a === 'ad-close') adDlg.close();
    else if (a === 'ad-tab') { adminTab = t.dataset.t; renderAdmin(); }
    else if (a === 'ad-create') adminCreate();
    else if (a === 'ad-save') adminSave(t.dataset.u, t.dataset.e);
    else if (a === 'ad-asig') adminAsignar();
    else if (a === 'ad-del') adminQuitar(t.dataset.e);
    else if (a === 'ad-global') adminGlobalCalc();
  });
  dock.prepend(adminBtn); document.body.appendChild(adDlg);
}
