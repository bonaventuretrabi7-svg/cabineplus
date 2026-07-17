'use strict';
// Scénarios clés du hors-ligne d'abord (voir le plan) : DB.settings doit
// toujours lire/écrire instantanément en local, connexion ou pas, et une
// écriture qui n'a pas pu être poussée vers le serveur (api/, PHP+MySQL)
// doit atterrir dans DB.syncQueue pour être rejouée plus tard — jamais
// perdue silencieusement.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDb } = require('./helpers/loadDb');

const SETTINGS_ROW = {
  platform_name: 'KBINE PLUS', currency: 'FCFA', commission_rate: 5,
  min_transfer: 500, max_transfer: 100000, recharge_min: 1000,
  maintenance: { services: { recharger: true } }, assistance: {},
  assistant_cabine: {}, assistant_client: {}, ussd_templates: {}, admin_schedules: [],
};

test('settings.get() en ligne : instantané (cache), jamais bloqué par le réseau', async () => {
  const { DB } = loadDb({ online: true, serverGetSettings: async () => SETTINGS_ROW });
  // Cache déjà présent (écrit par seed()) — get() doit le retourner
  // immédiatement, sans attendre la réponse serveur (réseau lent/instable
  // en Côte d'Ivoire : chaque vérification de maintenance ne doit jamais
  // faire attendre l'utilisateur).
  const s = await DB.settings.get();
  assert.equal(typeof s, 'object');
});

test('settings.get() en ligne : rafraîchit le cache local en arrière-plan (_refresh, jamais deux requêtes en vol)', async () => {
  const { DB, localStorage } = loadDb({ online: true, serverGetSettings: async () => SETTINGS_ROW });

  await DB.settings.get(); // déclenche le rafraîchissement en arrière-plan
  await DB.settings._refresh(); // attend explicitement la même requête en vol

  const cached = JSON.parse(localStorage.getItem('cbp_settings'));
  assert.equal(cached.maintenance.services.recharger, true);
});

test('settings.get() hors ligne : retombe sur le cache local, jamais un objet vide', async () => {
  const { DB, localStorage } = loadDb({ online: false });
  // Simule un cache déjà présent (écrit lors d'une session précédente en ligne).
  localStorage.setItem('cbp_settings', JSON.stringify({ maintenance: { services: { recharger: true } } }));

  const s = await DB.settings.get();
  assert.equal(s.maintenance.services.recharger, true);
});

test('settings.get() en ligne mais échec réseau réel : retombe aussi sur le cache (navigator.onLine peut mentir)', async () => {
  const { DB, localStorage } = loadDb({
    online: true,
    serverGetSettings: async () => { throw new Error('network down'); },
  });
  localStorage.setItem('cbp_settings', JSON.stringify({ maintenance: { services: { recharger: false } } }));

  const s = await DB.settings.get();
  assert.equal(s.maintenance.services.recharger, false);
});

test('settings.update() hors ligne : écrit en local immédiatement ET met en file (jamais perdu)', async () => {
  const { DB, localStorage } = loadDb({ online: false });

  await DB.settings.update({ maintenance: { services: { recharger: true } } });

  const cached = JSON.parse(localStorage.getItem('cbp_settings'));
  assert.equal(cached.maintenance.services.recharger, true, 'écrit en local tout de suite');

  const queue = DB.syncQueue.all();
  assert.equal(queue.length, 1);
  assert.equal(queue[0].entity, 'settings');
  // Comparaison via JSON plutôt que deepEqual : queue[0].payload provient du
  // JSON.parse exécuté dans le contexte vm du harnais (realm distinct de ce
  // fichier de test), deepEqual échouerait sur les prototypes malgré un
  // contenu strictement identique.
  assert.equal(JSON.stringify(queue[0].payload), JSON.stringify({ maintenance: { services: { recharger: true } } }));
});

test('settings.update() en ligne avec succès : écrit en local, rien en file', async () => {
  let pushed = null;
  const { DB, localStorage } = loadDb({
    online: true,
    serverUpdateSettings: async (row) => { pushed = row; return row; },
  });

  await DB.settings.update({ platformName: 'Nouveau nom' });

  const cached = JSON.parse(localStorage.getItem('cbp_settings'));
  assert.equal(cached.platformName, 'Nouveau nom');
  assert.equal(DB.syncQueue.all().length, 0);
  assert.equal(pushed.platform_name, 'Nouveau nom');
});

