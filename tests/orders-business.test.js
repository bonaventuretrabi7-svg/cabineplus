'use strict';
// DB.business.{createTransfer,acceptRequest,refuseRequest,assignPendingToCabine,
// reassignTransaction,bulkReassign,sweepStaleOrders,sweepAutoUnsuspensions}
// (js/db.js) — Phase 4 (moteur de commandes) : la logique métier réelle
// (débit atomique, CAS de propriété, sélection de cabine, retards,
// suspension...) vit désormais côté serveur (api/orders_*.php,
// api/orders_common.php), hors de portée de ce harnais JS. Ces tests
// vérifient uniquement que les wrappers transportent correctement la
// requête/réponse et maintiennent le cache local (transactions.refresh()) —
// PAS les règles métier elles-mêmes, qui n'ont pour l'instant aucune
// couverture automatisée (aucun framework PHPUnit/composer dans ce dépôt) :
// à valider manuellement contre le serveur réel après déploiement.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDb } = require('./helpers/loadDb');

function setup(DB) {
  DB.init();
  const cabine = DB.users.create({
    prenom: 'Cab', nom: 'Test', telephone: '0700000000', email: 'cab@gmail.com',
    mot_de_passe: '1234', role: 'cabine', solde: 1000, statut: 'actif',
    commissions_total: 0, transferts_total: 0, commandes_renvoyees: 0,
  });
  return { cabine };
}

test('createTransfer() : appelle ServerAPI.ordersCreate et met le résultat en cache local', async () => {
  let sentPayload = null;
  const { DB } = loadDb({
    online: true,
    serverOrdersCreate: async (payload) => { sentPayload = payload; return { ok: true, transaction: { id: 'srv-txn-1', montant: 1000, statut: 'en_attente' } }; },
  });
  DB.init();

  const res = await DB.business.createTransfer({ client_id: 'ignored', operateur: 'Orange', numero_beneficiaire: '0700000001', montant: 1000, service: 'Transfert direct' });
  assert.equal(res.ok, true);
  assert.equal(res.txn.id, 'srv-txn-1');
  assert.equal(sentPayload.operateur, 'Orange');
  assert.equal(DB.transactions.byId('srv-txn-1').montant, 1000);
});

test('createTransfer() : solde insuffisant côté serveur, aucune écriture locale', async () => {
  const { DB } = loadDb({ online: true, serverOrdersCreate: async () => ({ ok: false, error: 'Solde insuffisant (montant + 15 F de frais de service).' }) });
  DB.init();

  const res = await DB.business.createTransfer({ operateur: 'Orange', numero_beneficiaire: '0700000001', montant: 1000000 });
  assert.equal(res.ok, false);
  assert.match(res.error, /Solde insuffisant/);
  assert.equal(DB.transactions.all().length, 0);
});

test('acceptRequest() : crédite la commission localement puis resynchronise', async () => {
  let refreshCalled = false;
  const { DB } = loadDb({
    online: true,
    serverOrdersAccept: async () => ({ ok: true }),
    serverOrdersList: async () => { refreshCalled = true; return { ok: true, transactions: [] }; },
  });
  const { cabine } = setup(DB);
  const txn = DB.transactions.create({ client_id: 'cli1', cabine_id: cabine.id, montant: 1000, commission: 50, statut: 'en_attente' });

  const res = await DB.business.acceptRequest(txn.id, cabine.id);
  assert.equal(res.ok, true);
  const cabAfter = DB.users.byId(cabine.id);
  assert.equal(cabAfter.solde, 1050, 'commission créditée localement tout de suite');
  assert.equal(cabAfter.commissions_total, 50);
  assert.equal(cabAfter.transferts_total, 1);
  assert.equal(refreshCalled, true, 'transactions.refresh() appelé pour récupérer l\'état final (statut terminé)');
});

test('acceptRequest() : échec serveur (déjà traitée par une autre cabine), aucun crédit local', async () => {
  const { DB } = loadDb({ online: true, serverOrdersAccept: async () => ({ ok: false, error: 'Commande déjà traitée ou réattribuée.' }) });
  const { cabine } = setup(DB);
  const txn = DB.transactions.create({ client_id: 'cli1', cabine_id: cabine.id, montant: 1000, commission: 50, statut: 'en_attente' });

  const res = await DB.business.acceptRequest(txn.id, cabine.id);
  assert.equal(res.ok, false);
  assert.equal(DB.users.byId(cabine.id).solde, 1000, 'aucun crédit local si le serveur refuse');
});

