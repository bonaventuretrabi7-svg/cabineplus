'use strict';
// Harnais de test combiné pour js/db.js + js/auth.js + js/biometric.js +
// js/pull-to-refresh.js — les quatre se partagent un même contexte vm
// (comme dans un vrai navigateur, les fichiers sont chargés l'un après
// l'autre dans la même page). Étend le patron de tests/helpers/loadDb.js
// avec les globals supplémentaires dont auth.js/biometric.js ont besoin
// (sessionStorage, document minimal, NativeBiometric injectable — le
// plugin Capacitor natif, mocké ici).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DB_JS_PATH = path.join(__dirname, '..', '..', 'js', 'db.js');
const AUTH_JS_PATH = path.join(__dirname, '..', '..', 'js', 'auth.js');
const BIOMETRIC_JS_PATH = path.join(__dirname, '..', '..', 'js', 'biometric.js');
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

/* Charge DB + Auth + BiometricAuth dans un seul contexte vm isolé.
   opts: { initialNow, nativeBiometric, webauthn } — nativeBiometric est le
   mock du plugin Capacitor natif, webauthn celui de l'API navigateur
   (voir tests/biometric.test.js) : { available, create(options), get(options) },
   create/get renvoient un objet credential-like ou rejettent comme le
   ferait navigator.credentials. Omis = biométrie indisponible sur
   l'appareil simulé (aucun des deux ponts). */
// navigator.onLine + window.addEventListener('online'/'offline') — mêmes
// conventions que tests/helpers/loadDb.js (Net.setOnline() y bascule l'état
// et déclenche les listeners) : utilisé par tests/auth-remote-login.test.js
// pour vérifier que le repli serveur de Auth.login() est bien ignoré hors
// ligne (voir DB.Net.isOnline() dans js/db.js).
function makeNetStubs(initialOnline) {
  const navigatorStub = { userAgent: 'node-test', onLine: initialOnline, credentials: undefined };
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

function loadApp(opts = {}) {
  const initialNow = opts.initialNow ?? Date.now();
  const localStorage = makeStorage();
  const sessionStorage = makeStorage();
  const { FakeDate, clock } = makeFakeDate(initialNow);
  const { navigatorStub, windowStub, net } = makeNetStubs(opts.online ?? true);

  // window.PublicKeyCredential et le PublicKeyCredential global doivent
  // être le même objet (voir _webauthnSupported() vs checkAvailability()
  // dans js/biometric.js, qui lisent l'un puis l'autre) — dans un vrai
  // navigateur, window EST déjà le scope global, donc les deux coïncident
  // naturellement ; ici il faut les poser explicitement sur les deux.
  const publicKeyCredential = opts.webauthn
    ? { isUserVerifyingPlatformAuthenticatorAvailable: async () => !!opts.webauthn.available }
    : undefined;
  const credentialsContainer = opts.webauthn
    ? {
        create: (o) => opts.webauthn.create(o),
        get: (o) => opts.webauthn.get(o),
      }
    : undefined;

  const sandbox = {
    localStorage, sessionStorage,
    console,
    Date: FakeDate,
    crypto, atob, btoa, TextEncoder,
    navigator: Object.assign(navigatorStub, { credentials: credentialsContainer }),
    window: Object.assign(windowStub, { PublicKeyCredential: publicKeyCredential }),
    document: { addEventListener() {} },
    PublicKeyCredential: publicKeyCredential,
    // Pas de Fmt pré-posé ici : auth.js (chargé juste après db.js, avant
    // tout appel réel à DB.business.*) définit son PROPRE `const Fmt` au
    // niveau module — le prédéfinir sur le sandbox risquerait un conflit
    // de déclaration avec ce `const` au chargement du script.
    // isConfigured: true par défaut, même raison que loadDb.js (voir ce
    // fichier) — un test simule un serveur (api/, PHP+MySQL) joignable ou
    // non, pas l'état "jamais configuré".
    // login : mock injectable (voir tests/auth-remote-login.test.js) — le
    // repli serveur de Auth.login() (js/auth.js) l'appelle quand un compte
    // est absent/incorrect localement ; par défaut simule "jamais vu côté
    // serveur non plus", pour ne rien changer aux tests existants qui
    // n'injectent pas ce mock.
    ServerAPI: {
      isConfigured: opts.serverConfigured ?? true,
      login: opts.serverLogin ?? (async () => ({ ok: false, error: 'Compte introuvable.' })),
      // establishSession : appelé en arrière-plan par Auth.login() après une
      // connexion admin réussie via le chemin local (voir js/auth.js) — mock
      // injectable pour tests/auth-remote-login.test.js, no-op par défaut.
      establishSession: opts.serverEstablishSession ?? (async () => ({ ok: false })),
      adminCreateAccount: opts.serverAdminCreateAccount ?? (async () => ({ ok: false, error: 'not mocked' })),
      createAccount: opts.serverCreateAccount ?? (async () => ({ ok: false, error: 'not mocked' })),
      logout: opts.serverLogout ?? (async () => {}),
      getSettings: opts.serverGetSettings ?? (async () => ({})),
      updateSettings: opts.serverUpdateSettings ?? (async () => ({})),
    },
    NativeBiometric: opts.nativeBiometric,
  };
  vm.createContext(sandbox);

  const dbSrc = fs.readFileSync(DB_JS_PATH, 'utf8');
  vm.runInContext(dbSrc + '\nthis.DB = DB;', sandbox, { filename: DB_JS_PATH });

  const authSrc = fs.readFileSync(AUTH_JS_PATH, 'utf8');
  vm.runInContext(authSrc + '\nthis.Auth = Auth;', sandbox, { filename: AUTH_JS_PATH });

  const bioSrc = fs.readFileSync(BIOMETRIC_JS_PATH, 'utf8');
  vm.runInContext(bioSrc + '\nthis.BiometricAuth = BiometricAuth;', sandbox, { filename: BIOMETRIC_JS_PATH });

  const ptrSrc = fs.readFileSync(PTR_JS_PATH, 'utf8');
  vm.runInContext(ptrSrc + '\nthis.PullToRefresh = PullToRefresh;', sandbox, { filename: PTR_JS_PATH });

  return { DB: sandbox.DB, Auth: sandbox.Auth, BiometricAuth: sandbox.BiometricAuth, PullToRefresh: sandbox.PullToRefresh, localStorage, sessionStorage, clock, net };
}

module.exports = { loadApp };