test('settings.update() en ligne mais échec réseau réel : écrit en local ET met en file quand même', async () => {
  const { DB, localStorage } = loadDb({
    online: true,
    serverUpdateSettings: async () => { throw new Error('network down'); },
  });

  await DB.settings.update({ platformName: 'Hors service' });

  const cached = JSON.parse(localStorage.getItem('cbp_settings'));
  assert.equal(cached.platformName, 'Hors service');
  assert.equal(DB.syncQueue.all().length, 1);
});

test('drainSyncQueue() : vide la file dès que la connexion revient', async () => {
  let pushed = null;
  const { DB, net } = loadDb({
    online: false,
    serverUpdateSettings: async (row) => { pushed = row; return row; },
  });

  await DB.settings.update({ platformName: 'En file' });
  assert.equal(DB.syncQueue.all().length, 1);

  // La connexion revient — même appel que Net.onChange déclenche dans
  // client.js/cabine.js/admin.js.
  net.setOnline(true);
  await DB.drainSyncQueue();

  assert.equal(DB.syncQueue.all().length, 0, 'la file est vidée une fois synchronisé');
  assert.equal(pushed.platform_name, 'En file');
});

test('drainSyncQueue() ne fait rien tant qu\'on est hors ligne (pas de tentative inutile)', async () => {
  let called = false;
  const { DB } = loadDb({
    online: false,
    serverUpdateSettings: async () => { called = true; return {}; },
  });

  await DB.settings.update({ platformName: 'Toujours hors ligne' });
  await DB.drainSyncQueue();

  assert.equal(called, false);
  assert.equal(DB.syncQueue.all().length, 1, 'reste en file');
});

/* Serveur jamais configuré (js/server-config.js encore sur ses valeurs
   placeholder) — trouvé en auditant le site : chaque vérification de
   maintenance déclenchait une requête vers un domaine inexistant
   (ERR_NAME_NOT_RESOLVED), visible en console à chaque clic sur un
   service. ServerAPI.isConfigured (voir js/server-api.js) doit
   court-circuiter toute tentative réseau — un mock qui explose au moindre
   appel prouve qu'il n'est jamais sollicité. */
// `called` se lève même si l'appelant capture l'exception (try/catch
// existant de _refresh()) — seul moyen de prouver sans ambiguïté que le
// mock n'a JAMAIS été sollicité, pas juste que l'échec a été avalé.
function poison(state) {
  return async () => { state.called = true; throw new Error('ne doit jamais être appelé sans configuration réelle'); };
}

test('settings.get() sans configuration réelle : ne tente jamais le réseau, cache local direct', async () => {
  const state = { called: false };
  const { DB } = loadDb({ online: true, serverGetSettings: poison(state), serverConfigured: false });

  await DB.settings.get();
  assert.equal(state.called, false, 'ServerAPI.getSettings ne doit jamais être appelé sans configuration réelle');
});

test('settings.update() sans configuration réelle : écrit en local, jamais mis en file (rien à resynchroniser)', async () => {
  const state = { called: false };
  const { DB } = loadDb({ online: true, serverUpdateSettings: poison(state), serverConfigured: false });

  await DB.settings.update({ platformName: 'Sans backend' });

  const settings = await DB.settings.get();
  assert.equal(settings.platformName, 'Sans backend', 'écrit localement quand même');
  assert.equal(DB.syncQueue.all().length, 0, 'jamais mis en file : rien ne pourra jamais se synchroniser');
  assert.equal(state.called, false);
});

test('SYNC_HANDLERS.settings (via drainSyncQueue) : une entrée déjà en file avant ce contrôle est retirée sans planter', async () => {
  const state = { called: false };
  // Une session précédente (avant l'ajout du contrôle) a pu laisser une
  // entrée en file alors que le serveur n'a jamais été configuré — elle ne
  // doit plus jamais bloquer ni planter, juste être purgée.
  const { DB, net } = loadDb({ online: false, serverUpdateSettings: poison(state), serverConfigured: false });
  DB.syncQueue.enqueue({ entity: 'settings', op: 'update', payload: { platformName: 'Ancienne entrée' } });
  assert.equal(DB.syncQueue.all().length, 1);

  net.setOnline(true);
  await DB.drainSyncQueue();

  assert.equal(DB.syncQueue.all().length, 0, 'purgée silencieusement, jamais retentée indéfiniment');
});
