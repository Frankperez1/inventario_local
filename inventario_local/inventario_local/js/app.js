const KEY = 'inventario-trabajador-v1';
const STORAGE_DB = 'inventario-trabajador-db';
const states = ['Bueno', 'Regular', 'Malo'];
const $ = (id) => document.getElementById(id);
// Enfoca el input sin mover la pantalla. `focus({preventScroll:true})` no lo
// respetan todos los navegadores (algunas versiones de Safari/WebView en
// celulares lo ignoran), así que además guardamos y restauramos el scroll
// a mano para asegurar que la pantalla nunca "salte" al registrar.
// En celulares el navegador a veces desplaza la pantalla DESPUÉS de que aparece
// el mensaje de resultado (para "acomodar" el teclado junto al input enfocado),
// y eso ocurre más tarde que un solo requestAnimationFrame. Por eso se reintenta
// la restauración varias veces durante un rato corto tras el escaneo.
function focusKeepScroll(el) {
  const x = window.scrollX, y = window.scrollY;
  const restore = () => { if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y); };
  el.focus({ preventScroll: true });
  restore();
  requestAnimationFrame(restore);
  [50, 150, 300, 600].forEach((delay) => setTimeout(restore, delay));
}
// Solo restaura el scroll, SIN tocar el foco de ningún elemento (a diferencia de
// focusKeepScroll). Se usa después de un escaneo hecho con la CÁMARA: ahí no hace
// falta reenfocar el campo de código (el texto llega directo del lector de QR/código
// de barras, nadie está tecleando), y forzar el foco con .focus() hace que el celular
// abra el teclado en pantalla solo — eso es lo que "empuja" la página hacia arriba y
// hace perder de vista la tabla a la persona que va pegando los stickers.
function keepScrollOnly() {
  const x = window.scrollX, y = window.scrollY;
  const restore = () => { if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y); };
  restore();
  requestAnimationFrame(restore);
  [50, 150, 300, 600].forEach((delay) => setTimeout(restore, delay));
}
// Tras registrar/consultar un código: si la cámara está abierta y escaneando, NO se
// reenfoca el campo de texto (evita que aparezca el teclado y la pantalla salte); si
// se está tecleando a mano o con un lector físico tipo "pistola" (que escribe en el
// campo como si fuera un teclado), sí conviene reenfocarlo para poder seguir sin tocar
// la pantalla.
function afterScanUI() {
  if (scanner) keepScrollOnly();
  else focusKeepScroll($('code-input'));
}
let scanner;

// Descarga inventario.xlsx UNA sola vez, apenas arranca la página (en paralelo con todo lo demás),
// y comparte el resultado entre loadProjectInventory() y restoreSourceAreas() para no descargarlo dos veces.
const inventarioBookPromise = fetch('./data/inventario.xlsx')
  .then((response) => {
    if (!response.ok) throw new Error('Archivo no encontrado');
    return response.arrayBuffer();
  })
  .then((data) => XLSX.read(data, { type: 'array' }));
let editingRoomId = null;
let session = { active: false, encargados: '', mode: null };

// Jerarquía: Local (más amplio, ej. "Ciudad Universitaria") > Área (ej. una Facultad) > Ambiente (una oficina/aula/laboratorio).
const seed = {
  locals: [{ id: 'lo1', name: '' }],
  areas: [{ id: 'a1', localId: 'lo1', name: '' }],
  rooms: [{ id: 'r1', areaId: 'a1', name: '' }, { id: 'r2', areaId: 'a1', name: '' }],
  assets: [
    { id: 'b1', code: '001-2026-0001', type: 'Escritorio', detail: 'Madera, 2 cajones', roomId: 'r1', state: 'Bueno' },
    { id: 'b2', code: '001-2026-0002', type: 'Silla', detail: 'Giratoria, color negro', roomId: 'r1', state: 'Regular' },
    { id: 'b3', code: '001-2026-0003', type: 'Computadora', detail: 'Core i5, 8 GB RAM', roomId: 'r2', state: 'Bueno' }
  ],
  selected: { localId: 'lo1', areaId: 'a1', roomId: 'r1' },
  hierarchyV2: true,
  scanCounter: 0
};

let db = seed;

// Convierte datos guardados con la jerarquía antigua (Área > Local > Ambiente) a la nueva (Local > Área > Ambiente).
function migrateHierarchy(data) {
  if (!data) return data;
  if (data.hierarchyV2) return data;
  const oldShape = Array.isArray(data.areas) && Array.isArray(data.locals) && data.locals.length && 'areaId' in data.locals[0];
  if (oldShape) {
    const newLocals = data.areas.map((a) => ({ id: a.id, name: a.name }));
    const newAreas = data.locals.map((l) => ({ id: l.id, localId: l.areaId, name: l.name }));
    const newRooms = data.rooms.map((r) => ({ id: r.id, areaId: r.localId, name: r.name }));
    data.locals = newLocals; data.areas = newAreas; data.rooms = newRooms;
    data.selected = { localId: data.selected?.areaId, areaId: data.selected?.localId, roomId: data.selected?.roomId };
  }
  data.hierarchyV2 = true;
  return data;
}

function openStorage() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(STORAGE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('data');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function readSavedData() {
  const storage = await openStorage();
  return new Promise((resolve, reject) => {
    const request = storage.transaction('data').objectStore('data').get(KEY);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
const save = async () => {
  try {
    const storage = await openStorage();
    storage.transaction('data', 'readwrite').objectStore('data').put(db, KEY);
    window.Nube?.notify();
  } catch { setMessage('No se pudieron guardar los cambios en este navegador.', true); }
};
const uid = () => crypto.randomUUID();
const selectedRoom = () => db.rooms.find((room) => room.id === db.selected.roomId);
const selectedArea = () => db.areas.find((area) => area.id === db.selected.areaId);
const selectedLocal = () => db.locals.find((local) => local.id === db.selected.localId);

// === Acceso por grupo ===============================================================
// El administrador asigna uno o más GRUPOS (columna GRUPO del Excel) a cada usuario. Un usuario
// que no es administrador solo ve los ambientes cuyos bienes pertenecen a sus grupos; todo lo demás
// (otros locales, áreas y ambientes) se oculta en selectores, buscador, reportes y notas.
//   roomAccess === null  -> sin restricción (administrador o modo local sin perfil)
//   roomAccess === Set   -> ids de los ambientes permitidos (Set vacío = no ve nada)
// OJO: esto filtra lo que se MUESTRA; los datos siguen en el navegador (ver README).
let roomAccess = null;
const roomVisible = (room) => !roomAccess || roomAccess.has(room.id);
const roomIdVisible = (roomId) => !roomAccess || roomAccess.has(roomId);
const visibleRooms = () => (roomAccess ? db.rooms.filter(roomVisible) : db.rooms);
function visibleAreas() {
  if (!roomAccess) return db.areas;
  const ids = new Set(visibleRooms().map((r) => r.areaId));
  return db.areas.filter((a) => ids.has(a.id));
}
function visibleLocals() {
  if (!roomAccess) return db.locals;
  const ids = new Set(visibleAreas().map((a) => a.localId));
  return db.locals.filter((l) => ids.has(l.id));
}
// grupos: null = todo visible; arreglo de nombres de grupo = solo esos grupos.
function setAccess(grupos) {
  if (grupos === null || grupos === undefined) roomAccess = null;
  else {
    const set = new Set(grupos.map((g) => String(g).trim()));
    roomAccess = new Set();
    for (const a of db.assets) {
      if (!a.fromExcel || a.isDuplicateClone || !a.grupo || !set.has(String(a.grupo).trim())) continue;
      const roomId = a.homeRoomId || a.roomId;
      if (roomId) roomAccess.add(roomId);
    }
  }
  renderSelectors(); switchRoomSession();
}
const setMessage = (text, error = false) => { const el = $('scan-message'); el.textContent = text; el.classList.toggle('error', error); };
const setSessionMessage = (text) => { $('session-message').textContent = text; };
const safe = (value = '') => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const text = (value) => String(value ?? '').trim();
// Fecha y hora legibles (ej. "05/10/2026, 03:42 p. m."); '—' si el bien se registró antes de que existiera este dato.
const formatDateTime = (ts) => ts
  ? new Date(ts).toLocaleString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
  : '—';
// CONDICION del inventario.xlsx: A = activo, B = dado de BAJA. Un bien de baja ya no existe
// físicamente en el ambiente, por eso NO debe contarse como "faltante".
const esDeBaja = (asset) => String(asset.condicion || '').trim().toUpperCase() === 'B';
const header = (value) => text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Cierra la sesión de escaneo activa; el trabajador debe volver a pulsar "Iniciar inventario" e indicar encargados.
function resetSession() {
  session = { active: false, encargados: '', mode: null };
  $('scan-card').hidden = true;
  $('scan-result').hidden = true;
  $('close-scan-button').hidden = true;
  $('scan-eyebrow').textContent = 'Registro rápido';
  $('scan-title').textContent = 'Escanee o digite el código';
  $('code-submit-button').textContent = 'Buscar y registrar';
  $('code-input').removeAttribute('maxlength');
  $('code-input').placeholder = 'Código patrimonial';
  setSessionMessage('');
  setMessage('');
}

// Cambia la interfaz de la tarjeta de escaneo según el modo pedido, SIN tocar
// session.active/session.encargados: así, si hay un inventario en curso, se puede
// "salir" un momento a consultar o buscar por 4 dígitos y luego volver a registrar
// sin perder nada ni tener que indicar de nuevo los encargados.
function applyModeUI(mode, { focus = true } = {}) {
  session.mode = mode;
  $('scan-card').hidden = false;
  $('scan-result').hidden = true;
  setMessage('');
  if (mode === 'inventory') {
    $('close-scan-button').hidden = true;
    $('scan-eyebrow').textContent = 'Registro rápido';
    $('scan-title').textContent = 'Escanee o digite el código';
    $('code-submit-button').textContent = 'Buscar y registrar';
    $('code-input').removeAttribute('maxlength');
    $('code-input').placeholder = 'Código patrimonial';
    // Se muestran las dos personas juntas para que no se confundan: quien registra
    // (inventariador) y quien responde por los bienes del ambiente (encargado del Excel).
    const custodio = custodioLabel();
    setSessionMessage([
      session.encargados ? `Inventariando: ${session.encargados}` : '',
      custodio ? `Encargado del ambiente: ${custodio}` : ''
    ].filter(Boolean).join('  ·  '));
  } else if (mode === 'consulta') {
    $('close-scan-button').hidden = false;
    $('scan-eyebrow').textContent = 'Consulta';
    $('scan-title').textContent = 'Consulte un código (no se registra)';
    $('code-submit-button').textContent = 'Consultar';
    $('code-input').removeAttribute('maxlength');
    $('code-input').placeholder = 'Código patrimonial';
    setSessionMessage(session.active
      ? `Modo consulta: el bien no se agregará al inventario. (Inventario en curso — ${session.encargados})`
      : 'Modo consulta: el bien no se agregará al inventario.');
  } else if (mode === 'buscar4') {
    $('close-scan-button').hidden = false;
    $('scan-eyebrow').textContent = 'Búsqueda';
    $('scan-title').textContent = 'Digite los últimos 4 dígitos del código';
    $('code-submit-button').textContent = 'Buscar';
    $('code-input').setAttribute('maxlength', '4');
    $('code-input').placeholder = 'Ej.: 0535';
    setSessionMessage(session.active
      ? `Modo búsqueda: busca solo entre los bienes ya registrados en este ambiente. (Inventario en curso — ${session.encargados})`
      : 'Modo búsqueda: busca solo entre los bienes ya registrados en este ambiente.');
  }
  if (focus) focusKeepScroll($('code-input'));
}

// Muestra el resultado de un escaneo (registro o consulta) en un bloque destacado, con ícono y ubicación.
// Si se pasa 'html', se usa una lista de resultados en vez de una sola línea de ubicación (búsqueda por 4 dígitos).
function showScanResult({ title, location, error = false, html = null }) {
  setMessage('');
  const result = $('scan-result');
  result.hidden = false;
  result.classList.toggle('error-result', error);
  $('scan-result-title').textContent = title;
  const locationEl = $('scan-result-location');
  if (html) {
    locationEl.innerHTML = html;
    locationEl.hidden = false;
  } else {
    locationEl.textContent = location || '';
    locationEl.hidden = !location;
  }
}

// === Custom select: capa visual sobre un <select> nativo oculto, que sigue siendo la fuente de verdad ===
// Cada combo (Local/Área/Ambiente) trae además un buscador de texto dentro del desplegable
// (ver filterCustomSelect) porque con muchos locales/áreas/ambientes cargados era muy
// incómodo desplazarse a mano hasta encontrar el que se necesita.
const customSelects = {};
function enhanceSelect(id) {
  const select = $(id);
  const wrapper = select.closest('.custom-select');
  const trigger = wrapper.querySelector('.custom-select-trigger');
  const valueEl = wrapper.querySelector('.custom-select-value');
  const dropdown = wrapper.querySelector('.custom-select-dropdown');
  const panel = wrapper.querySelector('.custom-select-panel');
  const searchInput = wrapper.querySelector('.custom-select-search');
  customSelects[id] = { select, wrapper, trigger, valueEl, dropdown, panel, searchInput };
  const closePanel = () => { wrapper.classList.remove('open'); dropdown.hidden = true; };
  const openPanel = () => {
    Object.entries(customSelects).forEach(([otherId, other]) => {
      if (otherId !== id) { other.wrapper.classList.remove('open'); other.dropdown.hidden = true; }
    });
    wrapper.classList.add('open'); dropdown.hidden = false;
    searchInput.value = '';
    filterCustomSelect(id, '');
    panel.querySelector('.custom-select-option.is-selected')?.scrollIntoView({ block: 'nearest' });
    searchInput.focus();
  };
  trigger.onclick = () => { wrapper.classList.contains('open') ? closePanel() : openPanel(); };
  searchInput.addEventListener('input', () => filterCustomSelect(id, searchInput.value));
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePanel(); trigger.focus(); } });
  document.addEventListener('click', (e) => { if (!wrapper.contains(e.target)) closePanel(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });
}
// Oculta las opciones del panel que no coincidan con lo escrito (comparando sin tildes ni
// mayúsculas, con la misma normalización que usa header() para los encabezados del Excel).
function filterCustomSelect(id, query) {
  const custom = customSelects[id];
  if (!custom) return;
  const normalizedQuery = header(query);
  let anyVisible = false;
  custom.panel.querySelectorAll('.custom-select-option').forEach((li) => {
    const match = !normalizedQuery || header(li.textContent).includes(normalizedQuery);
    li.hidden = !match;
    if (match) anyVisible = true;
  });
  let emptyEl = custom.panel.querySelector('.custom-select-empty');
  if (!anyVisible) {
    if (!emptyEl) {
      emptyEl = document.createElement('li');
      emptyEl.className = 'custom-select-empty';
      emptyEl.textContent = 'Sin resultados';
      custom.panel.appendChild(emptyEl);
    }
  } else if (emptyEl) {
    emptyEl.remove();
  }
}
// Reduce el tamaño de letra del valor seleccionado hasta que quepa en una sola línea sin cortarse.
const VALUE_FONT_MAX_PX = 15;
const VALUE_FONT_MIN_PX = 9;
function fitSelectValue(valueEl) {
  valueEl.style.fontSize = VALUE_FONT_MAX_PX + 'px';
  let size = VALUE_FONT_MAX_PX;
  while (valueEl.scrollWidth > valueEl.clientWidth && size > VALUE_FONT_MIN_PX) {
    size -= 0.5;
    valueEl.style.fontSize = size + 'px';
  }
}
function syncCustomSelect(id) {
  const custom = customSelects[id];
  if (!custom) return;
  const { select, valueEl, panel, wrapper, dropdown, searchInput } = custom;
  panel.innerHTML = Array.from(select.options).map((opt) =>
    `<li class="custom-select-option${opt.selected ? ' is-selected' : ''}" role="option" data-value="${safe(opt.value)}">${safe(opt.textContent)}</li>`
  ).join('');
  panel.querySelectorAll('.custom-select-option').forEach((li) => {
    li.onclick = () => {
      select.value = li.dataset.value;
      select.dispatchEvent(new Event('change'));
      wrapper.classList.remove('open'); dropdown.hidden = true;
    };
  });
  valueEl.textContent = select.options[select.selectedIndex]?.textContent || '—';
  requestAnimationFrame(() => fitSelectValue(valueEl));
  if (searchInput && searchInput.value) filterCustomSelect(id, searchInput.value);
}
// Al cambiar el ancho de ventana (o girar el celular) los cuadros cambian de tamaño, así que se recalcula la letra.
window.addEventListener('resize', () => {
  Object.values(customSelects).forEach(({ valueEl }) => fitSelectValue(valueEl));
});
function options(select, data, selectedId) {
  select.innerHTML = data.map((x) => `<option value="${safe(x.id)}" ${x.id === selectedId ? 'selected' : ''}>${safe(x.name)}</option>`).join('');
  syncCustomSelect(select.id);
}
function renderSelectors() {
  const locals = [...visibleLocals()].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  if (!locals.some((x) => x.id === db.selected.localId)) db.selected.localId = locals[0]?.id;
  options($('local-select'), locals, db.selected.localId);
  const areas = visibleAreas().filter((x) => x.localId === db.selected.localId).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  if (!areas.some((x) => x.id === db.selected.areaId)) db.selected.areaId = areas[0]?.id;
  options($('area-select'), areas, db.selected.areaId);
  const rooms = visibleRooms().filter((x) => x.areaId === db.selected.areaId).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  if (!rooms.some((x) => x.id === db.selected.roomId)) db.selected.roomId = rooms[0]?.id;
  options($('room-select'), rooms, db.selected.roomId);
  save(); renderAssets(); renderCustodio();
}

// === Encargado del ambiente (dato del inventario.xlsx, NO se escribe a mano) =======
// El Excel maestro trae, en cada fila, quién responde por el bien: NRO_DOC_IDENT_PERSONAL +
// APELLIDO_PATERNO + APELLIDO_MATERNO + NOMBRES, y esa persona está atada al NOMBRE_OFICINA
// (el ambiente). Se resume una sola vez por ambiente y se guarda en db.custodios para no
// tener que releer el Excel (son ~105 000 filas) cada vez que se cambia de ambiente.
//
// Se indexa por NOMBRE (local|área|ambiente normalizados) y no por roomId a propósito: así el
// dato sobrevive a importar un respaldo de otra máquina, donde los ids son distintos pero los
// nombres son los mismos.
const custodioKey = (localName, areaName, roomName) => [header(localName), header(areaName), header(roomName)].join('|');

// Un mismo ambiente puede tener varios responsables en el Excel (pasa en ~1 de cada 8):
// se ordenan por cantidad de bienes a su cargo, así el primero es el responsable principal.
function custodiosOfRoom(roomId) {
  if (!db.custodios) return [];
  const room = db.rooms.find((r) => r.id === roomId);
  const area = db.areas.find((a) => a.id === room?.areaId);
  const local = db.locals.find((l) => l.id === area?.localId);
  if (!room) return [];
  return db.custodios[custodioKey(local?.name, area?.name, room.name)] || [];
}
const custodiosOfSelectedRoom = () => custodiosOfRoom(db.selected.roomId);
function custodioLabel(roomId = db.selected.roomId) {
  return custodiosOfRoom(roomId).map((c) => c.name).join(' / ');
}
function renderCustodio() {
  const banner = $('custodio-banner');
  if (!banner) return;
  const nameEl = $('custodio-name');
  const extraEl = $('custodio-extra');
  const list = custodiosOfSelectedRoom();
  banner.hidden = false;
  if (!list.length) {
    nameEl.className = 'custodio-name is-empty';
    nameEl.textContent = db.custodiosV1
      ? 'Sin encargado registrado en el inventario.xlsx para este ambiente.'
      : 'Leyendo encargados del inventario.xlsx…';
    extraEl.hidden = true;
    return;
  }
  const [main, ...others] = list;
  nameEl.className = 'custodio-name';
  nameEl.innerHTML = `${safe(main.name)} <span class="custodio-doc">· DNI ${safe(main.doc || '—')}</span>`;
  if (others.length) {
    extraEl.hidden = false;
    extraEl.textContent = `También figuran en este ambiente: ${others.map((c) => `${c.name} (${c.count} bien${c.count === 1 ? '' : 'es'})`).join(' · ')}`;
  } else {
    extraEl.hidden = true;
  }
}
// Recorre el Excel UNA sola vez en la vida de este navegador y arma el resumen de encargados
// por ambiente. Después queda guardado (db.custodiosV1), así que al abrir la app de nuevo el
// encargado aparece al instante sin esperar la descarga del archivo.
async function loadCustodios() {
  if (db.custodiosV1 && db.custodios) return renderCustodio();
  try {
    const book = await inventarioBookPromise;
    const matrix = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, defval: '', blankrows: false });
    const headerIndex = matrix.findIndex((row) => row.some((cell) => matchesColumn(cell, codeHeaders)));
    if (headerIndex < 0) return;
    const headers = matrix[headerIndex].map(header);
    const at = (...names) => headers.findIndex((name) => names.some((n) => name === n || name.includes(n)));
    const localIndex = at('nombrelocal', 'local');
    const areaIndex = at('nombrearea', 'area');
    const roomIndex = at('nombreoficina', 'oficina', 'ambiente', 'aula');
    const docIndex = at('nrodocidentpersonal', 'nrodocident', 'dni');
    const paternoIndex = at('apellidopaterno');
    const maternoIndex = at('apellidomaterno');
    const nombresIndex = at('nombres');
    if (roomIndex < 0 || (paternoIndex < 0 && nombresIndex < 0)) return;
    const tally = new Map();
    matrix.slice(headerIndex + 1).forEach((row) => {
      const name = [paternoIndex, maternoIndex, nombresIndex].filter((i) => i >= 0).map((i) => text(row[i])).filter(Boolean).join(' ');
      if (!name) return;
      const key = custodioKey(localIndex >= 0 ? row[localIndex] : '', areaIndex >= 0 ? row[areaIndex] : '', row[roomIndex]);
      const doc = docIndex >= 0 ? text(row[docIndex]) : '';
      if (!tally.has(key)) tally.set(key, new Map());
      const people = tally.get(key);
      const personKey = `${doc}|${name}`;
      if (people.has(personKey)) people.get(personKey).count++;
      else people.set(personKey, { doc, name, count: 1 });
    });
    const custodios = {};
    tally.forEach((people, key) => {
      custodios[key] = [...people.values()].sort((a, b) => b.count - a.count);
    });
    db.custodios = custodios;
    db.custodiosV1 = true;
    save();
    renderCustodio();
  } catch (err) {
    console.error('No se pudieron leer los encargados del inventario.xlsx:', err);
  }
}

