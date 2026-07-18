'use strict';
// DB.favoris (js/db.js) — premier module métier synchronisé de bout en bout
// (Phase 2, étape 2/6) : écrit en local immédiatement (source de vérité
// affichée), synchronise en tâche de fond vers le serveur (api/favoris_*.php)
// quand une connexion est là, et met en file (DB.syncQueue) sinon — jamais
// perdu, même patron que DB.settings (voir tests/sync-offline.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDb } = require('./helpers/loadDb');

test('create() en ligne : écrit en local immédiatement puis remplace l\'id local par l\'id serveur', async () => {
  let pushed = null;
  const { DB } = loadDb({
    online: true,
    serverFavorisCreate: async (payload) => { pushed = payload; return { ok: true, favori: { id: 'srv-fav-1', ...payload } }; },
  });

  const f = await DB.favoris.create({ client_id: 'cli1', nom: 'Maman', numero: '0700000001' });
  assert.equal(pushed.nom, 'Maman');
  assert.equal(pushed.numero, '0700000001');

  const list = DB.favoris.forUser('cli1');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'srv-fav-1', 'id local temporaire remplacé par l\'id serveur');
  assert.equal(DB.syncQueue.all().length, 0);
});

test('create() hors ligne : écrit en local avec un id temporaire ET met en file (jamais perdu)', async () => {
  const { DB } = loadDb({ online: false });

  const f = await DB.favoris.create({ client_id: 'cli1', nom: 'Papa', numero: '0700000002' });

  const list = DB.favoris.forUser('cli1');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, f.id, 'garde l\'id local temporaire tant que non synchronisé');

  const queue = DB.syncQueue.all();
  assert.equal(queue.length, 1);
  assert.equal(queue[0].entity, 'favorisCreate');
  assert.equal(queue[0].payload.localId, f.id);
});

test('create() en ligne mais échec réseau réel : écrit en local ET met en file quand même', async () => {
  const { DB } = loadDb({
    online: true,
    serverFavorisCreate: async () => { throw new Error('network down'); },
  });

  const f = await DB.favoris.create({ client_id: 'cli1', nom: 'Bureau', numero: '0700000003' });

  assert.equal(DB.favoris.forUser('cli1').length, 1);
  assert.equal(DB.syncQueue.all().length, 1);
  assert.equal(DB.syncQueue.all()[0].payload.localId, f.id);
});

test('drainSyncQueue() : une création mise en file hors ligne finit par obtenir l\'id serveur définitif une fois reconnecté', async () => {
  const { DB, net } = loadDb({
    online: false,
    serverFavorisCreate: async (payload) => ({ ok: true, favori: { id: 'srv-fav-3', ...payload } }),
  });
  const f = await DB.favoris.create({ client_id: 'cli1', nom: 'Voisin', numero: '0700000004' });
  assert.equal(DB.syncQueue.all().length, 1);
  assert.equal(DB.favoris.forUser('cli1')[0].id, f.id);

  net.setOnline(true);
  await DB.drainSyncQueue();

  assert.equal(DB.syncQueue.all().length, 0, 'synchronisée, retirée de la file');
  assert.equal(DB.favoris.forUser('cli1')[0].id, 'srv-fav-3', 'id local temporaire remplacé par l\'id serveur');
});

test('drainSyncQueue() : mock serveur défaillant laisse l\'entrée en file pour un prochain essai', async () => {
  const { DB, net } = loadDb({ online: false }); // serverFavorisCreate non fourni -> mock par défaut { ok:false }
  await DB.favoris.create({ client_id: 'cli1', nom: 'Voisin', numero: '0700000004' });
  assert.equal(DB.syncQueue.all().length, 1);

  net.setOnline(true);
  await DB.drainSyncQueue();

  assert.equal(DB.syncQueue.all().length, 1, 'un échec serveur laisse l\'entrée en file, jamais perdue silencieusement');
});

test('remove() : écrit en local immédiatement puis synchronise vers le serveur', async () => {
  let removedId = null;
  const { DB } = loadDb({
    online: true,
    serverFavorisCreate: async (payload) => ({ ok: true, favori: { id: 'srv-fav-2', ...payload } }),
    serverFavorisRemove: async (id) => { removedId = id; return { ok: true }; },
  });

  const f = await DB.favoris.create({ client_id: 'cli1', nom: 'Cousin', numero: '0700000005' });
  await DB.favoris.remove(f.id);

  assert.equal(DB.favoris.forUser('cli1').length, 0);
  assert.equal(removedId, 'srv-fav-2');
});

test('remove() d\'un favori créé hors ligne (jamais synchronisé) : annule la création en file, aucun appel serveur de suppression', async () => {
  let removeCalled = false;
  const { DB } = loadDb({
    online: false,
    serverFavorisRemove: async (id) => { removeCalled = true; return { ok: true }; },
  });

  const f = await DB.favoris.create({ client_id: 'cli1', nom: 'Ephémère', numero: '0700000006' });
  assert.equal(DB.syncQueue.all().length, 1);

  await DB.favoris.remove(f.id);

  assert.equal(DB.favoris.forUser('cli1').length, 0);
  assert.equal(DB.syncQueue.all().length, 0, 'la création en file est annulée, pas remplacée par une suppression');
  assert.equal(removeCalled, false, 'rien à supprimer côté serveur : ce favori n\'y a jamais existé');
});

test('refresh() : remplace la part locale de CE client par la liste serveur, sans toucher aux favoris des autres clients', async () => {
  const { DB } = loadDb({
    online: true,
    serverFavorisList: async () => ({ ok: true, favoris: [{ id: 'srv-1', client_id: 'cli1', nom: 'Sync', numero: '0700000007', date_creation: new Date().toISOString() }] }),
  });

  // Favori local pré-existant d'un AUTRE client (ex. compte partagé sur cet
  // appareil) — ne doit jamais être touché par le rafraîchissement de cli1.
  await DB.favoris.create({ client_id: 'cli2', nom: 'Autre client', numero: '0700000008' });

  await DB.favoris.refresh('cli1');

  const cli1List = DB.favoris.forUser('cli1');
  assert.equal(cli1List.length, 1);
  assert.equal(cli1List[0].id, 'srv-1');

  const cli2List = DB.favoris.forUser('cli2');
  assert.equal(cli2List.length, 1, 'favoris d\'un autre client préservés');
});

test('sans configuration réelle : create()/remove() écrivent en local, jamais mis en file (rien à resynchroniser)', async () => {
  const { DB } = loadDb({ online: true, serverConfigured: false });

  const f = await DB.favoris.create({ client_id: 'cli1', nom: 'Local seul', numero: '0700000009' });
  assert.equal(DB.favoris.forUser('cli1').length, 1);
  assert.equal(DB.syncQueue.all().length, 0);

  await DB.favoris.remove(f.id);
  assert.equal(DB.favoris.forUser('cli1').length, 0);
  assert.equal(DB.syncQueue.all().length, 0);
});