test('refuseRequest() : incrémente commandes_renvoyees localement puis resynchronise', async () => {
  const { DB } = loadDb({
    online: true,
    serverOrdersRefuse: async () => ({ ok: true, reassignedTo: 'autre-cabine-id' }),
  });
  const { cabine } = setup(DB);
  const txn = DB.transactions.create({ client_id: 'cli1', cabine_id: cabine.id, montant: 1000, statut: 'en_attente' });

  const res = await DB.business.refuseRequest(txn.id, cabine.id, 'client_absent', null);
  assert.equal(res.ok, true);
  assert.equal(res.reassignedTo, 'autre-cabine-id');
  assert.equal(DB.users.byId(cabine.id).commandes_renvoyees, 1);
});

test('assignPendingToCabine() : ne resynchronise que si count > 0', async () => {
  let refreshCalls = 0;
  const { DB: dbZero } = loadDb({
    online: true,
    serverOrdersAssignPending: async () => ({ ok: true, count: 0 }),
    serverOrdersList: async () => { refreshCalls++; return { ok: true, transactions: [] }; },
  });
  dbZero.init();
  const count0 = await dbZero.business.assignPendingToCabine('cab1');
  assert.equal(count0, 0);
  assert.equal(refreshCalls, 0, 'pas de resynchronisation inutile si rien n\'a été repris');

  const { DB: dbTwo } = loadDb({
    online: true,
    serverOrdersAssignPending: async () => ({ ok: true, count: 2 }),
    serverOrdersList: async () => { refreshCalls++; return { ok: true, transactions: [] }; },
  });
  dbTwo.init();
  const count2 = await dbTwo.business.assignPendingToCabine('cab1');
  assert.equal(count2, 2);
  assert.equal(refreshCalls, 1);
});

test('reassignTransaction() : transporte le résultat individuel depuis orders_reassign.php', async () => {
  const { DB } = loadDb({
    online: true,
    serverOrdersReassign: async (ids, cabineId) => ({
      ok: true, okCount: 1, failCount: 0,
      results: ids.map(id => ({ id, ok: true })),
    }),
  });
  DB.init();
  const res = await DB.business.reassignTransaction('txn1', 'cab2');
  assert.equal(res.ok, true);
});

test('bulkReassign() : agrège okCount/failCount depuis orders_reassign.php', async () => {
  const { DB } = loadDb({
    online: true,
    serverOrdersReassign: async (ids) => ({
      ok: true, okCount: 2, failCount: 1,
      results: [{ id: ids[0], ok: true }, { id: ids[1], ok: true }, { id: ids[2], ok: false, error: 'Commande introuvable ou déjà traitée.' }],
    }),
  });
  DB.init();
  const res = await DB.business.bulkReassign(['txn1', 'txn2', 'txn3'], 'cab2');
  assert.equal(res.okCount, 2);
  assert.equal(res.failCount, 1);
  assert.equal(res.results.length, 3);
});

test('sweepStaleOrders() : resynchronise transactions ET retards seulement si staleCount > 0', async () => {
  let txnRefreshed = false, retardsRefreshed = false;
  const { DB } = loadDb({
    online: true,
    serverOrdersSweep: async () => ({ ok: true, staleCount: 1, suspendedCabineIds: ['cab1'] }),
    serverOrdersList: async () => { txnRefreshed = true; return { ok: true, transactions: [] }; },
    serverRetardsList: async () => { retardsRefreshed = true; return { ok: true, retards: [] }; },
  });
  DB.init();

  const res = await DB.business.sweepStaleOrders();
  assert.equal(res.staleCount, 1);
  assert.deepEqual(res.suspendedCabineIds, ['cab1']);
  assert.equal(txnRefreshed, true);
  assert.equal(retardsRefreshed, true);
});

test('sweepAutoUnsuspensions() : resynchronise transactions seulement si liftedCount > 0', async () => {
  let refreshCalls = 0;
  const { DB } = loadDb({
    online: true,
    serverOrdersSweepUnsuspend: async () => ({ ok: true, liftedCount: 0 }),
    serverOrdersList: async () => { refreshCalls++; return { ok: true, transactions: [] }; },
  });
  DB.init();
  const res = await DB.business.sweepAutoUnsuspensions();
  assert.equal(res.liftedCount, 0);
  assert.equal(refreshCalls, 0);
});

