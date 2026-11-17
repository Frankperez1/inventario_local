// utils.js - Funciones puras: claves estables de documentos, firmas y mapas de ubicación.
import { S } from './estado.js';

export const cyrb = (str) => {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
};
export const H = (s) => S.ctx.header(s);
export const keyOf = (n) => [n.local, n.area, n.room].map(H).join('|');
// Clave estable de cada documento = código + ambiente (los ids internos de la app son aleatorios en cada equipo).
export const docIdOf = (code, n) => `${String(code).replace(/[^A-Za-z0-9_-]/g, '_')}_${cyrb(keyOf(n))}`;
// Id del documento en la nube: cada usuario tiene su PROPIO inventario (prefijo = uid del usuario).
export const cloudIdOf = (code, n) => `${S.user.uid}_${docIdOf(code, n)}`;

export function roomMaps(db) {
  const L = new Map(db.locals.map((x) => [x.id, x]));
  const A = new Map(db.areas.map((x) => [x.id, x]));
  const R = new Map(db.rooms.map((x) => [x.id, x]));
  return { L, A, R, names(roomId) {
    const r = R.get(roomId); if (!r) return null;
    const a = A.get(r.areaId); const l = a && L.get(a.localId);
    return a && l ? { local: l.name, area: a.name, room: r.name } : null;
  } };
}
export const payloadOf = (a, n) => ({
  code: String(a.code), local: n.local, area: n.area, room: n.room,
  type: a.type || '', detail: a.detail || '', state: a.state || 'Bueno',
  registered: !!a.registered, isDuplicateClone: !!a.isDuplicateClone, areaMismatch: !!a.areaMismatch, fromExcel: !!a.fromExcel,
  registeredAt: a.registeredAt || null, encargados: a.encargados || '',
  sourceArea: a.sourceArea || '', sourceRoom: a.sourceRoom || '', grupo: a.grupo || ''
});
export const sigOf = (p) => JSON.stringify(p);
