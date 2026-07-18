'use strict';
// DB.reclamations.{create,resolve,confirmReceived,relance,requestRefund,refresh}
// et DB.business.processRefundRequest (js/db.js) — Phase 5 (réclamations) :
// la logique métier réelle (CAS de propriété, plafond de relances,
// transitions d'état, suspension automatique à 5 demandes/jour) vit
// désormais côté serveur (api/reclamations_*.php, api/orders_process_refund.php),
// hors de portée de ce harnais JS. Ces tests vérifient uniquement que les
// wrappers transportent correctement la requête/réponse et maintiennent
// le cache local — pas les règles métier elles-mêmes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDb } = require('./helpers/loadDb');

test('create() : client_id/cabine_id locaux ignorés, l\'objet renvoyé par le serveur fait foi', async () => {
  let sentPayload = null;
  const { DB } = loadDb({
    online: true,
    serverReclamationsCreate: async (payload) => { sentPayload = payload; return { ok: true, reclamation: { id: 'recla1', transaction_id: 'txn1', client_id: 'cli-reel', cabine_id: 'cab-reel', statut: 'en_attente' } }; },
  });
  DB.init();

  const res = await DB.reclamations.create({ transaction_id: 'txn1', client_id: 'usurpe', cabine_id: 'usurpe', motif: 'Pas reçu' });
  assert.equal(res.ok, true);
  assert.equal(sentPayload.transactionId, 'txn1');
  assert.equal(sentPayload.motif, 'Pas reçu');
  assert.equal('client_id' in sentPayload, false, 'jamais transmis, le serveur re-dérive de la transaction');
  assert.equal(DB.reclamations.all()[0].client_id, 'cli-reel');
});

test('create() : réclamation déjà existante pour cette commande, transporté tel quel', async () => {
  const { DB } = loadDb({ online: true, serverReclamationsCreate: async () => ({ ok: false, error: 'Une réclamation existe déjà pour cette commande.' }) });
  DB.init();
  const res = await DB.reclamations.create({ transaction_id: 'txn1', motif: 'Pas reçu' });
  assert.equal(res.ok, false);
  assert.match(res.error, /existe déjà/);
});

test('resolve() : succès -> resynchronise les réclamations', async () => {
  let refreshed = false;
  const { DB } = loadDb({
    online: true,
    serverReclamationsResolve: async () => ({ ok: true }),
    serverReclamationsList: async () => { refreshed = true; return { ok: true, reclamations: [] }; },
  });
  DB.init();
  const res = await DB.reclamations.resolve('recla1', 'data:image/png;base64,xxx');
  assert.equal(res.ok, true);
  assert.equal(refreshed, true);
});

test('resolve() : échec (réclamation d\'une autre cabine), transporté tel quel', async () => {
  const { DB } = loadDb({ online: true, serverReclamationsResolve: async () => ({ ok: false, error: 'Réclamation introuvable.' }) });
  DB.init();
  const res = await DB.reclamations.resolve('recla1', 'data:image/png;base64,xxx');
  assert.equal(res.ok, false);
});

test('confirmReceived() : succès -> resynchronise', async () => {
  let refreshed = false;
  const { DB } = loadDb({
    online: true,
    serverReclamationsConfirmReceived: async () => ({ ok: true }),
    serverReclamationsList: async () => { refreshed = true; return { ok: true, reclamations: [] }; },
  });
  DB.init();
  const res = await DB.reclamations.confirmReceived('recla1');
  assert.equal(res.ok, true);
  assert.equal(refreshed, true);
});

test('relance() : transporte le compteur relancesApresPreuve renvoyé par le serveur', async () => {
  // Le mock remplace directement ServerAPI.reclamationsRelance() (déjà
  // transformée en camelCase par le vrai js/server-api.js, jamais le JSON
  // brut de reclamations_relance.php) — voir tests/helpers/loadDb.js.
  const { DB } = loadDb({
    online: true,
    serverReclamationsRelance: async () => ({ ok: true, relancesApresPreuve: 2 }),
  });
  DB.init();
  const res = await DB.reclamations.relance('recla1');
  assert.equal(res.ok, true);
  assert.equal(res.relancesApresPreuve, 2);
});

