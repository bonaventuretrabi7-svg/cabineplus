'use strict';
// Scénarios clés du hors-ligne d'abord (voir le plan) : DB.settings doit
// toujours lire/écrire instantanément en local, connexion ou pas, et une
// écriture qui n'a pas pu être poussée vers Supabase doit atterrir dans
// DB.syncQueue pour être rejouée plus tard — jamais perdue silencieusement.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDb } = require('./helpers/loadDb');

/* Fake client Supabase minimal — reproduit juste la forme des 2 chaînes
   utilisées par js/db.js (settings.get/SYNC_HANDLERS.settings) :
     .from('settings').select('*').eq('id', true).single()
     .from('settings').update(row).eq('id', true) */
function makeFakeSupabaseClient({ row = null, selectError = null, updateError = null, throwOnSelect = false, throwOnUpdate = false, onUpdate = null } = {}) {
  return {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        async single() {
          if (throwOnSelect) throw new Error('network down');
          return { data: row, error: selectError };
        },
        update(payload) {
          if (onUpdate) onUpdate(payload);
          return {
            async eq() {
              if (throwOnUpdate) throw new Error('network down');
              return { error: updateError };
            },
          };
        },
      };
    },
  };
}

const SETTINGS_ROW = {
  platform_name: 'KBINE PLUS', currency: 'FCFA', commission_rate: 5,
  min_transfer: 500, max_transfer: 100000, recharge_min: 1000,
  maintenance: { services: { recharger: true } }, assistance: {},
  assistant_cabine: {}, assistant_client: {}, ussd_templates: {}, admin_schedules: [],
};

test('settings.get() en ligne : instantané (cache), jamais bloqué par le réseau', async () => {
  const client = makeFakeSupabaseClient({ row: SETTINGS_ROW });
  const { DB, localStorage } = loadDb({ online: true, supabaseClient: client });
  // Cache déjà présent (écrit par seed()) — get() doit le retourner
  // immédiatement, sans attendre la réponse Supabase (réseau lent/instable
  // en Côte d'Ivoire : chaque vérification de maintenance ne doit jamais
  // faire attendre l'utilisateur).
  const s = await DB.settings.get();
  assert.equal(typeof s, 'object');
});

test('settings.get() en ligne : rafraîchit le cache local en arrière-plan (_refresh, jamais deux requêtes en vol)', async () => {
  const client = makeFakeSupabaseClient({ row: SETTINGS_ROW });
  const { DB, localStorage } = loadDb({ online: true, supabaseClient: client });

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
  const client = makeFakeSupabaseClient({ throwOnSelect: true });
  const { DB, localStorage } = loadDb({ online: true, supabaseClient: client });
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
  const client = makeFakeSupabaseClient({ onUpdate: (row) => { pushed = row; } });
  const { DB, localStorage } = loadDb({ online: true, supabaseClient: client });

  await DB.settings.update({ platformName: 'Nouveau nom' });

  const cached = JSON.parse(localStorage.getItem('cbp_settings'));
  assert.equal(cached.platformName, 'Nouveau nom');
  assert.equal(DB.syncQueue.all().length, 0);
  assert.equal(pushed.platform_name, 'Nouveau nom');
});

test('settings.update() en ligne mais échec réseau réel : écrit en local ET met en file quand même', async () => {
  const client = makeFakeSupabaseClient({ throwOnUpdate: true });
  const { DB, localStorage } = loadDb({ online: true, supabaseClient: client });

  await DB.settings.update({ platformName: 'Hors service' });

  const cached = JSON.parse(localStorage.getItem('cbp_settings'));
  assert.equal(cached.platformName, 'Hors service');
  assert.equal(DB.syncQueue.all().length, 1);
});

test('drainSyncQueue() : vide la file dès que la connexion revient', async () => {
  let pushed = null;
  const client = makeFakeSupabaseClient({ onUpdate: (row) => { pushed = row; } });
  const { DB, net } = loadDb({ online: false, supabaseClient: client });

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
  const client = makeFakeSupabaseClient({ onUpdate: () => { called = true; } });
  const { DB } = loadDb({ online: false, supabaseClient: client });

  await DB.settings.update({ platformName: 'Toujours hors ligne' });
  await DB.drainSyncQueue();

  assert.equal(called, false);
  assert.equal(DB.syncQueue.all().length, 1, 'reste en file');
});
