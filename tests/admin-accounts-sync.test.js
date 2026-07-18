'use strict';
// DB.users.mergeProfileList() (js/db.js) — corrige un bug rapporté : après
// suppression d'un compte client/cabine/admin via api/admin_delete_account.php
// (super admin uniquement), le compte supprimé restait affiché indéfiniment
// dans le tableau de bord admin. mergeProfileList() ne faisait jusqu'ici
// qu'ajouter/mettre à jour (upsert) sans jamais retirer une entrée locale
// absente de la réponse serveur, qui est pourtant la liste COMPLÈTE de ce
// rôle (voir api/list_profiles.php, jamais paginé). Voir aussi
// tests/orders-business.test.js pour le même correctif côté DB.transactions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDb } = require('./helpers/loadDb');

test('mergeProfileList() : retire un compte supprimé côté serveur (absent de la réponse)', () => {
  const { DB } = loadDb({ online: true });
  DB.users.cacheFromServer({ id: 'srv-1', role: 'client', telephone: '0700000001', statut: 'actif' });
  DB.users.cacheFromServer({ id: 'srv-2', role: 'client', telephone: '0700000002', statut: 'actif' });
  assert.equal(DB.users.byRole('client').length, 2);

  // srv-1 a été supprimé côté serveur : la réponse ne contient plus que srv-2.
  DB.users.mergeProfileList([
    { id: 'srv-2', role: 'client', telephone: '0700000002', statut: 'actif' },
  ], 'client');

  assert.equal(DB.users.byId('srv-1'), undefined, 'compte supprimé retiré du cache local');
  assert.ok(DB.users.byId('srv-2'), 'compte toujours présent côté serveur conservé');
});

test('mergeProfileList() : ne purge jamais un autre rôle', () => {
  const { DB } = loadDb({ online: true });
  DB.users.cacheFromServer({ id: 'cab-1', role: 'cabine', telephone: '0700000003', statut: 'actif' });

  // Réponse vide pour le rôle 'client' : ne doit pas affecter la cabine existante.
  DB.users.mergeProfileList([], 'client');

  assert.ok(DB.users.byId('cab-1'), 'compte cabine non concerné par une purge scopée au rôle client');
});

test('mergeProfileList() : ne purge jamais un compte créé hors ligne, pas encore synchronisé', () => {
  const { DB } = loadDb({ online: true });
  const localOnly = DB.users.create({ prenom: '0700000004', telephone: '0700000004', mot_de_passe: '1234', role: 'client' });
  assert.match(localOnly.id, /^u_/);

  DB.users.mergeProfileList([], 'client');

  assert.ok(DB.users.byId(localOnly.id), 'compte local non synchronisé conservé malgré une liste serveur vide');
});
