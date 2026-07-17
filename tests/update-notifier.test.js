'use strict';
// js/update-notifier.js ne concerne que l'app Android empaquetée (jamais le
// site web, voir le fichier) : compare une version locale embarquée à une
// version distante hébergée en ligne, toutes deux lues via fetch() (API
// indisponible telle quelle sous Node) — ces tests mockent window.Capacitor
// (détection app native) et fetch() pour vérifier la logique de décision.
// Le rendu visuel réel doit être revérifié à l'œil après toute modification
// de ce fichier.
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
// "en ligne". failLocal/failRemote : simule une réponse HTTP en erreur
// (fichier absent). throwOnFetch : simule une exception (hors ligne).
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

function load({ dom, fetchImpl, isNativeApp = true, open = () => {} }) {
  const sandbox = {
    console,
    document: dom.document,
    fetch: fetchImpl,
    window: { Capacitor: isNativeApp ? {} : undefined, open },
  };
  vm.createContext(sandbox);
  const src = fs.readFileSync(SRC_PATH, 'utf8');
  vm.runInContext(src + '\nthis.UpdateNotifier = UpdateNotifier;', sandbox, { filename: SRC_PATH });
  return sandbox.UpdateNotifier;
}

test('site web (pas d\'app native) : init() ne fait rien, aucun appel réseau', async () => {
  const dom = makeFakeDom();
  const fetchImpl = makeFakeFetch({ local: 1, remote: 2 });
  const UpdateNotifier = load({ dom, fetchImpl, isNativeApp: false });
  await UpdateNotifier.init();
  assert.strictEqual(dom.bannerEl.classList.contains('upb-show'), false);
  assert.strictEqual(fetchImpl.calls.length, 0, 'ne doit jamais vérifier depuis le site web');
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

test('une modale est ouverte : l\'affichage est reporté, pas annulé', async () => {
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
