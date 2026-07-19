'use strict';
// js/update-notifier.js gère deux mécanismes distincts :
//  - App Android empaquetée (window.Capacitor) : compare une version locale
//    embarquée à une version distante hébergée en ligne (deux fichiers) et
//    propose un téléchargement manuel de l'APK (impossible d'installer sans
//    action du client, contrainte Android).
//  - Site web (client/cabine/admin) : capture la version avec laquelle
//    l'onglet a été chargé, la revérifie périodiquement (un seul fichier,
//    même origine) et recharge la page automatiquement dès qu'un
//    déploiement plus récent est détecté — sauf pendant qu'une modale est
//    ouverte (reporté au tick suivant).
// fetch()/setInterval()/setTimeout() étant indisponibles tels quels sous
// Node, ces tests mockent window.Capacitor, fetch() et les timers pour
// vérifier la logique de décision. Le rendu visuel réel doit être revérifié
// à l'œil après toute modification de ce fichier.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC_PATH = path.join(__dirname, '..', 'js', 'update-notifier.js');

function makeFakeDom({ modalOpenInitially = false } = {}) {
  let modalOpen = modalOpenInitially;
  const clickListeners = [];
  const bannerEl = {
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
  };
  const document = {
    getElementById: (id) => (id === 'update-banner' ? bannerEl : null),
    querySelector: (sel) => (sel === '.modal-overlay.open' && modalOpen ? {} : null),
    addEventListener: (type, fn) => { if (type === 'click') clickListeners.push(fn); },
  };
  return {
    document,
    bannerEl,
    setModalOpen: (v) => { modalOpen = v; },
    fireClick: () => clickListeners.forEach(fn => fn({})),
  };
}

// local/remote : numéros de version renvoyés par le fichier "embarqué" vs
// "en ligne" (app native, deux fichiers distincts). failLocal/failRemote :
// simule une réponse HTTP en erreur (fichier absent). throwOnFetch : simule
// une exception (hors ligne).
function makeFakeFetch({ local = 1, remote = 1, failLocal = false, failRemote = false, throwOnFetch = false } = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (throwOnFetch) throw new Error('network unavailable');
    const isRemote = /^https?:\/\//.test(url);
    if (isRemote) return failRemote ? { ok: false } : { ok: true, json: async () => ({ version: remote }) };
    return failLocal ? { ok: false } : { ok: true, json: async () => ({ version: local }) };
  };
  fn.calls = calls;
  return fn;
}

// Site web : un seul fichier interrogé plusieurs fois (chargement initial +
// chaque tick de sondage) — `versions[i]` est la réponse du i-ème appel (le
// dernier élément se répète si davantage d'appels sont faits).
function makeSequenceFetch(versions) {
  const calls = [];
  let i = 0;
  const fn = async (url) => {
    calls.push(url);
    const v = versions[Math.min(i, versions.length - 1)];
    i++;
    return { ok: true, json: async () => ({ version: v }) };
  };
  fn.calls = calls;
  return fn;
}

// Timers factices : setInterval()/clearInterval() ne déclenchent jamais
// tout seuls (fireInterval() explicite depuis le test, même patron que
// dom.fireClick() ci-dessus) ; setTimeout() exécute immédiatement (pas
// besoin d'attendre un vrai délai dans un test).
function makeFakeTimers() {
  const intervals = [];
  return {
    setInterval: (fn, ms) => { const id = intervals.length; intervals.push({ fn, ms, cleared: false }); return id; },
    clearInterval: (id) => { if (intervals[id]) intervals[id].cleared = true; },
    setTimeout: (fn) => { fn(); return 0; },
    fireInterval: (id = 0) => { const iv = intervals[id]; return (iv && !iv.cleared) ? iv.fn() : Promise.resolve(); },
    intervals,
  };
}

function load({ dom, fetchImpl, timers, isNativeApp = true, open = () => {}, reload = () => {} }) {
  const t = timers || makeFakeTimers();
  const sandbox = {
    console,
    document: dom.document,
    fetch: fetchImpl,
    window: { Capacitor: isNativeApp ? {} : undefined, open, location: { reload } },
    setInterval: t.setInterval,
    clearInterval: t.clearInterval,
    setTimeout: t.setTimeout,
  };
  vm.createContext(sandbox);
  const src = fs.readFileSync(SRC_PATH, 'utf8');
  vm.runInContext(src + '\nthis.UpdateNotifier = UpdateNotifier;', sandbox, { filename: SRC_PATH });
  return sandbox.UpdateNotifier;
}

