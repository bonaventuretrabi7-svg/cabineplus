'use strict';
// Scénarios clés des règles métier "retards/suspension cabine" (voir le
// plan). Charge js/db.js dans un contexte isolé par test (tests/helpers/loadDb.js)
// avec une horloge simulée — aucun vrai setTimeout, le temps "passe" en
// avançant clock.now.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDb } = require('./helpers/loadDb');

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 6, 16, 10, 0, 0); // 2026-07-16 10:00:00 UTC — journée de référence

function setup(startNow = T0) {
  const { DB, clock } = loadDb(startNow);
  DB.init(); // seed demo data (fournit la structure KEY complète) — nos
             // propres cabines/transactions de test sont ajoutées à côté.
  return { DB, clock };
}

function makeCabine(DB, overrides = {}) {
  return DB.users.create({
    prenom: 'Cab', nom: overrides.nom || 'Test', telephone: overrides.telephone || ('07' + Math.random().toString().slice(2, 10)),
    email: overrides.email || `cab${Math.random().toString(36).slice(2)}@gmail.com`,
    mot_de_passe: '1234', role: 'cabine', solde: 0, statut: 'actif', ...overrides,
  });
}

function makeClient(DB) {
  return DB.users.create({
    prenom: 'Cli', nom: 'Test', telephone: '05' + Math.random().toString().slice(2, 10),
    mot_de_passe: '1234', role: 'client',
  });
}

/* Marque une cabine "connectée" à l'instant simulé courant — reflète un
   ping de présence frais (voir DB.presence.ping), requis par
   findReassignmentTarget/onlineCabineIds pour la considérer éligible. */
function markOnline(DB, cabineId) {
  DB.presence.ping(cabineId);
}

function assignPendingOrder(DB, { clientId, cabineId, dateAssignation }) {
  return DB.transactions.create({
    client_id: clientId, cabine_id: cabineId, operateur: 'Orange',
    numero_beneficiaire: '0700000000', montant: 1000, statut: 'en_attente',
    date: new Date(dateAssignation).toISOString(),
    date_assignation: new Date(dateAssignation).toISOString(),
  });
}

test('Scénario 1 — expiration à 3 min : détectée, journalisée, réassignée à une autre cabine en ligne', () => {
  const { DB, clock } = setup();
  const cabA = makeCabine(DB, { nom: 'A' });
  const cabB = makeCabine(DB, { nom: 'B' });
  const client = makeClient(DB);
  markOnline(DB, cabA.id);
  markOnline(DB, cabB.id);

  const txn = assignPendingOrder(DB, { clientId: client.id, cabineId: cabA.id, dateAssignation: clock.now });

  clock.now = T0 + 3 * MIN + 1000; // 3:01 — juste après le seuil
  markOnline(DB, cabB.id); // ping frais pour rester "en ligne" à cet instant

  const result = DB.business.sweepStaleOrders();
  assert.equal(result.staleCount, 1);

  const updated = DB.transactions.byId(txn.id);
  assert.equal(updated.cabine_id, cabB.id);
  assert.notEqual(updated.cabine_id, cabA.id);

  const retards = DB.retards.byCabine(cabA.id);
  assert.equal(retards.length, 1);
  assert.equal(retards[0].reassigned_to_cabine_id, cabB.id);
  assert.equal(retards[0].triggered_suspension, false);
});

test('Scénario 2 — extension "Garder 5min" : le total passe à 8 min pile, pas 3', () => {
  const { DB, clock } = setup();
  const cabA = makeCabine(DB, { nom: 'A' });
  const cabB = makeCabine(DB, { nom: 'B' });
  const client = makeClient(DB);
  markOnline(DB, cabA.id);
  markOnline(DB, cabB.id);

  const txn = assignPendingOrder(DB, { clientId: client.id, cabineId: cabA.id, dateAssignation: clock.now });

  // 1 min après l'assignation : le cabiniste clique "Conserver 5min" — même
  // opération que holdRequest() dans js/cabine.js (décale date_assignation
  // de +5 min depuis la valeur d'origine, marque hold_used).
  clock.now = T0 + 1 * MIN;
  const base = new Date(txn.date_assignation).getTime();
  const newAssignation = new Date(base + 5 * MIN).toISOString();
  DB.transactions.update(txn.id, { date_assignation: newAssignation, hold_used: true });

  // À 7:59 depuis l'assignation d'origine (juste avant le total de 8 min) : pas encore en retard.
  clock.now = T0 + 7 * MIN + 59 * 1000;
  markOnline(DB, cabB.id);
  let result = DB.business.sweepStaleOrders();
  assert.equal(result.staleCount, 0, 'ne doit pas expirer avant 8 minutes au total');
  assert.equal(DB.transactions.byId(txn.id).cabine_id, cabA.id);

  // À 8:00 pile : en retard, réassignée.
  clock.now = T0 + 8 * MIN + 1000;
  markOnline(DB, cabB.id);
  result = DB.business.sweepStaleOrders();
  assert.equal(result.staleCount, 1);
  assert.equal(DB.transactions.byId(txn.id).cabine_id, cabB.id);
});

