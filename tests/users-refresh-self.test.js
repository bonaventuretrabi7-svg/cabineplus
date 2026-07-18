'use strict';
// DB.users.refreshSelf() (js/db.js) — corrige un bug rapporté : après une
// recharge faite par l'administration (ou tout autre changement fait
// ailleurs), le compte connecté restait affiché avec son ANCIEN solde sur
// cet appareil jusqu'à une déconnexion/reconnexion complète, car
// cacheFromServer() n'était jusqu'ici jamais rappelé après le login initial.
// Voir js/client.js (startClientPresence) et js/cabine.js (setInterval de
// boot()), qui appellent désormais refreshSelf() à intervalles réguliers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDb } = require('./helpers/loadDb');

test('refreshSelf() en ligne : remplace le solde local par la valeur serveur à jour', async () => {
  const { DB } = loadDb({
    online: true,
    serverWhoami: async () => ({ ok: true, profile: {
      id: 'u1', role: 'client', telephone: '0700000000', nom: 'Doe', prenom: 'Jane',
      solde: 5000, statut: 'actif',
    } }),
  });
  DB.users.cacheFromServer({ id: 'u1', role: 'client', telephone: '0700000000', nom: 'Doe', prenom: 'Jane', solde: 1000, statut: 'actif' });
  assert.equal(DB.users.byId('u1').solde, 1000);

  const updated = await DB.users.refreshSelf();
  assert.equal(updated.solde, 5000, 'la valeur renvoyée reflète déjà le nouveau solde');
  assert.equal(DB.users.byId('u1').solde, 5000, 'le cache local est mis à jour sans repasser par le login');
});

test('refreshSelf() hors ligne : ne tente jamais le réseau, cache local inchangé', async () => {
  let called = false;
  const { DB } = loadDb({
    online: false,
    serverWhoami: async () => { called = true; return { ok: true, profile: { id: 'u1', role: 'client', telephone: '0700000000', solde: 9999, statut: 'actif' } }; },
  });
  DB.users.cacheFromServer({ id: 'u1', role: 'client', telephone: '0700000000', solde: 1000, statut: 'actif' });

  const res = await DB.users.refreshSelf();
  assert.equal(res, null);
  assert.equal(called, false);
  assert.equal(DB.users.byId('u1').solde, 1000);
});

test('refreshSelf() : jeton invalide/expiré côté serveur -> null, cache local inchangé', async () => {
  const { DB } = loadDb({
    online: true,
    serverWhoami: async () => ({ ok: false, error: 'Session expirée, reconnectez-vous.' }),
  });
  DB.users.cacheFromServer({ id: 'u1', role: 'client', telephone: '0700000000', solde: 1000, statut: 'actif' });

  const res = await DB.users.refreshSelf();
  assert.equal(res, null);
  assert.equal(DB.users.byId('u1').solde, 1000);
});