// isNative() (js/client.js, boot()) : décide si l'écran de chargement doit
// afficher "Vérification de mise à jour…" et attendre la fin de init()
// avant de révéler l'écran de connexion — uniquement pertinent dans l'app.
test('isNative() : reflète window.Capacitor sans appel réseau', () => {
  const dom = makeFakeDom();
  const fetchImpl = makeFakeFetch();
  const nativeApp = load({ dom, fetchImpl, isNativeApp: true });
  assert.strictEqual(nativeApp.isNative(), true);
  assert.strictEqual(fetchImpl.calls.length, 0);

  const webApp = load({ dom, fetchImpl, isNativeApp: false });
  assert.strictEqual(webApp.isNative(), false);
});

test('app native, version en ligne plus récente : la bannière s\'affiche', async () => {
  const dom = makeFakeDom();
  const fetchImpl = makeFakeFetch({ local: 1, remote: 2 });
  const UpdateNotifier = load({ dom, fetchImpl, isNativeApp: true });
  await UpdateNotifier.init();
  assert.strictEqual(dom.bannerEl.classList.contains('upb-show'), true);
});

test('app native, même version : pas de bannière', async () => {
  const dom = makeFakeDom();
  const fetchImpl = makeFakeFetch({ local: 2, remote: 2 });
  const UpdateNotifier = load({ dom, fetchImpl, isNativeApp: true });
  await UpdateNotifier.init();
  assert.strictEqual(dom.bannerEl.classList.contains('upb-show'), false);
});

test('app native, version en ligne plus ancienne (site pas encore redéployé) : pas de bannière', async () => {
  const dom = makeFakeDom();
  const fetchImpl = makeFakeFetch({ local: 3, remote: 2 });
  const UpdateNotifier = load({ dom, fetchImpl, isNativeApp: true });
  await UpdateNotifier.init();
  assert.strictEqual(dom.bannerEl.classList.contains('upb-show'), false);
});

test('app native, fichier distant absent (site jamais déployé avec app-version.json) : pas de bannière, pas d\'erreur', async () => {
  const dom = makeFakeDom();
  const fetchImpl = makeFakeFetch({ local: 1, failRemote: true });
  const UpdateNotifier = load({ dom, fetchImpl, isNativeApp: true });
  await assert.doesNotReject(UpdateNotifier.init());
  assert.strictEqual(dom.bannerEl.classList.contains('upb-show'), false);
});

test('app native, hors ligne (fetch lève une exception) : pas de bannière, pas d\'erreur', async () => {
  const dom = makeFakeDom();
  const fetchImpl = makeFakeFetch({ throwOnFetch: true });
  const UpdateNotifier = load({ dom, fetchImpl, isNativeApp: true });
  await assert.doesNotReject(UpdateNotifier.init());
  assert.strictEqual(dom.bannerEl.classList.contains('upb-show'), false);
});

test('app native, une modale est ouverte : l\'affichage est reporté, pas annulé', async () => {
  const dom = makeFakeDom({ modalOpenInitially: true });
  const fetchImpl = makeFakeFetch({ local: 1, remote: 2 });
  const UpdateNotifier = load({ dom, fetchImpl, isNativeApp: true });
  await UpdateNotifier.init();
  assert.strictEqual(dom.bannerEl.classList.contains('upb-show'), false, 'ne doit pas interrompre une action en cours');

  dom.setModalOpen(false);
  dom.fireClick(); // simule la fermeture de la modale
  assert.strictEqual(dom.bannerEl.classList.contains('upb-show'), true, 'doit s\'afficher dès que la modale se ferme');
});

test('applyUpdate() : ouvre le téléchargement de l\'APK et masque la bannière', async () => {
  const dom = makeFakeDom();
  const fetchImpl = makeFakeFetch({ local: 1, remote: 2 });
  let openedUrl = null;
  const UpdateNotifier = load({ dom, fetchImpl, isNativeApp: true, open: (url) => { openedUrl = url; } });
  await UpdateNotifier.init();
  assert.strictEqual(dom.bannerEl.classList.contains('upb-show'), true);

  UpdateNotifier.applyUpdate();
  assert.match(openedUrl, /\/downloads\/kbineplus\.apk$/);
  assert.strictEqual(dom.bannerEl.classList.contains('upb-show'), false);
});

