'use strict';
// Scénarios clés de la connexion biométrique (voir le plan) : le plugin
// natif capacitor-native-biometric ne peut pas tourner sous Node — ces
// tests mockent window.NativeBiometric pour vérifier la logique de
// décision de BiometricAuth (js/biometric.js), pas le comportement matériel
// réel (à valider sur un appareil Android, voir le plan).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/loadApp');

/* Fake plugin natif — un `vault` partagé simule le stockage chiffré
   persistant (Keystore/Keychain) entre l'activation et les connexions
   suivantes. `_state.failVerify`/`_state.failGetCredentials` sont mutables
   après coup, pour simuler un échec de capteur ou une invalidation. */
function makeFakeNativeBiometric(vault = {}) {
  const _state = { failVerify: false, failGetCredentials: false };
  return {
    _vault: vault,
    _state,
    async isAvailable() { return { isAvailable: true }; },
    async verifyIdentity() {
      if (_state.failVerify) throw new Error('biometric failed');
      return true;
    },
    async setCredentials({ username, password, server }) { vault[server] = { username, password }; },
    async getCredentials({ server }) {
      if (_state.failGetCredentials) throw new Error('invalidated');
      const rec = vault[server];
      if (!rec) throw new Error('no credentials');
      return rec;
    },
    async deleteCredentials({ server }) { delete vault[server]; },
  };
}

function makeUser(DB, overrides = {}) {
  return DB.users.create({
    prenom: 'Jean', nom: 'Test', telephone: '0700000000',
    mot_de_passe: '1234', role: 'client', statut: 'actif', ...overrides,
  });
}

test('activation : stocke un hash local, jamais le code ni le secret en clair', async () => {
  const bio = makeFakeNativeBiometric();
  const { DB, BiometricAuth, localStorage } = loadApp({ nativeBiometric: bio });
  DB.init();
  const user = makeUser(DB);

  const res = await BiometricAuth.enroll(user, 'client');
  assert.equal(res.ok, true);

  const flag = JSON.parse(localStorage.getItem('kbine_biometric_client'));
  assert.equal(flag.user_id, user.id);
  assert.match(flag.token_hash, /^[0-9a-f]{64}$/); // hex SHA-256

  // Le secret réellement stocké côté "Keystore" (vault) n'est pas le code.
  const stored = bio._vault['kbineplus-biometric:client'];
  assert.notEqual(stored.password, '1234');

  // Aucune trace du code ni du secret en clair dans l'enregistrement stocké.
  const raw = localStorage.getItem('kbine_biometric_client');
  assert.ok(!raw.includes('1234'));
  assert.ok(!raw.includes(stored.password));
});

test('connexion biométrique réussie : ouvre une session pour le bon utilisateur', async () => {
  const bio = makeFakeNativeBiometric();
  const { DB, Auth, BiometricAuth } = loadApp({ nativeBiometric: bio });
  DB.init();
  const user = makeUser(DB);

  await BiometricAuth.enroll(user, 'client');
  const res = await BiometricAuth.loginWithBiometric('client');

  assert.equal(res.ok, true);
  assert.equal(res.user.id, user.id);
  assert.equal(Auth.current().id, user.id);
});

test('repli sur le code après 3 échecs consécutifs', async () => {
  const bio = makeFakeNativeBiometric();
  const { DB, BiometricAuth } = loadApp({ nativeBiometric: bio });
  DB.init();
  const user = makeUser(DB);
  await BiometricAuth.enroll(user, 'client');

  bio._state.failVerify = true; // le capteur ne reconnaît plus le doigt

  const r1 = await BiometricAuth.loginWithBiometric('client');
  assert.equal(r1.ok, false);
  assert.ok(!r1.fallback, 'pas encore au bout de 3 échecs');
  const r2 = await BiometricAuth.loginWithBiometric('client');
  assert.ok(!r2.fallback, 'pas encore au bout de 3 échecs');
  const r3 = await BiometricAuth.loginWithBiometric('client');
  assert.equal(r3.fallback, true, 'après 3 échecs, doit signaler le repli sur le code');
});

test('le compteur d\'échecs est indépendant par rôle (client/cabine/admin)', async () => {
  const bio = makeFakeNativeBiometric();
  const { DB, BiometricAuth } = loadApp({ nativeBiometric: bio });
  DB.init();
  const client = makeUser(DB, { role: 'client' });
  const cabine = makeUser(DB, { role: 'cabine', telephone: '0711111111' });
  await BiometricAuth.enroll(client, 'client');
  await BiometricAuth.enroll(cabine, 'cabine');

  bio._state.failVerify = true;

  // 3 échecs sur le rôle client...
  await BiometricAuth.loginWithBiometric('client');
  await BiometricAuth.loginWithBiometric('client');
  const rClient3 = await BiometricAuth.loginWithBiometric('client');
  assert.equal(rClient3.fallback, true);

  // ... ne doivent pas affecter le budget d'essais du rôle cabine.
  const rCabine1 = await BiometricAuth.loginWithBiometric('cabine');
  assert.ok(!rCabine1.fallback, 'le rôle cabine doit garder ses 3 essais propres');
});

