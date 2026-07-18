'use strict';
// DB.partnerApplications.{refresh,create,validate,refuse} (js/db.js) —
// Phase F (mise en conformité temps réel). Ces tests vérifient le
// transport, pas les règles métier (déjà couvertes côté PHP,
// tests-php/PartnerApplicationsTest.php).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDb } = require('./helpers/loadDb');

test('partnerApplications.create() : transporte le payload complet vers le serveur', async () => {
  let sent = null;
  const { DB } = loadDb({
    online: true,
    serverPartnerApplicationsCreate: async (payload) => { sent = payload; return { ok: true }; },
  });
  DB.init();
  const res = await DB.partnerApplications.create({ prenom: 'Jean', nom: 'Kouassi', pin: '1234' });
  assert.equal(res.ok, true);
  assert.equal(sent.prenom, 'Jean');
  assert.equal(sent.pin, '1234');
});

test('partnerApplications.refresh() : remplace le cache local par la liste serveur', async () => {
  const { DB } = loadDb({
    online: true,
    serverPartnerApplicationsList: async () => ({ ok: true, applications: [
      { id: 'app1', prenom: 'Jean', nom: 'Kouassi', statut: 'en_attente', date_created: new Date().toISOString() },
    ] }),
  });
  DB.init();
  await DB.partnerApplications.refresh();
  assert.equal(DB.partnerApplications.all().length, 1);
  assert.equal(DB.partnerApplications.all()[0].prenom, 'Jean');
});

test('partnerApplications.validate() : succès -> rafraîchit le cache, renvoie cabineId', async () => {
  const { DB } = loadDb({
    online: true,
    serverPartnerApplicationsValidate: async () => ({ ok: true, cabineId: 'cab-new-1' }),
    serverPartnerApplicationsList: async () => ({ ok: true, applications: [
      { id: 'app1', statut: 'validée', date_created: new Date().toISOString() },
    ] }),
  });
  DB.init();
  const res = await DB.partnerApplications.validate('app1');
  assert.equal(res.ok, true);
  assert.equal(res.cabineId, 'cab-new-1');
  assert.equal(DB.partnerApplications.all()[0].statut, 'validée');
});

test('partnerApplications.refuse() : échec serveur -> erreur renvoyée, pas de refresh', async () => {
  let listCalled = false;
  const { DB } = loadDb({
    online: true,
    serverPartnerApplicationsRefuse: async () => ({ ok: false, error: 'Candidature introuvable ou déjà traitée.' }),
    serverPartnerApplicationsList: async () => { listCalled = true; return { ok: true, applications: [] }; },
  });
  DB.init();
  const res = await DB.partnerApplications.refuse('app1');
  assert.equal(res.ok, false);
  assert.equal(listCalled, false);
});
