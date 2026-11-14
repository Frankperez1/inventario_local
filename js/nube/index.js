// index.js - Punto de entrada del módulo de nube. Expone window.Nube = { init, notify, enabled } para app.js.
//   - Si firebase-config.js no tiene datos, no hace nada (la app sigue 100 % local).
import { S } from './estado.js';
import { notify, pushNow, startListener, stopListener } from './sync.js';
import { loadProfile, watchProfile, stopWatchProfile, applyAccess, resetAccess, accessKeyOf, userName, userDni, userId } from './perfil.js';
import { startAvisos, stopAvisos, showToast } from './avisos.js';
import { buildUI, setState, refreshDock } from './ui.js';
import { showGate, hideGate, updateNet, gateIsLoading, setGateError, enterLocalMode } from './acceso.js';

const noop = () => {};
window.Nube = { init: noop, notify: noop, enabled: false, userName: () => '', userDni: () => '', userId: () => '' };

const cfg = window.FIREBASE_CONFIG;
if (cfg && cfg.apiKey && window.firebase && firebase.firestore && firebase.auth) {
  S.cfg = cfg;

  const init = (options) => {
    S.ctx = options; window.Nube.enabled = true;
    firebase.initializeApp(cfg);
    S.fdb = firebase.firestore(); S.auth = firebase.auth(); S.auth.languageCode = 'es';   // correos de Firebase en español
    S.auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});
    S.fdb.enablePersistence({ synchronizeTabs: true }).catch((e) => console.warn('Nube: sin caché sin conexión', e && e.code));
    S.ui.applyAccess = applyAccess; S.ui.resetAccess = resetAccess;
    buildUI(() => { S.errorUntil = 0; pushNow(); if (S.user) startListener(); });

    window.addEventListener('online', () => {
      updateNet(); S.errorUntil = 0; S.notifyUpload = true; S.warnedLogin = false;
      // si se entró sin conexión con correo y clave, al volver el internet se retoma la sesión de la nube
      if (!S.user && S.offlineUser && S.offlineUser.email && S.offlinePass) {
        showToast('☁ Conexión recuperada', 'Retomando su sesión para subir sus datos…', 'ok');
        S.auth.signInWithEmailAndPassword(S.offlineUser.email, S.offlinePass).then(() => { S.offlinePass = ''; })
          .catch((e) => console.warn('Nube: no se pudo reconectar', e && e.code));
      } else if (S.user) {
        showToast('☁ Conexión recuperada', 'Subiendo sus cambios a su cuenta…', 'ok');
        notify();
      } else if (S.offlineUser) {
        S.ui.checkLoginWarning(true);   // modo local sin sesión: pedir que inicie sesión para no perder los datos
      }
    });
    window.addEventListener('offline', () => {
      updateNet();
      if (S.user) setState('offline', 'Los cambios se enviarán al volver la conexión');
      else if (!S.offlineUser) enterLocalMode('Sin internet: modo local. Los cambios quedan en este equipo.');   // se pasa solo a modo local
      else { setState('offline', 'Modo local: los cambios quedan en este equipo.'); S.ui.checkLoginWarning(); }
    });

    // Seguro: si Firebase tarda en responder (sin internet), no dejar al usuario atascado en "Verificando…"
    const wait = setTimeout(() => { if (!S.user && gateIsLoading()) { navigator.onLine ? showGate('login') : enterLocalMode(); } }, 2500);
    S.auth.onAuthStateChanged((u) => {
      clearTimeout(wait);
      S.user = u;
      if (!u) {
        stopListener(); stopAvisos(); stopWatchProfile(); S.profile = null; S.ready = false; refreshDock();
        if (!S.offlineUser) {
          // sin sesión y sin internet: modo local automático (salvo que haya cerrado sesión a propósito)
          if (!navigator.onLine && !S.manualOut) enterLocalMode('Sin internet: modo local. Los cambios quedan en este equipo; inicie sesión cuando vuelva la conexión.');
          else { showGate('login'); setState('nologin'); }
        }
        S.manualOut = false;
        return;
      }
      S.offlineUser = null; S.manualOut = false; S.notifyUpload = true; S.warnedLogin = false; hideGate();
      if (S.ui.checkLoginWarning) S.ui.checkLoginWarning();
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
  window.Nube = { init, notify, enabled: false, userName, userDni, userId };
}