test('changement d\'empreintes sur le téléphone : invalide le jeton et redemande le code', async () => {
  const bio = makeFakeNativeBiometric();
  const { DB, BiometricAuth } = loadApp({ nativeBiometric: bio });
  DB.init();
  const user = makeUser(DB);
  await BiometricAuth.enroll(user, 'client');
  assert.equal(BiometricAuth.isEnabled('client'), true);

  // L'OS invalide la clé Keystore liée à la biométrie dès que les
  // empreintes enregistrées changent — getCredentials() se met à échouer.
  bio._state.failGetCredentials = true;

  const res = await BiometricAuth.loginWithBiometric('client');
  assert.equal(res.ok, false);
  assert.equal(res.invalidated, true);
  assert.equal(BiometricAuth.isEnabled('client'), false, 'le flag local doit être effacé');
});

test('fonctionne hors ligne : aucun accès à Supabase pendant la connexion biométrique', async () => {
  const bio = makeFakeNativeBiometric();
  // Proxy qui explose au moindre accès — prouve que ce chemin ne touche
  // jamais Supabase pour un rôle client (contrairement à un admin simple,
  // qui doit vérifier settings.admin_schedules — voir js/auth.js).
  const explosiveClient = new Proxy({}, {
    get() { throw new Error('SupabaseAPI.client ne doit jamais être touché ici'); },
  });
  const { DB, BiometricAuth } = loadApp({ nativeBiometric: bio, supabaseClient: explosiveClient });
  DB.init();
  const user = makeUser(DB, { role: 'client' });

  await BiometricAuth.enroll(user, 'client');
  const res = await BiometricAuth.loginWithBiometric('client');

  assert.equal(res.ok, true, 'doit réussir sans jamais toucher à Supabase');
});

test('désactivation : refusée sans le bon code (vérifié par l\'appelant via DB.users.checkPwd)', async () => {
  const bio = makeFakeNativeBiometric();
  const { DB, BiometricAuth } = loadApp({ nativeBiometric: bio });
  DB.init();
  const user = makeUser(DB);
  await BiometricAuth.enroll(user, 'client');

  // Patron attendu côté UI (js/client.js) : ne jamais appeler disable()
  // sans avoir d'abord validé le code.
  const wrongPinOk = DB.users.checkPwd(DB.users.byId(user.id), '0000');
  assert.equal(wrongPinOk, false);
  if (wrongPinOk) await BiometricAuth.disable('client');

  assert.equal(BiometricAuth.isEnabled('client'), true, 'reste activé tant que le code n\'est pas confirmé');

  const rightPinOk = DB.users.checkPwd(DB.users.byId(user.id), '1234');
  assert.equal(rightPinOk, true);
  if (rightPinOk) await BiometricAuth.disable('client');
  assert.equal(BiometricAuth.isEnabled('client'), false);
});

/* ================================================================
   BACKEND WEBAUTHN (site web / "PWA" — pas de plugin Capacitor natif)
   ================================================================
   Même API navigator.credentials.create/get indisponible sous Node —
   ces tests mockent window.PublicKeyCredential + navigator.credentials
   pour vérifier que la même logique de décision (BiometricAuth) se
   comporte correctement avec ce second pont. Le comportement matériel
   réel (vrai prompt Face ID/empreinte du navigateur) doit être validé
   sur un appareil/navigateur réel (voir le plan). */
function makeFakeWebAuthn() {
  const _state = { available: true, failCreate: false, failGet: false };
  return {
    _state,
    get available() { return _state.available; },
    async create() {
      if (_state.failCreate) throw new Error('user cancelled');
      const rawId = new TextEncoder().encode('cred-' + Math.random().toString(36).slice(2)).buffer;
      return { rawId };
    },
    async get() {
      if (_state.failGet) throw new Error('not recognized');
      return { id: 'assertion-ok' };
    },
  };
}