// === Inventariador: se pide UNA sola vez y queda guardado ==========================
// Antes el nombre vivía solo en `session`, y como cambiar de ambiente reinicia la sesión,
// había que volver a escribirlo en cada ambiente. Ahora vive en db.inventariador (se guarda
// en este navegador) y la sesión solo lo copia.
function renderInventariador() {
  const bar = $('inventariador-bar');
  if (!bar) return;
  const name = db.inventariador || '';
  bar.hidden = !name;
  $('inventariador-name').textContent = name;
  $('start-inventory-button').textContent = name ? '▶ Inventariar este ambiente' : '▶ Iniciar inventario';
}
// Empieza (o retoma) el registro en el ambiente seleccionado usando el inventariador guardado.
function beginInventory({ focus = true } = {}) {
  if (!db.inventariador) return false;
  session.active = true;
  session.encargados = db.inventariador;
  applyModeUI('inventory', { focus });
  return true;
}
// Al cambiar de Local/Área/Ambiente: se limpia lo del ambiente anterior, pero si había un
// inventario en curso y hay inventariador guardado, se retoma solo en el ambiente nuevo
// (sin volver a preguntar nada y sin abrir el teclado del celular).
function switchRoomSession() {
  const wasActive = session.active;
  resetSession();
  if (wasActive) beginInventory({ focus: false });
}
// Ubicación registrada de un bien: misma regla usada en la tabla y en el mensaje de escaneo,
// para que ambas siempre coincidan (evita mostrar el ambiente activo cuando el bien es de otro lugar).
function registeredLocation(asset) {
  if (asset.areaMismatch) {
    return [asset.sourceArea, asset.sourceRoom].filter(Boolean).join(' — ') || asset.sourceRoom || '-';
  }
  return asset.sourceRoom || selectedRoom()?.name || '-';
}
// Texto "Local — Área — Ambiente" de un ambiente dado.
function roomLabel(roomId) {
  const room = db.rooms.find((r) => r.id === roomId);
  const area = db.areas.find((a) => a.id === room?.areaId);
  const local = db.locals.find((l) => l.id === area?.localId);
  return [local?.name, area?.name, room?.name].filter(Boolean).join(' — ') || room?.name || 'ambiente desconocido';
}
// Calcula EN VIVO en qué otros ambientes está activo (registrado, sin finalizar) el mismo código
// patrimonial. Se calcula siempre al vuelo (no se guarda) para que quede siempre al día: si en el
// otro ambiente finalizan o eliminan ese bien, aquí deja de aparecer automáticamente.
function otherActiveLocations(asset) {
  return db.assets
    .filter((x) => x.id !== asset.id && x.registered && x.code.toLowerCase() === asset.code.toLowerCase())
    .map((x) => roomLabel(x.roomId));
}

// === Buscador global de bienes registrados (todos los locales/áreas/ambientes) =====
// Distinto de "Buscar por 4 dígitos" (que solo mira el ambiente activo, sirve para el
// trabajador ubicar un bien mientras cuenta): este buscador es para responder preguntas
// como "¿cuántos bienes de tal facultad/ambiente se registraron?" o encontrar un código
// sin importar dónde se escaneó. Guarda el último resultado para poder exportarlo.
let lastSearchResults = [];

function populateSearchFilters() {
  const localSel = $('search-local-select');
  const areaSel = $('search-area-select');
  const roomSel = $('search-room-select');
  const prevLocal = localSel.value, prevArea = areaSel.value, prevRoom = roomSel.value;

  localSel.innerHTML = '<option value="">Todos los locales</option>'
    + visibleLocals().map((l) => `<option value="${safe(l.id)}">${safe(l.name || 'Sin nombre')}</option>`).join('');
  localSel.value = visibleLocals().some((l) => l.id === prevLocal) ? prevLocal : '';
  syncCustomSelect('search-local-select');

  const areasInLocal = visibleAreas().filter((a) => !localSel.value || a.localId === localSel.value);
  areaSel.innerHTML = '<option value="">Todas las áreas</option>'
    + areasInLocal.map((a) => `<option value="${safe(a.id)}">${safe(a.name || 'Sin nombre')}</option>`).join('');
  areaSel.value = areasInLocal.some((a) => a.id === prevArea) ? prevArea : '';
  syncCustomSelect('search-area-select');

  const roomsInArea = visibleRooms().filter((r) => areaSel.value ? r.areaId === areaSel.value : areasInLocal.some((a) => a.id === r.areaId));
  roomSel.innerHTML = '<option value="">Todos los ambientes</option>'
    + roomsInArea.map((r) => `<option value="${safe(r.id)}">${safe(r.name || 'Sin nombre')}</option>`).join('');
  roomSel.value = roomsInArea.some((r) => r.id === prevRoom) ? prevRoom : '';
  syncCustomSelect('search-room-select');
}

// --- Índice del buscador global -------------------------------------------------------------
// Con ~100 000 bienes, recorrer db.assets / db.rooms por cada fila y por cada tecla era O(n²).
// Se arma UNA vez al abrir el buscador (el diálogo es modal, los datos no cambian mientras está
// abierto) y se descarta al cerrarlo.
let searchIndex = null;
function buildSearchIndex() {
  const roomsById = new Map(db.rooms.map((r) => [r.id, r]));
  const areasById = new Map(db.areas.map((a) => [a.id, a]));
  const localsById = new Map(db.locals.map((l) => [l.id, l]));
  const labels = new Map();
  const roomArea = new Map();
  const roomLocal = new Map();
  for (const room of db.rooms) {
    const area = areasById.get(room.areaId);
    const local = localsById.get(area?.localId);
    roomArea.set(room.id, room.areaId);
    roomLocal.set(room.id, area?.localId);
    labels.set(room.id, [local?.name, area?.name, room?.name].filter(Boolean).join(' — ') || room?.name || 'ambiente desconocido');
  }
  const labelOf = (roomId) => labels.get(roomId) || 'ambiente desconocido';
  // Dónde figura el bien en el Excel maestro (su ambiente "oficial"); si no se conoce el ambiente,
  // se usa el texto Área — Ambiente que traía el Excel.
  const homeOf = (x) => (x.homeRoomId && labels.get(x.homeRoomId))
    || [x.sourceArea, x.sourceRoom].filter(Boolean).join(' — ') || '—';
  const registered = [];
  for (const x of db.assets) if (x.registered && roomIdVisible(x.roomId)) registered.push(x);
  registered.sort((a, b) => (a.registeredOrder || 0) - (b.registeredOrder || 0)); // se ordena UNA vez
  const n = registered.length;
  const hay = new Array(n);
  const byCode = new Map();
  for (let i = 0; i < n; i++) {
    const x = registered[i];
    const key = String(x.code).toLowerCase();
    const list = byCode.get(key);
    if (list) list.push(x); else byCode.set(key, [x]);
    hay[i] = (x.code + ' ' + (x.type || '') + ' ' + (x.detail || '') + ' ' + (x.encargados || '') + ' ' + (x.comment || '')
      + ' ' + (x.sourceArea || '') + ' ' + (x.sourceRoom || '') + ' ' + labelOf(x.roomId) + ' ' + homeOf(x) + ' ' + formatDateTime(x.registeredAt)).toLowerCase();
  }
  return { labelOf, homeOf, byCode, registered, hay, roomArea, roomLocal, lastQuery: '', lastIdxs: null };
}
function getSearchIndex() { return searchIndex || (searchIndex = buildSearchIndex()); }
function otherActiveLocationsFast(asset, idx) {
  const same = idx.byCode.get(String(asset.code).toLowerCase()) || [];
  const out = [];
  for (const x of same) if (x.id !== asset.id) out.push(idx.labelOf(x.roomId));
  return out;
}

function runSearch() {
  const idx = getSearchIndex();
  const query = $('search-query-input').value.trim().toLowerCase();
  const localId = $('search-local-select').value;
  const areaId = $('search-area-select').value;
  const roomId = $('search-room-select').value;
  const stateFilter = $('search-state-select').value;
  const { registered, hay, roomArea, roomLocal } = idx;

  // Si solo se añadieron letras a la búsqueda anterior (y los filtros no cambiaron), se busca
  // únicamente dentro de lo ya encontrado en vez de recorrer todo otra vez.
  const filterKey = `${localId}|${areaId}|${roomId}|${stateFilter}`;
  let candidates = null;
  if (idx.lastIdxs && idx.filterKey === filterKey && query && idx.lastQuery && query.startsWith(idx.lastQuery)) candidates = idx.lastIdxs;

  const out = [];
  const consider = (i) => {
    const x = registered[i];
    if (!candidates) {
      if (roomId) { if (x.roomId !== roomId) return; }
      else if (areaId) { if (roomArea.get(x.roomId) !== areaId) return; }
      else if (localId) { if (roomLocal.get(x.roomId) !== localId) return; }
      if (stateFilter && x.state !== stateFilter) return;
    }
    if (query && !hay[i].includes(query)) return;
    out.push(i);
  };
  if (candidates) for (let k = 0; k < candidates.length; k++) consider(candidates[k]);
  else for (let i = 0; i < registered.length; i++) consider(i);

  idx.lastQuery = query; idx.lastIdxs = out; idx.filterKey = filterKey;
  const results = new Array(out.length);
  for (let k = 0; k < out.length; k++) results[k] = registered[out[k]];
  lastSearchResults = results;
  renderSearchResults(results);
}

const SEARCH_PAGE_SIZE = 200;
let searchRendered = 0;
function searchRowHtml(asset, index, idx) {
  const mismatch = asset.areaMismatch;
  const duplicateElsewhere = otherActiveLocationsFast(asset, idx);
  const rowClass = (mismatch || duplicateElsewhere.length) ? 'mismatch-row' : '';
  const flagIcons = `${mismatch ? ' ⚠' : ''}${duplicateElsewhere.length ? ' 🔁' : ''}`;
  const alertaTexto = mismatch
    ? `Bien de otra área: ${safe([asset.sourceArea, asset.sourceRoom].filter(Boolean).join(' — '))}`
    : (duplicateElsewhere.length ? `Duplicado, también en: ${safe(duplicateElsewhere.join(', '))}` : '');
  return `<tr class="${rowClass}">`
    + `<td>${index + 1}</td>`
    + `<td>${safe(asset.code)}</td>`
    + `<td>${safe(asset.type)}</td>`
    + `<td>${safe(idx.labelOf(asset.roomId))}${flagIcons}</td>`
    + `<td>${safe(idx.homeOf(asset))}</td>`
    + `<td>${safe(asset.state)}</td>`
    + `<td>${safe(asset.encargados || '')}</td>`
    + `<td>${safe(formatDateTime(asset.registeredAt))}</td>`
    + `<td>${safe(asset.comment || '')}</td>`
    + `<td>${alertaTexto}</td>`
    + `</tr>`;
}
// Solo se dibujan SEARCH_PAGE_SIZE filas a la vez; el resto se agrega con "Mostrar más".
function renderSearchChunk(reset) {
  const tbody = $('search-results-body');
  const idx = getSearchIndex();
  const results = lastSearchResults;
  if (reset) { tbody.innerHTML = ''; searchRendered = 0; const wrap = document.querySelector('.search-results-wrap'); if (wrap) wrap.scrollTop = 0; }
  tbody.querySelector('.search-more-row')?.remove();
  const end = Math.min(results.length, searchRendered + SEARCH_PAGE_SIZE);
  let html = '';
  for (let i = searchRendered; i < end; i++) html += searchRowHtml(results[i], i, idx);
  searchRendered = end;
  if (searchRendered < results.length) {
    html += `<tr class="search-more-row"><td colspan="10" style="text-align:center;padding:12px">`
      + `<button type="button" class="button button-secondary" id="search-more-button">`
      + `Mostrar ${Math.min(SEARCH_PAGE_SIZE, results.length - searchRendered)} más (${results.length - searchRendered} restantes)</button></td></tr>`;
  }
  tbody.insertAdjacentHTML('beforeend', html);
  const more = $('search-more-button');
  if (more) {
    more.onclick = () => renderSearchChunk(false);
    if (searchObserver) searchObserver.disconnect();
    if ('IntersectionObserver' in window) {
      searchObserver = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) renderSearchChunk(false); },
        { root: document.querySelector('.search-results-wrap'), rootMargin: '300px' });
      searchObserver.observe(more);
    }
  }
}
let searchObserver = null;

function renderSearchResults(results) {
  const summary = $('search-summary');
  const emptyMsg = $('search-empty-message');
  const roomsUsed = new Set();
  for (const x of results) roomsUsed.add(x.roomId);

  summary.textContent = results.length
    ? `${results.length} bien(es) encontrado(s) en ${roomsUsed.size} ambiente(s).`
      + (results.length > SEARCH_PAGE_SIZE ? ' Se muestran de a poco; el PDF incluye todos.' : '')
    : '';
  emptyMsg.hidden = results.length > 0;
  renderSearchChunk(true);
}

function exportSearchResultsPdf() {
  if (!window.jspdf || !window.jspdf.jsPDF) return alert('La exportación PDF no está disponible: no cargaron las librerías (jsPDF). Revise su conexión a internet y recargue la página.');
  if (typeof window.jspdf.jsPDF.API?.autoTable !== 'function') return alert('La exportación PDF no está disponible: no cargó el complemento de tablas (autoTable). Revise su conexión a internet y recargue la página.');
  if (!lastSearchResults.length) return alert('No hay resultados para exportar.');

  // Formato "claro/corporativo": fondo blanco, franja de color a la izquierda y una insignia
  // con el total — a propósito muy distinto del HUD oscuro del PDF por ambiente y del formato
  // ámbar del reporte de faltantes, para diferenciar de un vistazo cada tipo de reporte.
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation: 'landscape' });
  const width = pdf.internal.pageSize.getWidth();
  const BLUE = [11, 92, 171]; const BLUE_SOFT = [223, 236, 249]; const INK = [20, 30, 46]; const GREY = [110, 124, 150];

  pdf.setFillColor(255, 255, 255); pdf.rect(0, 0, width, 28, 'F');
  pdf.setFillColor(...BLUE); pdf.rect(0, 0, 4, 28, 'F');
  pdf.setTextColor(...INK); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(15);
  pdf.text('Búsqueda en todo el inventario', 12, 13);
  pdf.setFont('helvetica', 'normal'); pdf.setTextColor(...GREY); pdf.setFontSize(8.5);
  pdf.text('Universidad Nacional del Centro del Perú — todos los locales y ambientes', 12, 20);

  pdf.setFillColor(...BLUE_SOFT); pdf.roundedRect(width - 66, 5, 54, 18, 2.5, 2.5, 'F');
  pdf.setTextColor(...BLUE); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(13);
  pdf.text(String(lastSearchResults.length), width - 60, 15);
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(6.4); pdf.setTextColor(...GREY);
  pdf.text('BIEN(ES) ENCONTRADO(S)', width - 50, 11);
  pdf.text(new Date().toLocaleDateString('es-PE', { day: '2-digit', month: 'long', year: 'numeric' }), width - 50, 17.5);

  pdf.setDrawColor(...BLUE); pdf.setLineWidth(0.7); pdf.line(0, 28, width, 28);

  pdf.autoTable({
    startY: 34,
    head: [['Ítem', 'Código', 'Tipo de bien', 'Inventariado en (Local — Área — Ambiente)', 'Ubicación en Excel', 'Estado', 'Inventariador', 'Fecha y hora', 'Comentario', 'Alerta']],
    body: lastSearchResults.map((asset, index) => {
      const duplicateElsewhere = otherActiveLocationsFast(asset, getSearchIndex());
      const alerta = asset.areaMismatch
        ? `Bien de otra área: ${[asset.sourceArea, asset.sourceRoom].filter(Boolean).join(' — ')}`
        : (duplicateElsewhere.length ? `Duplicado, también en: ${duplicateElsewhere.join(', ')}` : '');
      return [index + 1, asset.code, asset.type, getSearchIndex().labelOf(asset.roomId), getSearchIndex().homeOf(asset), asset.state, asset.encargados || '', formatDateTime(asset.registeredAt), asset.comment || '', alerta];
    }),
    theme: 'grid',
    headStyles: { fillColor: BLUE, textColor: [255, 255, 255], fontSize: 7.5 },
    alternateRowStyles: { fillColor: [246, 249, 252] },
    styles: { fontSize: 7.5, cellPadding: 2.2, textColor: INK, lineColor: [222, 229, 240] },
    columnStyles: {
      0: { cellWidth: 10, halign: 'center' }, 1: { cellWidth: 24 }, 2: { cellWidth: 28 }, 3: { cellWidth: 44 }, 4: { cellWidth: 38 },
      5: { cellWidth: 14, halign: 'center' }, 6: { cellWidth: 24 }, 7: { cellWidth: 24 }, 8: { cellWidth: 24 }, 9: { cellWidth: 34 }
    },
    didParseCell: (data) => {
      if (data.section === 'body' && data.row.raw[9]) { data.cell.styles.fillColor = [253, 233, 236]; data.cell.styles.textColor = [176, 26, 62]; data.cell.styles.fontStyle = 'bold'; }
    },
    didDrawPage: () => {
      const h = pdf.internal.pageSize.getHeight();
      pdf.setDrawColor(222, 229, 240); pdf.setLineWidth(0.35); pdf.line(12, h - 12, width - 12, h - 12);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7.3); pdf.setTextColor(...GREY);
      pdf.text('Búsqueda global de inventario', 12, h - 7);
      pdf.text(`Página ${pdf.internal.getCurrentPageInfo().pageNumber} de ${pdf.internal.getNumberOfPages()}`, width - 12, h - 7, { align: 'right' });
    }
  });

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  pdf.save(`busqueda-inventario-${stamp}.pdf`);
}

// === Reporte de bienes faltantes por ambiente ======================================
// Distinto del buscador global de arriba: aquí se elige UN ambiente puntual y se
// responde "¿qué bienes de este ambiente (según inventario.xlsx) todavía no aparecen?"
// y "¿cuáles de los suyos sí se encontraron pero en otro ambiente/área?". Se apoya en
// homeRoomId (el ambiente "oficial" de cada bien, ver importRows), que no cambia aunque
// el bien se registre en otro lugar — a diferencia de roomId, que sí refleja dónde está
// físicamente ahora.
let lastMissingReport = { room: null, custodio: '', notFound: [], foundElsewhere: [], inPlaceCount: 0, sobrantes: [], inPlace: [] };

