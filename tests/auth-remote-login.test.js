'use strict';
// Reproduit et vérifie la correction du bug rapporté : un client/cabiniste/
// administrateur déjà connecté sur un premier appareil ne pouvait plus se
// connecter avec ses identifiants (pourtant corrects) sur un second appareil,
// parce que DB.users vivait 100% en local, par appareil (voir js/db.js). Ces
// tests vérifient le nouveau repli serveur de Auth.login() (js/auth.js) :
// ServerAPI.login() est mocké ici (pas de vrai réseau), voir
// tests/helpers/loadApp.js pour le mock injectable.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/loadApp');

function serverProfile(overrides = {}) {
  return {
    id: 'uuid-server-1', nom: 'Traoré', prenom: 'Awa', telephone: '0711223344',
    email: null, role: 'client', solde: 5000, statut: 'actif',
    admin_level: null, permissions: null, zone: null, cabine_nom: null,
    commissions_total: 0, transferts_total: 0, limite_commandes: null,
    tentatives_echouees: 0, suspendu_auto: false, suspendu_by: null,
    suspendu_motif: null, suspendu_jusqu: null, abonnement: null,
    date_creation: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('nouvel appareil, compte jamais vu localement : le repli serveur ouvre la session et met le profil en cache local', async () => {
  const calls = [];
  const serverLogin = async (identifiant, pin, role) => {
    calls.push({ identifiant, pin, role });
    return { ok: true, profile: serverProfile() };
  };
  const { DB, Auth } = loadApp({ serverLogin });
  DB.init();

  const res = await Auth.login('0711223344', '1234', false, 'client');
  assert.equal(res.ok, true);
  assert.equal(res.user.id, 'uuid-server-1');
  assert.equal(res.user.telephone, '0711223344');
  assert.equal(res.user.solde, 5000);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { identifiant: '0711223344', pin: '1234', role: 'client' });

  // Compte désormais "onboardé" sur cet appareil, hors ligne y compris.
  const cached = DB.users.byId('uuid-server-1');
  assert.ok(cached);
  assert.equal(DB.users.checkPwd(cached, '1234'), true);
});

test('compte inconnu localement ET côté serveur : "Compte introuvable.", jamais de session', async () => {
  const serverLogin = async () => ({ ok: false, error: 'Compte introuvable.' });
  const { DB, Auth } = loadApp({ serverLogin });
  DB.init();

  const res = await Auth.login('0799999999', '1234', false, 'client');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Compte introuvable.');
});

test('compte déjà connu localement sous un ancien id : la fusion serveur met à jour les champs mais conserve l\'id local (ne casse pas les données déjà liées)', async () => {
  const serverLogin = async () => ({ ok: true, profile: serverProfile({ solde: 12000 }) });
  const { DB, Auth } = loadApp({ serverLogin });
  DB.init();
  // Simule exactement le bug rapporté : un compte créé localement (ex. par
  // l'admin sur SON appareil) avec un mot de passe local qui ne correspond
  // plus à ce que le serveur considère correct.
  const localUser = DB.users.create({
    prenom: 'Awa', nom: 'Traoré', telephone: '0711223344',
    mot_de_passe: '0000', role: 'client', statut: 'actif',
  });

  const res = await Auth.login('0711223344', '1234', false, 'client');
  assert.equal(res.ok, true);
  assert.equal(res.user.id, localUser.id);
  assert.equal(res.user.solde, 12000);
  assert.equal(DB.users.checkPwd(DB.users.byId(localUser.id), '1234'), true);
});

test('compte bloqué localement : refus immédiat, aucun appel au serveur', async () => {
  let called = false;
  const serverLogin = async () => { called = true; return { ok: true, profile: serverProfile() }; };
  const { DB, Auth } = loadApp({ serverLogin });
  DB.init();
  DB.users.create({
    prenom: 'Awa', nom: 'Traoré', telephone: '0711223344',
    mot_de_passe: '1234', role: 'client', statut: 'bloqué',
  });

  const res = await Auth.login('0711223344', '1234', false, 'client');
  assert.equal(res.ok, false);
  assert.match(res.error, /bloqué/);
  assert.equal(called, false);
});

test('hors ligne : Auth.login() ne tente jamais ServerAPI.login, comportement local existant conservé', async () => {
  let called = false;
  const serverLogin = async () => { called = true; return { ok: true, profile: serverProfile() }; };
  const { DB, Auth } = loadApp({ serverLogin, online: false });
  DB.init();

  const res = await Auth.login('0711223344', '1234', false, 'client');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Compte introuvable.');
  assert.equal(called, false);
});

test('mot de passe local ET serveur incorrects : compteur d\'échecs local incrémenté, bloqué au 3e essai', async () => {
  const serverLogin = async () => ({ ok: false, error: 'Identifiant ou PIN incorrect.' });
  const { DB, Auth } = loadApp({ serverLogin });
  DB.init();
  DB.users.create({
    prenom: 'Awa', nom: 'Traoré', telephone: '0711223344',
    mot_de_passe: '1234', role: 'client', statut: 'actif',
  });

  await Auth.login('0711223344', '0000', false, 'client');
  await Auth.login('0711223344', '0000', false, 'client');
  const res3 = await Auth.login('0711223344', '0000', false, 'client');
  assert.equal(res3.ok, false);
  assert.match(res3.error, /bloqué/);

  const stored = DB.users.byPhoneAndRole('0711223344', 'client');
  assert.equal(stored.statut, 'bloqué');
});

test('reconnexion suivante sur le même appareil après un repli serveur réussi : entièrement locale (ServerAPI.login non rappelé)', async () => {
  let calls = 0;
  const serverLogin = async () => { calls++; return { ok: true, profile: serverProfile() }; };
  const { DB, Auth } = loadApp({ serverLogin });
  DB.init();

  const first = await Auth.login('0711223344', '1234', false, 'client');
  assert.equal(first.ok, true);
  assert.equal(calls, 1);

  const second = await Auth.login('0711223344', '1234', false, 'client');
  assert.equal(second.ok, true);
  assert.equal(calls, 1); // pas de second appel réseau : le mot de passe local suffit désormais
});

test('connexion admin réussie via le chemin local : établit une session serveur en arrière-plan (jamais bloquant)', async () => {
  const calls = [];
  const serverEstablishSession = async (identifiant, pin, role) => {
    calls.push({ identifiant, pin, role });
    return { ok: true };
  };
  const { DB, Auth } = loadApp({ serverEstablishSession });
  DB.init();
  DB.users.create({
    prenom: 'Admin', nom: 'Super', email: 'admin.super@gmail.com',
    mot_de_passe: '1234', role: 'admin', admin_level: 'super', statut: 'actif',
  });

  const res = await Auth.login('admin.super@gmail.com', '1234', false, 'admin');
  assert.equal(res.ok, true);
  // Invoquée de façon synchrone (avant même le retour de login()), même si
  // elle-même ne bloque jamais la connexion — voir Auth.login() (js/auth.js).
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { identifiant: 'admin.super@gmail.com', pin: '1234', role: 'admin' });
});

test('connexion client réussie via le chemin local : n\'établit jamais de session en arrière-plan (réservé aux admins)', async () => {
  let called = false;
  const serverEstablishSession = async () => { called = true; return { ok: true }; };
  const { DB, Auth } = loadApp({ serverEstablishSession });
  DB.init();
  DB.users.create({
    prenom: 'Jean', nom: 'Client', telephone: '0700000001',
    mot_de_passe: '1234', role: 'client', statut: 'actif',
  });

  const res = await Auth.login('0700000001', '1234', false, 'client');
  assert.equal(res.ok, true);
  assert.equal(called, false);
});
