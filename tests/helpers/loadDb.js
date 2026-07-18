'use strict';
// Harnais de test pour js/db.js — un IIFE global écrit pour le navigateur
// (pas de module.exports). Plutôt que de le réécrire, on charge son code
// source dans un contexte vm Node avec les globals minimaux dont il a
// besoin (localStorage, Fmt, une horloge Date contrôlable, un navigator/
// window simulés pour Net), et on récupère l'objet DB qui en résulte.
// Aucune modification de js/db.js pour ça.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DB_JS_PATH = path.join(__dirname, '..', '..', 'js', 'db.js');

/* localStorage — Map en mémoire, API minimale utilisée par js/db.js. */
function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => { store.clear(); },
    get length() { return store.size; },
  };
}

/* Horloge contrôlable : `new Date()` (sans argument) et `Date.now()`
   utilisent la valeur courante de `clock.now` ; `new Date(x)` garde le
   comportement natif (parsing de timestamp/chaîne ISO inchangé). Permet
   de simuler le passage du temps (3 min, 8 min, minuit, 24h) sans vrai
   setTimeout dans les tests. */
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

/* navigator.onLine + window.addEventListener('online'/'offline') — assez
   pour DB.Net (voir js/db.js). `net.setOnline(bool)` bascule l'état ET
   déclenche les callbacks enregistrés via Net.onChange(), comme le ferait
   un vrai changement de connectivité. */