function populateMissingFilters() {
  const localSel = $('missing-local-select');
  const areaSel = $('missing-area-select');
  const roomSel = $('missing-room-select');
  const prevLocal = localSel.value, prevArea = areaSel.value, prevRoom = roomSel.value;

  localSel.innerHTML = '<option value="">Todos los locales</option>'
    + [...visibleLocals()].sort((a, b) => a.name.localeCompare(b.name, 'es')).map((l) => `<option value="${safe(l.id)}">${safe(l.name || 'Sin nombre')}</option>`).join('');
  localSel.value = visibleLocals().some((l) => l.id === prevLocal) ? prevLocal : '';
  syncCustomSelect('missing-local-select');

  const areasInLocal = visibleAreas().filter((a) => !localSel.value || a.localId === localSel.value).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  areaSel.innerHTML = '<option value="">Todas las áreas</option>'
    + areasInLocal.map((a) => `<option value="${safe(a.id)}">${safe(a.name || 'Sin nombre')}</option>`).join('');
  areaSel.value = areasInLocal.some((a) => a.id === prevArea) ? prevArea : '';
  syncCustomSelect('missing-area-select');

  const roomsInArea = visibleRooms().filter((r) => areaSel.value ? r.areaId === areaSel.value : areasInLocal.some((a) => a.id === r.areaId)).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  roomSel.innerHTML = '<option value="">Seleccione un ambiente…</option>'
    + roomsInArea.map((r) => `<option value="${safe(r.id)}">${safe(r.name || 'Sin nombre')}</option>`).join('');
  roomSel.value = roomsInArea.some((r) => r.id === prevRoom) ? prevRoom : '';
  syncCustomSelect('missing-room-select');
}

function runMissingReport() {
  const roomId = $('missing-room-select').value;
  const foundBody = $('missing-found-body');
  const notFoundBody = $('missing-notfound-body');
  const foundEmpty = $('missing-found-empty');
  const notFoundEmpty = $('missing-notfound-empty');
  const summary = $('missing-summary');
  const extraBody = $('missing-extra-body');
  const inplaceBody = $('missing-inplace-body');
  const inplaceEmpty = $('missing-inplace-empty');
  const extraEmpty = $('missing-extra-empty');

  if (!roomId) {
    foundBody.innerHTML = ''; notFoundBody.innerHTML = ''; extraBody.innerHTML = ''; extraEmpty.hidden = true; inplaceBody.innerHTML = ''; inplaceEmpty.hidden = true;
    foundEmpty.hidden = true; notFoundEmpty.hidden = true;
    summary.textContent = 'Seleccione un ambiente para ver el reporte.';
    lastMissingReport = { room: null, custodio: '', notFound: [], foundElsewhere: [], inPlaceCount: 0, sobrantes: [], inPlace: [] };
    return;
  }

  // Para cada bien "oficial" de este ambiente se revisan TODAS sus copias registradas (el
  // original y, si además se escaneó en otro ambiente, su copia/duplicado de allá) — no solo
  // el registro original. Antes solo se miraba el original, así que un bien que seguía "activo"
  // en su ambiente de origen pero que ADEMÁS se encontró en otro lado nunca aparecía en
  // "Encontrados en otro ambiente" (su copia duplicada estaba excluida del reporte).
  const homeAll = db.assets.filter((x) => !x.isDuplicateClone && x.homeRoomId === roomId);
  // Los bienes con CONDICION = B (dados de baja) ya no están en el ambiente: no son "faltantes".
  const homeAssets = homeAll.filter((x) => !esDeBaja(x));
  const bajasCount = homeAll.length - homeAssets.length;
  const copiesByCode = new Map();
  db.assets.forEach((x) => {
    const key = x.code.toLowerCase();
    if (!copiesByCode.has(key)) copiesByCode.set(key, []);
    copiesByCode.get(key).push(x);
  });

  const notFound = [];
  const inPlace = [];
  const foundElsewhere = [];
  let inPlaceCount = 0;
  homeAssets.forEach((home) => {
    const registeredCopies = (copiesByCode.get(home.code.toLowerCase()) || [home]).filter((x) => x.registered);
    const hereCopy = registeredCopies.find((x) => x.roomId === roomId);
    if (hereCopy) {
      inPlaceCount++;
      inPlace.push({ code: home.code, type: home.type, detail: home.detail, fechaAdq: home.fechaAdq || '', state: hereCopy.state, registeredAt: hereCopy.registeredAt, registeredOrder: hereCopy.registeredOrder || 0 });
      return;
    }
    const elsewhere = registeredCopies[0];
    if (elsewhere) foundElsewhere.push({ ...home, roomId: elsewhere.roomId, state: elsewhere.state });
    else notFound.push(home);
  });
  // Orden alfabético: primero por tipo de bien y, dentro del mismo tipo, por código.
  const byTypeThenCode = (a, b) => String(a.type || '').localeCompare(String(b.type || ''), 'es', { sensitivity: 'base' }) || String(a.code).localeCompare(String(b.code), 'es', { numeric: true });
  inPlace.sort(byTypeThenCode);
  notFound.sort(byTypeThenCode);
  foundElsewhere.sort(byTypeThenCode);

  // Bienes ESCANEADOS en este ambiente que según el Excel pertenecen a otro. Antes no salían en
  // ninguna parte del reporte (no son faltantes), y por eso parecía que "faltaba" lo escaneado.
  const originals = new Map();
  db.assets.forEach((x) => { if (!x.isDuplicateClone) originals.set(x.code.toLowerCase(), x); });
  const sobrantes = [];
  db.assets.forEach((x) => {
    if (!x.registered || x.roomId !== roomId) return;
    const orig = x.isDuplicateClone ? (originals.get(x.code.toLowerCase()) || x) : x;
    if (orig.homeRoomId === roomId) return;
    const origin = (orig.homeRoomId && roomLabel(orig.homeRoomId) !== 'ambiente desconocido')
      ? roomLabel(orig.homeRoomId)
      : ([orig.sourceArea, orig.sourceRoom].filter(Boolean).join(' — ') || 'Sin ubicación en el Excel');
    sobrantes.push({ code: x.code, type: x.type, origin, fechaAdq: orig.fechaAdq || '', state: x.state, registeredAt: x.registeredAt, registeredOrder: x.registeredOrder || 0 });
  });
  sobrantes.sort(byTypeThenCode);

  const custodio = custodioLabel(roomId);
  lastMissingReport = { room: roomLabel(roomId), custodio, notFound, foundElsewhere, inPlaceCount, bajasCount, sobrantes, inPlace };

  if (!homeAll.length) {
    summary.textContent = 'Este ambiente no tiene bienes esperados según inventario.xlsx (si acaba de importar, espere unos segundos a que se complete el catálogo).';
  } else summary.textContent = `${custodio ? `Encargado: ${custodio}. ` : ''}${homeAssets.length} bien(es) esperado(s) en este ambiente según inventario.xlsx — ${inPlaceCount} encontrado(s) aquí, ${foundElsewhere.length} encontrado(s) en otro ambiente, ${notFound.length} sin encontrar. En total hay ${inPlaceCount + sobrantes.length} bien(es) escaneado(s) en este ambiente (${inPlaceCount} de este ambiente + ${sobrantes.length} que pertenecen a otro).`
    + (bajasCount ? ` (No se cuentan ${bajasCount} bien(es) dado(s) de baja en el Excel.)` : '')
    + (db.extraFieldsV1 || homeAll.some((x) => x.condicion !== undefined) ? '' : (extraLoadError ? ` ⚠ No se pudo leer datos-extra.json ni inventario.xlsx (${extraLoadError}): no se pueden excluir los bienes de baja ni mostrar fechas. Verifique que esos archivos estén en la carpeta data/.` : ' ⏳ Leyendo condición de los bienes… se actualizará solo.'));

  foundBody.innerHTML = foundElsewhere.map((asset, index) =>
    `<tr><td>${index + 1}</td><td>${safe(asset.code)}</td><td>${safe(asset.type)}</td><td>${safe(roomLabel(asset.roomId))}</td><td>${safe(asset.state)}</td></tr>`
  ).join('');
  foundEmpty.hidden = foundElsewhere.length > 0;

  notFoundBody.innerHTML = notFound.map((asset, index) =>
    `<tr><td>${index + 1}</td><td>${safe(asset.code)}</td><td>${safe(asset.type)}</td><td>${safe(asset.detail || '')}</td><td>${safe(asset.fechaAdq || '—')}</td></tr>`
  ).join('');
  notFoundEmpty.hidden = notFound.length > 0;

  inplaceBody.innerHTML = inPlace.map((a, index) =>
    `<tr><td>${index + 1}</td><td>${safe(a.code)}</td><td>${safe(a.type)}</td><td>${safe(a.detail || '')}</td><td>${safe(a.fechaAdq || '—')}</td><td>${safe(a.state)}</td><td>${safe(formatDateTime(a.registeredAt))}</td></tr>`
  ).join('');
  inplaceEmpty.hidden = inPlace.length > 0;

  extraBody.innerHTML = sobrantes.map((a, index) =>
    `<tr><td>${index + 1}</td><td>${safe(a.code)}</td><td>${safe(a.type)}</td><td>${safe(a.origin)}</td><td>${safe(a.fechaAdq || '—')}</td><td>${safe(a.state)}</td><td>${safe(formatDateTime(a.registeredAt))}</td></tr>`
  ).join('');
  extraEmpty.hidden = sobrantes.length > 0;
}

function exportMissingReportPdf() {
  if (!window.jspdf || !window.jspdf.jsPDF) return alert('La exportación PDF no está disponible: no cargaron las librerías (jsPDF). Revise su conexión a internet y recargue la página.');
  if (typeof window.jspdf.jsPDF.API?.autoTable !== 'function') return alert('La exportación PDF no está disponible: no cargó el complemento de tablas (autoTable). Revise su conexión a internet y recargue la página.');
  if (!lastMissingReport.room) return alert('Seleccione un ambiente antes de exportar el reporte.');

  // Formato "ámbar/alerta" con insignias de resumen: a propósito muy distinto del HUD oscuro
  // del PDF por ambiente y del formato claro/corporativo de la búsqueda global, para que cada
  // reporte se reconozca de un vistazo por su color y estructura.
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation: 'portrait' });
  const width = pdf.internal.pageSize.getWidth();
  const GOLD = [217, 158, 6]; const GOLD_DARK = [92, 66, 0]; const GREY = [110, 124, 150];
  const GREEN = [15, 130, 90]; const CYAN = [7, 137, 165]; const CYAN_SOFT = [223, 246, 251];
  const DANGER = [176, 26, 62]; const DANGER_SOFT = [253, 233, 236];

  pdf.setFillColor(...GOLD); pdf.rect(0, 0, width, 30, 'F');
  if (window.LOGO_DATA_URI) { try { pdf.addImage(window.LOGO_DATA_URI, 'PNG', 10, 5, 20, 20); } catch { /* se omite el logo si falla */ } }
  pdf.setTextColor(...GOLD_DARK); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(14);
  pdf.text('REPORTE DE BIENES FALTANTES', 34, 13);
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);
  pdf.text(`Ambiente: ${lastMissingReport.room}`, 34, 21);
  if (lastMissingReport.custodio) { pdf.setFontSize(8); pdf.text(`Encargado: ${lastMissingReport.custodio}`, 34, 26); }
  pdf.setFontSize(7.5);
  pdf.text(new Date().toLocaleDateString('es-PE', { day: '2-digit', month: 'long', year: 'numeric' }), width - 12, 12, { align: 'right' });

  // Insignias de resumen (esperados / en su lugar / en otro ambiente / sin encontrar)
  const total = lastMissingReport.inPlaceCount + lastMissingReport.foundElsewhere.length + lastMissingReport.notFound.length;
  const badges = [
    { label: 'ESPERADOS', value: total, color: [40, 50, 70] },
    { label: 'EN SU LUGAR', value: lastMissingReport.inPlaceCount, color: GREEN },
    { label: 'EN OTRO AMBIENTE', value: lastMissingReport.foundElsewhere.length, color: CYAN },
    { label: 'SIN ENCONTRAR', value: lastMissingReport.notFound.length, color: DANGER }
  ];
  const badgeGap = 4; const badgeWidth = (width - 24 - badgeGap * 3) / 4; let bx = 12; const by = 37;
  badges.forEach((badge) => {
    pdf.setFillColor(249, 250, 252); pdf.setDrawColor(224, 228, 236); pdf.setLineWidth(0.3);
    pdf.roundedRect(bx, by, badgeWidth, 20, 2, 2, 'FD');
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(14); pdf.setTextColor(...badge.color);
    pdf.text(String(badge.value), bx + badgeWidth / 2, by + 10, { align: 'center' });
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(6); pdf.setTextColor(...GREY);
    pdf.text(badge.label, bx + badgeWidth / 2, by + 16, { align: 'center' });
    bx += badgeWidth + badgeGap;
  });

  let y = by + 30;
  const section = (title, color, head, body, emptyRow, softFill) => {
    if (y > pdf.internal.pageSize.getHeight() - 40) { pdf.addPage(); y = 20; }
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10); pdf.setTextColor(...color);
    pdf.text(title, 12, y);
    pdf.autoTable({
      startY: y + 3, head: [head], body: body.length ? body : [emptyRow], theme: 'grid',
      headStyles: { fillColor: color, textColor: [255, 255, 255], fontSize: 8 },
      ...(softFill ? { alternateRowStyles: { fillColor: softFill } } : {}),
      styles: { fontSize: 7.5, cellPadding: 2.2 }
    });
    y = pdf.lastAutoTable.finalY + 12;
  };
  const r = lastMissingReport;
  section(`1. BIENES ENCONTRADOS EN ESTE AMBIENTE (${(r.inPlace || []).length})`, GREEN,
    ['Ítem', 'Código', 'Tipo de bien', 'Características', 'Fecha adq.', 'Estado', 'Registrado'],
    (r.inPlace || []).map((a, i) => [i + 1, a.code, a.type, a.detail || '', a.fechaAdq || '—', a.state, formatDateTime(a.registeredAt)]),
    ['—', 'Ninguno', '', '', '', '', ''], [232, 246, 240]);
  section(`2. BIENES FALTANTES (${r.notFound.length})`, DANGER,
    ['Ítem', 'Código', 'Tipo de bien', 'Detalle técnico', 'Fecha adquisición'],
    r.notFound.map((a, i) => [i + 1, a.code, a.type, a.detail || '', a.fechaAdq || '—']),
    ['—', 'Ninguno', '', '', ''], DANGER_SOFT);
  section(`3. ENCONTRADOS AQUÍ PERO DE OTRA ÁREA/AMBIENTE (${(r.sobrantes || []).length})`, GOLD,
    ['Ítem', 'Código', 'Tipo de bien', 'Pertenece a (Excel)', 'Fecha adq.', 'Estado', 'Registrado'],
    (r.sobrantes || []).map((a, i) => [i + 1, a.code, a.type, a.origin, a.fechaAdq || '—', a.state, formatDateTime(a.registeredAt)]),
    ['—', 'Ninguno', '', '', '', '', ''], null);
  section(`4. BIENES DE ESTE AMBIENTE ENCONTRADOS EN OTRO AMBIENTE (${r.foundElsewhere.length})`, CYAN,
    ['Ítem', 'Código', 'Tipo de bien', 'Encontrado en', 'Estado'],
    r.foundElsewhere.map((a, i) => [i + 1, a.code, a.type, roomLabel(a.roomId), a.state]),
    ['—', 'Ninguno', '', '', ''], CYAN_SOFT);

  const stampName = lastMissingReport.room.replaceAll(' ', '-').replaceAll('—', '-');
  pdf.save(`reporte-faltantes-${stampName}.pdf`);
}

// Lista de bienes registrados en el ambiente actual, en el mismo orden en que se
// muestran en la tabla (por orden de registro). La usan renderAssets() y el
// navegador ▲▼ de "bien actual", para no repetir el mismo filtro/orden dos veces.
function getRoomAssets() {
  return db.assets
    .filter((x) => x.registered && x.roomId === db.selected.roomId)
    .sort((a, b) => (a.registeredOrder || 0) - (b.registeredOrder || 0));
}

// Un bien "sin características" es el que no trae marca/modelo/color/serie ni ningún otro
// detalle técnico en el Excel (ver technicalDetail()): importRows() le deja el texto fijo
// "Sin detalle". Se detecta así en vez de con un campo aparte para no tener que migrar los
// datos ya guardados.
function isMissingDetail(asset) {
  const value = (asset.detail || '').trim();
  return !value || value === 'Sin detalle';
}

function renderAssets() {
  const assets = getRoomAssets();
  $('inventory-body').innerHTML = assets.map((asset, index) => {
    const mismatch = asset.areaMismatch;
    const duplicateElsewhere = otherActiveLocations(asset);
    const origin = registeredLocation(asset);
    const missingDetail = isMissingDetail(asset);
    const rowClasses = [
      (mismatch || duplicateElsewhere.length) ? 'mismatch-row' : '',
      missingDetail ? 'missing-detail-row' : '',
    ].filter(Boolean).join(' ');
    const flagIcons = `${mismatch ? ' ⚠' : ''}${duplicateElsewhere.length ? ' 🔁' : ''}`;
    const duplicateNote = duplicateElsewhere.length
      ? `<br><span class="dup-note">🔁 También registrado en «${duplicateElsewhere.map(safe).join('», «')}»</span>`
      : '';
    const detailValue = missingDetail ? '' : asset.detail;
    const detailCell = `<input type="text" class="detail-input${missingDetail ? ' detail-missing' : ''}" maxlength="200" placeholder="⚠ Falta: marca, modelo, color, serie…" data-detail-id="${safe(asset.id)}" value="${safe(detailValue)}" />`;
    return `<tr class="${rowClasses}" data-asset-row="${safe(asset.id)}"><td>${index + 1}</td><td>${safe(asset.code)}</td><td>${safe(asset.type)}</td><td>${detailCell}</td><td>${safe(origin)}${flagIcons}${duplicateNote}</td><td><select data-asset-id="${safe(asset.id)}">${states.map((state) => `<option ${state === asset.state ? 'selected' : ''}>${state}</option>`).join('')}</select></td><td><input type="text" class="comment-input" maxlength="200" placeholder="Añadir comentario…" data-comment-id="${safe(asset.id)}" value="${safe(asset.comment)}" /></td><td><button class="button delete-button" data-delete-asset-id="${safe(asset.id)}" type="button">Eliminar</button></td></tr>`;
  }).join('');
  $('empty-message').hidden = assets.length > 0;
  renderRoomComment();
  updateRowNavigator();
}

// === "📝 Comentarios y características" (GLOBAL) =====================================
// Vista de TODO el inventario (todos los locales, áreas y ambientes): lista los bienes ya
// registrados que tienen un comentario y/o las características completadas, con su
// ubicación "Local — Área — Ambiente", y arriba las observaciones generales de cada
// ambiente. Todo lo que aparece ya está inventariado, por eso lleva el sello ✅.
function renderNotesDialog() {
  const q = ($('notes-filter').value || '').trim().toLowerCase();
  const matches = (text) => !q || text.toLowerCase().includes(q);

  const all = db.assets
    .filter((asset) => asset.registered && roomIdVisible(asset.roomId) && ((asset.comment && asset.comment.trim()) || !isMissingDetail(asset)))
    .map((asset) => ({ asset, place: roomLabel(asset.roomId) }))
    .sort((a, b) => a.place.localeCompare(b.place, 'es') || (a.asset.registeredOrder || 0) - (b.asset.registeredOrder || 0));
  const rows = all.filter(({ asset, place }) => matches([asset.code, asset.type, place, isMissingDetail(asset) ? '' : asset.detail, asset.comment || ''].join(' ')));

  const roomNotes = Object.entries(db.roomComments || {})
    .filter(([roomId, text]) => text && text.trim() && roomIdVisible(roomId))
    .map(([roomId, text]) => ({ place: roomLabel(roomId), text }))
    .filter((n) => matches(`${n.place} ${n.text}`))
    .sort((a, b) => a.place.localeCompare(b.place, 'es'));

  $('notes-rooms').innerHTML = roomNotes.length
    ? '<p class="field-label">💬 Observaciones generales por ambiente</p>'
      + roomNotes.map((n) => `<div class="room-comment-banner"><span class="room-comment-icon">💬</span><p class="room-comment-text"><strong>${safe(n.place)}</strong><br>${safe(n.text)}</p></div>`).join('')
    : '';

  $('notes-body').innerHTML = rows.map(({ asset, place }, index) => {
    const hasDetail = !isMissingDetail(asset);
    return `<tr><td>${index + 1}</td><td>${safe(asset.code)}</td><td>${safe(asset.type)}</td>`
      + `<td>✅ ${safe(place)}</td>`
      + `<td>${hasDetail ? safe(asset.detail) : '—'}</td>`
      + `<td>${safe(asset.comment || '') || '—'}</td></tr>`;
  }).join('');
  $('notes-count').textContent = `${rows.length} bien(es) con comentario o características` + (q ? ` (de ${all.length} en total)` : '') + ` · ${roomNotes.length} observación(es) de ambiente`;
  $('notes-empty-message').hidden = rows.length > 0 || roomNotes.length > 0;
}