test('dismiss() : masque la bannière sans rien télécharger', async () => {
  const dom = makeFakeDom();
  const fetchImpl = makeFakeFetch({ local: 1, remote: 2 });
  let opened = false;
  const UpdateNotifier = load({ dom, fetchImpl, isNativeApp: true, open: () => { opened = true; } });
  await UpdateNotifier.init();
  assert.strictEqual(dom.bannerEl.classList.contains('upb-show'), true);

  UpdateNotifier.dismiss();
  assert.strictEqual(dom.bannerEl.classList.contains('upb-show'), false);
  assert.strictEqual(opened, false);
});

// ── Site web (client/cabine/admin) ──────────────────────────────────────

test('site web : init() capture la version chargée sans recharger immédiatement', async () => {
  const dom = makeFakeDom();
  const timers = makeFakeTimers();
  const fetchImpl = makeSequenceFetch([2]);
  let reloaded = false;
  const UpdateNotifier = load({ dom, fetchImpl, timers, isNativeApp: false, reload: () => { reloaded = true; } });
  await UpdateNotifier.init();
  assert.strictEqual(fetchImpl.calls.length, 1, 'doit lire app-version.json une fois au chargement');
  assert.strictEqual(reloaded, false);
  assert.strictEqual(timers.intervals.length, 1, 'doit programmer une vérification périodique');
});

test('site web : un déploiement détecté à un tick de sondage recharge automatiquement la page', async () => {
  const dom = makeFakeDom();
  const timers = makeFakeTimers();
  // 2 au chargement, toujours 2 au 1er tick (rien de nouveau), puis 3 au 2e tick (déploiement).
  const fetchImpl = makeSequenceFetch([2, 2, 3]);
  let reloaded = false;
  const UpdateNotifier = load({ dom, fetchImpl, timers, isNativeApp: false, reload: () => { reloaded = true; } });
  await UpdateNotifier.init();

  await timers.fireInterval();
  assert.strictEqual(reloaded, false, 'même version détectée : pas de rechargement');

  await timers.fireInterval();
  assert.strictEqual(reloaded, true, 'version plus récente détectée : rechargement automatique');
});

test('site web : ne recharge jamais tant qu\'une modale est ouverte (reporté, pas annulé)', async () => {
  const dom = makeFakeDom({ modalOpenInitially: true });
  const timers = makeFakeTimers();
  const fetchImpl = makeSequenceFetch([1, 5, 5]);
  let reloaded = false;
  const UpdateNotifier = load({ dom, fetchImpl, timers, isNativeApp: false, reload: () => { reloaded = true; } });
  await UpdateNotifier.init();

  await timers.fireInterval();
  assert.strictEqual(reloaded, false, 'modale ouverte : le rechargement ne doit jamais interrompre une action en cours');

  dom.setModalOpen(false);
  await timers.fireInterval();
  assert.strictEqual(reloaded, true, 'modale fermée : le déploiement en attente est appliqué au tick suivant');
});

test('site web : hors ligne au chargement, aucune vérification périodique ne démarre', async () => {
  const dom = makeFakeDom();
  const timers = makeFakeTimers();
  const fetchImpl = async () => { throw new Error('offline'); };
  fetchImpl.calls = [];
  const UpdateNotifier = load({ dom, fetchImpl, timers, isNativeApp: false });
  await assert.doesNotReject(UpdateNotifier.init());
  assert.strictEqual(timers.intervals.length, 0, 'sans version de référence, aucun sondage ne doit démarrer');
});

test('site web : fichier absent au chargement (site pas encore déployé avec app-version.json) : pas d\'erreur', async () => {
  const dom = makeFakeDom();
  const timers = makeFakeTimers();
  const fetchImpl = async () => ({ ok: false });
  const UpdateNotifier = load({ dom, fetchImpl, timers, isNativeApp: false });
  await assert.doesNotReject(UpdateNotifier.init());
  assert.strictEqual(timers.intervals.length, 0);
});
