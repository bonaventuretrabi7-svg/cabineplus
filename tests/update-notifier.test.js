'use strict';
// js/update-notifier.js enregistre un vrai service worker (API navigateur
// indisponible sous Node) — ces tests mockent navigator.serviceWorker et un
// DOM minimal (juste les méthodes réellement utilisées) pour vérifier la
// logique de décision : n'affiche la bannière qu'une fois, la reporte tant
// qu'une modale est ouverte, et la réaffiche dès qu'elle se ferme. Le rendu
// visuel réel (voir la capture d'écran faite en session) doit être revérifié
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

function makeEventTarget() {
  const listeners = {};
  return {
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    _fire(type, ev) { (listeners[type] || []).slice().forEach(fn => fn(ev)); },
  };
}

// withWaiting: une mise à jour est déjà en attente au moment de register()
// (cas "déployée pendant que le client n'utilisait pas l'app").
function makeFakeServiceWorker({ withWaiting = false } = {}) {
  const registration = Object.assign(makeEventTarget(), {
    waiting: withWaiting ? { postMessage() {} } : null,
    installing: null,
    update() {},
  });
  const container = Object.assign(makeEventTarget(), {
    controller: {}, // une page déjà contrôlée par un ancien SW — sinon rien à notifier
    register: async () => registration,
  });
  return { registration, container };
}

function load({ dom, navigatorOverride, reload = () => {} }) {
  const sandbox = {
    console,
    document: dom.document,
    navigator: navigatorOverride,
    window: { location: { reload } },
    setInterval: () => 0,
  };
  vm.createContext(sandbox);
  const src = fs.readFileSync(SRC_PATH, 'utf8');
  vm.runInContext(src + '\nthis.UpdateNotifier = UpdateNotifier;', sandbox, { filename: SRC_PATH });
  return sandbox.UpdateNotifier;
}

test('aucun navigator.serviceWorker : init() ne fait rien, jamais d\'erreur', async () => {
  const dom = makeFakeDom();
  const UpdateNotifier = load({ dom, navigatorOverride: {} });
  await UpdateNotifier.init();
  assert.strictEqual(dom.bannerEl.classList.contains('upb-show'), false);
});

test('mise à jour déjà en attente au chargement : la bannière s\'affiche', async () => {
  const dom = makeFakeDom();
  const { container } = makeFakeServiceWorker({ withWaiting: true });
  const UpdateNotifier = load({ dom, navigatorOverride: { serviceWorker: container } });
  await UpdateNotifier.init();
  assert.strictEqual(dom.bannerEl.classList.contains('upb-show'), true);
});

test('une modale est ouverte : l\'affichage est reporté, pas annulé', async () => {
  const dom = makeFakeDom({ modalOpenInitially: true });
  const { container } = makeFakeServiceWorker({ withWaiting: true });
  const UpdateNotifier = load({ dom, navigatorOverride: { serviceWorker: container } });
  await UpdateNotifier.init();
  assert.strictEqual(dom.bannerEl.classList.contains('upb-show'), false, 'ne doit pas interrompre une action en cours');

  dom.setModalOpen(false);
  dom.fireClick(); // simule la fermeture de la modale (clic sur le bouton "Fermer" par ex.)
  assert.strictEqual(dom.bannerEl.classList.contains('upb-show'), true, 'doit s\'afficher dès que la modale se ferme');
});

test('updatefound + installed avec un controller déjà actif : affiche la bannière', async () => {
  const dom = makeFakeDom();
  const { container, registration } = makeFakeServiceWorker();
  const UpdateNotifier = load({ dom, navigatorOverride: { serviceWorker: container } });
  await UpdateNotifier.init();
  assert.strictEqual(dom.bannerEl.classList.contains('upb-show'), false);

  const newWorker = Object.assign(makeEventTarget(), { state: 'installing' });
  registration.installing = newWorker;
  registration._fire('updatefound');
  newWorker.state = 'installed';
  newWorker._fire('statechange');

  assert.strictEqual(dom.bannerEl.classList.contains('upb-show'), true);
});

test('ne s\'affiche qu\'une seule fois : un second événement ne relance rien', async () => {
  const dom = makeFakeDom();
  const { container, registration } = makeFakeServiceWorker({ withWaiting: true });
  const UpdateNotifier = load({ dom, navigatorOverride: { serviceWorker: container } });
  await UpdateNotifier.init();
  assert.strictEqual(dom.bannerEl.classList.contains('upb-show'), true);

  dom.bannerEl.classList.remove('upb-show'); // simule un dismiss() manuel
  registration._fire('updatefound'); // un événement redondant ne doit pas la refaire apparaître
  assert.strictEqual(dom.bannerEl.classList.contains('upb-show'), false);
});

test('applyUpdate() : poste SKIP_WAITING et recharge au controllerchange', async () => {
  const dom = makeFakeDom();
  const { container, registration } = makeFakeServiceWorker({ withWaiting: true });
  let posted = null;
  registration.waiting.postMessage = (msg) => { posted = msg; };
  let reloaded = false;
  const UpdateNotifier = load({ dom, navigatorOverride: { serviceWorker: container }, reload: () => { reloaded = true; } });
  await UpdateNotifier.init();

  UpdateNotifier.applyUpdate();
  assert.strictEqual(posted, 'SKIP_WAITING');
  assert.strictEqual(reloaded, false, 'ne recharge pas avant que le nouveau SW ait réellement pris le contrôle');

  container._fire('controllerchange');
  assert.strictEqual(reloaded, true);
});

test('dismiss() : masque la bannière sans recharger ni forcer la mise à jour', async () => {
  const dom = makeFakeDom();
  const { container } = makeFakeServiceWorker({ withWaiting: true });
  let reloaded = false;
  const UpdateNotifier = load({ dom, navigatorOverride: { serviceWorker: container }, reload: () => { reloaded = true; } });
  await UpdateNotifier.init();
  assert.strictEqual(dom.bannerEl.classList.contains('upb-show'), true);

  UpdateNotifier.dismiss();
  assert.strictEqual(dom.bannerEl.classList.contains('upb-show'), false);
  assert.strictEqual(reloaded, false);
});
