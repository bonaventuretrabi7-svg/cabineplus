/* ================================================================
   KBINE PLUS | Client Supabase
   ================================================================
   Doit être chargé après le SDK https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2
   et js/supabase-config.js, avant js/db.js et js/auth.js. */
const SupabaseAPI = (() => {
  const client = supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);

  // Tant que js/supabase-config.js n'a pas été renseigné avec un vrai
  // projet (valeurs par défaut "VOTRE-PROJET"/"VOTRE-ANON-KEY"), tout
  // appel réseau échouerait de toute façon (domaine inexistant,
  // ERR_NAME_NOT_RESOLVED) — DB.settings (js/db.js) vérifie ce drapeau
  // avant de tenter quoi que ce soit, pour ne jamais multiplier des
  // requêtes vouées à l'échec (retombe directement sur le cache local,
  // déjà le comportement hors ligne existant).
  const isConfigured = !/VOTRE-PROJET|VOTRE-ANON-KEY/.test(SUPABASE_CONFIG.url + SUPABASE_CONFIG.anonKey);

  /* Appelle l'Edge Function `login` (vérifie identifiant+PIN côté serveur
     via verify_login()), puis adopte la session Supabase retournée pour que
     les appels suivants (RLS basé sur auth.uid()) soient authentifiés. */
  async function login(identifiant, pin, role) {
    const { data, error } = await client.functions.invoke('login', {
      body: { identifiant, pin, role },
    });
    if (error || !data || data.error) {
      return { ok: false, error: (data && data.error) || 'Identifiant ou PIN incorrect.' };
    }
    await client.auth.setSession({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
    return { ok: true, profile: data.profile };
  }

  async function logout() {
    await client.auth.signOut();
  }

  /* Auto-inscription client/cabine (voir create_account() dans
     supabase/migrations/0002_auth.sql, déjà accordée à anon) — utilisée par
     handleAuthGateRegister()/handleCabineRegister() dans js/client.js. */
  async function createAccount({ role, nom, prenom, telephone, pin, email, cabineNom }) {
    const { data, error } = await client.rpc('create_account', {
      p_role: role, p_nom: nom, p_prenom: prenom, p_telephone: telephone, p_pin: pin,
      p_email: email || null, p_cabine_nom: cabineNom || null,
    });
    if (error || !data) {
      return { ok: false, error: (error && error.message) || 'Échec de la création du compte.' };
    }
    return { ok: true, profile: data };
  }

  /* Établit une session Supabase Auth en arrière-plan (mode "silent" de
     l'Edge Function login, voir supabase/functions/login) — appelée par
     Auth.login() (js/auth.js) après une connexion réussie via le chemin
     local rapide, pour que les actions authentifiées côté serveur (ex.
     adminCreateAccount ci-dessous) fonctionnent même sans jamais être passé
     par le repli serveur. Best-effort : aucun effet de bord sur le compteur
     de tentatives, jamais présenté à l'utilisateur (voir l'appel dans
     Auth.login(), toujours .catch()é). */
  async function establishSession(identifiant, pin, role) {
    const { data, error } = await client.functions.invoke('login', {
      body: { identifiant, pin, role, silent: true },
    });
    if (error || !data || data.error) return { ok: false };
    await client.auth.setSession({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
    return { ok: true };
  }

  /* Création de compte PAR L'ADMINISTRATION (cabine approuvée, admin simple
     ajouté par le super admin — voir admin_create_account() dans
     supabase/migrations/0006_admin_create_account.sql). Réservée à une
     session authentifiée avec le rôle admin (voir establishSession()
     ci-dessus) — utilisée par finishCreateUser() dans js/admin.js. */
  async function adminCreateAccount({ role, nom, prenom, telephone, pin, email, cabineNom, adminLevel }) {
    const { data, error } = await client.rpc('admin_create_account', {
      p_role: role, p_nom: nom, p_prenom: prenom, p_telephone: telephone, p_pin: pin,
      p_email: email || null, p_cabine_nom: cabineNom || null, p_admin_level: adminLevel || null,
    });
    if (error || !data) {
      return { ok: false, error: (error && error.message) || 'Échec de la création du compte.' };
    }
    return { ok: true, profile: data };
  }

  return { client, login, logout, createAccount, establishSession, adminCreateAccount, isConfigured };
})();
