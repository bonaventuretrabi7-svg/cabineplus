'use strict';
// DB.resetRequests.{refresh,create,apply,refuse} (js/db.js) — Phase E
// (mise en conformité temps réel). Le nouveau PIN est haché côté serveur
// dès la création (api/reset_requests_create.php) : ces tests vérifient
// le transport, pas les règles métier (déjà couvertes côté PHP,
// tests-php/ResetRequestsTest.php).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDb } = require('./helpers/loadDb');

test('resetRequests.create() : transporte role/identifiant/PIN, ne stocke rien en local en cas d\'échec', async () => {
  let sent = null;
  const { DB } = loadDb({
    online: true,
    serverResetRequestsCreate: async (payload) => { sent = payload; return { ok: false, error: 'Aucun compte trouvé.' }; },
  });
  DB.init();
  const res = await DB.resetRequests.create('client', '0700000000', '1234');
  assert.equal(res.ok, false);
  assert.equal(sent.role, 'client');
  assert.equal(sent.identifiant, '0700000000');
  assert.equal(sent.nouveauMotDePasse, '1234');
});

test('resetRequests.refresh() : remplace le cache local par la liste serveur', async () => {
  const { DB } = loadDb({
    online: true,
    serverResetRequestsList: async () => ({ ok: true, resetRequests: [
      { id: 'rr1', role: 'client', telephone: '0700000000', nom: 'Jane Doe', statut: 'en_attente', date_created: new Date().toISOString() },
    ] }),
  });
  DB.init();
  await DB.resetRequests.refresh();
  assert.equal(DB.resetRequests.all().length, 1);
  assert.equal(DB.resetRequests.all()[0].nom, 'Jane Doe');
});

test('resetRequests.apply() : succès -> rafraîchit le cache depuis le serveur', async () => {
  const { DB } = loadDb({
    online: true,
    serverResetRequestsApply: async () => ({ ok: true }),
    serverResetRequestsList: async () => ({ ok: true, resetRequests: [
      { id: 'rr1', role: 'client', statut: 'traité', date_created: new Date().toISOString() },
    ] }),
  });
  DB.init();
  const res = await DB.resetRequests.apply('rr1');
  assert.equal(res.ok, true);
  assert.equal(DB.resetRequests.all()[0].statut, 'traité');
});

test('resetRequests.refuse() : échec serveur -> erreur renvoyée, pas de refresh', async () => {
  let listCalled = false;
  const { DB } = loadDb({
    online: true,
    serverResetRequestsRefuse: async () => ({ ok: false, error: 'Demande introuvable ou déjà traitée.' }),
    serverResetRequestsList: async () => { listCalled = true; return { ok: true, resetRequests: [] }; },
  });
  DB.init();
  const res = await DB.resetRequests.refuse('rr1');
  assert.equal(res.ok, false);
  assert.equal(listCalled, false);
});
