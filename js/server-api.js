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
    // fetch() lui-même peut lever une exception (réseau coupé, CORS, DNS...),
    // contrairement au client Supabase historique qui renvoyait toujours un
    // objet { data, error }. Sans ce try/catch, un tel échec remontait en
    // exception non gérée à travers login()/Auth.login() jusqu'à l'appelant
    // (ex. submitAdminLogin() dans js/client.js, jamais dans un try/catch),
    // ce qui bloquait silencieusement l'écran de connexion sans le moindre
    // message — jamais un { ok:false, error } exploitable par l'appelant.
    try {
      const res = await fetch(BASE_URL + '/' + path, {
        method: 'POST', headers, body: JSON.stringify(body || {}),
      });
      let data = null;
      try { data = await res.json(); } catch (e) { /* réponse non-JSON (ex. erreur serveur brute) */ }
      return { res, data };
    } catch (e) {
      // Distingue une vraie panne réseau (fetch n'a jamais atteint le
      // serveur) d'un refus applicatif (identifiants incorrects, etc.) —
      // voir Auth.login()/Auth.resumeSession() dans js/auth.js, qui doivent
      // afficher "connexion Internet requise" uniquement dans ce cas, pas
      // pour un vrai mot de passe erroné.
      return { res: { ok: false }, data: null, networkError: true };
    }
  }

  /* Vérifie identifiant+PIN côté serveur (voir api/login.php), obtient un
     jeton d'accès en cas de succès. Plus aucun repli local : voir
     Auth.login() (js/auth.js), qui exige désormais ce résultat pour toute
     connexion, y compris sur un appareil déjà "onboardé". */
  async function login(identifiant, pin, role) {
    const { res, data, networkError } = await _call('login.php', { body: { identifiant, pin, role } });
    if (networkError) return { ok: false, networkError: true, error: 'Connexion Internet requise pour vous connecter.' };
    if (!res.ok || !data || data.error) {
      return { ok: false, error: (data && data.error) || 'Identifiant ou PIN incorrect.' };
    }
    _setToken(data.token);
    return { ok: true, profile: data.profile };
  }

  /* Jeton actuellement actif (voir Auth._applyDeviceBookkeeping, js/auth.js)
     — persisté en localStorage sous "rester connecté" pour permettre une
     reprise de session vérifiée par le serveur au prochain démarrage
     (voir resumeSession/whoami ci-dessous), sans jamais stocker le PIN. */
  function getToken() { return _token; }

  // Réhydrate un jeton persisté (localStorage, "rester connecté") dans ce
  // module avant d'appeler whoami() — voir Auth.resumeSession().
  function setToken(token) { _setToken(token); }

  /* Reprise de session "rester connecté" (voir api/session_whoami.php) —
     valide le jeton persisté contre le serveur et renvoie le profil à
     jour. Remplace toute reconnexion silencieuse purement locale : sans
     réseau ou jeton expiré/invalide, échoue plutôt que d'ouvrir une
     session non vérifiée (voir Auth.resumeSession(), js/auth.js). */
  async function whoami() {
    const { res, data, networkError } = await _call('session_whoami.php', { auth: true });
    if (networkError) return { ok: false, networkError: true, error: 'Connexion Internet requise.' };
    if (!res.ok || !data || data.error) {
      return { ok: false, error: (data && data.error) || 'Session expirée, reconnectez-vous.' };
    }
    return { ok: true, profile: data.profile };
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

  /* Liste des comptes (voir api/list_profiles.php, réservée à un jeton
     admin) — utilisée par refreshUsersFromServer() dans js/admin.js pour
     que le tableau de bord admin reflète tous les comptes existants, pas
     seulement ceux déjà connus sur cet appareil. `role` optionnel
     ('client'/'cabine'/'admin') — omis renvoie tous les rôles. */
  async function listProfiles(role) {
    const { res, data } = await _call('list_profiles.php', { auth: true, body: { role: role || null } });
    if (!res.ok || !data || data.error) {
      return { ok: false, error: (data && data.error) || 'Échec de la synchronisation.' };
    }
    return { ok: true, profiles: data.profiles };
  }

  /* Favoris (numéros de destinataires du client) — voir DB.favoris
     (js/db.js) et api/favoris_list.php/favoris_create.php/favoris_remove.php.
     Réservées au rôle client, jamais lues par cabine/admin. */
  async function favorisList() {
    const { res, data } = await _call('favoris_list.php', { auth: true });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la synchronisation.' };
    return { ok: true, favoris: data.favoris };
  }

  async function favorisCreate({ nom, numero }) {
    const { res, data } = await _call('favoris_create.php', { auth: true, body: { nom, numero } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de l\'ajout du favori.' };
    return { ok: true, favori: data.favori };
  }

  async function favorisRemove(id) {
    const { res, data } = await _call('favoris_remove.php', { auth: true, body: { id } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la suppression.' };
    return { ok: true };
  }

  /* Journaux d'audit admin (accès/permissions cabine/maintenance) — voir
     DB.accessLogs/permissionLogs/maintenanceLogs (js/db.js) et
     api/access_logs_*.php, permission_logs_*.php, maintenance_logs_*.php.
     Écriture best-effort (jamais mise en file en cas d'échec — un accès
     manqué dans le journal n'est pas assez critique pour justifier une
     resynchronisation garantie, contrairement à favoris/settings) ;
     lecture réservée à un jeton admin, partagée entre tous les
     administrateurs quel que soit l'appareil. */
  async function accessLogsList() {
    const { res, data } = await _call('access_logs_list.php', { auth: true });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la synchronisation.' };
    return { ok: true, logs: data.logs };
  }
  async function accessLogsCreate(payload) {
    const { res, data } = await _call('access_logs_create.php', { auth: true, body: payload });
    return (res.ok && data && !data.error) ? { ok: true } : { ok: false };
  }

  async function permissionLogsList() {
    const { res, data } = await _call('permission_logs_list.php', { auth: true });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la synchronisation.' };
    return { ok: true, logs: data.logs };
  }
  async function permissionLogsCreate(payload) {
    const { res, data } = await _call('permission_logs_create.php', { auth: true, body: payload });
    return (res.ok && data && !data.error) ? { ok: true } : { ok: false };
  }

  async function maintenanceLogsList() {
    const { res, data } = await _call('maintenance_logs_list.php', { auth: true });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la synchronisation.' };
    return { ok: true, logs: data.logs };
  }
  async function maintenanceLogsCreate(payload) {
    const { res, data } = await _call('maintenance_logs_create.php', { auth: true, body: payload });
    return (res.ok && data && !data.error) ? { ok: true } : { ok: false };
  }

  /* Présence en ligne (voir DB.presence, js/db.js et
     api/presence_ping.php/presence_online.php) — prérequis à la migration
     du moteur d'attribution des commandes (Phase 4), qui doit distinguer
     une cabine réellement joignable d'une autre appareil du même compte
     hors ligne. Écriture best-effort (même raisonnement que les journaux
     d'audit : un battement manqué n'est pas critique, le suivant dans
     HEARTBEAT_MS le rattrape). */
  async function presencePing() {
    const { res, data } = await _call('presence_ping.php', { auth: true });
    return (res.ok && data && !data.error) ? { ok: true } : { ok: false };
  }
  async function presenceOnline() {
    const { res, data } = await _call('presence_online.php', { auth: true });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la synchronisation.' };
    return { ok: true, presence: data.presence };
  }

  /* Moteur de commandes (Phase 4) — voir DB.business.* (js/db.js) et
     api/orders_*.php. Chaque endpoint est un CAS atomique côté serveur
     (voir le commentaire en tête de chaque fichier PHP) ; ces wrappers ne
     font que transporter la requête/réponse, aucune logique métier ici. */
  async function ordersCreate(payload) {
    const { res, data, networkError } = await _call('orders_create.php', { auth: true, body: payload });
    if (networkError) return { ok: false, networkError: true, error: 'Connexion Internet requise.' };
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la création de la commande.' };
    return { ok: true, transaction: data.transaction };
  }

  async function ordersAccept(transactionId, proof) {
    const { res, data, networkError } = await _call('orders_accept.php', { auth: true, body: { transaction_id: transactionId, proof: proof || null } });
    if (networkError) return { ok: false, networkError: true, error: 'Connexion Internet requise.' };
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la validation.' };
    return { ok: true };
  }

  async function ordersRefuse(transactionId, motif, justification) {
    const { res, data, networkError } = await _call('orders_refuse.php', { auth: true, body: { transaction_id: transactionId, motif: motif || null, justification: justification || null } });
    if (networkError) return { ok: false, networkError: true, error: 'Connexion Internet requise.' };
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec du renvoi.' };
    return { ok: true, reassignedTo: data.reassignedTo };
  }

  async function ordersList() {
    const { res, data } = await _call('orders_list.php', { auth: true });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la synchronisation.' };
    return { ok: true, transactions: data.transactions };
  }

  async function ordersAssignPending() {
    const { res, data } = await _call('orders_assign_pending.php', { auth: true });
    return (res.ok && data && !data.error) ? { ok: true, count: data.count } : { ok: false, count: 0 };
  }

  async function ordersReassign(transactionIds, cabineId) {
    const { res, data } = await _call('orders_reassign.php', { auth: true, body: { transaction_ids: transactionIds, cabine_id: cabineId } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la réassignation.' };
    return { ok: true, okCount: data.okCount, failCount: data.failCount, results: data.results };
  }

  async function ordersSweep() {
    const { res, data } = await _call('orders_sweep.php', { auth: true });
    return (res.ok && data && !data.error) ? { ok: true, staleCount: data.staleCount, suspendedCabineIds: data.suspendedCabineIds } : { ok: false, staleCount: 0, suspendedCabineIds: [] };
  }

  async function ordersSweepUnsuspend() {
    const { res, data } = await _call('orders_sweep_unsuspend.php', { auth: true });
    return (res.ok && data && !data.error) ? { ok: true, liftedCount: data.liftedCount } : { ok: false, liftedCount: 0 };
  }

  // Historique des retards — lecture seule (voir DB.retards, js/db.js et
  // api/retards_list.php), sa seule écriture se fait désormais côté
  // serveur (orders_sweep.php).
  async function retardsList() {
    const { res, data } = await _call('retards_list.php', { auth: true });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la synchronisation.' };
    return { ok: true, retards: data.retards };
  }

  async function notificationsList() {
    const { res, data } = await _call('notifications_list.php', { auth: true });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la synchronisation.' };
    return { ok: true, notifications: data.notifications };
  }

  async function notificationsMarkRead(notificationId) {
    const { res, data } = await _call('notifications_mark_read.php', { auth: true, body: { notification_id: notificationId } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec.' };
    return { ok: true };
  }

  async function notificationsMarkAllRead() {
    const { res, data } = await _call('notifications_mark_all_read.php', { auth: true });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec.' };
    return { ok: true };
  }

  async function retraitsCreate(cabineId, montant) {
    const { res, data } = await _call('retraits_create.php', { auth: true, body: { cabine_id: cabineId, montant } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec du retrait.' };
    return { ok: true };
  }

  async function retraitsList() {
    const { res, data } = await _call('retraits_list.php', { auth: true });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la synchronisation.' };
    return { ok: true, retraits: data.retraits };
  }

  async function cabineSetRetraitInfo({ paiementVers, numeroCompte, targetId }) {
    const { res, data } = await _call('cabine_set_retrait_info.php', { auth: true, body: { paiement_vers: paiementVers, numero_compte: numeroCompte, target_id: targetId || null } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec.' };
    return { ok: true };
  }

  async function resetRequestsCreate({ role, identifiant, nouveauMotDePasse }) {
    const { res, data } = await _call('reset_requests_create.php', { body: { role, identifiant, nouveau_mot_de_passe: nouveauMotDePasse } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la demande.' };
    return { ok: true };
  }

  async function resetRequestsList() {
    const { res, data } = await _call('reset_requests_list.php', { auth: true });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la synchronisation.' };
    return { ok: true, resetRequests: data.resetRequests };
  }

  async function resetRequestsApply(requestId) {
    const { res, data } = await _call('reset_requests_apply.php', { auth: true, body: { request_id: requestId } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec.' };
    return { ok: true };
  }

  async function resetRequestsRefuse(requestId) {
    const { res, data } = await _call('reset_requests_refuse.php', { auth: true, body: { request_id: requestId } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec.' };
    return { ok: true };
  }

  async function transfertsCabineList() {
    const { res, data } = await _call('transferts_cabine_list.php', { auth: true });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la synchronisation.' };
    return { ok: true, transferts: data.transferts };
  }

  async function resubscriptionsList() {
    const { res, data } = await _call('resubscriptions_list.php', { auth: true });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la synchronisation.' };
    return { ok: true, resubscriptions: data.resubscriptions };
  }

  /* Endpoints périphériques du moteur de commandes (Phase 4, second lot) —
     voir api/orders_recharge.php, orders_refund.php, orders_suspend.php,
     orders_reactivate.php, cabine_suspend_manual.php,
     cabine_self_recharge.php, cabine_resubscribe.php,
     admin_set_abonnement.php, cabine_transfer.php. */
  async function ordersRecharge({ montant, method, targetId }) {
    const { res, data } = await _call('orders_recharge.php', { auth: true, body: { montant, method: method || null, target_id: targetId || null } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la recharge.' };
    return { ok: true };
  }

  async function ordersRefund(transactionId) {
    const { res, data } = await _call('orders_refund.php', { auth: true, body: { transaction_id: transactionId } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec du remboursement.' };
    return { ok: true };
  }

  async function ordersSuspend(transactionId, motif) {
    const { res, data } = await _call('orders_suspend.php', { auth: true, body: { transaction_id: transactionId, motif } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la suspension.' };
    return { ok: true };
  }

  async function ordersReactivate(transactionId) {
    const { res, data } = await _call('orders_reactivate.php', { auth: true, body: { transaction_id: transactionId } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la réactivation.' };
    return { ok: true };
  }

  // Suppression définitive — réservée au super admin, voir
  // api/orders_delete.php (bloquée pour une commande 'terminé').
  async function ordersDelete(transactionId) {
    const { res, data } = await _call('orders_delete.php', { auth: true, body: { transaction_id: transactionId } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la suppression.' };
    return { ok: true };
  }

  async function cabineSuspendManual(cabineId, motif) {
    const { res, data } = await _call('cabine_suspend_manual.php', { auth: true, body: { cabine_id: cabineId, motif } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la suspension.' };
    return { ok: true };
  }

  async function cabineSelfRecharge({ network, numero, montant }) {
    const { res, data } = await _call('cabine_self_recharge.php', { auth: true, body: { network, numero, montant } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la recharge.' };
    return { ok: true, transaction: data.transaction, assignedTo: data.assignedTo, frais: data.frais, total: data.total };
  }

  async function cabineResubscribe(formule) {
    const { res, data } = await _call('cabine_resubscribe.php', { auth: true, body: { formule } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec du réabonnement.' };
    return { ok: true, resteDu: data.resteDu, nouveauSolde: data.nouveauSolde, transactionId: data.transactionId };
  }

  async function adminSetAbonnement(cabineId, formule) {
    const { res, data } = await _call('admin_set_abonnement.php', { auth: true, body: { cabine_id: cabineId, formule } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec du changement de formule.' };
    return { ok: true };
  }

  async function cabineTransfer(toCabineNom, montant) {
    const { res, data } = await _call('cabine_transfer.php', { auth: true, body: { to_cabine_nom: toCabineNom, montant } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec du transfert.' };
    return { ok: true, recipient: data.recipient };
  }

  /* Réclamations + demandes de remboursement (Phase 5) — voir
     DB.reclamations/refundRequests (js/db.js) et api/reclamations_*.php,
     refund_requests_list.php. */
  async function reclamationsList() {
    const { res, data } = await _call('reclamations_list.php', { auth: true });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la synchronisation.' };
    return { ok: true, reclamations: data.reclamations };
  }

  async function reclamationsCreate({ transactionId, motif }) {
    const { res, data } = await _call('reclamations_create.php', { auth: true, body: { transaction_id: transactionId, motif } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de l\'envoi de la réclamation.' };
    return { ok: true, reclamation: data.reclamation };
  }

  async function reclamationsResolve(reclamationId, screenshot) {
    const { res, data } = await _call('reclamations_resolve.php', { auth: true, body: { reclamation_id: reclamationId, screenshot } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de l\'envoi de la preuve.' };
    return { ok: true };
  }

  async function reclamationsConfirmReceived(reclamationId) {
    const { res, data } = await _call('reclamations_confirm_received.php', { auth: true, body: { reclamation_id: reclamationId } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la confirmation.' };
    return { ok: true };
  }

  async function reclamationsRelance(reclamationId) {
    const { res, data } = await _call('reclamations_relance.php', { auth: true, body: { reclamation_id: reclamationId } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la relance.' };
    return { ok: true, relancesApresPreuve: data.relances_apres_preuve };
  }

  async function reclamationsRequestRefund(reclamationId) {
    const { res, data } = await _call('reclamations_request_refund.php', { auth: true, body: { reclamation_id: reclamationId } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la demande de remboursement.' };
    return { ok: true };
  }

  async function ordersProcessRefund(requestId) {
    const { res, data } = await _call('orders_process_refund.php', { auth: true, body: { request_id: requestId } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec du remboursement.' };
    return { ok: true };
  }

  async function refundRequestsList() {
    const { res, data } = await _call('refund_requests_list.php', { auth: true });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la synchronisation.' };
    return { ok: true, refundRequests: data.refundRequests };
  }

  /* Catalogue forfaits + règles de commission (Phase 6) — lecture publique
     (même patron que getSettings() ci-dessus), écriture réservée au super
     administrateur. Voir DB.forfaits/DB.commissions (js/db.js) et
     api/forfaits_*.php, commissions_*.php. */
  async function forfaitsList() {
    const { res, data } = await _call('forfaits_list.php', {});
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la synchronisation.' };
    return { ok: true, forfaits: data.forfaits };
  }

  async function forfaitsCreate(payload) {
    const { res, data } = await _call('forfaits_create.php', { auth: true, body: payload });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de l\'ajout du forfait.' };
    return { ok: true, forfait: data.forfait };
  }

  async function forfaitsUpdate(id, payload) {
    const { res, data } = await _call('forfaits_update.php', { auth: true, body: { id, ...payload } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la modification du forfait.' };
    return { ok: true, forfait: data.forfait };
  }

  async function forfaitsRemove(id) {
    const { res, data } = await _call('forfaits_remove.php', { auth: true, body: { id } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la suppression du forfait.' };
    return { ok: true };
  }

  async function commissionsList() {
    const { res, data } = await _call('commissions_list.php', {});
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la synchronisation.' };
    return { ok: true, commissions: data.commissions };
  }

  async function commissionsUpdateRate(pourcentage) {
    const { res, data } = await _call('commissions_update_rate.php', { auth: true, body: { pourcentage } });
    if (!res.ok || !data || data.error) return { ok: false, error: (data && data.error) || 'Échec de la mise à jour du taux.' };
    return { ok: true, commissions: data.commissions };
  }

  return {
    login, logout, createAccount, adminCreateAccount, getSettings, updateSettings, listProfiles,
    isConfigured, getToken, setToken, whoami, favorisList, favorisCreate, favorisRemove,
    accessLogsList, accessLogsCreate, permissionLogsList, permissionLogsCreate,
    maintenanceLogsList, maintenanceLogsCreate, presencePing, presenceOnline,
    ordersCreate, ordersAccept, ordersRefuse, ordersAssignPending, ordersReassign,
    ordersSweep, ordersSweepUnsuspend, ordersList, retardsList,
    ordersRecharge, ordersRefund, ordersSuspend, ordersReactivate, ordersDelete, cabineSuspendManual,
    cabineSelfRecharge, cabineResubscribe, adminSetAbonnement, cabineTransfer,
    forfaitsList, forfaitsCreate, forfaitsUpdate, forfaitsRemove, commissionsList, commissionsUpdateRate,
    reclamationsList, reclamationsCreate, reclamationsResolve, reclamationsConfirmReceived,
    reclamationsRelance, reclamationsRequestRefund, ordersProcessRefund, refundRequestsList,
    transfertsCabineList, resubscriptionsList,
    notificationsList, notificationsMarkRead, notificationsMarkAllRead,
    retraitsCreate, retraitsList, cabineSetRetraitInfo,
    resetRequestsCreate, resetRequestsList, resetRequestsApply, resetRequestsRefuse,
  };
})();