test('DB.transactions.refresh() : upsert par id (met à jour une entrée existante, ajoute une nouvelle)', async () => {
  const { DB } = loadDb({
    online: true,
    serverOrdersList: async () => ({ ok: true, transactions: [
      { id: 'txn1', statut: 'terminé', montant: 500 },
      { id: 'txn2', statut: 'en_attente', montant: 800 },
    ] }),
  });
  DB.init();
  DB.transactions.create({ id: 'txn1', client_id: 'cli1', statut: 'en_attente', montant: 500 });

  await DB.transactions.refresh();
  assert.equal(DB.transactions.byId('txn1').statut, 'terminé', 'entrée existante mise à jour');
  assert.equal(DB.transactions.byId('txn2').montant, 800, 'nouvelle entrée ajoutée');
});

test('DB.transactions.refresh() : purge une commande supprimée côté serveur (orders_delete.php)', async () => {
  const { DB } = loadDb({
    online: true,
    serverOrdersList: async () => ({ ok: true, transactions: [
      { id: 'txn2', statut: 'en_attente', montant: 800 },
    ] }),
  });
  DB.init();
  DB.transactions.create({ id: 'txn1', client_id: 'cli1', statut: 'en_attente', montant: 500 });
  DB.transactions.create({ id: 'txn2', client_id: 'cli1', statut: 'en_attente', montant: 800 });

  await DB.transactions.refresh();
  assert.equal(DB.transactions.byId('txn1'), undefined, 'commande absente de la réponse serveur retirée du cache local');
  assert.equal(DB.transactions.byId('txn2').montant, 800, 'commande toujours présente côté serveur conservée');
});

test('DB.transactions.refresh() : ne purge jamais une commande créée hors ligne, pas encore synchronisée', async () => {
  const { DB } = loadDb({
    online: true,
    serverOrdersList: async () => ({ ok: true, transactions: [] }),
  });
  DB.init();
  const localOnly = DB.transactions.create({ client_id: 'cli1', statut: 'en_attente', montant: 300 });
  assert.match(localOnly.id, /^txn_/);

  await DB.transactions.refresh();
  assert.ok(DB.transactions.byId(localOnly.id), 'commande locale non synchronisée conservée malgré une liste serveur vide');
});

test('DB.retards.refresh() : remplace le cache local par la liste serveur', async () => {
  const { DB } = loadDb({
    online: true,
    serverRetardsList: async () => ({ ok: true, retards: [{ id: 'rtd1', cabine_id: 'cab1', transaction_id: 'txn1' }] }),
  });
  DB.init();
  await DB.retards.refresh();
  assert.equal(DB.retards.all().length, 1);
  assert.equal(DB.retards.all()[0].id, 'rtd1');
});

/* ── Endpoints périphériques (Phase 4, second lot) ───────────────────── */

test('recharge() : crédite le compte ciblé localement tout de suite', async () => {
  const { DB } = loadDb({ online: true, serverOrdersRecharge: async () => ({ ok: true }) });
  const { cabine } = setup(DB);

  const res = await DB.business.recharge(cabine.id, 5000, 'Orange');
  assert.equal(res.ok, true);
  assert.equal(DB.users.byId(cabine.id).solde, 6000);
});

test('recharge() : échec serveur (réseau en maintenance), aucun crédit local', async () => {
  const { DB } = loadDb({ online: true, serverOrdersRecharge: async () => ({ ok: false, error: 'Ce réseau est temporairement indisponible pour la recharge.' }) });
  const { cabine } = setup(DB);

  const res = await DB.business.recharge(cabine.id, 5000, 'Orange');
  assert.equal(res.ok, false);
  assert.equal(DB.users.byId(cabine.id).solde, 1000, 'solde inchangé');
});

test('refundTransaction() : succès -> resynchronise les transactions', async () => {
  let refreshed = false;
  const { DB } = loadDb({
    online: true,
    serverOrdersRefund: async () => ({ ok: true }),
    serverOrdersList: async () => { refreshed = true; return { ok: true, transactions: [] }; },
  });
  DB.init();
  const res = await DB.business.refundTransaction('txn1');
  assert.equal(res.ok, true);
  assert.equal(refreshed, true);
});

