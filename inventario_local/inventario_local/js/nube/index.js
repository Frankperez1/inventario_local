// index.js - Punto de entrada del módulo de nube. Expone window.Nube = { init, notify, enabled } para app.js.
//   - Si firebase-config.js no tiene datos, no hace nada (la app sigue 100 % local).
import { S } from './estado.js';
import { notify, pushNow, startListener, stopListener } from './sync.js';
import { loadProfile, watchProfile, stopWatchProfile, applyAccess, resetAccess, accessKeyOf } from './perfil.js';
import { startAvisos, stopAvisos } from './avisos.js';
import { buildUI, setState, refreshDock } from './ui.js';
import { showGate, hideGate, updateNet, gateIsLoading, setGateError } from './acceso.js';

const noop = () => {};
window.Nube = { init: noop, notify: noop, enabled: false };

const cfg = window.FIREBASE_CONFIG;
if (cfg && cfg.apiKey && window.firebase && firebase.firestore && firebase.auth) {
  S.cfg = cfg;

  const init = (options) => {
    S.ctx = options; window.Nube.enabled = true;
    firebase.initializeApp(cfg);
    S.fdb = firebase.firestore(); S.auth = firebase.auth();
    S.auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});
    S.fdb.enablePersistence({ synchronizeTabs: true }).catch((e) => console.warn('Nube: sin caché sin conexión', e && e.code));
    S.ui.applyAccess = applyAccess; S.ui.resetAccess = resetAccess;
    buildUI(() => { S.errorUntil = 0; pushNow(); if (S.user) startListener(); });

    window.addEventListener('online', () => {
      updateNet(); S.errorUntil = 0;
      // si se entró sin conexión con correo y clave, al volver el internet se retoma la sesión de la nube
      if (!S.user && S.offlineUser && S.offlineUser.email && S.offlinePass) {
        S.auth.signInWithEmailAndPassword(S.offlineUser.email, S.offlinePass).then(() => { S.offlinePass = ''; })
          .catch((e) => console.warn('Nube: no se pudo reconectar', e && e.code));
      } else notify();
    });
    window.addEventListener('offline', () => { updateNet(); setState('offline', 'Los cambios se enviarán al volver la conexión'); });

    // Seguro: si Firebase tarda en responder (sin internet), no dejar al usuario atascado en "Verificando…"
    const wait = setTimeout(() => { if (!S.user && gateIsLoading()) showGate('login'); }, 2500);
    S.auth.onAuthStateChanged((u) => {
      clearTimeout(wait);
      S.user = u;
      if (!u) {
        stopListener(); stopAvisos(); stopWatchProfile(); S.profile = null; S.ready = false; refreshDock();
        if (!S.offlineUser) { showGate('login'); setState('nologin'); }
        return;
      }
      S.offlineUser = null; hideGate();
      setState('sync', 'Preparando…');
      loadProfile(u).then(async (p) => {
        if (p.activo === false) { await S.auth.signOut(); showGate('login'); setGateError('Su usuario está desactivado. Consulte al administrador.'); return; }
        S.profile = p; S.accessKey = accessKeyOf(p); S.ready = false; refreshDock(); startAvisos(); applyAccess();
        // si el administrador cambia sus grupos mientras tiene la sesión abierta, se actualiza solo
        watchProfile(u, async (np) => {
          if (np.activo === false) { await S.auth.signOut(); resetAccess(); showGate('login'); setGateError('Su usuario está desactivado. Consulte al administrador.'); return; }
          refreshDock(); applyAccess();
          // si cambió su rol o sus grupos, se reinician las descargas para traer lo del grupo nuevo
          const k = accessKeyOf(np);
          if (k !== S.accessKey) { S.accessKey = k; startAvisos(); if (S.ready) startListener(); }
        });
        return Promise.resolve(S.ctx.ready).then(() => { S.ready = true; applyAccess(); startListener(); pushNow(); });
      });
    });
  };
  window.Nube = { init, notify, enabled: false };
}
