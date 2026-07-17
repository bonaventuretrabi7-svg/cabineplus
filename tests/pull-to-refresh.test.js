'use strict';
// Le geste tactile réel (glisser, résistance perçue au doigt) ne peut pas
// être simulé sous Node — ces tests vérifient uniquement la fonction pure
// d'amortissement (js/pull-to-refresh.js) qui détermine la distance
// visuelle de l'indicateur à partir du déplacement brut du doigt : c'est
// elle qui donne la sensation de résistance progressive, et elle ne
// dépend d'aucun DOM. Le ressenti réel du geste (armé au bon moment,
// neutralisation du pull-to-refresh natif, callbacks par section) doit
// être validé sur un appareil tactile (voir le plan).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/loadApp');

test('computePullDistance(0, max) = 0 — aucun mouvement, aucun tirage', () => {
  const { PullToRefresh } = loadApp();
  assert.strictEqual(PullToRefresh.computePullDistance(0, 100), 0);
});

test('computePullDistance ignore un delta négatif (doigt remonté au-dessus du point de départ)', () => {
  const { PullToRefresh } = loadApp();
  assert.strictEqual(PullToRefresh.computePullDistance(-40, 100), 0);
});

test('résistance progressive : la distance amortie croît moins vite que le mouvement brut', () => {
  const { PullToRefresh } = loadApp();
  const near = PullToRefresh.computePullDistance(20, 100);
  const far  = PullToRefresh.computePullDistance(200, 100);
  // Un mouvement brut 10x plus grand ne donne jamais une distance
  // amortie 10x plus grande — c'est la résistance progressive.
  assert.ok(far / near < 10);
  assert.ok(near < 20);   // toujours strictement en-deçà du mouvement brut...
  assert.ok(far < 200);   // ...même très loin dans le tirage.
});

test('résistance progressive : monotone (tirer plus loin ne fait jamais reculer l\'indicateur)', () => {
  const { PullToRefresh } = loadApp();
  const steps = [0, 10, 25, 50, 90, 150, 300].map(d => PullToRefresh.computePullDistance(d, 100));
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i] > steps[i - 1]);
});

test('résistance progressive : jamais de dépassement de la distance maximale, même sur un tirage extrême', () => {
  const { PullToRefresh } = loadApp();
  // Asymptotique : se rapproche de la borne sans jamais la dépasser (à la
  // précision flottante près, qui arrondit à pile 100 pour un delta énorme).
  assert.ok(PullToRefresh.computePullDistance(100000, 100) <= 100);
  assert.ok(PullToRefresh.computePullDistance(1000, 100) < 100);
  assert.ok(PullToRefresh.computePullDistance(1000, 100) > 99); // très proche de la borne, sans l'atteindre
});

test('register() + les callbacks ne sont pas appelés tant que init() n\'a pas déclenché de refresh', () => {
  const { PullToRefresh } = loadApp();
  let called = false;
  PullToRefresh.register('historique', () => { called = true; });
  assert.strictEqual(called, false);
});