test('Scénario 3 — réassignation : jamais vers la cabine qui vient de laisser expirer la commande', () => {
  const { DB, clock } = setup();
  const cabA = makeCabine(DB, { nom: 'A' });
  const cabB = makeCabine(DB, { nom: 'B' });
  const cabC = makeCabine(DB, { nom: 'C' });
  const client = makeClient(DB);
  [cabA, cabB, cabC].forEach(c => markOnline(DB, c.id));

  const txn = assignPendingOrder(DB, { clientId: client.id, cabineId: cabA.id, dateAssignation: clock.now });

  clock.now = T0 + 3 * MIN + 1000;
  [cabB, cabC].forEach(c => markOnline(DB, c.id));

  DB.business.sweepStaleOrders();
  const target = DB.transactions.byId(txn.id).cabine_id;
  assert.notEqual(target, cabA.id);
  assert.ok([cabB.id, cabC.id].includes(target));
});

test('Scénario 4 — aucune cabine en ligne disponible : la commande retourne au pool admin (cabine_id: null)', () => {
  const { DB, clock } = setup();
  const cabA = makeCabine(DB, { nom: 'Seule' });
  const client = makeClient(DB);
  markOnline(DB, cabA.id);
  // Aucune autre cabine créée : personne d'autre à réattribuer.

  const txn = assignPendingOrder(DB, { clientId: client.id, cabineId: cabA.id, dateAssignation: clock.now });

  clock.now = T0 + 3 * MIN + 1000;
  const result = DB.business.sweepStaleOrders();

  assert.equal(result.staleCount, 1);
  const updated = DB.transactions.byId(txn.id);
  assert.equal(updated.cabine_id, null);
  assert.equal(updated.statut, 'en_attente');

  const retard = DB.retards.byCabine(cabA.id)[0];
  assert.equal(retard.reassigned_to_cabine_id, null);
  assert.equal(retard.triggered_suspension, false);
});

test('Scénario 5a — 3 retards la même journée calendaire déclenchent la suspension automatique 24h', () => {
  const { DB, clock } = setup();
  const cabA = makeCabine(DB, { nom: 'Fautive' });
  const cabB = makeCabine(DB, { nom: 'Secours' });
  const client = makeClient(DB);
  markOnline(DB, cabA.id);
  markOnline(DB, cabB.id);

  // 3 commandes successives assignées à cabA, chacune expirée séparément le
  // même jour calendaire.
  for (let i = 0; i < 3; i++) {
    const assignedAt = T0 + i * 20 * MIN;
    const txn = assignPendingOrder(DB, { clientId: client.id, cabineId: cabA.id, dateAssignation: assignedAt });
    clock.now = assignedAt + 3 * MIN + 1000;
    markOnline(DB, cabB.id);
    DB.business.sweepStaleOrders();
    void txn;
  }

  const cabAfter = DB.users.byId(cabA.id);
  assert.equal(cabAfter.statut, 'suspendu');
  assert.equal(cabAfter.suspendu_auto, true);
  assert.equal(new Date(cabAfter.suspendu_jusqu).getTime(), clock.now + 24 * 60 * 60 * 1000);

  const openLog = DB.suspensionLogs.active(cabA.id);
  assert.ok(openLog, 'un suspensionLogs ouvert doit exister');
  assert.equal(openLog.auto, true);
});