function makeNetStubs(initialOnline) {
  const navigatorStub = { onLine: initialOnline };
  const listeners = { online: [], offline: [] };
  const windowStub = {
    addEventListener(evt, cb) { if (listeners[evt]) listeners[evt].push(cb); },
    removeEventListener(evt, cb) {
      if (listeners[evt]) listeners[evt] = listeners[evt].filter(l => l !== cb);
    },
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

/* Stub minimal de Fmt (js/db.js n'utilise que .ref()/.money() en interne —
   voir le format réel dans js/client.js si un test a besoin de plus). */
const FmtStub = {
  ref: (id) => '#' + String(id).slice(-6),
  money: (n) => String(n) + ' FCFA',
  operator: (o) => o,
  phone: (p) => p,
  datetime: (d) => new Date(d).toISOString(),
};

/* Charge une instance fraîche de DB dans un contexte vm isolé.
   `opts` : soit un nombre (initialNow, forme historique), soit un objet
   { initialNow, online = true, serverGetSettings, serverUpdateSettings,
   serverConfigured }. */
function loadDb(opts = {}) {
  const options = typeof opts === 'number' ? { initialNow: opts } : opts;
  const initialNow = options.initialNow ?? Date.now();
  const online = options.online ?? true;

  const src = fs.readFileSync(DB_JS_PATH, 'utf8');
  const localStorage = makeLocalStorage();
  const { FakeDate, clock } = makeFakeDate(initialNow);
  const { navigatorStub, windowStub, net } = makeNetStubs(online);

  const sandbox = {
    localStorage,
    console,
    Date: FakeDate,
    crypto,
    atob, btoa,
    Fmt: FmtStub,
    navigator: navigatorStub,
    window: windowStub,
    // DB.settings pousse ses écritures vers ServerAPI quand une connexion
    // est là (voir SYNC_HANDLERS.settings, js/db.js) — un test hors-ligne
    // peut laisser les mocks par défaut (jamais appelés, Net.isOnline() le
    // court-circuite), un test de synchronisation fournit getSettings/
    // updateSettings. isConfigured : true par défaut (un test simule un
    // serveur joignable ou non, pas l'état "jamais configuré" — passer
    // serverConfigured:false explicitement pour tester ce cas précis).
    ServerAPI: {
      isConfigured: options.serverConfigured ?? true,
      getSettings: options.serverGetSettings || (async () => ({})),
      updateSettings: options.serverUpdateSettings || (async () => ({})),
      // Favoris / journaux d'audit (voir tests/favoris-sync.test.js) — mocks
      // injectables, no-op par défaut pour ne rien changer aux tests
      // existants qui ne les fournissent pas.
      favorisList: options.serverFavorisList || (async () => ({ ok: true, favoris: [] })),
      favorisCreate: options.serverFavorisCreate || (async () => ({ ok: false, error: 'not mocked' })),
      favorisRemove: options.serverFavorisRemove || (async () => ({ ok: false, error: 'not mocked' })),
      // Présence (voir tests/presence-sync.test.js) — no-op par défaut :
      // DB.presence.ping() appelle ceci en tâche de fond dès que online:true
      // (défaut de ce harnais), donc TOUS les tests existants qui pinguent
      // sans fournir ce mock (ex. tests/retards-suspension.test.js) doivent
      // continuer de fonctionner sans erreur.
      presencePing: options.serverPresencePing || (async () => ({ ok: true })),
      presenceOnline: options.serverPresenceOnline || (async () => ({ ok: true, presence: [] })),
      // Moteur de commandes (Phase 4, voir tests/orders-business.test.js) —
      // la logique métier réelle vit désormais côté PHP (api/orders_*.php,
      // non testable depuis ce harnais JS) : ces mocks vérifient seulement
      // que DB.business.* transporte correctement la requête/réponse, pas
      // les règles elles-mêmes (retards, suspension, réattribution...).
      ordersCreate: options.serverOrdersCreate || (async () => ({ ok: false, error: 'not mocked' })),
      ordersAccept: options.serverOrdersAccept || (async () => ({ ok: false, error: 'not mocked' })),
      ordersRefuse: options.serverOrdersRefuse || (async () => ({ ok: false, error: 'not mocked' })),
      ordersAssignPending: options.serverOrdersAssignPending || (async () => ({ ok: true, count: 0 })),
      ordersReassign: options.serverOrdersReassign || (async () => ({ ok: false, error: 'not mocked' })),
      ordersSweep: options.serverOrdersSweep || (async () => ({ ok: true, staleCount: 0, suspendedCabineIds: [] })),
      ordersSweepUnsuspend: options.serverOrdersSweepUnsuspend || (async () => ({ ok: true, liftedCount: 0 })),
      ordersList: options.serverOrdersList || (async () => ({ ok: true, transactions: [] })),
      retardsList: options.serverRetardsList || (async () => ({ ok: true, retards: [] })),
      // Endpoints périphériques (Phase 4, second lot).
      ordersRecharge: options.serverOrdersRecharge || (async () => ({ ok: false, error: 'not mocked' })),
      ordersRefund: options.serverOrdersRefund || (async () => ({ ok: false, error: 'not mocked' })),
      ordersSuspend: options.serverOrdersSuspend || (async () => ({ ok: false, error: 'not mocked' })),
      ordersReactivate: options.serverOrdersReactivate || (async () => ({ ok: false, error: 'not mocked' })),
      cabineSuspendManual: options.serverCabineSuspendManual || (async () => ({ ok: false, error: 'not mocked' })),
      cabineSelfRecharge: options.serverCabineSelfRecharge || (async () => ({ ok: false, error: 'not mocked' })),
      cabineResubscribe: options.serverCabineResubscribe || (async () => ({ ok: false, error: 'not mocked' })),
      adminSetAbonnement: options.serverAdminSetAbonnement || (async () => ({ ok: false, error: 'not mocked' })),
      cabineTransfer: options.serverCabineTransfer || (async () => ({ ok: false, error: 'not mocked' })),
      // Réclamations + demandes de remboursement (Phase 5).
      reclamationsList: options.serverReclamationsList || (async () => ({ ok: true, reclamations: [] })),
      reclamationsCreate: options.serverReclamationsCreate || (async () => ({ ok: false, error: 'not mocked' })),
      reclamationsResolve: options.serverReclamationsResolve || (async () => ({ ok: false, error: 'not mocked' })),
      reclamationsConfirmReceived: options.serverReclamationsConfirmReceived || (async () => ({ ok: false, error: 'not mocked' })),
      reclamationsRelance: options.serverReclamationsRelance || (async () => ({ ok: false, error: 'not mocked' })),
      reclamationsRequestRefund: options.serverReclamationsRequestRefund || (async () => ({ ok: false, error: 'not mocked' })),
      ordersProcessRefund: options.serverOrdersProcessRefund || (async () => ({ ok: false, error: 'not mocked' })),
      refundRequestsList: options.serverRefundRequestsList || (async () => ({ ok: true, refundRequests: [] })),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src + '\nthis.__DB__ = DB;', sandbox, { filename: DB_JS_PATH });

  return { DB: sandbox.__DB__, localStorage, clock, net };
}

module.exports = { loadDb };