test('suspendTransaction() : motif vide rejeté avant même l\'appel réseau', async () => {
  let called = false;
  const { DB } = loadDb({ online: true, serverOrdersSuspend: async () => { called = true; return { ok: true }; } });
  DB.init();
  const res = await DB.business.suspendTransaction('txn1', '   ');
  assert.equal(res.ok, false);
  assert.equal(called, false);
});

test('reactivateTransaction() : transporte l\'échec serveur tel quel', async () => {
  const { DB } = loadDb({ online: true, serverOrdersReactivate: async () => ({ ok: false, error: "Cette commande n'est pas suspendue." }) });
  DB.init();
  const res = await DB.business.reactivateTransaction('txn1');
  assert.equal(res.ok, false);
  assert.match(res.error, /pas suspendue/);
});

test('suspendCabineManually() : transporte le succès/échec depuis cabine_suspend_manual.php', async () => {
  const { DB: dbOk } = loadDb({ online: true, serverCabineSuspendManual: async () => ({ ok: true }) });
  dbOk.init();
  assert.equal((await dbOk.business.suspendCabineManually('cab1', 'motif', 'admin1')).ok, true);

  const { DB: dbFail } = loadDb({ online: true, serverCabineSuspendManual: async () => ({ ok: false, error: 'Cabine introuvable.' }) });
  dbFail.init();
  const res = await dbFail.business.suspendCabineManually('cab-inconnu', 'motif', 'admin1');
  assert.equal(res.ok, false);
});

test('cabineSelfRecharge() : débite localement le total (montant + frais) renvoyé par le serveur', async () => {
  const { DB } = loadDb({
    online: true,
    serverCabineSelfRecharge: async () => ({ ok: true, transaction: { id: 'txn-uv-1', statut: 'en_attente' }, assignedTo: 'cab2', frais: 200, total: 10200 }),
  });
  const { cabine } = setup(DB);
  DB.users.update(cabine.id, { solde: 20000 });

  const res = await DB.business.cabineSelfRecharge(cabine.id, { network: 'Orange', numero: '0700000001', montant: 10000 });
  assert.equal(res.ok, true);
  assert.equal(DB.users.byId(cabine.id).solde, 20000 - 10200);
  assert.equal(DB.transactions.byId('txn-uv-1').statut, 'en_attente');
});

test('resubscribeCabine() : applique le nouveau solde exact renvoyé par le serveur (pas un calcul local)', async () => {
  const { DB } = loadDb({
    online: true,
    serverCabineResubscribe: async () => ({ ok: true, resteDu: 0, nouveauSolde: 4321, transactionId: 'txn-reabo-1' }),
  });
  const { cabine } = setup(DB);

  const res = await DB.business.resubscribeCabine(cabine.id, 'VIP');
  assert.equal(res.ok, true);
  const cab = DB.users.byId(cabine.id);
  assert.equal(cab.solde, 4321);
  assert.equal(cab.abonnement, 'VIP');
  assert.equal(cab.commissions_total, 0);
});

test('adminSetCabineAbonnement() : transporte le résultat, aucune écriture locale de solde', async () => {
  const { DB } = loadDb({ online: true, serverAdminSetAbonnement: async () => ({ ok: true }) });
  const { cabine } = setup(DB);
  const before = DB.users.byId(cabine.id).solde;

  const res = await DB.business.adminSetCabineAbonnement(cabine.id, 'VVIP');
  assert.equal(res.ok, true);
  assert.equal(DB.users.byId(cabine.id).solde, before, 'aucun débit côté admin (pas de paiement, voir endpoint)');
});

test('cabineTransfer() : débite l\'expéditeur localement (montant + frais)', async () => {
  const { DB } = loadDb({
    online: true,
    serverCabineTransfer: async () => ({ ok: true, recipient: { id: 'cab2', cabine_nom: 'Boutique B', prenom: 'B', nom: 'B' } }),
  });
  const { cabine } = setup(DB);
  DB.users.update(cabine.id, { solde: 10000 });

  const res = await DB.business.cabineTransfer(cabine.id, 'Boutique B', 5000);
  assert.equal(res.ok, true);
  assert.equal(DB.users.byId(cabine.id).solde, 10000 - 5000 - 150, 'frais fixe (TRANSFERT_CABINE_FRAIS) inclus');
});
