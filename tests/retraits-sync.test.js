'use strict';
// DB.retraits.{process,setInfo,refresh} (js/db.js) — Phase D (mise en
// conformité temps réel) : corrige un bug financier réel où le débit
// admin d'un retrait cabine n'était jamais persisté côté serveur. Ces
// tests vérifient le transport JS<->serveur, pas les règles métier
// (CAS/délai de 24h), déjà couvertes côté PHP (tests-php/RetraitsTest.php).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDb } = require('./helpers/loadDb');

test('retraits.process() : succès -> rafraîchit le cache local depuis le serveur', async () => {
  const { DB } = loadDb({
    online: true,
    serverRetraitsCreate: async () => ({ ok: true }),
    serverRetraitsList: async () => ({ ok: true, retraits: [
      { id: 'r1', cabine_id: 'cab1', montant: 2000, statut: 'terminé', date: new Date().toISOString() },
    ] }),
  });
  DB.init();
  const res = await DB.retraits.process('cab1', 2000);
  assert.equal(res.ok, true);
  assert.equal(DB.retraits.byCabine('cab1').length, 1);
});

test('retraits.process() : échec serveur (solde insuffisant) -> pas de rafraîchissement, erreur renvoyée', async () => {
  let listCalled = false;
  const { DB } = loadDb({
    online: true,
    serverRetraitsCreate: async () => ({ ok: false, error: 'Le montant dépasse le solde disponible.' }),
    serverRetraitsList: async () => { listCalled = true; return { ok: true, retraits: [] }; },
  });
  DB.init();
  const res = await DB.retraits.process('cab1', 999999);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Le montant dépasse le solde disponible.');
  assert.equal(listCalled, false);
});

test('retraits.setInfo() : transporte paiementVers/numeroCompte/targetId vers le serveur', async () => {
  let sentPayload = null;
  const { DB } = loadDb({
    online: true,
    serverCabineSetRetraitInfo: async (payload) => { sentPayload = payload; return { ok: true }; },
  });
  DB.init();
  const res = await DB.retraits.setInfo('Orange Money', '0700000000', 'cab1');
  assert.equal(res.ok, true);
  // Comparaison champ par champ plutôt qu'un deepEqual d'objet entier :
  // sentPayload vient du contexte vm sandboxé (loadDb.js), dont l'Object
  // natif diffère de celui de ce process de test (deepEqual le signale à
  // tort comme "not reference-equal" malgré un contenu identique).
  assert.equal(sentPayload.paiementVers, 'Orange Money');
  assert.equal(sentPayload.numeroCompte, '0700000000');
  assert.equal(sentPayload.targetId, 'cab1');
});