test('relance() : limite atteinte, transporté tel quel', async () => {
  const { DB } = loadDb({ online: true, serverReclamationsRelance: async () => ({ ok: false, error: 'Limite de relances atteinte.' }) });
  DB.init();
  const res = await DB.reclamations.relance('recla1');
  assert.equal(res.ok, false);
  assert.match(res.error, /Limite/);
});

test('requestRefund() : succès -> resynchronise', async () => {
  let refreshed = false;
  const { DB } = loadDb({
    online: true,
    serverReclamationsRequestRefund: async () => ({ ok: true }),
    serverReclamationsList: async () => { refreshed = true; return { ok: true, reclamations: [] }; },
  });
  DB.init();
  const res = await DB.reclamations.requestRefund('recla1');
  assert.equal(res.ok, true);
  assert.equal(refreshed, true);
});

test('refresh() : upsert par id (met à jour une entrée existante, ajoute une nouvelle)', async () => {
  let serverReclamations = [{ id: 'recla1', statut: 'en_attente' }];
  const { DB } = loadDb({
    online: true,
    serverReclamationsList: async () => ({ ok: true, reclamations: serverReclamations }),
  });
  DB.init();

  await DB.reclamations.refresh();
  assert.equal(DB.reclamations.all().length, 1);
  assert.equal(DB.reclamations.all()[0].statut, 'en_attente');

  // La cabine résout la réclamation entre-temps (vu ici comme un simple
  // changement de ce que le serveur renverra au prochain appel) + une
  // nouvelle réclamation apparaît.
  serverReclamations = [
    { id: 'recla1', statut: 'résolue' },
    { id: 'recla2', statut: 'en_attente' },
  ];
  await DB.reclamations.refresh();
  assert.equal(DB.reclamations.all().find(r => r.id === 'recla1').statut, 'résolue', 'entrée existante mise à jour');
  assert.ok(DB.reclamations.all().find(r => r.id === 'recla2'), 'nouvelle entrée ajoutée');
  assert.equal(DB.reclamations.all().length, 2);
});

test('DB.business.processRefundRequest() : succès -> resynchronise transactions/refundRequests/reclamations', async () => {
  const calls = { transactions: false, refundRequests: false, reclamations: false };
  const { DB } = loadDb({
    online: true,
    serverOrdersProcessRefund: async () => ({ ok: true }),
    serverOrdersList: async () => { calls.transactions = true; return { ok: true, transactions: [] }; },
    serverRefundRequestsList: async () => { calls.refundRequests = true; return { ok: true, refundRequests: [] }; },
    serverReclamationsList: async () => { calls.reclamations = true; return { ok: true, reclamations: [] }; },
  });
  DB.init();
  const res = await DB.business.processRefundRequest('rfr1', 'admin1');
  assert.equal(res.ok, true);
  assert.equal(calls.transactions, true);
  assert.equal(calls.refundRequests, true);
  assert.equal(calls.reclamations, true);
});

test('DB.business.processRefundRequest() : échec (déjà traitée), aucune resynchronisation', async () => {
  let anyRefresh = false;
  const { DB } = loadDb({
    online: true,
    serverOrdersProcessRefund: async () => ({ ok: false, error: 'Demande introuvable ou déjà traitée.' }),
    serverOrdersList: async () => { anyRefresh = true; return { ok: true, transactions: [] }; },
  });
  DB.init();
  const res = await DB.business.processRefundRequest('rfr1', 'admin1');
  assert.equal(res.ok, false);
  assert.equal(anyRefresh, false);
});

test('DB.refundRequests.refresh() : remplace le cache local par la liste serveur', async () => {
  const { DB } = loadDb({
    online: true,
    serverRefundRequestsList: async () => ({ ok: true, refundRequests: [{ id: 'rfr1', statut: 'en_attente' }] }),
  });
  DB.init();
  await DB.refundRequests.refresh();
  assert.equal(DB.refundRequests.all().length, 1);
  assert.equal(DB.refundRequests.all()[0].id, 'rfr1');
});
