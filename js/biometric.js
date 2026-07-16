/* ================================================================
   KBINE PLUS | Connexion biométrique (empreinte / visage)
   ================================================================
   Capacitor natif (plugin capacitor-native-biometric — AndroidX
   BiometricPrompt / iOS LocalAuthentication), jamais le code de
   l'utilisateur : un secret opaque, généré à l'activation, stocké chiffré
   côté OS (Keystore/Keychain) via setCredentials/getCredentials, déverrouillé
   uniquement après succès biométrique. Seul son hash SHA-256 vit en
   LocalStorage — ni le secret, ni le code, n'y apparaissent jamais.
   100% hors ligne : aucun appel réseau/Supabase dans ce fichier.
   Chargé après js/db.js et js/auth.js, avant client.js/cabine.js/admin.js. */
const BiometricAuth = (() => {
  const SERVER_PREFIX = 'kbineplus-biometric';
  const MAX_ATTEMPTS = 3;
  // Un compteur par rôle (client/cabine/admin), pas un seul partagé — sinon
  // des échecs sur l'écran client feraient basculer prématurément l'écran
  // cabine/admin en repli code, alors que ce sont 2 tentatives indépendantes.
  const _attempts = { client: 0, cabine: 0, admin: 0 };

  function _flagKey(role) { return `kbine_biometric_${role}`; }
  function _server(role) { return `${SERVER_PREFIX}:${role}`; }

  // Un plugin Capacitor natif ne se charge pas via <script src> (il n'y a
  // pas de bundler dans ce projet) : une fois installé (npm install +
  // npx cap sync android), Capacitor l'expose lui-même au runtime sur
  // window.Capacitor.Plugins.<Nom>. Lu à chaque appel (pas mis en cache au
  // chargement du script) pour rester robuste à l'ordre d'injection du
  // pont natif. undefined dans un navigateur desktop classique ou sous
  // Node (tests) — traité comme "biométrie indisponible" partout ci-dessous.
  function _plugin() {
    return (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins)
      ? window.Capacitor.Plugins.NativeBiometric
      : (typeof NativeBiometric !== 'undefined' ? NativeBiometric : undefined);
  }

  function _getFlag(role) {
    try { return JSON.parse(localStorage.getItem(_flagKey(role)) || 'null'); }
    catch (e) { return null; }
  }
  function _setFlag(role, data) { localStorage.setItem(_flagKey(role), JSON.stringify(data)); }
  function _clearFlag(role) { localStorage.removeItem(_flagKey(role)); }

  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Distingue "aucun capteur biométrique" (option masquée dans l'UI) de
  // "capteur présent mais aucune empreinte/visage enregistré sur le
  // téléphone" (option visible mais désactivée, avec un message d'aide) —
  // le code d'erreur exact renvoyé ici peut varier selon la version
  // installée du plugin, à vérifier sur un appareil réel à l'implémentation.
  async function checkAvailability() {
    const plugin = _plugin();
    if (!plugin) return { available: false, reason: 'no-hardware' };
    try {
      const result = await plugin.isAvailable();
      if (result && result.isAvailable) return { available: true, reason: 'ok', biometryType: result.biometryType };
      const notEnrolled = result && (result.errorCode === 11 || /enroll/i.test(result.errorMessage || ''));
      return { available: false, reason: notEnrolled ? 'not-enrolled' : 'no-hardware' };
    } catch (e) {
      return { available: false, reason: 'no-hardware' };
    }
  }

  function isEnabled(role) {
    const flag = _getFlag(role);
    return !!(flag && flag.enabled);
  }

  function resetAttempts(role) { _attempts[role] = 0; }

  // Appelée juste après une connexion normale au code réussie (voir
  // proposition d'activation dans client.js/cabine.js/admin.js) —
  // confirme d'abord que l'utilisateur peut réellement s'authentifier
  // avant d'activer quoi que ce soit.
  async function enroll(user, role) {
    const plugin = _plugin();
    if (!plugin) return { ok: false, error: 'Biométrie indisponible sur cet appareil.' };
    try {
      await plugin.verifyIdentity({
        reason: 'Confirmez votre identité pour activer la connexion par empreinte.',
        title: 'Activer la connexion par empreinte',
      });
    } catch (e) {
      return { ok: false, error: 'Vérification biométrique annulée ou échouée.' };
    }
    // Secret aléatoire, jamais dérivé du code — c'est lui qui est chiffré
    // par l'OS, pas le code de l'utilisateur.
    const secret = crypto.randomUUID() + crypto.randomUUID();
    try {
      await plugin.setCredentials({ username: user.id, password: secret, server: _server(role) });
    } catch (e) {
      return { ok: false, error: "Impossible d'enregistrer les informations biométriques sur cet appareil." };
    }
    const token_hash = await sha256(secret);
    _setFlag(role, { user_id: user.id, token_hash, enabled: true });
    return { ok: true };
  }

  // Désactivation (interrupteur Paramètres, ou invalidation automatique
  // suite à un échec de vérification/empreintes modifiées) — l'appelant
  // (js/client.js etc.) est responsable de redemander le code AVANT
  // d'appeler ceci pour une désactivation volontaire (voir le plan).
  async function disable(role) {
    const plugin = _plugin();
    try { if (plugin) await plugin.deleteCredentials({ server: _server(role) }); }
    catch (e) { /* déjà absent — rien à faire */ }
    _clearFlag(role);
  }

  async function loginWithBiometric(role) {
    const flag = _getFlag(role);
    if (!flag || !flag.enabled) return { ok: false, error: 'Connexion par empreinte non activée.' };

    const plugin = _plugin();
    if (!plugin) return { ok: false, error: 'Biométrie indisponible sur cet appareil.' };

    if (_attempts[role] >= MAX_ATTEMPTS) {
      return { ok: false, fallback: true, error: 'Trop de tentatives — utilisez votre code.' };
    }

    try {
      await plugin.verifyIdentity({
        reason: 'Déverrouillez votre compte KBINE PLUS.',
        title: 'Connexion',
      });
    } catch (e) {
      _attempts[role]++;
      const fallback = _attempts[role] >= MAX_ATTEMPTS;
      return {
        ok: false, fallback,
        error: fallback ? 'Trop de tentatives — utilisez votre code.' : 'Empreinte non reconnue, réessayez.',
      };
    }

    let creds;
    try {
      creds = await plugin.getCredentials({ server: _server(role) });
    } catch (e) {
      // Empreintes/visage ajoutés ou retirés sur le téléphone depuis
      // l'activation : la clé Keystore/Keychain liée à la biométrie est
      // invalidée automatiquement par l'OS — comportement natif de la
      // plateforme, pas à réimplémenter. On efface juste le flag local et
      // on force le code par sécurité.
      await disable(role);
      return { ok: false, invalidated: true, error: 'Empreintes modifiées sur cet appareil — reconnectez-vous avec votre code pour réactiver.' };
    }

    const hash = await sha256(creds.password);
    if (hash !== flag.token_hash) {
      await disable(role);
      return { ok: false, invalidated: true, error: 'Échec de vérification — reconnectez-vous avec votre code.' };
    }

    const user = DB.users.byId(flag.user_id);
    if (!user) {
      await disable(role);
      return { ok: false, error: 'Compte introuvable — reconnectez-vous avec votre code.' };
    }

    // Mêmes règles de statut de compte qu'une connexion au code (bloqué/
    // suspendu/inactif/programmation admin) — voir js/auth.js.
    const gates = await Auth._checkAccountGates(user);
    if (!gates.ok) return gates;

    Auth._backupClientSessionIfSwitching(gates.user);
    Auth.save(gates.user);
    _attempts[role] = 0;

    return { ok: true, user: gates.user, ...Auth._applyDeviceBookkeeping(gates.user, true) };
  }

  return { checkAvailability, isEnabled, enroll, disable, loginWithBiometric, resetAttempts, sha256 };
})();
