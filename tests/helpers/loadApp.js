'use strict';
// Harnais de test combiné pour js/db.js + js/auth.js + js/pull-to-refresh.js
// — les trois se partagent un même contexte vm (comme dans un vrai
// navigateur, les fichiers sont chargés l'un après l'autre dans la même
// page). Étend le patron de tests/helpers/loadDb.js avec les globals
// supplémentaires dont auth.js a besoin (sessionStorage, document minimal).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DB_JS_PATH = path.join(__dirname, '..', '..', 'js', 'db.js');
const AUTH_JS_PATH = path.join(__dirname, '..', '..', 'js', 'auth.js');
const PTR_JS_PATH = path.join(__dirname, '..', '..', 'js', 'pull-to-refresh.js');

function makeStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => { store.clear(); },
    get length() { return store.size; },
  };
}

function makeFakeDate(initialNow) {
  const clock = { now: initialNow };
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(clock.now);
      else super(...args);
    }
    static now() { return clock.now; }
  }
  return { FakeDate, clock };
}

// navigator.onLine + window.addEventListener('online'/'offline') — mêmes
// conventions que tests/helpers/loadDb.js (Net.setOnline() y bascule l'état
// et déclenche les listeners) : utilisé par tests/auth-remote-login.test.js
// pour vérifier que le repli serveur de Auth.login() est bien ignoré hors
// ligne (voir DB.Net.isOnline() dans js/db.js).
function makeNetStubs(initialOnline) {
  const navigatorStub = { userAgent: 'node-test', onLine: initialOnline };
  const listeners = { online: [], offline: [] };
  const windowStub = {
    addEventListener(evt, cb) { if (listeners[evt]) listeners[evt].push(cb); },
    removeEventListener(evt, cb) {
      if (listeners[evt]) listeners[evt] = listeners[evt].filter(l => l !== cb);
    },
    location: { href: '' },
  };
  const net = {
    setOnline(value) {
      navigatorStub.onLine = value;
      const evt = value ? 'online' : 'offline';
      listeners[evt].slice().forEach(cb => cb());
    },
  };
  return { navigatorStub, windowStub, net };
}

/* Charge DB + Auth + PullToRefresh dans un seul contexte vm isolé.
   opts: { initialNow, online, serverConfigured, serverLogin, serverWhoami,
   serverAdminCreateAccount, serverCreateAccount, serverLogout,
   serverGetSettings, serverUpdateSettings } — voir
   tests/auth-remote-login.test.js pour les mocks ServerAPI injectables. */
function loadApp(opts = {}) {
  const initialNow = opts.initialNow ?? Date.now();
  const localStorage = makeStorage();
  const sessionStorage = makeStorage();
  const { FakeDate, clock } = makeFakeDate(initialNow);
  const { navigatorStub, windowStub, net } = makeNetStubs(opts.online ?? true);

  let _token = null;
  const sandbox = {
    localStorage, sessionStorage,
    console,
    Date: FakeDate,
    crypto, atob, btoa, TextEncoder, setTimeout, clearTimeout,
    navigator: navigatorStub,
    window: windowStub,
    document: { addEventListener() {} },
    // Pas de Fmt pré-posé ici : auth.js (chargé juste après db.js, avant
    // tout appel réel à DB.business.*) définit son PROPRE `const Fmt` au
    // niveau module — le prédéfinir sur le sandbox risquerait un conflit
    // de déclaration avec ce `const` au chargement du script.
    // isConfigured: true par défaut, même raison que loadDb.js (voir ce
    // fichier) — un test simule un serveur (api/, PHP+MySQL) joignable ou
    // non, pas l'état "jamais configuré".
    // login/whoami : mocks injectables (voir tests/auth-remote-login.test.js)
    // — Auth.login()/Auth.resumeSession() (js/auth.js) exigent désormais
    // tous les deux une vérification serveur, plus aucun repli local. Un
    // mock renvoyant { ok:false, networkError:true } simule une vraie panne
    // réseau (voir js/server-api.js _call()) plutôt qu'un refus applicatif.
    ServerAPI: {
      isConfigured: opts.serverConfigured ?? true,
      login: opts.serverLogin ?? (async () => ({ ok: false, error: 'Compte introuvable.' })),
      whoami: opts.serverWhoami ?? (async () => ({ ok: false, error: 'Session expirée, reconnectez-vous.' })),
      getToken: () => _token,
      setToken: (t) => { _token = t; },
      adminCreateAccount: opts.serverAdminCreateAccount ?? (async () => ({ ok: false, error: 'not mocked' })),
      createAccount: opts.serverCreateAccount ?? (async () => ({ ok: false, error: 'not mocked' })),
      logout: opts.serverLogout ?? (async () => {}),
      getSettings: opts.serverGetSettings ?? (async () => ({})),
      updateSettings: opts.serverUpdateSettings ?? (async () => ({})),
      // Miroir serveur "appareils connectés" (Phase G) — appelé en
      // best-effort par Auth.login() via DB.partnerDevices.syncSelf(),
      // voir js/auth.js/_applyDeviceBookkeeping(). No-op par défaut pour
      // ne rien changer aux tests existants qui ne le fournissent pas.
      devicesTouch: opts.serverDevicesTouch ?? (async () => ({ ok: true, id: 'dev-row-1' })),
      devicesList: opts.serverDevicesList ?? (async () => ({ ok: true, devices: [] })),
      devicesRemove: opts.serverDevicesRemove ?? (async () => ({ ok: false, error: 'not mocked' })),
    },
  };
  vm.createContext(sandbox);

  const dbSrc = fs.readFileSync(DB_JS_PATH, 'utf8');
  vm.runInContext(dbSrc + '\nthis.DB = DB;', sandbox, { filename: DB_JS_PATH });

  const authSrc = fs.readFileSync(AUTH_JS_PATH, 'utf8');
  vm.runInContext(authSrc + '\nthis.Auth = Auth;', sandbox, { filename: AUTH_JS_PATH });

  const ptrSrc = fs.readFileSync(PTR_JS_PATH, 'utf8');
  vm.runInContext(ptrSrc + '\nthis.PullToRefresh = PullToRefresh;', sandbox, { filename: PTR_JS_PATH });

  return { DB: sandbox.DB, Auth: sandbox.Auth, PullToRefresh: sandbox.PullToRefresh, localStorage, sessionStorage, clock, net };
}

module.exports = { loadApp };
