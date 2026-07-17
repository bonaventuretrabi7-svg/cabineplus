/* ================================================================
   KBINE PLUS | Connexion biométrique (empreinte / visage)
   ================================================================
   Deux "ponts" possibles vers le capteur biométrique, choisis
   automatiquement selon le contexte (voir _backend()) — jamais le code
   de l'utilisateur dans un cas comme dans l'autre, 100% local, aucun
   appel réseau/serveur dans ce fichier :

   - App Android empaquetée (Capacitor) : plugin natif
     capacitor-native-biometric (AndroidX BiometricPrompt). Un secret
     opaque, généré à l'activation, stocké chiffré côté OS (Keystore) via
     setCredentials/getCredentials, déverrouillé uniquement après succès
     biométrique — seul son hash SHA-256 vit en LocalStorage.
   - Site web (navigateur, "PWA") : WebAuthn (navigator.credentials),
     seule API biométrique disponible hors de l'app empaquetée. Pas de
     secret séparé à stocker : la clé créée par le navigateur est déjà
     liée au capteur (Face ID/empreinte) au niveau matériel — seul son
     identifiant (credential_id, pas la clé elle-même) vit en LocalStorage.
     Volontairement local uniquement : ce projet n'a aucun backend
     d'authentification pour jouer le rôle de "relying party" WebAuthn
     (vérification de signature serveur) — la garantie de sécurité vient
     du capteur biométrique de l'OS qui doit réussir pour que
     navigator.credentials.get() aboutisse, exactement comme le plugin
     natif ci-dessus. Limite assumée de la plateforme : aucune API
     navigateur ne permet de supprimer réellement une clé WebAuthn créée
     (voir disable()) — seule la référence locale est effacée.

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
  // Node (tests).
  function _plugin() {
    return (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins)
      ? window.Capacitor.Plugins.NativeBiometric
      : (typeof NativeBiometric !== 'undefined' ? NativeBiometric : undefined);
  }

  function _webauthnSupported() {
    return typeof window !== 'undefined' && !!window.PublicKeyCredential
      && typeof navigator !== 'undefined' && !!navigator.credentials;
  }

  // 'capacitor' dans l'app Android empaquetée, 'webauthn' sur le site web
  // si le navigateur le permet, null sinon ("biométrie indisponible" dans
  // tous les appels ci-dessous). Le plugin natif est toujours prioritaire
  // quand les deux seraient techniquement présents (jamais le cas en
  // pratique : window.Capacitor n'existe pas dans un navigateur classique).
  function _backend() {
    if (_plugin()) return 'capacitor';
    if (_webauthnSupported()) return 'webauthn';
    return null;
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

  function _bufToB64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
  function _b64ToBuf(b64) { return Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer; }

  // Distingue "aucun capteur biométrique" (option masquée dans l'UI) de
  // "capteur présent mais aucune empreinte/visage enregistré sur le
  // téléphone" (option visible mais désactivée, avec un message d'aide) —
  // uniquement possible côté Capacitor (le code d'erreur exact renvoyé
  // peut varier selon la version installée du plugin, à vérifier sur un
  // appareil réel). Côté WebAuthn, le navigateur ne renvoie qu'un booléen
  // (isUserVerifyingPlatformAuthenticatorAvailable) : impossible de
  // distinguer les deux cas, on retombe alors toujours sur 'no-hardware'.
  async function checkAvailability() {
    const backend = _backend();
    if (backend === 'capacitor') {
      const plugin = _plugin();
      try {
        const result = await plugin.isAvailable();
        if (result && result.isAvailable) return { available: true, reason: 'ok', biometryType: result.biometryType };
        const notEnrolled = result && (result.errorCode === 11 || /enroll/i.test(result.errorMessage || ''));
        return { available: false, reason: notEnrolled ? 'not-enrolled' : 'no-hardware' };
      } catch (e) {
        return { available: false, reason: 'no-hardware' };
      }
    }
    if (backend === 'webauthn') {
      try {
        const ok = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
        return ok ? { available: true, reason: 'ok', biometryType: 'webauthn' } : { available: false, reason: 'no-hardware' };
      } catch (e) {
        return { available: false, reason: 'no-hardware' };
      }
    }
    return { available: false, reason: 'no-hardware' };
  }

  function isEnabled(role) {
    const flag = _getFlag(role);
    return !!(flag && flag.enabled);
  }

  function resetAttempts(role) { _attempts[role] = 0; }

  async function _capacitorEnroll(user, role) {
    const plugin = _plugin();
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
    _setFlag(role, { user_id: user.id, token_hash, enabled: true, backend: 'capacitor' });
    return { ok: true };
  }

  // La clé WebAuthn créée est déjà liée au capteur au niveau matériel :
  // pas de secret séparé à générer/chiffrer nous-mêmes (contrairement au
  // plugin natif) — l'aboutissement de create() EST la preuve que le
  // capteur a validé l'utilisateur.
  async function _webauthnEnroll(user, role) {
    try {
      const cred = await navigator.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { name: 'KBINE PLUS' },
          user: {
            id: new TextEncoder().encode(user.id),
            name: user.telephone || user.email || user.id,
            displayName: `${user.prenom || ''} ${user.nom || ''}`.trim() || (user.telephone || user.id),
          },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
          timeout: 60000,
          attestation: 'none',
        },
      });
      if (!cred) return { ok: false, error: 'Vérification biométrique annulée ou échouée.' };
      _setFlag(role, { user_id: user.id, credential_id: _bufToB64(cred.rawId), enabled: true, backend: 'webauthn' });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'Vérification biométrique annulée ou échouée.' };
    }
  }

  // Appelée juste après une connexion normale au code réussie (voir
  // proposition d'activation dans client.js/cabine.js/admin.js) —
  // confirme d'abord que l'utilisateur peut réellement s'authentifier
  // avant d'activer quoi que ce soit.
  async function enroll(user, role) {
    const backend = _backend();
    if (!backend) return { ok: false, error: 'Biométrie indisponible sur cet appareil.' };
    return backend === 'webauthn' ? _webauthnEnroll(user, role) : _capacitorEnroll(user, role);
  }

  // Désactivation (interrupteur Paramètres, ou invalidation automatique
  // suite à un échec de vérification/empreintes modifiées) — l'appelant
  // (js/client.js etc.) est responsable de redemander le code AVANT
  // d'appeler ceci pour une désactivation volontaire (voir le plan).
  async function disable(role) {
    const flag = _getFlag(role);
    if (flag && flag.backend !== 'webauthn') {
      const plugin = _plugin();
      try { if (plugin) await plugin.deleteCredentials({ server: _server(role) }); }
      catch (e) { /* déjà absent — rien à faire */ }
    }
    // WebAuthn : aucune API navigateur ne permet de supprimer réellement
    // la clé créée côté plateforme (voir note en tête de fichier) — on
    // efface seulement la référence locale, la rendant inutilisable par
    // l'app (l'app ne peut plus jamais s'en servir pour se connecter).
    _clearFlag(role);
  }

  async function _capacitorVerify(role, flag) {
    const plugin = _plugin();
    try {
      await plugin.verifyIdentity({ reason: 'Déverrouillez votre compte KBINE PLUS.', title: 'Connexion' });
    } catch (e) {
      return { ok: false, error: 'Empreinte non reconnue, réessayez.' };
    }
    let creds;
    try {
      creds = await plugin.getCredentials({ server: _server(role) });
    } catch (e) {
      // Empreintes/visage ajoutés ou retirés sur le téléphone depuis
      // l'activation : la clé Keystore liée à la biométrie est invalidée
      // automatiquement par l'OS — comportement natif de la plateforme,
      // pas à réimplémenter.
      return { ok: false, invalidated: true, error: 'Empreintes modifiées sur cet appareil — reconnectez-vous avec votre code pour réactiver.' };
    }
    const hash = await sha256(creds.password);
    if (hash !== flag.token_hash) {
      return { ok: false, invalidated: true, error: 'Échec de vérification — reconnectez-vous avec votre code.' };
    }
    return { ok: true };
  }

  async function _webauthnVerify(flag) {
    try {
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          allowCredentials: [{ id: _b64ToBuf(flag.credential_id), type: 'public-key' }],
          userVerification: 'required',
          timeout: 60000,
        },
      });
      if (!assertion) return { ok: false, error: 'Empreinte/Face ID non reconnu(e), réessayez.' };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'Empreinte/Face ID non reconnu(e), réessayez.' };
    }
  }

  async function loginWithBiometric(role) {
    const flag = _getFlag(role);
    if (!flag || !flag.enabled) return { ok: false, error: 'Connexion par empreinte non activée.' };

    const flagBackend = flag.backend === 'webauthn' ? 'webauthn' : 'capacitor';
    if (_backend() !== flagBackend) {
      // Activée depuis l'app Android puis tentative depuis le site web
      // (ou l'inverse) : chaque pont a sa propre clé/secret côté
      // plateforme, jamais interchangeable.
      return { ok: false, error: 'Biométrie indisponible sur cet appareil.' };
    }

    if (_attempts[role] >= MAX_ATTEMPTS) {
      return { ok: false, fallback: true, error: 'Trop de tentatives — utilisez votre code.' };
    }

    const result = flagBackend === 'webauthn' ? await _webauthnVerify(flag) : await _capacitorVerify(role, flag);
    if (!result.ok) {
      if (result.invalidated) { await disable(role); return result; }
      _attempts[role]++;
      const fallback = _attempts[role] >= MAX_ATTEMPTS;
      return {
        ok: false, fallback,
        error: fallback ? 'Trop de tentatives — utilisez votre code.' : result.error,
      };
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
