/* ================================================================
   KBINE PLUS | Client API serveur (PHP + MySQL, hébergement Hostinger)
   ================================================================
   Remplace js/supabase-client.js (Supabase, abandonné — voir supabase/,
   conservé dans le dépôt pour l'historique mais hors service). Même
   "forme" d'API (login/createAccount/adminCreateAccount/logout/
   isConfigured) que l'ancien SupabaseAPI, pour que js/db.js/js/auth.js/
   js/client.js/js/admin.js n'aient eu besoin que d'un renommage d'appel,
   pas d'une réécriture — voir api/ pour le code serveur correspondant.
   Doit être chargé après js/server-config.js, avant js/db.js et
   js/auth.js. */
const ServerAPI = (() => {
  const BASE_URL = SERVER_CONFIG.baseUrl;
  const isConfigured = !!BASE_URL;

  // Jeton opaque émis par api/login.php (table `sessions`) — remplace la
  // session Supabase Auth. Conservé en sessionStorage (comme cbp_session)
  // pour survivre à un F5 mais pas à la fermeture de l'onglet.
  const TOKEN_KEY = 'cbp_server_token';
  let _token = null;
  try { _token = sessionStorage.getItem(TOKEN_KEY); } catch (e) { /* stockage indisponible */ }

  function _setToken(token) {
    _token = token || null;
    try {
      if (token) sessionStorage.setItem(TOKEN_KEY, token);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* stockage indisponible — jeton encore valable en mémoire pour cet onglet */ }
  }

  async function _call(path, { body, auth = false } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth && _token) headers['Authorization'] = 'Bearer ' + _token;
    const res = await fetch(BASE_URL + '/' + path, {
      method: 'POST', headers, body: JSON.stringify(body || {}),
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* réponse non-JSON (ex. erreur serveur brute) */ }
    return { res, data };
  }

  /* Vérifie identifiant+PIN côté serveur (voir api/login.php), obtient un
     jeton d'accès en cas de succès. */
  async function login(identifiant, pin, role) {
    const { res, data } = await _call('login.php', { body: { identifiant, pin, role } });
    if (!res.ok || !data || data.error) {
      return { ok: false, error: (data && data.error) || 'Identifiant ou PIN incorrect.' };
    }
    _setToken(data.token);
    return { ok: true, profile: data.profile };
  }

  /* Mode "silent" (voir api/login.php) — établit/rafraîchit un jeton en
     arrière-plan sans jamais faire progresser le compteur de tentatives
     en cas d'échec. Utilisé par Auth.login() (js/auth.js) après une
     connexion admin réussie via le chemin local rapide. */
  async function establishSession(identifiant, pin, role) {
    const { res, data } = await _call('login.php', { body: { identifiant, pin, role, silent: true } });
    if (!res.ok || !data || data.error) return { ok: false };
    _setToken(data.token);
    return { ok: true };
  }

  async function logout() {
    if (_token) {
      try { await _call('logout.php', { auth: true }); } catch (e) { /* best-effort */ }
    }
    _setToken(null);
  }

  /* Auto-inscription client/cabine (voir api/create_account.php, public) —
     utilisée par handleAuthGateRegister() dans js/client.js. */
  async function createAccount({ role, nom, prenom, telephone, pin, email, cabineNom }) {
    const { res, data } = await _call('create_account.php', {
      body: { role, nom, prenom, telephone, pin, email: email || null, cabine_nom: cabineNom || null },
    });
    if (!res.ok || !data || data.error) {
      return { ok: false, error: (data && data.error) || 'Échec de la création du compte.' };
    }
    return { ok: true, profile: data.profile };
  }

  /* Création de compte PAR L'ADMINISTRATION (voir
     api/admin_create_account.php, réservée à un jeton admin) — utilisée
     par finishCreateUser()/validatePartnerRequest() dans js/admin.js. */
  async function adminCreateAccount({ role, nom, prenom, telephone, pin, email, cabineNom, adminLevel }) {
    const { res, data } = await _call('admin_create_account.php', {
      auth: true,
      body: {
        role, nom, prenom, telephone: telephone || null, pin,
        email: email || null, cabine_nom: cabineNom || null, admin_level: adminLevel || null,
      },
    });
    if (!res.ok || !data || data.error) {
      return { ok: false, error: (data && data.error) || 'Échec de la création du compte.' };
    }
    return { ok: true, profile: data.profile };
  }

  /* Lecture/écriture des réglages globaux (voir api/settings_get.php et
     api/settings_update.php, réservée à un jeton admin) — utilisées par
     DB.settings dans js/db.js. Lève une exception en cas d'échec (au lieu
     de { ok:false }) : DB.settings.get()/.update() interceptent déjà tout
     échec réseau, même contrat qu'avec l'ancien client Supabase
     (.from('settings').select()/.update() pouvait aussi rejeter). */
  async function getSettings() {
    const { res, data } = await _call('settings_get.php', {});
    if (!res.ok || !data || data.error) throw new Error((data && data.error) || 'Échec de lecture des réglages.');
    return data.settings;
  }

  async function updateSettings(row) {
    const { res, data } = await _call('settings_update.php', { auth: true, body: row });
    if (!res.ok || !data || data.error) throw new Error((data && data.error) || 'Échec de mise à jour des réglages.');
    return data.settings;
  }

  return { login, establishSession, logout, createAccount, adminCreateAccount, getSettings, updateSettings, isConfigured };
})();