test('Scénario 5b — 2 retards hier + 1 aujourd\'hui NE déclenche PAS la suspension (fenêtre calendaire, pas glissante)', () => {
  const { DB, clock } = setup();
  const cabA = makeCabine(DB, { nom: 'Fautive2' });
  const cabB = makeCabine(DB, { nom: 'Secours2' });
  const client = makeClient(DB);
  markOnline(DB, cabA.id);
  markOnline(DB, cabB.id);

  // 2 retards "hier" (avant minuit).
  for (let i = 0; i < 2; i++) {
    const assignedAt = T0 + i * 20 * MIN;
    assignPendingOrder(DB, { clientId: client.id, cabineId: cabA.id, dateAssignation: assignedAt });
    clock.now = assignedAt + 3 * MIN + 1000;
    markOnline(DB, cabB.id);
    DB.business.sweepStaleOrders();
  }
  assert.equal(DB.users.byId(cabA.id).statut, 'actif', 'pas encore suspendue après 2 retards');

  // Passage à "aujourd'hui" (minuit local dépassé) puis 1 seul retard de plus.
  const tomorrowStart = new Date(clock.now);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);
  tomorrowStart.setHours(1, 0, 0, 0);
  const assignedAt = tomorrowStart.getTime();
  clock.now = assignedAt;
  assignPendingOrder(DB, { clientId: client.id, cabineId: cabA.id, dateAssignation: assignedAt });
  clock.now = assignedAt + 3 * MIN + 1000;
  markOnline(DB, cabB.id);
  DB.business.sweepStaleOrders();

  assert.equal(DB.users.byId(cabA.id).statut, 'actif', '3e retard réparti sur 2 jours calendaires ne doit pas suspendre');
  assert.equal(DB.retards.byCabine(cabA.id).length, 3);
});

test('Scénario 6 — déblocage automatique pile à l\'heure (checkAutoUnsuspend et sweepAutoUnsuspensions)', () => {
  const { DB, clock } = setup();
  const cabA = makeCabine(DB, { nom: 'Suspendue1' });
  const cabB = makeCabine(DB, { nom: 'Suspendue2' }); // sans commande en attente

  DB.business.suspendCabineAuto(cabA.id, 'test');
  const jusqu = new Date(DB.users.byId(cabA.id).suspendu_jusqu).getTime();
  assert.equal(jusqu, clock.now + 24 * 60 * 60 * 1000);

  // 1 seconde avant l'échéance : toujours suspendue.
  clock.now = jusqu - 1000;
  DB.business.checkAutoUnsuspend(cabA.id);
  assert.equal(DB.users.byId(cabA.id).statut, 'suspendu');

  // Pile à l'échéance : débloquée.
  clock.now = jusqu;
  DB.business.checkAutoUnsuspend(cabA.id);
  const cabAfter = DB.users.byId(cabA.id);
  assert.equal(cabAfter.statut, 'actif');
  assert.equal(cabAfter.suspendu_jusqu, null);
  assert.equal(DB.suspensionLogs.active(cabA.id), null);

  // cabB : suspendue, SANS commande en attente — jamais visitée par
  // sweepStaleOrders (qui ne regarde que les cabines propriétaires d'une
  // commande en retard). sweepAutoUnsuspensions() doit quand même la lever
  // une fois l'échéance dépassée.
  DB.business.suspendCabineAuto(cabB.id, 'test2');
  const jusquB = new Date(DB.users.byId(cabB.id).suspendu_jusqu).getTime();
  clock.now = jusquB + 1000;
  const swept = DB.business.sweepAutoUnsuspensions();
  assert.equal(swept.liftedCount, 1);
  assert.equal(DB.users.byId(cabB.id).statut, 'actif');
});

test('Scénario 7 — suspensionLogs : suspension manuelle puis levée enregistrent date_levee/levee_par', () => {
  const { DB } = setup();
  const cab = makeCabine(DB, { nom: 'Manuelle' });

  DB.business.suspendCabineManually(cab.id, 'motif test', 'admin123');
  const open = DB.suspensionLogs.active(cab.id);
  assert.ok(open);
  assert.equal(open.auto, false);
  assert.equal(open.motif, 'motif test');
  assert.equal(open.date_levee, null);

  // Levée manuelle par un admin — même opération que toggleCabine(id, true)
  // dans js/admin.js (fonction DOM-dépendante, non chargeable dans ce
  // harnais de test).
  DB.users.update(cab.id, { statut: 'actif', suspendu_auto: false, suspendu_by: null, suspendu_motif: null, suspendu_jusqu: null });
  DB.suspensionLogs.close(cab.id, 'admin123');

  assert.equal(DB.suspensionLogs.active(cab.id), null);
  const closed = DB.suspensionLogs.byCabine(cab.id)[0];
  assert.ok(closed.date_levee);
  assert.equal(closed.levee_par, 'admin123');
});