// === Navegador de "bien actual" (▲▼) para pegar stickers =========================
// Marca con un color distinto ("current-row") la fila en la que se quedó la persona
// que va pegando los stickers, con dos botones para pasar a la fila anterior/siguiente
// y scroll automático hasta ella. Es TOTALMENTE independiente de la sesión de escaneo:
// no toca session, scanner ni scan-card, así que jamás puede "apagar" la cámara ni
// hacer desaparecer el botón de escaneo — solo resalta filas de la tabla y mueve el
// scroll. Por eso vive fuera de registerCode()/toggleCamera() y no comparte funciones
// con ellos.
let currentRowAssetId = null;
function updateRowNavigator() {
  const assets = getRoomAssets();
  const nav = $('row-navigator');
  document.querySelectorAll('#inventory-body tr.current-row').forEach((row) => row.classList.remove('current-row'));
  if (!assets.length) { nav.hidden = true; currentRowAssetId = null; return; }
  nav.hidden = false;
  let index = assets.findIndex((x) => x.id === currentRowAssetId);
  if (index === -1) { index = 0; currentRowAssetId = assets[0].id; }
  $('row-nav-counter').textContent = `${index + 1} / ${assets.length}`;
  $('row-nav-up').disabled = index === 0;
  $('row-nav-down').disabled = index === assets.length - 1;
  const row = document.querySelector(`[data-asset-row="${currentRowAssetId}"]`);
  if (row) row.classList.add('current-row');
}
function goToRow(delta) {
  const assets = getRoomAssets();
  if (!assets.length) return;
  let index = assets.findIndex((x) => x.id === currentRowAssetId);
  if (index === -1) index = 0;
  index = Math.max(0, Math.min(assets.length - 1, index + delta));
  currentRowAssetId = assets[index].id;
  updateRowNavigator();
  const row = document.querySelector(`[data-asset-row="${currentRowAssetId}"]`);
  if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // Si por lo que sea el foco terminó en uno de los botones ▲▼ (o en ningún lado), se
  // devuelve al campo de código — así un lector físico tipo "pistola" (que escribe donde
  // esté el foco) puede seguir escaneando sin que haya que tocar el campo de nuevo. Con la
  // cámara abierta esto no hace falta (no usa el foco), así que no se toca en ese caso.
  const active = document.activeElement;
  if (!scanner && (active === $('row-nav-up') || active === $('row-nav-down') || active === document.body)) {
    focusKeepScroll($('code-input'));
  }
}

// Evita que un botón se quede con el foco del teclado al tocarlo/hacerle clic — se usa en
// los botones ▲▼ para que NUNCA le quiten el foco al campo de código mientras se navega la
// tabla, ni siquiera por un instante. Sin esto, en muchos navegadores un simple tap sobre el
// botón ya movía el foco (y con él, a veces, el teclado en pantalla), obligando a tocar de
// nuevo el campo de código para poder seguir escaneando.
function preserveFocusOnPress(el) {
  el.addEventListener('pointerdown', (e) => e.preventDefault());
  el.addEventListener('mousedown', (e) => e.preventDefault());
}

// Muestra (o esconde) el banner de "Observaciones generales" del ambiente seleccionado, y ajusta el texto del botón.
function renderRoomComment() {
  const comment = (db.roomComments && db.roomComments[db.selected.roomId]) || '';
  const banner = $('room-comment-banner');
  banner.hidden = !comment;
  $('room-comment-text').textContent = comment;
  $('comment-button').textContent = comment ? '💬 Editar comentario' : '💬 Añadir comentario';
}

// Resalta en la tabla las filas de los bienes encontrados por la búsqueda de 4 dígitos y hace scroll hasta la primera.
// También mueve ahí el navegador ▲▼ de "bien actual", para que tras ubicar un código con la
// búsqueda se pueda seguir avanzando fila por fila con los botones sin tener que tipear de nuevo.
function highlightAssetRows(assetIds) {
  document.querySelectorAll('[data-asset-row].highlight-row').forEach((row) => row.classList.remove('highlight-row'));
  let first = null;
  assetIds.forEach((id) => {
    const row = document.querySelector(`[data-asset-row="${id}"]`);
    if (!row) return;
    row.classList.add('highlight-row');
    if (!first) first = row;
  });
  if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (assetIds.length) { currentRowAssetId = assetIds[0]; updateRowNavigator(); }
}
function moveRoom(direction) {
  const rooms = visibleRooms().filter((x) => x.areaId === db.selected.areaId).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  if (!rooms.length) return;
  const index = rooms.findIndex((x) => x.id === db.selected.roomId);
  db.selected.roomId = rooms[(index + direction + rooms.length) % rooms.length].id;
  renderSelectors(); switchRoomSession();
}
async function registerCode(code) {
  code = code.trim();
  if (!code) return setMessage(session.mode === 'buscar4' ? 'Digite los últimos 4 dígitos del código.' : 'Digite o escanee un código patrimonial.', true);

  // MODO BUSCAR 4 DÍGITOS: busca solo entre los bienes YA REGISTRADOS en este ambiente (no registra nada).
  if (session.mode === 'buscar4') {
    const suffix = code.toLowerCase();
    const registeredHere = db.assets
      .filter((x) => x.registered && x.roomId === db.selected.roomId)
      .sort((a, b) => (a.registeredOrder || 0) - (b.registeredOrder || 0));
    const matches = registeredHere
      .map((asset, idx) => ({ asset, item: idx + 1 }))
      .filter((x) => x.asset.code.toLowerCase().endsWith(suffix));
    if (!matches.length) {
      showScanResult({ title: `❌ Ningún bien registrado aquí termina en "${code}".`, location: '', error: true });
    } else {
      const rowsHtml = matches.slice(0, 25).map(({ asset, item }) => {
        const location = registeredLocation(asset);
        return `<div class="search-hit"><strong>Ítem ${item}</strong> — <strong>${safe(asset.code)}</strong> · ${safe(asset.type)}<br>📍 ${safe(location)} · Estado: ${safe(asset.state)}</div>`;
      }).join('');
      const extra = matches.length > 25 ? `<div class="search-hit">…y ${matches.length - 25} más. Escriba más dígitos para acotar la búsqueda.</div>` : '';
      showScanResult({ title: `🔎 ${matches.length} coincidencia(s) para "${code}"`, html: rowsHtml + extra });
      highlightAssetRows(matches.map((x) => x.asset.id));
    }
    $('code-input').value = '';
    afterScanUI();
    return;
  }

  // Puede haber más de un registro con el mismo código: el original del Excel y, si se
  // encontró en más de un ambiente, una copia por cada ambiente donde se escaneó (ver abajo).
  const candidates = db.assets.filter((x) => x.code.toLowerCase() === code.toLowerCase());
  if (!candidates.length) return setMessage(`El código ${code} no está registrado.`, true);

  // MODO CONSULTA: solo muestra información, no registra ni mueve el bien.
  // Muestra todo lo necesario: ubicación, encargado, fecha de adquisición, características,
  // condición (activo/baja), grupo, y cuándo y quién lo inventarió.
  if (session.mode === 'consulta') {
    const activeCopies = candidates.filter((x) => x.registered);
    const base = activeCopies[0] || candidates[0];
    const original = candidates.find((x) => !x.isDuplicateClone) || base;
    const src = original.sourceData || base.sourceData || null;
    const fromSrc = (names) => (src ? valueFrom(src, names) : '');
    const fechaAdq = original.fechaAdq || base.fechaAdq || fromSrc(['fechaadquisicion']);
    const docAdq = original.docAdq || base.docAdq || fromSrc(['nrodocadquisicion']);
    const condRaw = String(original.condicion || base.condicion || fromSrc(['condicion'])).toUpperCase();
    const nroBaja = original.nroBaja || base.nroBaja || fromSrc(['nroresolucionbaja']);
    const encargado = original.encargadoExcel || base.encargadoExcel
      || (original.homeRoomId ? custodioLabel(original.homeRoomId) : '')
      || (src ? [fromSrc(['apellidopaterno']), fromSrc(['apellidomaterno']), fromSrc(['nombres'])].filter(Boolean).join(' ') : '');
    const excelPlace = (original.homeRoomId && roomLabel(original.homeRoomId) !== 'ambiente desconocido')
      ? roomLabel(original.homeRoomId)
      : ([base.sourceArea, base.sourceRoom].filter(Boolean).join(' — ') || 'Sin ubicación en el Excel');
    const caract = base.detail && base.detail !== 'Sin detalle' ? base.detail : '—';
    const line = (icon, label, value) => `<div class="search-hit">${icon} <strong>${label}:</strong> ${safe(value || '—')}</div>`;

    let html = '';
    html += line('📅', 'Fecha de adquisición', fechaAdq + (docAdq ? ` (Doc. adquisición: ${docAdq})` : ''));
    html += line('🧾', 'Características', caract);
    html += line('👤', 'Encargado (según inventario.xlsx)', encargado);
    html += line('🏢', 'Ubicación en el Excel', excelPlace);
    html += line('📦', 'Condición', condRaw === 'B' ? `DADO DE BAJA${nroBaja ? ` — ${nroBaja}` : ''}` : (condRaw === 'A' ? 'Activo' : '—'));
    if (base.grupo) html += line('👥', 'Grupo responsable', base.grupo);
    if (activeCopies.length) {
      html += activeCopies.map((x) =>
        `<div class="search-hit">📍 <strong>Inventariado en:</strong> ${safe(roomLabel(x.roomId))} · Estado: ${safe(x.state)}`
        + `<br>🕒 Registrado: ${safe(formatDateTime(x.registeredAt))}${x.encargados ? ` · Inventariador: ${safe(x.encargados)}` : ''}`
        + `${x.comment ? `<br>💬 ${safe(x.comment)}` : ''}</div>`).join('');
    } else {
      html += `<div class="search-hit">📍 <strong>Aún no registrado</strong> en ningún ambiente · Estado: ${safe(base.state)}</div>`;
    }
    showScanResult({
      title: `🔍 ${base.code} · ${base.type}${activeCopies.length > 1 ? ` — registrado en ${activeCopies.length} ambientes` : ''}`,
      html
    });
    $('code-input').value = '';
    afterScanUI();
    return;
  }

  const currentArea = selectedArea()?.name || '';

  // Bien correspondiente a ESTE ambiente: si ya hay un registro (activo o no) apuntando a este
  // ambiente lo reutilizamos; si no existe, se crea uno nuevo aquí abajo.
  let asset = candidates.find((x) => x.roomId === db.selected.roomId);
  let isNewDuplicateCopy = false;
  let duplicateOrigin = null;

  if (!asset) {
    const activeElsewhere = candidates.find((x) => x.registered);
    if (activeElsewhere) {
      // DUPLICADO EN OTRO AMBIENTE: el bien ya está activo (sin finalizar) en otro ambiente.
      // En vez de moverlo (lo que lo borraría de allá), se crea una COPIA independiente para
      // este ambiente. Así queda registrado en los dos sitios y se puede ubicar cada uno.
      duplicateOrigin = roomLabel(activeElsewhere.roomId);
      asset = {
        id: uid(), code: activeElsewhere.code, type: activeElsewhere.type, detail: activeElsewhere.detail,
        sourceArea: activeElsewhere.sourceArea, sourceRoom: activeElsewhere.sourceRoom,
        grupo: activeElsewhere.grupo, sourceData: activeElsewhere.sourceData, fromExcel: activeElsewhere.fromExcel,
        fechaAdq: activeElsewhere.fechaAdq, docAdq: activeElsewhere.docAdq, condicion: activeElsewhere.condicion,
        nroBaja: activeElsewhere.nroBaja, encargadoExcel: activeElsewhere.encargadoExcel,
        state: activeElsewhere.state || 'Bueno', roomId: null, registered: false, isDuplicateClone: true
      };
      db.assets.push(asset);
      isNewDuplicateCopy = true;
    } else {
      asset = candidates[0];
    }
  }

  // ¿Este código YA estaba registrado (activo) en ESTE MISMO ambiente? Se calcula antes de
  // tocar nada del bien: si es así, NO se vuelve a registrar ni se pisan su estado, encargado(s)
  // u orden — solo se muestra una alerta para avisar del doble escaneo. Antes esto "actualizaba"
  // el registro en silencio, lo que podía sobrescribir cambios hechos a mano sin que se note.
  const alreadyHere = Boolean(!isNewDuplicateCopy && asset.registered && asset.roomId === db.selected.roomId);

  if (alreadyHere) {
    const origin = registeredLocation(asset);
    showScanResult({
      title: `⚠️ Alerta: ${asset.code} · ${asset.type} ya está registrado en este ambiente (no se volvió a registrar).`,
      location: `📍 Ubicación registrada: ${origin}`,
      error: true
    });
    $('code-input').value = '';
    afterScanUI();
    return;
  }

  asset.areaMismatch = Boolean(
    asset.sourceArea && header(asset.sourceArea) !== header(currentArea)
  );

  asset.roomId = db.selected.roomId;
  asset.registered = true;
  db.scanCounter = (db.scanCounter || 0) + 1;
  asset.registeredOrder = db.scanCounter;
  asset.registeredAt = Date.now();

  if (session.active) {
    asset.encargados = session.encargados;
  }

  // GUARDAR PRIMERO
  await save();

  // DESPUÉS MOSTRARLO EN LA TABLA
  renderAssets();

  const alerts = [];

  if (asset.areaMismatch) {
    const fullOrigin = [asset.sourceArea, asset.sourceRoom]
      .filter(Boolean)
      .join(' — ');

    alerts.push(`es de otra área: ${fullOrigin || asset.sourceArea}`);
  }

  if (duplicateOrigin) {
    alerts.push(`DUPLICADO: también está registrado en «${duplicateOrigin}» (se dejó en ambos ambientes)`);
  }

  if (isMissingDetail(asset)) {
    alerts.push('le faltan las características (marca, modelo, color, serie) — complételas en la columna "Características" de la tabla');
  }

  // Mismo valor que aparece en la columna "Ubicación registrada" de la tabla,
  // para que el mensaje de confirmación nunca contradiga lo que queda registrado.
  const origin = registeredLocation(asset);

  if (alerts.length) {
    showScanResult({ title: `⚠️ Alerta: ${asset.code} ${alerts.join(', ')}.`, location: `📍 Ubicación registrada: ${origin}`, error: true });
  } else {
    showScanResult({ title: `✅ ${asset.code} · ${asset.type} registrado correctamente.`, location: `📍 Ubicación registrada: ${origin}` });
  }

  $('code-input').value = '';
  afterScanUI();
}

// La cámara ahora permanece ABIERTA entre lecturas (antes se cerraba sola tras cada
// escaneo, lo que colapsaba el recuadro de video y hacía "saltar" la pantalla). Para no
// registrar el mismo código varias veces por segundo mientras la cámara lo sigue viendo,
// se ignora una relectura del mismo código dentro de este margen de tiempo.
const CAMERA_REPEAT_COOLDOWN_MS = 2500;