test('WebAuthn — activation : stocke l\'identifiant de la clé, jamais de secret séparé', async () => {
  const webauthn = makeFakeWebAuthn();
  const { DB, BiometricAuth, localStorage } = loadApp({ webauthn });
  DB.init();
  const user = makeUser(DB);

  const res = await BiometricAuth.enroll(user, 'client');
  assert.equal(res.ok, true);

  const flag = JSON.parse(localStorage.getItem('kbine_biometric_client'));
  assert.equal(flag.user_id, user.id);
  assert.equal(flag.backend, 'webauthn');
  assert.ok(flag.credential_id, 'identifiant de la clé WebAuthn conservé');
  assert.equal(flag.token_hash, undefined, 'aucun secret/hash séparé côté WebAuthn — la clé elle-même est déjà liée au capteur');

  const raw = localStorage.getItem('kbine_biometric_client');
  assert.ok(!raw.includes('1234'), 'jamais le code en clair');
});

test('WebAuthn — connexion biométrique réussie : ouvre une session pour le bon utilisateur', async () => {
  const webauthn = makeFakeWebAuthn();
  const { DB, Auth, BiometricAuth } = loadApp({ webauthn });
  DB.init();
  const user = makeUser(DB);

  await BiometricAuth.enroll(user, 'client');
  const res = await BiometricAuth.loginWithBiometric('client');

  assert.equal(res.ok, true);
  assert.equal(res.user.id, user.id);
  assert.equal(Auth.current().id, user.id);
});

test('WebAuthn — repli sur le code après 3 échecs consécutifs', async () => {
  const webauthn = makeFakeWebAuthn();
  const { DB, BiometricAuth } = loadApp({ webauthn });
  DB.init();
  const user = makeUser(DB);
  await BiometricAuth.enroll(user, 'client');

  webauthn._state.failGet = true; // le capteur ne reconnaît plus le doigt/visage

  await BiometricAuth.loginWithBiometric('client');
  await BiometricAuth.loginWithBiometric('client');
  const r3 = await BiometricAuth.loginWithBiometric('client');
  assert.equal(r3.fallback, true, 'après 3 échecs, doit signaler le repli sur le code');
});

test('WebAuthn — checkAvailability() : capteur indisponible → no-hardware (pas de distinction possible avec "non enrôlé")', async () => {
  const webauthn = makeFakeWebAuthn();
  webauthn._state.available = false;
  const { DB, BiometricAuth } = loadApp({ webauthn });
  DB.init();

  const avail = await BiometricAuth.checkAvailability();
  assert.equal(avail.available, false);
  assert.equal(avail.reason, 'no-hardware');
});

test('WebAuthn — désactivation efface la référence locale (aucune API navigateur pour supprimer la clé elle-même)', async () => {
  const webauthn = makeFakeWebAuthn();
  const { DB, BiometricAuth } = loadApp({ webauthn });
  DB.init();
  const user = makeUser(DB);
  await BiometricAuth.enroll(user, 'client');
  assert.equal(BiometricAuth.isEnabled('client'), true);

  await BiometricAuth.disable('client');
  assert.equal(BiometricAuth.isEnabled('client'), false);
  const res = await BiometricAuth.loginWithBiometric('client');
  assert.equal(res.ok, false, 'ne peut plus être utilisée par l\'app une fois désactivée');
});

test('Sélection du pont : le plugin natif Capacitor est prioritaire si les deux sont présents', async () => {
  const bio = makeFakeNativeBiometric();
  const webauthn = makeFakeWebAuthn();
  const { DB, BiometricAuth, localStorage } = loadApp({ nativeBiometric: bio, webauthn });
  DB.init();
  const user = makeUser(DB);

  await BiometricAuth.enroll(user, 'client');
  const flag = JSON.parse(localStorage.getItem('kbine_biometric_client'));
  assert.equal(flag.backend, 'capacitor');
});

test('Une biométrie activée via un pont ne peut pas être utilisée via l\'autre (jamais interchangeable)', async () => {
  const bio = makeFakeNativeBiometric();
  const { DB, BiometricAuth } = loadApp({ nativeBiometric: bio }); // activée côté Capacitor (app Android)
  DB.init();
  const user = makeUser(DB);
  await BiometricAuth.enroll(user, 'client');

  // Même appareil/compte, mais cette fois-ci depuis le site web (pas de
  // window.Capacitor.Plugins) : simulé en rechargeant l'app avec le même
  // flag localStorage déjà écrit, mais un environnement WebAuthn-only.
  const rawFlag = JSON.stringify({ user_id: user.id, token_hash: 'whatever', enabled: true, backend: 'capacitor' });
  const webauthn = makeFakeWebAuthn();
  const second = loadApp({ webauthn });
  second.DB.init();
  second.localStorage.setItem('kbine_biometric_client', rawFlag);

  const res = await second.BiometricAuth.loginWithBiometric('client');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Biométrie indisponible sur cet appareil.');
});
