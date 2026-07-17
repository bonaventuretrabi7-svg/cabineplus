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
   opts: { initialNow, nativeBiometric } — nativeBiometric est le mock du
   plugin Capacitor natif (voir tests/biometric.test.js), omis = biométrie
   indisponible sur l'appareil simulé. */
function loadApp(opts = {}) {
  const initialNow = opts.initialNow ?? Date.now();
  const localStorage = makeStorage();
  const sessionStorage = makeStorage();
  const { FakeDate, clock } = makeFakeDate(initialNow);

  const sandbox = {
    localStorage, sessionStorage,
    console,
    Date: FakeDate,
    crypto, atob, btoa, TextEncoder,
    navigator: { userAgent: 'node-test', onLine: true },
    window: { addEventListener() {}, removeEventListener() {}, location: { href: '' } },
    document: { addEventListener() {} },
    // Pas de Fmt pré-posé ici : auth.js (chargé juste après db.js, avant
    // tout appel réel à DB.business.*) définit son PROPRE `const Fmt` au
    // niveau module — le prédéfinir sur le sandbox risquerait un conflit
    // de déclaration avec ce `const` au chargement du script.
    SupabaseAPI: { client: opts.supabaseClient ?? null },
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

  return { DB: sandbox.DB, Auth: sandbox.Auth, BiometricAuth: sandbox.BiometricAuth, PullToRefresh: sandbox.PullToRefresh, localStorage, sessionStorage, clock };
}

module.exports = { loadApp };
