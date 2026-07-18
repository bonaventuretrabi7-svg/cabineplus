'use strict';
// DB.presence (js/db.js) — Phase 2, étape 3/6 : prérequis à la migration de
// l'attribution des commandes (Phase 4). ping() reste local-first (écrit
// IMMÉDIATEMENT, même patron que favoris/settings) puis pousse vers le
// serveur en tâche de fond ; refresh() tire la présence connue côté serveur
// (autres appareils du même compte, ou une autre cabine jamais vue
// localement) pour que onlineCabineIds()/onlineIds() (encore 100%
// synchrones, utilisées par DB.business.findReassignmentTarget) reflètent
// plus que le seul onglet courant.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDb } = require('./helpers/loadDb');

function setup(DB) {
  DB.init();
  return DB.users.create({
    prenom: 'Cab', nom: 'Test', telephone: '0700000000', email: 'cab@gmail.com',
    mot_de_passe: '1234', role: 'cabine', solde: 0, statut: 'actif',
  });
}

test('ping() en ligne : écrit en local immédiatement ET pousse vers le serveur en tâche de fond', async () => {
  let called = false;
  const { DB } = loadDb({ online: true, serverPresencePing: async () => { called = true; return { ok: true }; } });
  const cab = setup(DB);

  DB.presence.ping(cab.id);
  assert.ok(DB.presence.onlineIds().includes(cab.id), 'visible localement tout de suite');

  // ping() ne retourne rien (fire-and-forget) : laisse le microtask du
  // .catch() interne se résoudre avant de vérifier l'appel.
  await Promise.resolve();
  assert.equal(called, true);
});

test('ping() hors ligne : écrit en local, aucun appel serveur tenté (jamais d\'exception)', async () => {
  let called = false;
  const { DB } = loadDb({ online: false, serverPresencePing: async () => { called = true; return { ok: true }; } });
  const cab = setup(DB);

  assert.doesNotThrow(() => DB.presence.ping(cab.id));
  assert.ok(DB.presence.onlineIds().includes(cab.id));
  assert.equal(called, false);
});

test('refresh() : une cabine jamais pinguée localement (connectée sur un autre appareil) devient visible après synchronisation', async () => {
  let cabId;
  const { DB } = loadDb({
    online: true,
    // Le mock lit `cabId` au moment de l'appel (pas à la création du
    // sandbox) : `cabId` n'est affecté qu'après DB.users.create() ci-dessous.
    serverPresenceOnline: async () => ({ ok: true, presence: [{ profile_id: cabId, ts: Math.floor(Date.now() / 1000) }] }),
  });
  DB.init();
  cabId = DB.users.create({
    prenom: 'Cab', nom: 'Distant', telephone: '0700000001', email: 'cab2@gmail.com',
    mot_de_passe: '1234', role: 'cabine', solde: 0, statut: 'actif',
  }).id;

  assert.equal(DB.presence.onlineCabineIds().length, 0, 'rien avant refresh() : jamais pinguée sur cet appareil');
  await DB.presence.refresh();
  assert.ok(DB.presence.onlineCabineIds().includes(cabId), 'visible après refresh(), bien que jamais pinguée localement');
});

test('refresh() : ne recule jamais un ping local plus récent que ce que renvoie le serveur', async () => {
  let cabId;
  const { DB, clock } = loadDb({
    online: true,
    serverPresenceOnline: async () => ({ ok: true, presence: [{ profile_id: cabId, ts: Math.floor((clock.now - 60000) / 1000) }] }),
  });
  const cab = setup(DB);
  cabId = cab.id;

  DB.presence.ping(cab.id); // ping local "maintenant" — plus récent que le serveur (il y a 60s)
  const before = DB.presence._all()[cab.id];

  await DB.presence.refresh();
  const after = DB.presence._all()[cab.id];
  assert.equal(after, before, 'le timestamp local, plus récent, est conservé tel quel');
});

test('refresh() hors ligne ou sans configuration réelle : ne tente jamais le réseau', async () => {
  const state = { called: false };
  const poison = async () => { state.called = true; return { ok: true, presence: [] }; };

  const { DB: offlineDB } = loadDb({ online: false, serverPresenceOnline: poison });
  offlineDB.init();
  await offlineDB.presence.refresh();
  assert.equal(state.called, false, 'hors ligne : jamais appelé');

  const { DB: unconfiguredDB } = loadDb({ online: true, serverConfigured: false, serverPresenceOnline: poison });
  unconfiguredDB.init();
  await unconfiguredDB.presence.refresh();
  assert.equal(state.called, false, 'sans configuration réelle : jamais appelé');
});
