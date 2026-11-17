// estado.js - Estado compartido y constantes del módulo de nube.
// Todos los módulos leen/escriben aquí en vez de usar variables sueltas.
export const COL = 'inventario';        // bienes registrados
export const US_COL = 'usuarios';       // perfiles: rol y grupos
export const AS_COL = 'asignaciones';   // correo (ya creado en Authentication) -> grupos que le asigna el administrador
export const AV_COL = 'avisos';         // avisos de bienes encontrados en otro ambiente
export const OFF_KEY = 'nube_offline_cred_v1';
export const OVERLAP_MS = 2 * 60 * 1000;  // margen al leer, por si hay relojes/escrituras casi simultáneas
export const PUSH_DELAY_MS = 3000;        // espera tras guardar antes de subir (agrupa cambios)
export const BATCH = 400;                 // Firestore admite 500 operaciones por lote
export const ERROR_BACKOFF_MS = 60000;

export const S = {
  cfg: null, ctx: null, fdb: null, auth: null,
  user: null,            // usuario de Firebase Authentication
  profile: null,         // perfil en la colección usuarios (rol, grupos, activo)
  unsub: null, pushTimer: null, errorUntil: 0,
  state: 'nologin', lastInfo: '',
  offlineUser: null, offlinePass: '',   // sesión local cuando se entra sin internet
  pending: new Map(),    // id de bien -> firma que está subiéndose (solo memoria)
  avisos: [],
  ready: false,          // el catálogo ya cargó
  accessKey: '',         // grupos+rol con que se abrieron los listeners (para reiniciarlos si el admin los cambia)
  ui: {}                 // ganchos que registran los módulos de interfaz (setState, refreshDock, showGate...)
};

export const FV = () => firebase.firestore.FieldValue;
export const isAdmin = () => !!(S.profile && S.profile.rol === 'admin');
export const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