// Índice de códigos del catálogo (solo dígitos -> código real) para la lectura inteligente (OCR):
// un número leído por IA solo se acepta si existe en el inventario.
let codeIndexCache = { n: -1, map: null };
function codeIndex() {
  if (codeIndexCache.map && codeIndexCache.n === db.assets.length) return codeIndexCache.map;
  const map = new Map();
  for (const a of db.assets) { if (!a.isDuplicateClone) map.set(String(a.code).replace(/\D/g, ''), a.code); }
  codeIndexCache = { n: db.assets.length, map };
  return map;
}
const digitsOf = (v) => String(v ?? '').replace(/\D/g, '');
// Formato del código patrimonial: 8 dígitos, guion y 4 dígitos (ej. 53224722-0002).
const fmtCode = (d) => `${d.slice(0, 8)}-${d.slice(8)}`;
// Si lo leído o digitado coincide con un código del catálogo, se usa el código tal como está en el catálogo.
// Si son 12 dígitos que no están en el catálogo, se escriben en el formato 8-4.
function normalizeCode(v) {
  const d = digitsOf(v);
  if (d.length >= 8) { const hit = codeIndex().get(d); if (hit) return hit; }
  if (d.length === 12 && !/[A-Za-z]/.test(String(v))) return fmtCode(d);
  return v;
}
// Posibles códigos dentro de un texto leído por OCR:
//  - strong: coinciden con el formato exacto 8 dígitos + guion + 4 dígitos (el más confiable)
//  - all: además, cualquier secuencia de 12 dígitos (con dígitos sobrantes pegados, partida en líneas, etc.)
function candidates12(raw) {
  const text = String(raw);
  const strong = [], all = [];
  const add = (list, d) => { if (!list.includes(d)) list.push(d); };
  for (const m of text.matchAll(/(\d{8})\s*[-–—_.:]\s*(\d{4})/g)) { add(strong, m[1] + m[2]); add(all, m[1] + m[2]); }
  const lines = text.split(/\n+/).map(digitsOf).filter((x) => x.length >= 3);
  const windows = (d) => { for (let i = 0; i + 12 <= d.length; i++) add(all, d.slice(i, i + 12)); };
  lines.forEach(windows);
  for (let i = 0; i < lines.length; i++) {
    let acc = '';
    for (let j = i; j < lines.length && acc.length < 12; j++) { acc += lines[j]; if (acc.length >= 12) windows(acc); }
  }
  const joined = lines.join(''); if (joined.length <= 40) windows(joined);
  return { strong, all: all.slice(0, 60) };
}
// Códigos del catálogo que difieren de `d` en exactamente `maxErr` dígitos (1 o 2).
function nearCodes(d, idx, maxErr) {
  const hits = new Set();
  const swap = (s, i, k) => s.slice(0, i) + k + s.slice(i + 1);
  for (let i = 0; i < 12; i++) for (let k = 0; k < 10; k++) {
    if (String(k) === d[i]) continue;
    const s1 = swap(d, i, k);
    if (maxErr === 1) { const h = idx.get(s1); if (h) hits.add(h); continue; }
    for (let j = i + 1; j < 12; j++) for (let m = 0; m < 10; m++) {
      if (String(m) === d[j]) continue;
      const h = idx.get(swap(s1, j, m)); if (h) hits.add(h);
    }
  }
  return hits;
}
function matchCodeFromText(raw) {
  const idx = codeIndex(), { strong, all } = candidates12(raw);
  for (const d of all) { const hit = idx.get(d); if (hit) return { code: hit, exact: true }; }
  // dígitos mal leídos (el OCR confunde 1/7, 4/8, 5/6, 0/9...): se propone el ÚNICO código parecido del catálogo,
  // primero con 1 dígito de diferencia y luego con 2. Siempre queda como sugerencia: la persona lo confirma.
  const cands = all.slice(0, 6);
  for (const maxErr of [1, 2]) {
    for (const d of cands) {
      const hits = nearCodes(d, idx, maxErr);
      if (hits.size === 1) return { code: [...hits][0], exact: false };
    }
  }
  // número con el formato exacto 8-4 que no figura en el catálogo: se muestra para confirmar
  if (strong.length) return { code: fmtCode(strong[0]), exact: false };
  return null;
}
function closeCameraUI() {
  scanner = null;
  $('reader').hidden = true; $('reader-tools').hidden = true;
  $('camera-button').textContent = 'Abrir cámara';
}
async function toggleCamera() {
  const btn = $('camera-button');
  if (scanner) { await window.Escaner.stop(); closeCameraUI(); return; }
  if (!window.Html5Qrcode || !window.Escaner) return setMessage('El lector de cámara aún no está disponible. Use digitación manual.', true);
  $('reader').hidden = false; $('reader-tools').hidden = false; scanner = window.Escaner;
  $('torch-button').hidden = true; $('zoom-range').hidden = true; $('torch-button').classList.remove('on');
  try {
    await window.Escaner.start({
      elementId: 'reader', cooldown: CAMERA_REPEAT_COOLDOWN_MS, match: matchCodeFromText,
      onCode: (code, source) => {
        if (source === 'ocr-suggest') {
          $('code-input').value = code;
          setMessage(codeIndex().has(digitsOf(code)) ? `🤖 Posible código leído por IA: ${code}. Verifíquelo y pulse Registrar.` : `🤖 Número leído: ${code} (no figura en el catálogo). Verifíquelo y pulse Registrar.`);
          return;
        }
        if (source === 'ocr') setMessage(`🤖 Código reconocido por IA: ${code}`);
        registerCode(normalizeCode(code));
      },
      onStatus: (t) => { $('reader-status').textContent = t || ''; },
      onReady: (c) => {
        $('torch-button').hidden = !c.torch;
        const z = $('zoom-range'); z.hidden = !c.zoom;
        if (c.zoom) { z.min = c.zoom.min; z.max = Math.min(c.zoom.max, c.zoom.min + 4); z.step = c.zoom.step; z.value = c.zoom.min; }
      },
      onStop: (msg) => { closeCameraUI(); if (msg) setMessage(msg, true); }
    });
    btn.textContent = 'Cerrar cámara';
  } catch { closeCameraUI(); setMessage('No se pudo abrir la cámara. Revise el permiso o digite el código.', true); }
}
$('torch-button').onclick = async (e) => {
  const on = !e.currentTarget.classList.contains('on');
  if (await window.Escaner.setTorch(on)) e.currentTarget.classList.toggle('on', on);
};
$('zoom-range').oninput = (e) => window.Escaner.setZoom(e.target.value);
$('ocr-button').onclick = () => window.Escaner.readNow();
// === Respaldo completo (mover datos a otro navegador/dispositivo) ===================
// Distinto de los botones "Excel"/"PDF" de más abajo: aquellos solo son para LEER lo
// registrado en el ambiente actual (no se pueden volver a cargar en la app). Este respaldo
// en cambio guarda TODO (locales, áreas, ambientes, bienes registrados y sin registrar,
// comentarios) en un .json que sí se puede volver a importar, en este navegador o en otro.
const BACKUP_VERSION = 1;
function exportBackup() {
  const payload = { backupVersion: BACKUP_VERSION, exportedAt: new Date().toISOString(), db };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.href = url; a.download = `respaldo-inventario-${stamp}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  const total = db.assets.filter((x) => x.registered).length;
  setSessionMessage(`📤 Respaldo exportado: ${total} bien(es) registrados y toda la estructura de locales/áreas/ambientes. Guarda ese archivo (nube, USB, etc.) para poder importarlo luego.`);
}
function isValidBackup(data) {
  return Boolean(data && Array.isArray(data.locals) && Array.isArray(data.areas) && Array.isArray(data.rooms) && Array.isArray(data.assets));
}
// Combina un respaldo con lo que ya hay en este navegador, sin borrar nada. Como cada
// dispositivo genera sus propios IDs internos para local/área/ambiente, primero se
// empareja cada uno del respaldo con su equivalente aquí por NOMBRE (usando header(), la
// misma normalización que ya usa el resto de la app contra tildes/mayúsculas/espacios); si
// no existe, se crea. Con ese mapa de "id del respaldo -> id de aquí" se traen los bienes:
// - Bien nuevo (código que no existía aquí): se agrega tal cual.
// - Bien que aquí no estaba registrado pero en el respaldo sí: se adopta ese registro.
// - Bien registrado en AMBOS pero en ambientes distintos: no se pisa ninguno de los dos, se
//   agrega como copia/duplicado (igual que cuando alguien escanea el mismo código en más de
//   un ambiente), para no perder ninguna de las dos ubicaciones.
// - Todo lo demás (mismo bien, mismo ambiente en ambos lados) se deja como está.
function mergeIncomingBackup(incoming) {
  const localIdMap = new Map();
  incoming.locals.forEach((oldLocal) => {
    let local = db.locals.find((l) => header(l.name) === header(oldLocal.name));
    if (!local) { local = { id: uid(), name: oldLocal.name }; db.locals.push(local); }
    localIdMap.set(oldLocal.id, local.id);
  });

  const areaIdMap = new Map();
  incoming.areas.forEach((oldArea) => {
    const newLocalId = localIdMap.get(oldArea.localId);
    let area = db.areas.find((a) => a.localId === newLocalId && header(a.name) === header(oldArea.name));
    if (!area) { area = { id: uid(), localId: newLocalId, name: oldArea.name }; db.areas.push(area); }
    areaIdMap.set(oldArea.id, area.id);
  });

  const roomIdMap = new Map();
  incoming.rooms.forEach((oldRoom) => {
    const newAreaId = areaIdMap.get(oldRoom.areaId);
    let room = db.rooms.find((r) => r.areaId === newAreaId && header(r.name) === header(oldRoom.name));
    if (!room) { room = { id: uid(), areaId: newAreaId, name: oldRoom.name }; db.rooms.push(room); }
    roomIdMap.set(oldRoom.id, room.id);
  });

  const byCode = new Map();
  db.assets.forEach((a) => {
    const key = a.code.toLowerCase();
    if (!byCode.has(key)) byCode.set(key, []);
    byCode.get(key).push(a);
  });
  const indexAsset = (key, asset) => { if (!byCode.has(key)) byCode.set(key, []); byCode.get(key).push(asset); };

  let added = 0, updated = 0, keptDuplicates = 0;
  incoming.assets.forEach((oldAsset) => {
    const key = oldAsset.code.toLowerCase();
    const remappedRoomId = oldAsset.roomId ? (roomIdMap.get(oldAsset.roomId) || null) : null;
    const remappedHomeRoomId = oldAsset.homeRoomId ? (roomIdMap.get(oldAsset.homeRoomId) || null) : null;
    const copies = byCode.get(key) || [];

    if (!oldAsset.isDuplicateClone) {
      const original = copies.find((a) => !a.isDuplicateClone);
      if (!original) {
        const created = { ...oldAsset, id: uid(), roomId: remappedRoomId, homeRoomId: remappedHomeRoomId };
        db.assets.push(created); indexAsset(key, created); added++;
        return;
      }
      if (!original.homeRoomId && remappedHomeRoomId) original.homeRoomId = remappedHomeRoomId;
      if (!oldAsset.registered || !remappedRoomId) return;
      if (!original.registered) {
        Object.assign(original, {
          roomId: remappedRoomId, registered: true, state: oldAsset.state, areaMismatch: oldAsset.areaMismatch,
          comment: oldAsset.comment, encargados: oldAsset.encargados, registeredAt: oldAsset.registeredAt,
          registeredOrder: (db.scanCounter = (db.scanCounter || 0) + 1)
        });
        updated++;
      } else if (original.roomId !== remappedRoomId && remappedRoomId && !copies.some((a) => a.registered && a.roomId === remappedRoomId)) {
        const dup = {
          id: uid(), code: oldAsset.code, type: oldAsset.type, detail: oldAsset.detail,
          sourceArea: oldAsset.sourceArea, sourceRoom: oldAsset.sourceRoom, grupo: oldAsset.grupo,
          sourceData: oldAsset.sourceData, fromExcel: oldAsset.fromExcel, state: oldAsset.state,
          comment: oldAsset.comment, encargados: oldAsset.encargados, registeredAt: oldAsset.registeredAt,
          roomId: remappedRoomId, registered: true, isDuplicateClone: true,
          registeredOrder: (db.scanCounter = (db.scanCounter || 0) + 1)
        };
        db.assets.push(dup); indexAsset(key, dup); keptDuplicates++;
      }
    } else if (remappedRoomId && oldAsset.registered) {
      // Copia por duplicado del respaldo. ANTES se descartaba si algún registro local tenía ese
      // ambiente en roomId, pero un bien SIN escanear conserva su ambiente de origen en roomId:
      // así se perdían los bienes escaneados en su propio ambiente de origen (y seguían como
      // faltantes). Ahora solo cuenta lo que realmente está registrado allí.
      const localOriginal = copies.find((a) => !a.isDuplicateClone);
      if (localOriginal && !localOriginal.registered) {
        Object.assign(localOriginal, {
          roomId: remappedRoomId, registered: true, state: oldAsset.state, areaMismatch: oldAsset.areaMismatch,
          comment: oldAsset.comment, encargados: oldAsset.encargados, registeredAt: oldAsset.registeredAt,
          registeredOrder: (db.scanCounter = (db.scanCounter || 0) + 1)
        });
        updated++;
      } else if (!copies.some((a) => a.registered && a.roomId === remappedRoomId)) {
        const dup = { ...oldAsset, id: uid(), roomId: remappedRoomId, homeRoomId: undefined };
        db.assets.push(dup); indexAsset(key, dup); keptDuplicates++;
      }
    }
  });

  return { added, updated, keptDuplicates };
}
// Después de importar un respaldo (reemplazo o combinación): completa el catálogo del Excel si
// faltó, rellena condición/fecha/encargado (para excluir bienes de baja de los faltantes) y
// recalcula el ambiente "oficial" (homeRoomId). Sin esto el reporte de faltantes seguía
// mostrando como faltantes bienes que sí estaban en el respaldo o que ya eran de baja.
async function refreshAfterImport() {
  await loadProjectInventory();
  await restoreSourceAreas();
  migrateHomeRoomIds();
  await save();
  renderSelectors();
  if ($('missing-dialog')?.open) runMissingReport();
}
async function importBackupFile(file) {
  let payload;
  try { payload = JSON.parse(await file.text()); }
  catch { return setSessionMessage('⚠ El archivo elegido no es un respaldo válido (no es un JSON legible).'); }
  const incoming = isValidBackup(payload?.db) ? payload.db : payload;
  if (!isValidBackup(incoming)) return setSessionMessage('⚠ El archivo elegido no tiene el formato de un respaldo de esta app.');
  const registeredCount = incoming.assets.filter((x) => x.registered).length;
  const currentCount = db.assets.filter((x) => x.registered).length;
  const replaceAll = $('import-replace-checkbox')?.checked;

  if (replaceAll) {
    const proceed = confirm(
      `Este respaldo trae ${registeredCount} bien(es) registrados en ${incoming.rooms.length} ambiente(s).\n\n` +
      `Esto REEMPLAZARÁ todos los datos que hay ahora mismo en este navegador (actualmente tiene ${currentCount} bien(es) registrados). Se perderá lo que no esté en el respaldo.\n\n` +
      `¿Continuar con la importación?`
    );
    if (!proceed) return;
    db = migrateHierarchy(incoming);
    if (typeof db.scanCounter !== 'number') db.scanCounter = 0;
    if (typeof db.inventariador !== 'string') db.inventariador = '';
    await save();
    resetSession();
    renderInventariador();
    renderSelectors();
    // El respaldo de otra máquina puede no traer el resumen de encargados: se vuelve a armar
    // del inventario.xlsx (y si ya venía, loadCustodios() solo lo pinta y sale).
    loadCustodios();
    await refreshAfterImport();
    setSessionMessage(`✅ Respaldo importado (reemplazo total): ${registeredCount} bien(es) registrados restaurados en este navegador.`);
    return;
  }

  const proceed = confirm(
    `Este respaldo trae ${registeredCount} bien(es) registrados en ${incoming.rooms.length} ambiente(s).\n\n` +
    `Se COMBINARÁ con lo que ya hay en este navegador (actualmente tiene ${currentCount} bien(es) registrados): no se borra nada, solo se agrega o completa lo que falte.\n\n` +
    `¿Continuar con la importación?`
  );
  if (!proceed) return;
  const stats = mergeIncomingBackup(migrateHierarchy(incoming));
  if (typeof db.scanCounter !== 'number') db.scanCounter = 0;
  migrateHomeRoomIds();
  await save();
  resetSession();
  renderInventariador();
  renderSelectors();
  loadCustodios();
  await refreshAfterImport();
  setSessionMessage(
    `✅ Respaldo combinado: ${stats.added} bien(es) nuevo(s), ${stats.updated} adoptado(s) de otro dispositivo, ` +
    `${stats.keptDuplicates} copia(s) por estar en más de un ambiente. Total ahora: ${db.assets.filter((x) => x.registered).length} registrados.`
  );
}

function exportRows() {
  return db.assets
    .filter((x) => x.registered && x.roomId === db.selected.roomId)
    .sort((a, b) => (a.registeredOrder || 0) - (b.registeredOrder || 0))
    .map((x, i) => ({
    'Ítem': i + 1, 'Código patrimonial': x.code, 'Tipo de bien': x.type, 'Detalle técnico': x.detail,
    'Ubicación registrada': x.areaMismatch
      ? ([x.sourceArea, x.sourceRoom].filter(Boolean).join(' — ') || x.sourceRoom || '')
      : (x.sourceRoom || selectedRoom()?.name || ''),
    // Dos personas distintas, en dos columnas distintas: quien registró el bien y quien
    // responde por él según el inventario.xlsx. Antes se mezclaban en "Encargado(s)".
    Estado: x.state, 'Inventariador': x.encargados || session.encargados || db.inventariador || '',
    'Encargado del ambiente': custodioLabel(),
    Comentario: x.comment || '',
    Alerta: [
      x.areaMismatch ? `Bien de otra área: ${[x.sourceArea, x.sourceRoom].filter(Boolean).join(' — ')}` : '',
      (() => { const others = otherActiveLocations(x); return others.length ? `Duplicado, también en: ${others.join(' | ')}` : ''; })()
    ].filter(Boolean).join(' | '),
    ...(x.sourceData || {})
  }));
}
function exportExcel() {
  if (!window.XLSX) return setMessage('La exportación Excel no está disponible.', true);
  const rows = exportRows();
  if (!rows.length) return setMessage('No hay bienes escaneados para exportar.', true);
  const sheet = XLSX.utils.json_to_sheet(rows); const book = XLSX.utils.book_new();
  sheet['!cols'] = [{ wch: 8 }, { wch: 22 }, { wch: 30 }, { wch: 46 }, { wch: 30 }, { wch: 12 }, { wch: 26 }, { wch: 30 }, { wch: 30 }, { wch: 34 }];
  sheet['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(Object.keys(rows[0]).length - 1)}${rows.length + 1}` };
  Object.keys(rows[0]).forEach((_, index) => { const cell = sheet[XLSX.utils.encode_cell({ r: 0, c: index })]; if (cell) cell.s = { fill: { fgColor: { rgb: '0B5CAB' } }, font: { color: { rgb: 'FFFFFF' }, bold: true } }; });
  rows.forEach((row, rowIndex) => { if (!row.Alerta) return; Object.keys(row).forEach((_, columnIndex) => { const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex + 1, c: columnIndex })]; if (cell) cell.s = { fill: { fgColor: { rgb: 'FDECEA' } }, font: { color: { rgb: 'B42318' }, bold: true } }; }); });
  XLSX.utils.book_append_sheet(book, sheet, 'Inventario');
  XLSX.writeFile(book, `inventario-${selectedRoom().name.replaceAll(' ', '-')}.xlsx`);
}
function matchesColumn(column, names) {
  const normalized = header(column);
  return names.some((name) => normalized === name || (name !== 'codigo' && normalized.includes(name)));
}
function valueFrom(row, names) {
  const key = Object.keys(row).find((column) => matchesColumn(column, names));
  return key === undefined ? '' : text(row[key]);
}
const codeHeaders = ['codigopatrimonial', 'codigopatrim', 'codigopat', 'codpatrimonial', 'codigo', 'codigodelbien', 'codigoactivo', 'codigoinventario', 'numeropatrimonial', 'nropatrimonial'];
function technicalDetail(row) {
  return [
    ['Marca', valueFrom(row, ['marca'])],
    ['Modelo', valueFrom(row, ['modelo'])],
    ['Tipo', valueFrom(row, ['tipo'])],
    ['Color', valueFrom(row, ['color'])],
    ['Serie', valueFrom(row, ['serie'])]
  ].filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`).join(' | ');
}
function importRows(rows) {
  let imported = 0; let updated = 0; let omitted = 0;
  const keepSourceData = rows.length < 5000;
  // No se indexan las copias por duplicado (isDuplicateClone): la reimportación del Excel
  // maestro solo debe actualizar el registro original de cada código, nunca una copia activa
  // en otro ambiente (eso la borraría de ese ambiente).
  const assetsByCode = new Map(db.assets.filter((asset) => !asset.isDuplicateClone).map((asset) => [asset.code.toLowerCase(), asset]));
  const localsByName = new Map(db.locals.map((local) => [header(local.name), local]));
  const areasByName = new Map(db.areas.map((area) => [`${area.localId}|${header(area.name)}`, area]));
  const roomsByName = new Map(db.rooms.map((room) => [`${room.areaId}|${header(room.name)}`, room]));
  rows.forEach((row) => {
    const code = valueFrom(row, codeHeaders);
    if (!code) { omitted++; return; }
    const localName = valueFrom(row, ['local', 'nombrel', 'sede', 'edificio']) || selectedLocal()?.name || 'Sin local';
    const localKey = header(localName);
    let local = localsByName.get(localKey);
    if (!local) { local = { id: uid(), name: localName }; db.locals.push(local); localsByName.set(localKey, local); }
    const areaName = valueFrom(row, ['area']) || selectedArea()?.name || 'Sin área';
    const areaKey = `${local.id}|${header(areaName)}`;
    let area = areasByName.get(areaKey);
    if (!area) { area = { id: uid(), localId: local.id, name: areaName }; db.areas.push(area); areasByName.set(areaKey, area); }
    const roomName = valueFrom(row, ['ambiente', 'oficina', 'nombreoficina', 'aula', 'ambienteoficina']) || selectedRoom()?.name || 'Sin ambiente';
    const roomKey = `${area.id}|${header(roomName)}`;
    let room = roomsByName.get(roomKey);
    if (!room) { room = { id: uid(), areaId: area.id, name: roomName }; db.rooms.push(room); roomsByName.set(roomKey, room); }
    const stateRaw = valueFrom(row, ['estadobien', 'estado']).toLowerCase();
    const state = states.find((x) => x.toLowerCase() === stateRaw) || 'Bueno';
    const data = {
      code,
      type: valueFrom(row, ['denominacionbien', 'tipodebien', 'denominacion', 'descripcion', 'tipo']) || 'Sin especificar',
      detail: technicalDetail(row) || valueFrom(row, ['detalletecnico', 'detalle', 'caracteristicas', 'observaciones']) || 'Sin detalle',
      roomId: room.id,
      // homeRoomId: el ambiente "oficial" del bien según el Excel maestro. A diferencia de
      // roomId (que cambia si el trabajador lo escanea en otro ambiente), esto NUNCA se
      // sobrescribe una vez asignado, para que el "Reporte de faltantes por ambiente" siempre
      // pueda saber a qué ambiente pertenecía originalmente un bien aunque ya se haya movido.
      homeRoomId: room.id,
      state, registered: false, fromExcel: true, sourceArea: areaName, sourceRoom: roomName,
      grupo: valueFrom(row, ['grupo']),
      fechaAdq: valueFrom(row, ['fechaadquisicion']),
      docAdq: valueFrom(row, ['nrodocadquisicion']),
      condicion: valueFrom(row, ['condicion']).toUpperCase(),
      nroBaja: valueFrom(row, ['nroresolucionbaja']),
      encargadoExcel: [valueFrom(row, ['apellidopaterno']), valueFrom(row, ['apellidomaterno']), valueFrom(row, ['nombres'])].filter(Boolean).join(' '),
      ...(keepSourceData ? { sourceData: { ...row } } : {})
    };
    const asset = assetsByCode.get(code.toLowerCase());
    if (asset) {
      if (asset.registered) {
        // Este bien YA fue escaneado/registrado por un trabajador en algún ambiente: no se le
        // pisa su ubicación real (roomId) ni su estado/registro con los datos "de fábrica" del
        // Excel. Solo se completan datos que pudieran faltar (útil cuando se importó un
        // respaldo parcial que no traía el catálogo completo de local/área/ambiente "oficial").
        if (!asset.sourceArea) asset.sourceArea = areaName;
        if (!asset.sourceRoom) asset.sourceRoom = roomName;
        if (!asset.grupo) asset.grupo = data.grupo;
        if (!asset.homeRoomId) asset.homeRoomId = room.id;
        ['fechaAdq', 'docAdq', 'condicion', 'nroBaja', 'encargadoExcel'].forEach((k) => { if (!asset[k]) asset[k] = data[k]; });
      } else {
        Object.assign(asset, data);
      }
      updated++;
    } else {
      const created = { id: uid(), ...data }; db.assets.push(created); assetsByCode.set(code.toLowerCase(), created); imported++;
    }
  });
  if (!imported && !updated) return setMessage('No se encontraron códigos patrimoniales para importar. Revise los encabezados.', true);
  save(); renderSelectors();
  setMessage(`Importación terminada: ${imported} bienes nuevos, ${updated} actualizados${omitted ? `, ${omitted} filas omitidas` : ''}.`);
}
function setLoadingState(loading) {
  $('start-inventory-button').disabled = loading;
  $('consult-button').disabled = loading;
}
async function loadProjectInventory() {
  // Se salta solo si el catálogo ya está completo: un respaldo parcial puede traer la marca
  // 'cargado' pero sin los bienes sin registrar, y entonces el reporte de faltantes quedaba vacío.
  if (db.projectInventoryLoaded && db.assets.some((asset) => !asset.registered)) return;
  setLoadingState(true);
  setSessionMessage('Cargando inventario.xlsx (puede tardar unos segundos la primera vez)…');
  try {
    const book = await inventarioBookPromise;
    const sheet = book.Sheets[book.SheetNames[0]];
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
    const headerIndex = matrix.findIndex((row) => row.some((cell) => matchesColumn(cell, codeHeaders)));
    if (headerIndex < 0) throw new Error('Encabezados no encontrados');
    const headers = matrix[headerIndex].map(text);
    const rows = matrix.slice(headerIndex + 1).filter((row) => row.some((cell) => text(cell))).map((row) => Object.fromEntries(headers.map((name, index) => [name, row[index] ?? ''])));
    importRows(rows);
    db.projectInventoryLoaded = true;
    save();
    setSessionMessage('');
  } catch (err) {
    console.error('No se pudo cargar inventario.xlsx:', err);
    setSessionMessage(`⚠ No se pudo cargar inventario.xlsx (${err?.message || 'error desconocido'}). Verifique que el archivo esté en la carpeta data/ y recargue la página.`);
  }
  finally { setLoadingState(false); }
}
// Fecha de adquisición, condición (A/B), resolución de baja y encargado de cada bien. Se leen de
// datos-extra.json (7 MB, carga en un instante) en vez de re-leer el inventario.xlsx entero
// (105 000 filas), que tardaba o fallaba y dejaba el reporte con "Leyendo condición…" para siempre.
// Si datos-extra.json no está, restoreSourceAreas() usa inventario.xlsx como respaldo.
let extraJsonPromise = null;
let extraLoadError = '';
async function enrichFromJson() {
  if (!db.assets.some((a) => a.fromExcel && a.condicion === undefined)) return;
  try {
    extraJsonPromise = extraJsonPromise || fetch('./data/datos-extra.json').then((r) => {
      if (!r.ok) throw new Error('datos-extra.json no encontrado');
      return r.json();
    });
    const d = await extraJsonPromise;
    db.assets.forEach((a) => {
      if (!(a.fromExcel && a.condicion === undefined)) return;
      const e = d.d[a.code] || d.d[String(a.code).toUpperCase()];
      if (e) {
        a.fechaAdq = e[0]; a.docAdq = e[1]; a.condicion = e[2];
        a.nroBaja = e[3] >= 0 ? d.r[e[3]] : ''; a.encargadoExcel = e[4] >= 0 ? d.p[e[4]] : '';
      } else a.condicion = '';
    });
    db.extraFieldsV1 = true; extraLoadError = '';
    await save();
    if ($('missing-dialog')?.open) runMissingReport();
  } catch (err) {
    extraJsonPromise = null;
    console.warn('No se pudo usar datos-extra.json, se intentará con inventario.xlsx:', err);
  }
}
async function restoreSourceAreas() {
  await enrichFromJson();
  const needsSourceAreas = !db.sourceAreasRestored && db.assets.some((asset) => !asset.sourceArea || !asset.sourceRoom);
  const needsGrupo = !db.grupoRestored && db.assets.some((asset) => asset.fromExcel && !asset.grupo);
  const needsExtra = db.assets.some((asset) => asset.fromExcel && asset.condicion === undefined);
  if (!needsSourceAreas && !needsGrupo && !needsExtra) return;
  try {
    const book = await inventarioBookPromise;
    const matrix = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, defval: '', blankrows: false });
    const headerIndex = matrix.findIndex((row) => row.some((cell) => matchesColumn(cell, codeHeaders)));
    if (headerIndex < 0) return;
    const headers = matrix[headerIndex].map(header);
    const codeIndex = headers.findIndex((name) => codeHeaders.includes(name));
    const areaIndex = headers.findIndex((name) => name.includes('area'));
    const roomIndex = headers.findIndex((name) => name.includes('ambiente') || name.includes('oficina') || name.includes('aula'));
    const grupoIndex = headers.findIndex((name) => name === 'grupo');
    if (codeIndex < 0) return;
    const pickIdx = (...names) => headers.findIndex((name) => names.some((n) => name === n || name.includes(n)));
    const fechaIdx = pickIdx('fechaadquisicion');
    const docAdqIdx = pickIdx('nrodocadquisicion');
    const condIdx = pickIdx('condicion');
    const bajaIdx = pickIdx('nroresolucionbaja');
    const pIdx = pickIdx('apellidopaterno'); const mIdx = pickIdx('apellidomaterno'); const nIdx = pickIdx('nombres');
    const copiesByCode = new Map();
    if (needsExtra) db.assets.forEach((asset) => { const k = asset.code.toLowerCase(); if (!copiesByCode.has(k)) copiesByCode.set(k, []); copiesByCode.get(k).push(asset); });
    const assetsByCode = new Map(db.assets.map((asset) => [asset.code.toLowerCase(), asset]));
    matrix.slice(headerIndex + 1).forEach((row) => {
      if (needsExtra) {
        const copies = copiesByCode.get(text(row[codeIndex]).toLowerCase());
        if (copies) {
          const extra = {
            fechaAdq: fechaIdx >= 0 ? text(row[fechaIdx]) : '',
            docAdq: docAdqIdx >= 0 ? text(row[docAdqIdx]) : '',
            condicion: condIdx >= 0 ? text(row[condIdx]).toUpperCase() : '',
            nroBaja: bajaIdx >= 0 ? text(row[bajaIdx]) : '',
            encargadoExcel: [pIdx, mIdx, nIdx].filter((i) => i >= 0).map((i) => text(row[i])).filter(Boolean).join(' ')
          };
          copies.forEach((c) => Object.assign(c, extra));
        }
      }
      const asset = assetsByCode.get(text(row[codeIndex]).toLowerCase());
      if (!asset) return;
      if (needsSourceAreas) {
        if (areaIndex >= 0 && !asset.sourceArea) asset.sourceArea = text(row[areaIndex]);
        if (roomIndex >= 0 && !asset.sourceRoom) asset.sourceRoom = text(row[roomIndex]);
      }
      if (needsGrupo && grupoIndex >= 0 && !asset.grupo) asset.grupo = text(row[grupoIndex]);
    });
    if (needsSourceAreas) {
      const currentArea = selectedArea()?.name || '';
      db.assets.forEach((asset) => {
        if (!asset.registered) return;
        asset.areaMismatch = Boolean(asset.sourceArea && header(asset.sourceArea) !== header(currentArea));
      });
      db.sourceAreasRestored = true;
    }
    if (needsGrupo) db.grupoRestored = true;
    if (needsExtra) {
      db.assets.forEach((asset) => { if (asset.fromExcel && asset.condicion === undefined) asset.condicion = ''; });
      db.extraFieldsV1 = true;
    }
    save(); renderAssets();
    if ($('missing-dialog')?.open) runMissingReport();
  } catch (err) {
    extraLoadError = String(err?.message || err);
    console.error('No se pudo leer inventario.xlsx:', err);
    if ($('missing-dialog')?.open) runMissingReport();
  }
}
// Rellena homeRoomId en inventarios guardados ANTES de que existiera este campo (ver importRows).
// Para cada bien sin homeRoomId, intenta ubicar el ambiente "oficial" cruzando su sourceArea/
// sourceRoom (texto guardado del Excel) contra los ambientes ya existentes; si no encuentra
// coincidencia exacta, usa su roomId actual como mejor aproximación disponible.
function migrateHomeRoomIds() {
  const pending = db.assets.filter((asset) => !asset.isDuplicateClone && !asset.homeRoomId);
  if (!pending.length) return;
  const areasByHeaderName = new Map();
  db.areas.forEach((area) => {
    const key = header(area.name);
    if (!areasByHeaderName.has(key)) areasByHeaderName.set(key, []);
    areasByHeaderName.get(key).push(area);
  });
  const roomsByAreaAndName = new Map(db.rooms.map((room) => [`${room.areaId}|${header(room.name)}`, room]));
  pending.forEach((asset) => {
    let home = null;
    if (asset.sourceArea && asset.sourceRoom) {
      const candidateAreas = areasByHeaderName.get(header(asset.sourceArea)) || [];
      for (const area of candidateAreas) {
        const room = roomsByAreaAndName.get(`${area.id}|${header(asset.sourceRoom)}`);
        if (room) { home = room; break; }
      }
    }
    asset.homeRoomId = home ? home.id : (asset.roomId || null);
  });
  save();
}
async function exportPdf() {
  if (!window.jspdf || !window.jspdf.jsPDF) return setMessage('La exportación PDF no está disponible: no cargaron las librerías (jsPDF). Revise su conexión a internet y recargue la página.', true);
  if (typeof window.jspdf.jsPDF.API?.autoTable !== 'function') return setMessage('La exportación PDF no está disponible: no cargó el complemento de tablas (autoTable). Revise su conexión a internet y recargue la página.', true);
  const rows = exportRows();
  if (!rows.length) return setMessage('No hay bienes escaneados para exportar.', true);
  try {
    const { jsPDF } = window.jspdf; const pdf = new jsPDF({ orientation: 'landscape' }); const width = pdf.internal.pageSize.getWidth();
    const local = selectedLocal()?.name || ''; const area = selectedArea()?.name || ''; const room = selectedRoom().name;
    const NAVY = [8, 13, 27]; const NAVY_SOFT = [21, 32, 58]; const CYAN = [44, 227, 255]; const CYAN_PRINT = [7, 137, 165];
    const GOLD = [217, 158, 6]; const INK = [18, 27, 46]; const GREY = [110, 124, 150]; const HAIRLINE = [222, 229, 240];

    // --- Header band: dark navy with a cyan edge and gold status tag, echoing the app's HUD look ---
    pdf.setFillColor(...NAVY); pdf.rect(0, 0, width, 32, 'F');
    pdf.setFillColor(...CYAN); pdf.rect(0, 32, width, 0.9, 'F');
    // corner ticks, same reticle motif as the on-screen scan card
    pdf.setDrawColor(...CYAN); pdf.setLineWidth(0.6);
    [[8, 6], [width - 8, 6]].forEach(([x, y]) => {
      const dir = x < width / 2 ? 1 : -1;
      pdf.line(x, y, x + 4 * dir, y); pdf.line(x, y, x, y + 4);
    });
    let logoWarning = '';
    if (window.LOGO_DATA_URI) {
      try { pdf.addImage(window.LOGO_DATA_URI, 'PNG', 12, 4, 24, 24); }
      catch (logoErr) { console.error('No se pudo dibujar el logo:', logoErr); logoWarning = ' (aviso: no se pudo incluir el logo)'; }
    } else {
      logoWarning = ' (aviso: no se encontró el logo — revise que logo-data.js esté cargado)';
    }
    pdf.setTextColor(255, 255, 255); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(15);
    pdf.text('INVENTARIO DE BIENES PATRIMONIALES', 42, 15);
    pdf.setFont('helvetica', 'normal'); pdf.setTextColor(150, 235, 250); pdf.setFontSize(9);
    pdf.text('Universidad Nacional del Centro del Perú  ·  Módulo de trabajador', 42, 22);
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(...GOLD);
    pdf.text('REGISTRO ESCANEADO', width - 14, 11, { align: 'right' });
    pdf.setFont('helvetica', 'normal'); pdf.setTextColor(180, 200, 225); pdf.setFontSize(8);
    pdf.text(new Date().toLocaleDateString('es-PE', { day: '2-digit', month: 'long', year: 'numeric' }), width - 14, 17, { align: 'right' });

    // --- Meta strip: 5 columnas fijas con separadores; el texto se reduce o trunca para no encimarse ---
    const metaTop = 40; const metaBottom = 54;
    const metaLeft = 14; const metaRight = width - 14;
    const metaColumns = [
      { label: 'Local', value: local },
      { label: 'Área', value: area },
      { label: 'Ambiente', value: room },
      { label: 'Inventariador', value: session.encargados || db.inventariador || '—' },
      { label: 'Encargado del ambiente', value: custodioLabel() || '—' },
      { label: 'Bienes registrados', value: String(rows.length) }
    ];
    const colWidth = (metaRight - metaLeft) / metaColumns.length;
    pdf.setDrawColor(...HAIRLINE); pdf.setLineWidth(0.35);
    pdf.rect(metaLeft, metaTop, metaRight - metaLeft, metaBottom - metaTop);
    for (let i = 1; i < metaColumns.length; i++) {
      const x = metaLeft + colWidth * i;
      pdf.line(x, metaTop, x, metaBottom);
    }
    const fitMetaText = (value, maxWidth) => {
      let size = 9.5; let text = value || '—';
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(size);
      while (size > 6.5 && pdf.getTextWidth(text) > maxWidth) { size -= 0.5; pdf.setFontSize(size); }
      if (pdf.getTextWidth(text) > maxWidth) {
        while (text.length > 1 && pdf.getTextWidth(text + '…') > maxWidth) text = text.slice(0, -1);
        text += '…';
      }
      return { text, size };
    };
    metaColumns.forEach((col, i) => {
      const x = metaLeft + colWidth * i + 5;
      const maxWidth = colWidth - 8;
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(6.6); pdf.setTextColor(...GREY);
      pdf.text(col.label.toUpperCase(), x, metaTop + 8);
      pdf.setTextColor(...INK);
      const fitted = fitMetaText(col.value, maxWidth);
      pdf.setFontSize(fitted.size);
      pdf.text(fitted.text, x, metaTop + 13);
    });

    // --- Nota de observaciones generales del ambiente (si el trabajador escribió una) ---
    let tableStartY = metaBottom + 6;
    const roomComment = (db.roomComments && db.roomComments[db.selected.roomId]) || '';
    if (roomComment) {
      const noteTop = metaBottom + 4; const noteLeft = 14; const noteWidth = width - 28;
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.4);
      const lines = pdf.splitTextToSize(roomComment, noteWidth - 12);
      const lineHeight = 4.3;
      const noteHeight = Math.max(13, lines.length * lineHeight + 8);
      pdf.setFillColor(255, 250, 232);
      pdf.setDrawColor(...GOLD); pdf.setLineWidth(0.5);
      pdf.roundedRect(noteLeft, noteTop, noteWidth, noteHeight, 2, 2, 'FD');
      pdf.setFillColor(...GOLD); pdf.rect(noteLeft, noteTop, 2.2, noteHeight, 'F');
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(6.8); pdf.setTextColor(...GOLD);
      pdf.text('OBSERVACIONES GENERALES', noteLeft + 6, noteTop + 5.5);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.4); pdf.setTextColor(...INK);
      pdf.text(lines, noteLeft + 6, noteTop + 10.8);
      tableStartY = noteTop + noteHeight + 5;
    }

    pdf.autoTable({
      startY: tableStartY,
      head: [['Ítem', 'Código patrimonial', 'Tipo de bien', 'Detalle técnico', 'Ubicación registrada', 'Estado', 'Inventariador', 'Comentario', 'Alerta']],
      body: rows.map((x) => [x['Ítem'], x['Código patrimonial'], x['Tipo de bien'], x['Detalle técnico'], x['Ubicación registrada'], x.Estado, x['Inventariador'], x.Comentario, x.Alerta]),
      theme: 'grid',
      headStyles: { fillColor: NAVY, textColor: [180, 235, 250], fontStyle: 'bold', fontSize: 7.6, halign: 'left' },
      alternateRowStyles: { fillColor: [244, 248, 252] },
      styles: { fontSize: 7.6, cellPadding: 2.8, lineColor: HAIRLINE, lineWidth: 0.3, textColor: INK },
      columnStyles: {
        0: { cellWidth: 10, halign: 'center' },
        1: { cellWidth: 26, textColor: CYAN_PRINT, fontStyle: 'bold' },
        2: { cellWidth: 30 }, 3: { cellWidth: 50 }, 4: { cellWidth: 34 }, 5: { cellWidth: 14, halign: 'center' },
        6: { cellWidth: 26 }, 7: { cellWidth: 30 }, 8: { cellWidth: 30 }
      },
      didParseCell: (data) => {
        if (data.section === 'body' && data.row.raw[8]) { data.cell.styles.fillColor = [253, 233, 236]; data.cell.styles.textColor = [176, 26, 62]; data.cell.styles.fontStyle = 'bold'; }
      },
      didDrawPage: () => {
        const h = pdf.internal.pageSize.getHeight();
        pdf.setDrawColor(...HAIRLINE); pdf.setLineWidth(0.35); pdf.line(14, h - 12, width - 14, h - 12);
        pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7.5); pdf.setTextColor(...GREY);
        pdf.text('Generado por el sistema de inventario', 14, h - 7);
        pdf.text(`Página ${pdf.internal.getCurrentPageInfo().pageNumber} de ${pdf.internal.getNumberOfPages()}`, width - 14, h - 7, { align: 'right' });
      }
    });
    pdf.save(`inventario-${room.replaceAll(' ', '-')}.pdf`);
    setMessage(`PDF generado y descargado correctamente.${logoWarning}`);
  } catch (err) {
    console.error(err);
    setMessage(`No se pudo generar el PDF: ${err?.message || 'error desconocido'}. Revise la consola del navegador (F12) para más detalle.`, true);
  }
}

// === Acta de verificación física (PDF) ===============================================
// Replica el modelo de la Sub Unidad de Bienes Patrimoniales (ejemplo: Facultad de Minas).
// En cada acta solo cambian: la Facultad/Área, el ambiente y los inventariadores. Todo lo
// demás es texto fijo. Es un PDF NUEVO: no toca ni modifica los otros reportes.
const ACTA_ANIO = 2026; // año del inventario que sale en el título y en el texto del acta
const ACTA_MAX_INVENTARIADORES = 3;
const ACTA_MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
let actaTeam = []; // [{ name, doc }] mientras el diálogo está abierto

// Si todavía no hay equipo guardado, se parte del nombre que ya se escribió en "Inventariador".
function actaInitialTeam() {
  if (Array.isArray(db.actaTeam) && db.actaTeam.length) return db.actaTeam.map((m) => ({ name: m.name || '', doc: m.doc || '' }));
  const names = String(db.inventariador || '').split(/\s*(?:,|;|\sy\s|\se\s)\s*/i).map((n) => n.trim()).filter(Boolean);
  return (names.length ? names : ['']).slice(0, ACTA_MAX_INVENTARIADORES).map((name) => ({ name, doc: '' }));
}

// Compara lo que dice inventario.xlsx para ESTE ambiente contra lo que se registró:
// faltantes = bienes del ambiente que no se registraron en él (si se hallaron en otro
// ambiente se indica dónde); sobrantes = bienes registrados aquí que pertenecen a otro lugar.
function computeActaBienes(roomId) {
  const shortPlace = (id) => {
    const room = db.rooms.find((r) => r.id === id);
    const area = db.areas.find((a) => a.id === room?.areaId);
    return [area?.name, room?.name].filter(Boolean).join(' — ');
  };
  const copiesByCode = new Map();
  db.assets.forEach((x) => {
    const key = x.code.toLowerCase();
    if (!copiesByCode.has(key)) copiesByCode.set(key, []);
    copiesByCode.get(key).push(x);
  });
  const homeAssets = db.assets.filter((x) => !x.isDuplicateClone && x.homeRoomId === roomId && !esDeBaja(x));
  const faltantes = [];
  let encontrados = 0;
  homeAssets.forEach((home) => {
    const registered = (copiesByCode.get(home.code.toLowerCase()) || [home]).filter((x) => x.registered);
    if (registered.some((x) => x.roomId === roomId)) { encontrados++; return; }
    faltantes.push({ code: home.code, type: home.type, foundIn: registered[0] ? shortPlace(registered[0].roomId) : '' });
  });
  faltantes.sort((a, b) => (a.foundIn ? 1 : 0) - (b.foundIn ? 1 : 0) || a.code.localeCompare(b.code));
  const sobrantes = db.assets
    .filter((x) => x.registered && x.roomId === roomId && x.homeRoomId !== roomId)
    .sort((a, b) => (a.registeredOrder || 0) - (b.registeredOrder || 0))
    .map((x) => ({ code: x.code, type: x.type, origin: [x.sourceArea, x.sourceRoom].filter(Boolean).join(' — ') }));
  return { esperados: homeAssets.length, encontrados, faltantes, sobrantes };
}

function renderActaTeam() {
  const box = $('acta-team');
  box.innerHTML = '';
  actaTeam.forEach((member, index) => {
    const row = document.createElement('div');
    row.className = 'acta-member';
    const nameLabel = document.createElement('label');
    nameLabel.append(`Inventariador ${index + 1}`);
    const nameInput = document.createElement('input');
    nameInput.maxLength = 120; nameInput.autocomplete = 'off'; nameInput.placeholder = 'Apellidos y nombres'; nameInput.value = member.name;
    nameInput.oninput = () => { member.name = nameInput.value; };
    nameLabel.append(nameInput);
    const docLabel = document.createElement('label');
    docLabel.append('DNI');
    const docInput = document.createElement('input');
    docInput.maxLength = 12; docInput.inputMode = 'numeric'; docInput.autocomplete = 'off'; docInput.value = member.doc;
    docInput.oninput = () => { member.doc = docInput.value; };
    docLabel.append(docInput);
    row.append(nameLabel, docLabel);
    if (actaTeam.length > 1) {
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'button button-secondary'; remove.textContent = '✕';
      remove.title = 'Quitar inventariador'; remove.setAttribute('aria-label', 'Quitar inventariador');
      remove.onclick = () => { actaTeam.splice(index, 1); renderActaTeam(); };
      row.append(remove);
    }
    box.append(row);
  });
  $('acta-add-member').hidden = actaTeam.length >= ACTA_MAX_INVENTARIADORES;
}

// Un solo clic: genera UN PDF con el acta de TODOS los ambientes del Área (facultad) seleccionada,
// una hoja por ambiente. Solo se piden los inventariadores; lo demás queda en blanco para llenarlo a mano.
// - Los ambientes "FALTANTES ..." son bolsas de bienes no ubicados, no ambientes reales: NO llevan acta.
// - Todas las aulas del área (nombres que empiezan con "AULA"/"AULAS") van JUNTAS en una sola acta.
const ACTA_GRUPO_AULAS_ID = '__grupo_aulas__';
const actaEsFaltante = (room) => /falt/i.test(String(room?.name || ''));
const actaEsAula = (room) => /^\s*aulas?\b/i.test(String(room?.name || ''));
function actaRoomsOfSelectedArea() {
  const area = selectedArea();
  if (!area) return [];
  const byName = (a, b) => (a.name || '').localeCompare(b.name || '', 'es');
  const rooms = visibleRooms().filter((r) => r.areaId === area.id && !actaEsFaltante(r));
  const aulas = rooms.filter(actaEsAula);
  const otros = rooms.filter((r) => !actaEsAula(r)).sort(byName);
  const result = otros.map((r) => ({ id: r.id, name: r.name }));
  if (aulas.length) {
    // Nombre del acta: "AULAS 301, 302, 303" (se quita la palabra AULA de cada nombre y se juntan los números).
    const nums = aulas.slice().sort(byName)
      .map((r) => String(r.name || '').replace(/^\s*aulas?\s*[-:]?\s*/i, '').trim())
      .filter(Boolean);
    const nombre = aulas.length === 1 ? (aulas[0].name || 'AULA') : (nums.length ? `AULAS ${nums.join(', ')}` : 'AULAS');
    result.unshift({
      id: ACTA_GRUPO_AULAS_ID,
      name: nombre,
      label: aulas.length === 1 ? nombre : `${nombre}  (${aulas.length} aulas en una sola acta)`
    });
  }
  return result;
}

function openActaDialog() {
  const area = selectedArea();
  if (!area) return setSessionMessage('Seleccione Local y Área (facultad) antes de generar las actas.');
  const rooms = actaRoomsOfSelectedArea();
  if (!rooms.length) return setSessionMessage('Esta área no tiene ambientes.');
  $('acta-area-label').textContent = area.name || 'Sin nombre';
  const list = $('acta-rooms');
  list.innerHTML = '';
  rooms.forEach((room) => {
    const label = document.createElement('label');
    label.className = 'acta-check';
    const box = document.createElement('input');
    box.type = 'checkbox'; box.checked = true; box.value = room.id;
    const span = document.createElement('span');
    span.textContent = room.label || room.name || 'Sin nombre';
    label.append(box, span);
    list.append(label);
  });
  const updateCount = () => {
    const n = list.querySelectorAll('input:checked').length;
    $('acta-count').textContent = `${n} de ${rooms.length} ambiente(s) → ${n} acta(s) en un solo PDF.`;
  };
  list.onchange = updateCount;
  updateCount();
  actaTeam = actaInitialTeam();
  renderActaTeam();
  $('acta-dialog').showModal();
}

function generateActaFromDialog() {
  if (!window.jspdf || !window.jspdf.jsPDF) return alert('La exportación PDF no está disponible: no cargaron las librerías (jsPDF). Revise su conexión a internet y recargue la página.');
  const area = selectedArea();
  if (!area) return;
  const ids = new Set([...$('acta-rooms').querySelectorAll('input:checked')].map((i) => i.value));
  const rooms = actaRoomsOfSelectedArea().filter((r) => ids.has(r.id));
  if (!rooms.length) return alert('Marque al menos un ambiente.');
  const team = actaTeam.map((m) => ({ name: m.name.trim(), doc: m.doc.trim() })).filter((m) => m.name || m.doc);
  db.actaTeam = team; save();
  const actas = rooms.map((room) => ({
    area: area.name, room: room.name, date: '', time: '', respName: '', respDoc: '', team,
    sobrantes: null, faltantes: null, obs: '', folios: ''
  }));
  try {
    buildActasPdf(actas, area.name);
    $('acta-dialog').close();
    setSessionMessage(`${actas.length} acta(s) generada(s) en un solo PDF.`);
  } catch (err) {
    console.error(err);
    alert(`No se pudieron generar las actas: ${err?.message || 'error desconocido'}. Revise la consola del navegador (F12).`);
  }
}

function buildActasPdf(actas, areaName) {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'mm', format: 'letter', orientation: 'portrait' });
  actas.forEach((d, i) => { if (i) pdf.addPage(); drawActa(pdf, d); });
  const slug = String(areaName || 'area').replace(/[\\/:*?"<>|]+/g, '-').trim().replaceAll(' ', '-');
  pdf.save(`actas-verificacion-fisica-${slug}.pdf`);
}

function drawActa(pdf, d) {
  const W = pdf.internal.pageSize.getWidth();
  const H = pdf.internal.pageSize.getHeight();
  const L = 20; const R = W - 20; const BW = R - L;
  let BOTTOM = H - 16; const TOP = 18;
  let y = 16;

  const setF = (style, size, family = 'helvetica') => { pdf.setFont(family, style); pdf.setFontSize(size); };
  const resetInk = () => { pdf.setTextColor(0, 0, 0); pdf.setDrawColor(0, 0, 0); pdf.setLineWidth(0.25); };
  const ensure = (h) => { if (y + h > BOTTOM) { pdf.addPage(); y = TOP; return true; } return false; };
  const dotted = (x1, x2, yy) => { pdf.setLineDashPattern([0.3, 0.9], 0); pdf.setLineWidth(0.25); pdf.line(x1, yy, x2, yy); pdf.setLineDashPattern([], 0); };
  const dotsLines = (count) => { for (let i = 0; i < count; i++) { ensure(6); y += 5.6; dotted(L, R, y); } y += 2; };
  const styleOf = (w) => (w.b && w.i ? 'bolditalic' : w.b ? 'bold' : w.i ? 'italic' : 'normal');

  // Párrafo con negritas/cursivas mezcladas, ajustado a un ancho y justificado. Devuelve nº de líneas.
  // Un segmento que empieza sin espacio justo después de otro que termina sin espacio se pega a la
  // palabra anterior (así la coma de ", teniendo" no se separa de la negrita que la precede).
  const rich = (segs, x, maxW, lh, { size = 10, justify = true } = {}) => {
    pdf.setFontSize(size);
    pdf.setFont('helvetica', 'normal');
    const space = pdf.getTextWidth(' ');
    const words = []; // cada palabra = { parts: [{ w, b, i, width }], width }
    let prevEndsOpen = false;
    segs.forEach((seg) => {
      const t = String(seg.t);
      const tokens = t.split(/\s+/).filter(Boolean);
      tokens.forEach((tok, k) => {
        pdf.setFont('helvetica', styleOf(seg));
        const part = { w: tok, b: seg.b, i: seg.i, width: [...tok].reduce((sum, ch) => sum + pdf.getTextWidth(ch), 0) };
        const glue = k === 0 && words.length && prevEndsOpen && !/^\s/.test(t);
        if (glue) { const last = words[words.length - 1]; last.parts.push(part); last.width += part.width; }
        else words.push({ parts: [part], width: part.width });
      });
      if (tokens.length) prevEndsOpen = !/\s$/.test(t);
    });
    const lines = []; let line = []; let lineW = 0;
    words.forEach((word) => {
      const add = line.length ? space + word.width : word.width;
      if (line.length && lineW + add > maxW) { lines.push({ words: line, width: lineW }); line = [word]; lineW = word.width; }
      else { line.push(word); lineW += add; }
    });
    if (line.length) lines.push({ words: line, width: lineW });
    lines.forEach((ln, idx) => {
      ensure(lh);
      const extra = justify && idx < lines.length - 1 && ln.words.length > 1 ? (maxW - ln.width) / (ln.words.length - 1) : 0;
      let cx = x;
      ln.words.forEach((word) => {
        let px = cx;
        word.parts.forEach((part) => {
          pdf.setFont('helvetica', styleOf(part)); pdf.setFontSize(size);
          pdf.text(part.w, px, y + lh * 0.72);
          px += part.width;
        });
        cx += word.width + space + extra;
      });
      y += lh;
    });
    return lines.length;
  };

  const upper = (v) => String(v || '').toUpperCase();
  const dots = (n) => '.'.repeat(n);

  // --- Encabezado ---
  setF('bold', 15); pdf.text('UNIVERSIDAD NACIONAL DEL CENTRO DEL PERÚ', W / 2, 19, { align: 'center' });
  setF('bold', 11.5, 'times'); pdf.text('SUB UNIDAD DE BIENES PATRIMONIALES', W / 2, 25, { align: 'center' });
  setF('normal', 7); pdf.text('Av. Mariscal. Castilla N°3909-4089 -Ciudad Universitaria', W / 2, 29, { align: 'center' });
  pdf.setLineWidth(0.3); pdf.line(L, 30.5, R, 30.5); pdf.setLineWidth(0.25);
  setF('bold', 11);
  pdf.text('ACTA DE VERIFICACIÓN FÍSICA DE BIENES MUEBLES PATRIMONIALES', W / 2, 38.5, { align: 'center' });
  pdf.text(`CORRESPONDIENTE AL INVENTARIO ${ACTA_ANIO}`, W / 2, 44, { align: 'center' });
  y = 50;

  // --- Facultad / Área ---
  rich([{ t: 'Facultad/Oficina/Unidad/Área: ' }, { t: upper(d.area) || dots(40) }], L, BW, 5, { justify: false });
  y += 2;

  // --- Párrafo principal ---
  let hora = dots(15); let dia = dots(4); let mes = dots(23); let anio = String(ACTA_ANIO);
  if (d.time) hora = d.time;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.date || '');
  if (m) { dia = String(Number(m[3])); mes = ACTA_MESES[Number(m[2]) - 1] || mes; anio = m[1]; }
  const nombres = d.team.map((t) => t.name).filter(Boolean);
  const equipo = nombres.length ? (nombres.length > 1 ? `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}` : nombres[0]) : dots(40);
  const locadores = nombres.length > 1 ? 'locadores de servicio' : 'locador de servicio';
  rich([
    { t: `En Ciudad universitaria, siendo las ${hora} horas del día ${dia} de ${mes} del ${anio}, culminado el Inventario Físico de Bienes Patrimoniales ${ACTA_ANIO} de ${upper(d.room)}, se reunieron ${d.respName || dots(85)} y el Equipo Técnico de Inventario conformado por: ${equipo} (${locadores}) acreditados por la Sub Unidad de Bienes Patrimoniales, con la finalidad de suscribir el ` },
    { t: 'ACTA DE VERIFICACIÓN FÍSICA DE BIENES MUEBLES PATRIMONIALES', b: true },
    { t: ', teniendo los siguientes resultados:' }
  ], L + 2, BW - 2, 4.5);
  y += 2;

  ['Se verificó los bienes muebles existentes del mencionado ambiente.', 'Se verificó el estado (detalle técnico) y el estado de conservación de cada bien.'].forEach((txt) => {
    ensure(5);
    pdf.setFillColor(0, 0, 0); pdf.circle(L + 7, y + 2.4, 0.55, 'F');
    rich([{ t: txt }], L + 11, BW - 11, 4.5, { justify: false });
  });
  y += 2;

  // --- Secciones con etiqueta + nota pequeña ---
  const sectionLabel = (label, note) => {
    ensure(14);
    setF('normal', 10); const lw = pdf.getTextWidth(label);
    setF('bold', 6.6); const nw = pdf.getTextWidth(note);
    setF('normal', 10); pdf.text(label, L, y + 3.6);
    setF('bold', 6.6);
    if (lw + 1.5 + nw <= BW) { pdf.text(note, L + lw + 1.5, y + 3.6); y += 6; }
    else { pdf.text(note, L, y + 8); y += 10.5; }
  };
  const tableOf = (head, body, columnStyles, blank) => {
    pdf.autoTable({
      startY: y, margin: { left: L, right: W - R, top: TOP, bottom: 16 }, tableWidth: BW,
      head: [head], body, theme: 'grid',
      styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 1.4, textColor: [0, 0, 0], lineColor: [0, 0, 0], lineWidth: 0.25, valign: 'middle', overflow: 'linebreak' },
      headStyles: { fillColor: [255, 255, 255], textColor: [0, 0, 0], fontStyle: 'bold', halign: 'center' },
      bodyStyles: blank ? { minCellHeight: 4.6 } : {},
      columnStyles
    });
    y = pdf.lastAutoTable.finalY + 2;
    resetInk();
  };

  sectionLabel('Bienes Sobrantes:', '(Especificar su procedencia, como fue adquirido, detallar cuantos bienes e ítems)');
  if (d.sobrantes) {
    const body = d.sobrantes.length
      ? d.sobrantes.map((s, i) => [i + 1, s.code, s.type, s.origin || ''])
      : [['', 'NINGUNO', '', '']];
    tableOf(['ITEM', 'CÓDIGO', 'DENOMINACIÓN', 'PROCEDENCIA'], body, { 0: { cellWidth: 12, halign: 'center' }, 1: { cellWidth: 30 }, 3: { cellWidth: 62 } }, false);
  } else {
    dotsLines(3);
  }
  y += 1;

  sectionLabel('Bienes Faltantes:', '(detallar cuantos bienes e ítems)');
  if (d.faltantes) {
    const body = d.faltantes.length
      ? d.faltantes.map((f, i) => [i + 1, f.code, f.foundIn ? `${f.type} (encontrado en: ${f.foundIn})` : f.type])
      : [['', 'NINGUNO', '']];
    tableOf(['ITEM', 'CÓDIGO', 'DENOMINACIÓN'], body, { 0: { cellWidth: 12, halign: 'center' }, 1: { cellWidth: 30 } }, false);
  } else {
    tableOf(['ITEM', 'CÓDIGO', 'DENOMINACIÓN'], Array.from({ length: 5 }, () => ['', '', '']), { 0: { cellWidth: 14, halign: 'center' }, 1: { cellWidth: 34 } }, true);
  }
  y += 1;

  sectionLabel('Observaciones:', '(En caso que el encargado del ambiente no quiere firmar, detallar y comunicar de inmediato a la jefatura)');
  if (d.obs) {
    const used = rich([{ t: d.obs }], L, BW, 4.6, { size: 9.5, justify: false });
    dotsLines(Math.max(0, 2 - used));
  } else {
    dotsLines(2);
  }
  y += 1;

  // --- Nota ---
  ensure(30);
  setF('bolditalic', 7.5); pdf.text('Nota:', L, y + 3);
  y += 3.6;
  [
    'Cada trabajador o usuario es responsable directo de la existencia física, permanencia, conservación y buen uso de cada uno de los bienes descritos, por lo que se recomienda tomar las providencias del caso para evitar pérdida, sustracciones, deterioros, etc. que luego podrían ser considerados como descuido o negligencia, imputando alguna responsabilidad posterior.',
    'Cualquier movimiento dentro o fuera de la Entidad deberá ser autorizado por el encargado de la Sub Unidad de Bienes Patrimoniales, bajo responsabilidad del usuario.'
  ].forEach((txt) => {
    ensure(8);
    setF('italic', 7.5); pdf.text('-', L + 2, y + 2.7);
    rich([{ t: txt, i: true }], L + 6, BW - 6, 3.4, { size: 7.5 });
  });
  y += 4;

  ensure(10);
  rich([{ t: 'No habiendo mayores observaciones, se levanta el presente Acta y se firma al pie en señal de conformidad.' }], L, BW, 4.6, { justify: false });

  // --- Firmas ---
  // Responsable del ambiente + inventariadores, hasta 3 por fila. La altura de cada fila se calcula
  // según cuántas líneas ocupa el nombre (si es largo se parte en dos) para que nada se encime.
  const blocks = [{ kind: 'resp', name: d.respName, doc: d.respDoc }, ...d.team.map((t) => ({ kind: 'inv', name: t.name, doc: t.doc }))];
  const cols = Math.min(3, blocks.length);
  const rows = Math.ceil(blocks.length / cols);
  const colW = BW / cols;
  const bwOf = colW - 6;
  setF('normal', 8);
  blocks.forEach((b) => { b.lines = b.name ? pdf.splitTextToSize(`NOMBRE: ${b.name}`, bwOf) : null; });
  const rowH = Array.from({ length: rows }, (_, r) => {
    const maxLines = Math.max(...blocks.slice(r * cols, r * cols + cols).map((b) => (b.lines ? b.lines.length : 1)));
    return 16 + 8 + maxLines * 3.6 + 3;
  });
  const sigH = rowH.reduce((a, b) => a + b, 0) + 11;
  const SIG_BOTTOM = H - 10;
  BOTTOM = H - 8; // la última nota puede llegar casi al pie de la hoja
  let sy;
  if (y + 8 + sigH > SIG_BOTTOM) { pdf.addPage(); y = TOP; sy = y + 10; }
  else sy = Math.max(y + 10, SIG_BOTTOM - sigH);
  blocks.forEach((b, idx) => {
    const r = Math.floor(idx / cols); const c = idx % cols;
    const x1 = L + c * colW + 3; const x2 = L + (c + 1) * colW - 3; const bw = x2 - x1;
    const ly = sy + rowH.slice(0, r).reduce((a, v) => a + v, 0) + 16;
    pdf.setLineWidth(0.3); pdf.line(x1, ly, x2, ly); pdf.setLineWidth(0.25);
    const fill = (prefix) => {
      setF('normal', 8);
      let t = prefix;
      while (pdf.getTextWidth(t + '.') < bw) t += '.';
      return t;
    };
    const cx = (x1 + x2) / 2;
    const centered = b.kind === 'inv';
    if (centered) { setF('bold', 9); pdf.text('Inventariador', cx, ly + 4, { align: 'center' }); }
    else { setF('bold', 8); pdf.text('RESPONSABLE DEL AMBIENTE', x1, ly + 4); }
    let ty = ly + 8;
    setF('normal', 8);
    if (b.lines) { pdf.text(b.lines, centered ? cx : x1, ty, centered ? { align: 'center' } : {}); ty += b.lines.length * 3.6; }
    else { pdf.text(fill('NOMBRE'), x1, ty); ty += 3.6; }
    setF('normal', 8);
    if (b.doc) pdf.text(`DNI: ${b.doc}`, centered ? cx : x1, ty, centered ? { align: 'center' } : {});
    else pdf.text(fill('DNI'), x1, ty);
  });
  y = sy + rowH.reduce((a, v) => a + v, 0);
  rich([{ t: `* La verificación se realizó conjuntamente con el responsable del ambiente y se deja constancia que se entregan copias la Acta y Reporte de Bienes Muebles de Verificación Física, en ${d.folios || dots(14)} folios para conocimiento del interesado.` }], L + 4, BW - 8, 3.4, { size: 7.5 });
}

$('acta-button').onclick = openActaDialog;
$('acta-add-member').onclick = () => { if (actaTeam.length < ACTA_MAX_INVENTARIADORES) { actaTeam.push({ name: '', doc: '' }); renderActaTeam(); } };
$('acta-cancel-button').onclick = () => $('acta-dialog').close();
$('acta-generate-button').onclick = generateActaFromDialog;

// switchRoomSession() en vez de resetSession(): si ya se está inventariando, cambiar de
// ambiente NO obliga a volver a pulsar "Iniciar" ni a reescribir el nombre.
$('local-select').onchange = (e) => { db.selected.localId = e.target.value; renderSelectors(); switchRoomSession(); };
$('area-select').onchange = (e) => { db.selected.areaId = e.target.value; renderSelectors(); switchRoomSession(); };
$('room-select').onchange = (e) => { db.selected.roomId = e.target.value; renderSelectors(); switchRoomSession(); };
$('previous-room').onclick = () => moveRoom(-1); $('next-room').onclick = () => moveRoom(1);
$('camera-button').onclick = toggleCamera;
$('code-form').onsubmit = (e) => { e.preventDefault(); registerCode(normalizeCode($('code-input').value)); };

// === Autoenvío para lectores de código de barras (pistola/lector físico tipo "teclado") ===
// Estos lectores escriben el código carácter por carácter mucho más rápido de lo que
// puede teclear una persona. Medimos el tiempo entre pulsaciones: si el promedio es muy
// bajo (típico de un lector), enviamos el formulario automáticamente al terminar de leer,
// sin esperar a que el usuario presione Enter.
const SCANNER_MAX_MS_PER_CHAR = 40; // umbral: menos de esto por carácter en promedio = lector físico
const SCANNER_PAUSE_MS = 120; // pausa tras la última pulsación para considerar que terminó de leer
const SCANNER_BURST_GAP_MS = 500; // si pasa más de esto entre pulsaciones, es una ráfaga nueva (tecleo humano)
let scanBurst = { start: 0, last: 0, timer: null };
$('code-input').addEventListener('input', () => {
  const input = $('code-input');
  const value = input.value;
  const now = Date.now();
  if (scanBurst.timer) clearTimeout(scanBurst.timer);
  if (!scanBurst.last || now - scanBurst.last > SCANNER_BURST_GAP_MS) scanBurst.start = now;
  scanBurst.last = now;
  scanBurst.timer = setTimeout(() => {
    const elapsed = now - scanBurst.start;
    const looksLikeScanner = value.trim().length >= 4 && elapsed < value.trim().length * SCANNER_MAX_MS_PER_CHAR;
    if (looksLikeScanner && document.activeElement === input) {
      $('code-form').requestSubmit();
    }
  }, SCANNER_PAUSE_MS);
});
$('inventory-body').onchange = (e) => {
  if (e.target.matches('[data-asset-id]')) {
    db.assets.find((x) => x.id === e.target.dataset.assetId).state = e.target.value;
    // OJO: aquí NO se reenfoca el campo de código. Cambiar el "Estado" de un bien es algo
    // que suele hacer la persona que revisa la tabla (no la que escanea), y forzar el foco
    // de vuelta arriba en ese momento era justo lo que hacía "saltar" la pantalla y perder
    // la posición en la tabla mientras se va pegando los stickers.
    save(); setMessage('Estado actualizado y guardado.');
    return;
  }
  if (e.target.matches('[data-comment-id]')) {
    db.assets.find((x) => x.id === e.target.dataset.commentId).comment = e.target.value.trim();
    save(); setMessage('Comentario guardado.');
    return;
  }
  if (e.target.matches('[data-detail-id]')) {
    const asset = db.assets.find((x) => x.id === e.target.dataset.detailId);
    const value = e.target.value.trim();
    asset.detail = value || 'Sin detalle';
    save();
    // Igual que con el Estado: no se llama a renderAssets() (perdería el foco/scroll). Se
    // actualiza a mano el aviso ámbar de esta fila, ya con el detalle puesto.
    const stillMissing = isMissingDetail(asset);
    e.target.classList.toggle('detail-missing', stillMissing);
    const row = e.target.closest('[data-asset-row]');
    if (row) row.classList.toggle('missing-detail-row', stillMissing);
    setMessage(stillMissing ? 'Guardado — aún faltan las características de este bien.' : 'Características guardadas.');
  }
};
$('inventory-body').onclick = (e) => {
  const button = e.target.closest('[data-delete-asset-id]');
  if (!button) return;
  const asset = db.assets.find((x) => x.id === button.dataset.deleteAssetId);
  if (!asset) return;
  asset.registered = false;
  save(); renderAssets(); setMessage(`${asset.code} fue eliminado.`);
};
$('excel-button').onclick = exportExcel; $('pdf-button').onclick = exportPdf;


// === 👥 Encargados de toda el área =====================================================
// Resume quién responde por los bienes de CADA ambiente del Local/Área seleccionados, según el
// inventario.xlsx (db.custodios, ya armado por loadCustodios). Dos vistas: por persona (cuántos
// ambientes y bienes tiene a su cargo) y por ambiente.
let lastEncargadosArea = { title: '', people: [], rooms: [] };
function computeEncargadosArea() {
  const area = selectedArea(); const local = selectedLocal();
  if (!area) return { title: '', people: [], rooms: [] };
  const rooms = visibleRooms().filter((r) => r.areaId === area.id).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const people = new Map();
  const roomRows = [];
  rooms.forEach((room) => {
    const list = custodiosOfRoom(room.id);
    if (!list.length) return;
    roomRows.push({ room: room.name, names: list.map((c) => `${c.name}${c.doc ? ` (DNI ${c.doc})` : ''}`).join(' / ') });
    list.forEach((c) => {
      const key = `${c.doc}|${c.name}`;
      if (!people.has(key)) people.set(key, { name: c.name, doc: c.doc, rooms: [], bienes: 0 });
      const p = people.get(key); p.rooms.push(room.name); p.bienes += c.count;
    });
  });
  const peopleRows = [...people.values()].sort((a, b) => b.bienes - a.bienes || a.name.localeCompare(b.name, 'es'));
  return { title: [local?.name, area.name].filter(Boolean).join(' — '), people: peopleRows, rooms: roomRows, totalRooms: rooms.length };
}
async function openEncargadosArea() {
  $('encargados-area-filter').value = '';
  $('encargados-area-dialog').showModal();
  if (!(db.custodiosV1 && db.custodios)) {
    $('encargados-area-summary').textContent = 'Leyendo encargados del inventario.xlsx…';
    await loadCustodios();
  }
  renderEncargadosArea();
}
function renderEncargadosArea() {
  const data = computeEncargadosArea();
  lastEncargadosArea = data;
  const q = ($('encargados-area-filter').value || '').trim().toLowerCase();
  const people = data.people.filter((p) => !q || `${p.name} ${p.doc} ${p.rooms.join(' ')}`.toLowerCase().includes(q));
  const rooms = data.rooms.filter((r) => !q || `${r.room} ${r.names}`.toLowerCase().includes(q));
  $('encargados-area-title').textContent = data.title ? `Área: ${data.title}` : 'Seleccione un Local y un Área primero.';
  const totalBienes = data.people.reduce((a, p) => a + p.bienes, 0);
  $('encargados-area-summary').innerHTML = data.title
    ? `<div class="enc-stats">
        <div class="enc-stat"><b>${data.people.length}</b><span>Encargados</span></div>
        <div class="enc-stat"><b>${data.rooms.length}<small style="font-size:.9rem;color:var(--text-dim)"> / ${data.totalRooms}</small></b><span>Ambientes con encargado</span></div>
        <div class="enc-stat"><b>${totalBienes}</b><span>Bienes (según inventario.xlsx)</span></div>
      </div>`
    : '';
  $('encargados-area-people').innerHTML = people.map((p, i) =>
    `<tr><td><span class="enc-rank">${i + 1}</span></td><td>${safe(p.name)}</td><td>${safe(p.doc || '—')}</td><td><span class="enc-badge alt">${p.rooms.length}</span></td><td><span class="enc-badge">${p.bienes}</span></td><td><div class="enc-chips">${p.rooms.map((r) => `<span class="enc-chip">${safe(r)}</span>`).join('')}</div></td></tr>`).join('');
  $('encargados-area-rooms').innerHTML = rooms.map((r, i) =>
    `<tr><td><span class="enc-rank">${i + 1}</span></td><td>${safe(r.room)}</td><td>${safe(r.names)}</td></tr>`).join('');
  $('encargados-area-empty').hidden = people.length > 0 || rooms.length > 0;
}
function exportEncargadosAreaPdf() {
  if (!window.jspdf || !window.jspdf.jsPDF) return alert('La exportación PDF no está disponible: no cargaron las librerías (jsPDF). Revise su conexión a internet y recargue la página.');
  if (typeof window.jspdf.jsPDF.API?.autoTable !== 'function') return alert('La exportación PDF no está disponible: no cargó el complemento de tablas (autoTable).');
  const d = lastEncargadosArea;
  if (!d.title || (!d.people.length && !d.rooms.length)) return alert('No hay encargados para exportar.');
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation: 'portrait' });
  const width = pdf.internal.pageSize.getWidth();
  const BLUE = [11, 92, 171]; const INK = [20, 30, 46]; const GREY = [110, 124, 150];
  pdf.setFillColor(...BLUE); pdf.rect(0, 0, width, 26, 'F');
  if (window.LOGO_DATA_URI) { try { pdf.addImage(window.LOGO_DATA_URI, 'PNG', 10, 4, 18, 18); } catch { /* sin logo */ } }
  pdf.setTextColor(255, 255, 255); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(14);
  pdf.text('ENCARGADOS DE TODA EL ÁREA', 32, 12);
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5);
  pdf.text(d.title, 32, 19);
  pdf.text(new Date().toLocaleDateString('es-PE', { day: '2-digit', month: 'long', year: 'numeric' }), width - 12, 12, { align: 'right' });
  pdf.setTextColor(...INK); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10);
  pdf.text(`POR PERSONA (${d.people.length})`, 12, 36);
  pdf.autoTable({
    startY: 39,
    head: [['Ítem', 'Encargado', 'DNI', 'Amb.', 'Bienes', 'Ambientes a su cargo']],
    body: d.people.map((p, i) => [i + 1, p.name, p.doc || '—', p.rooms.length, p.bienes, p.rooms.join(' · ')]),
    theme: 'grid', headStyles: { fillColor: BLUE, textColor: [255, 255, 255], fontSize: 8 },
    alternateRowStyles: { fillColor: [246, 249, 252] }, styles: { fontSize: 7.5, cellPadding: 2, textColor: INK },
    columnStyles: { 0: { cellWidth: 10, halign: 'center' }, 2: { cellWidth: 20 }, 3: { cellWidth: 12, halign: 'center' }, 4: { cellWidth: 14, halign: 'center' } }
  });
  const y = pdf.lastAutoTable.finalY + 12;
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10); pdf.setTextColor(...INK);
  pdf.text(`POR AMBIENTE (${d.rooms.length})`, 12, y);
  pdf.autoTable({
    startY: y + 3,
    head: [['Ítem', 'Ambiente', 'Encargado(s)']],
    body: d.rooms.map((r, i) => [i + 1, r.room, r.names]),
    theme: 'grid', headStyles: { fillColor: BLUE, textColor: [255, 255, 255], fontSize: 8 },
    alternateRowStyles: { fillColor: [246, 249, 252] }, styles: { fontSize: 7.5, cellPadding: 2, textColor: INK },
    columnStyles: { 0: { cellWidth: 10, halign: 'center' } },
    didDrawPage: () => {
      const hh = pdf.internal.pageSize.getHeight();
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7.3); pdf.setTextColor(...GREY);
      pdf.text('Generado por el sistema de inventario', 12, hh - 7);
      pdf.text(`Página ${pdf.internal.getCurrentPageInfo().pageNumber}`, width - 12, hh - 7, { align: 'right' });
    }
  });
  pdf.save(`encargados-${d.title.replaceAll(' ', '-').replaceAll('—', '-')}.pdf`);
}
$('encargados-area-button').onclick = openEncargadosArea;
$('encargados-area-filter').oninput = renderEncargadosArea;
$('encargados-area-export').onclick = exportEncargadosAreaPdf;
$('encargados-area-close').onclick = () => $('encargados-area-dialog').close();

$('notes-button').onclick = () => { $('notes-filter').value = ''; renderNotesDialog(); $('notes-dialog').showModal(); };
$('notes-filter').oninput = renderNotesDialog;
$('notes-close-button').onclick = () => $('notes-dialog').close();

// Navegador ▲▼ de "bien actual": solo mueve/resalta filas de la tabla y hace scroll,
// nunca toca session, scanner ni scan-card (ver comentario en updateRowNavigator()),
// así que no hay forma de que "apague" la cámara ni cierre el escaneo.
$('row-nav-up').onclick = () => goToRow(-1);
$('row-nav-down').onclick = () => goToRow(1);
preserveFocusOnPress($('row-nav-up'));
preserveFocusOnPress($('row-nav-down'));

$('export-backup-button').onclick = exportBackup;
$('import-backup-button').onclick = () => $('import-backup-input').click();
$('import-backup-input').onchange = (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) importBackupFile(file);
};

$('comment-button').onclick = () => {
  $('comment-textarea').value = (db.roomComments && db.roomComments[db.selected.roomId]) || '';
  $('comment-dialog').showModal();
  $('comment-textarea').focus();
};
$('cancel-comment').onclick = () => $('comment-dialog').close();
$('comment-form').onsubmit = () => {
  const value = $('comment-textarea').value.trim();
  db.roomComments = db.roomComments || {};
  if (value) db.roomComments[db.selected.roomId] = value;
  else delete db.roomComments[db.selected.roomId];
  save(); renderRoomComment();
};
$('remove-comment-button').onclick = () => {
  if (!db.roomComments) return;
  delete db.roomComments[db.selected.roomId];
  save(); renderRoomComment();
};
// Guarda explícitamente (por si el trabajador quiere confirmar que no se perderá nada).
// Los datos ya se guardan solos en cada escaneo, pero este botón da la tranquilidad
// de un guardado inmediato sin borrar ni finalizar nada.
$('save-button').onclick = async () => {
  await save();
  setMessage('✅ Datos guardados correctamente.');
};
$('new-room-button').onclick = () => { editingRoomId = null; $('dialog-title').textContent = 'Nuevo ambiente'; $('room-name-input').value = ''; $('room-dialog').showModal(); };
$('edit-room-button').onclick = () => { const room = selectedRoom(); editingRoomId = room.id; $('dialog-title').textContent = 'Editar ambiente'; $('room-name-input').value = room.name; $('room-dialog').showModal(); };
$('cancel-room').onclick = () => $('room-dialog').close();
// Al RENOMBRAR un ambiente (editar), roomLabel() usa siempre el nombre vigente de db.rooms,
// así que un bien YA REGISTRADO (escaneado) se ve bien de inmediato en todos lados. Pero un
// bien que TODAVÍA NO se escaneó no tiene roomId activo: "Consultar código" y el "Reporte de
// faltantes" lo ubican con asset.sourceRoom, que es una FOTO del nombre tal cual venía en el
// Excel original y no se actualizaba sola — por eso, tras renombrar, la consulta seguía
// mostrando el nombre viejo. Aquí se actualiza ese texto (y el encargado guardado bajo el
// nombre viejo) para que todo quede consistente con el nombre nuevo.
$('room-form').onsubmit = () => {
  const name = $('room-name-input').value.trim();
  if (!name) return;
  if (editingRoomId) {
    const room = db.rooms.find((x) => x.id === editingRoomId);
    const oldName = room.name;
    room.name = name;
    if (header(oldName) !== header(name)) {
      const area = db.areas.find((a) => a.id === room.areaId);
      const oldRoomKey = header(oldName);
      const areaKey = header(area?.name || '');
      db.assets.forEach((asset) => {
        if (header(asset.sourceRoom) === oldRoomKey && header(asset.sourceArea) === areaKey) {
          asset.sourceRoom = name;
        }
      });
      if (db.custodios) {
        const local = db.locals.find((l) => l.id === area?.localId);
        const oldCustodioKey = custodioKey(local?.name, area?.name, oldName);
        const newCustodioKey = custodioKey(local?.name, area?.name, name);
        if (db.custodios[oldCustodioKey] && oldCustodioKey !== newCustodioKey) {
          db.custodios[newCustodioKey] = db.custodios[oldCustodioKey];
          delete db.custodios[oldCustodioKey];
        }
      }
    }
  } else {
    const room = { id: uid(), areaId: db.selected.areaId, name };
    db.rooms.push(room);
    if (roomAccess) roomAccess.add(room.id);
    db.selected.roomId = room.id;
  }
  save(); renderSelectors(); switchRoomSession();
};

// Pide el nombre del inventariador. Solo se abre si todavía no hay uno guardado
// o si la persona pulsa "Cambiar" a propósito.
function askInventariador() {
  $('encargados-input').value = db.inventariador || '';
  $('encargados-dialog-title').textContent = db.inventariador ? 'Cambiar de inventariador' : '¿Quién va a inventariar?';
  $('encargados-submit').textContent = db.inventariador ? 'Guardar' : 'Iniciar inventario';
  $('encargados-dialog').showModal();
}
$('start-inventory-button').onclick = () => {
  if (!selectedRoom()) return setSessionMessage('Seleccione Local, Área y Ambiente antes de iniciar.');
  // Con inventariador ya guardado se entra directo al registro: el nombre se pide una vez
  // y basta, aunque se cambie de ambiente veinte veces.
  if (beginInventory()) return;
  askInventariador();
};
$('change-inventariador-button').onclick = askInventariador;
// "Cerrar" deja el inventario guardado tal cual (no borra nada de lo escaneado): solo suelta
// el nombre, para que la siguiente persona que agarre el celular tenga que poner el suyo.
$('close-inventariador-button').onclick = () => {
  db.inventariador = '';
  resetSession();
  save();
  renderInventariador();
  setSessionMessage('Sesión cerrada. Lo registrado quedó guardado; pulse "Iniciar inventario" para continuar con otro nombre.');
};
$('cancel-encargados').onclick = () => $('encargados-dialog').close();
$('encargados-form').onsubmit = () => {
  const names = $('encargados-input').value.trim();
  if (!names) return;
  db.inventariador = names;
  save();
  renderInventariador();
  beginInventory();
};

$('consult-button').onclick = () => {
  if (!selectedRoom()) return setSessionMessage('Seleccione Local, Área y Ambiente antes de consultar.');
  applyModeUI('consulta');
};

$('search4-button').onclick = () => {
  if (!selectedRoom()) return setSessionMessage('Seleccione Local, Área y Ambiente antes de buscar.');
  applyModeUI('buscar4');
};

// Buscador global: no depende del ambiente activo, busca en TODOS los bienes registrados.
$('search-all-button').onclick = () => {
  searchIndex = null; // reconstruir con los datos más recientes
  populateSearchFilters();
  $('search-query-input').value = '';
  $('search-state-select').value = '';
  $('search-summary').textContent = 'Preparando búsqueda…';
  $('search-dialog').showModal();
  $('search-query-input').focus();
  // el diálogo se pinta primero; el índice se arma justo después sin congelar la pantalla
  requestAnimationFrame(() => setTimeout(runSearch, 0));
};
let searchDebounceTimer = null;
$('search-query-input').oninput = () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(runSearch, 220);
};
$('search-local-select').onchange = () => { populateSearchFilters(); runSearch(); };
$('search-area-select').onchange = () => { populateSearchFilters(); runSearch(); };
$('search-room-select').onchange = runSearch;
$('search-state-select').onchange = runSearch;
$('search-clear-button').onclick = () => {
  $('search-query-input').value = '';
  $('search-local-select').value = '';
  $('search-area-select').value = '';
  $('search-room-select').value = '';
  $('search-state-select').value = '';
  populateSearchFilters();
  runSearch();
  $('search-query-input').focus();
};
$('search-export-button').onclick = exportSearchResultsPdf;
$('search-close-button').onclick = () => $('search-dialog').close();
$('search-dialog').addEventListener('close', () => { searchIndex = null; lastSearchResults = []; $('search-results-body').innerHTML = ''; if (searchObserver) searchObserver.disconnect(); });

// Reporte de faltantes por ambiente: al abrir, se precarga con el Local/Área/Ambiente
// que el trabajador tiene seleccionado en ese momento (comodidad), pero se puede cambiar
// libremente dentro del diálogo sin afectar la sesión de escaneo en curso.
$('missing-report-button').onclick = () => {
  // Seguro adicional: si por cualquier motivo quedaron bienes sin homeRoomId (p. ej. un
  // respaldo antiguo, o datos restaurados de otra forma), se completan aquí también, no
  // solo al cargar la página. migrateHomeRoomIds() es segura de llamar varias veces: solo
  // completa lo que falte, nunca pisa un homeRoomId que ya esté asignado.
  migrateHomeRoomIds();
  restoreSourceAreas(); // completa condición/baja si falta; refresca el reporte abierto al terminar
  populateMissingFilters();
  $('missing-local-select').value = db.selected.localId || '';
  populateMissingFilters();
  $('missing-area-select').value = db.selected.areaId || '';
  populateMissingFilters();
  $('missing-room-select').value = db.selected.roomId || '';
  ['missing-local-select', 'missing-area-select', 'missing-room-select'].forEach(syncCustomSelect);
  runMissingReport();
  $('missing-dialog').showModal();
};
$('missing-local-select').onchange = () => { populateMissingFilters(); runMissingReport(); };
$('missing-area-select').onchange = () => { populateMissingFilters(); runMissingReport(); };
$('missing-room-select').onchange = runMissingReport;
$('missing-export-button').onclick = exportMissingReportPdf;
$('missing-close-button').onclick = () => $('missing-dialog').close();

// Si hay un inventario en curso, "Cerrar consulta" vuelve al registro (no lo cancela);
// si no había inventario en curso, cierra la tarjeta de escaneo por completo.
$('close-scan-button').onclick = () => {
  if (session.active) applyModeUI('inventory');
  else resetSession();
};

async function initialize() {
  [
    'local-select', 'area-select', 'room-select',
    'search-local-select', 'search-area-select', 'search-room-select',
    'missing-local-select', 'missing-area-select', 'missing-room-select'
  ].forEach(enhanceSelect);
  try {
    db = migrateHierarchy(await readSavedData() || JSON.parse(localStorage.getItem(KEY)) || seed);
  } catch { db = migrateHierarchy(JSON.parse(localStorage.getItem(KEY)) || seed); }
  if (!db.inventoryModeV2) {
    db.assets.forEach((asset) => { asset.registered = false; asset.fromExcel = true; });
    db.inventoryModeV2 = true; save();
  }
  if (typeof db.scanCounter !== 'number') db.scanCounter = 0;
  if (typeof db.inventariador !== 'string') db.inventariador = '';
  resetSession();
  renderInventariador();
  renderSelectors();
  // Se corre de inmediato (no depende de re-descargar inventario.xlsx): usa los datos que
  // YA están guardados en este navegador (sourceArea/sourceRoom, roomId), así el "Reporte de
  // faltantes por ambiente" funciona bien aunque se abra apenas carga la página, sin esperar
  // a que termine de bajarse el Excel (que puede tardar varios segundos).
  migrateHomeRoomIds();
  // Los encargados se leen del mismo inventario.xlsx ya descargado; si ya estaban resumidos
  // de una sesión anterior, loadCustodios() sale de inmediato y solo los pinta.
  loadCustodios();
  // La nube (Firebase) espera a que el catálogo esté cargado para poder ubicar cada bien por código y ambiente.
  const catalogReady = Promise.allSettled([loadProjectInventory(), restoreSourceAreas()]);
  window.Nube?.init({ getDb: () => db, header, uid, persist: () => save(), refresh: () => { renderSelectors(); renderAssets(); }, setAccess, ready: catalogReady });
}
initialize();