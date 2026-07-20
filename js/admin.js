/* ================================================================
   KBINE PLUS | Espace Administrateur
   ================================================================ */

let currentUser = null;
let router      = null;
let charts      = {};

/* ── Reprise d'état au rechargement (voir ResumeState dans auth.js) ──
   Un seul objet en mémoire, sauvegardé à chaque mutation et relu une
   fois au boot (restoreAdminState()). */
let _adminResume = {
  view: null,
  filters: {
    clients: '', cabines: '', rechargeCabiniste: '', rechargeClient: '',
    rechargeUv: { q: '', status: '' }, exchange: { q: '', status: '' },
    retards: '', transactions: { q: '', status: '' }, admins: '',
  },
  settingsDraft: null, assistanceDraft: null, maintenanceDraft: null,
};
function _saveAdminResume() { ResumeState.save('admin', _adminResume); }

function _adminViewAllowed(name) {
  const nav = document.querySelector(`.nav-item[data-view="${name}"]`);
  return !!nav && nav.style.display !== 'none';
}

/* Un badge "en attente" (voir loadTransactions()/loadRechargeUvAdmin()/
   loadExchangeAdmin()) ne doit jamais s'afficher pendant qu'on est déjà
   sur l'onglet concerné — utilisé en filet de sécurité en plus du
   masquage explicite dans le callback onShow d'initRouter() (voir boot()),
   pour couvrir les rechargements redondants (ex. boot() qui appelle
   loadTransactions() après coup, indépendamment de l'onglet restauré). */
function _isNavActive(view) {
  return !!document.querySelector(`.nav-item[data-view="${view}"]`)?.classList.contains('active');
}

/* Vues non peuplées par les chargements par défaut de boot() ci-dessous —
   il faut rappeler leur loader explicitement quand on y restaure
   directement (même logique que les onclick correspondants dans
   admin.html, ex: data-view="settings" onclick="loadSettings();...`). */
/* Table complète des vues admin -> fonction(s) de rechargement de leurs
   données, réutilisée à la fois pour la reprise d'état au boot (voir
   plus bas) et pour le bouton "Actualiser" de la barre du haut (voir
   refreshCurrentAdminView()), qui doit recharger l'onglet réellement
   affiché plutôt que toujours le tableau de bord. "reports" est
   volontairement absent : aucun rechargement silencieux possible
   (printReport() ouvre l'impression en effet de bord). */
function _adminViewLoader(name) {
  return ({
    dashboard:              () => { loadDashboard(); initCharts(); },
    clients:                 loadClients,
    cabines:                 loadCabines,
    'retraits-admin':        loadRetraitsAdmin,
    'recharge-cabiniste':    loadRechargeCabiniste,
    'recharge-client':       loadRechargeClient,
    'recharge-uv-admin':     loadRechargeUvAdmin,
    'exchange-admin':        loadExchangeAdmin,
    'retards-admin':         loadRetardsAdmin,
    'retraits-historique':   () => loadRetraitsHistorique(1),
    transactions:            loadTransactions,
    'commissions-admin':     loadCommissionsAdmin,
    'partner-requests':      loadPartnerRequests,
    rankings:                loadRankings,
    'zero-transaction':      loadZeroTransactionAdmin,
    'clients-inactifs':      loadClientsInactifsAdmin,
    'cabines-inactives':     loadCabinesInactivesAdmin,
    'reset-requests':        loadResetRequests,
    'comptes-bloques':       loadComptesBloquesAdmin,
    'cabines-suspendues':    loadCabinesSuspenduesAdmin,
    'appareils-admin':       loadAppareilsAdmin,
    'refund-requests':       loadRefundRequests,
    'discussions-admin':     loadDiscussionsAdmin,
    'access-logs':           loadAccessLogs,
    'reabonnement-cabine':   loadReabonnementCabine,
    'assistant-cabine':      loadAssistantCabineAdmin,
    'assistant-client':      loadAssistantClientAdmin,
    'notifications-admin':   loadAdminNotifications,
    'maintenance-admin':     loadMaintenanceAdmin,
    'uv-cabine-admin':       loadUvCabineAdmin,
    'dispo-services-admin':  loadDispoServicesAdmin,
    settings:                () => { loadSettings(); loadAssistanceAdmin(); loadAdminNotifSoundSettings(); loadActualitesAdmin(); },
    administrateurs:         loadAdminsList,
    'permission-cabine':     loadPermissionCabine,
    'gestion-admins':        loadGestionAdminsAdmin,
    bilan:                   loadBilan,
    forfaits:                loadForfaits,
  })[name];
}

/* Bouton "Actualiser" de la barre du haut : recharge l'onglet réellement
   affiché (table ci-dessus) au lieu de rester figé sur le tableau de
   bord quel que soit l'endroit où l'admin se trouve. */
function refreshCurrentAdminView() {
  const view = document.querySelector('.view.active')?.dataset.view;
  const loader = view && _adminViewLoader(view);
  if (loader) loader();
  else { loadDashboard(); initCharts(); }
}

/* Menu déroulant "⋯" générique pour les actions de ligne des tableaux
   (voir CSS .row-menu/.menu-btn-row dans admin.html) — un bouton unique
   listant les actions en toutes lettres plutôt qu'un groupe de boutons
   icône colorés sans texte. items = [{label, icon, fn, danger}]. */
function openRowMenu(btn, items) {
  closeAllRowMenus();
  items = items.filter(Boolean);
  if (!items.length) return;
  const menu = document.createElement('div');
  menu.className = 'row-menu';
  // it.icon accepte soit un simple nom d'icône ("fa-eye" -> fa-solid par
  // défaut), soit une classe complète pour les familles non-solid
  // ("fa-brands fa-whatsapp", avec un espace).
  menu.innerHTML = items.map(it => {
    const iconClass = it.icon.includes(' ') ? it.icon : `fa-solid ${it.icon}`;
    return `<button class="row-menu-item${it.danger ? ' danger' : ''}" onclick="closeAllRowMenus();${it.fn}"><i class="${iconClass}"></i> ${it.label}</button>`;
  }).join('');
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  menu.style.top = (r.bottom + window.scrollY + 4) + 'px';
  let left = r.right + window.scrollX - menu.offsetWidth;
  if (left < 8) left = 8;
  menu.style.left = left + 'px';
}
function closeAllRowMenus() {
  document.querySelectorAll('.row-menu').forEach(m => m.remove());
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.row-menu') && !e.target.closest('.menu-btn-row')) closeAllRowMenus();
});

/* Retour visuel sur les boutons "Actualiser" (icône fa-rotate-right) —
   ces rechargements sont locaux/synchrones (pas d'appel réseau), donc
   sans ce spin l'utilisateur n'a aucun signal que le clic a été pris en
   compte. Délégué au document pour couvrir tous les boutons Actualiser
   du fichier sans devoir toucher chacun de leurs onclick. */
document.addEventListener('click', (e) => {
  const icon = e.target.closest('button')?.querySelector('.fa-rotate-right');
  if (!icon) return;
  icon.classList.remove('spinning');
  void icon.offsetWidth;
  icon.classList.add('spinning');
});

/* Actions de ligne pour une transaction — voir loadTransactions(). */
function toggleTxnRowMenu(btn, txnId) {
  const t = DB.transactions.byId(txnId);
  if (!t) return;
  const cabine = t.cabine_id ? DB.users.byId(t.cabine_id) : null;
  const client = t.client_id ? DB.users.byId(t.client_id) : null;
  openRowMenu(btn, [
    t.statut === 'en_attente' && { label: 'Réassigner', icon: 'fa-shuffle', fn: `openReassignModal('${txnId}')` },
    (t.statut === 'en_attente' || t.statut === 'terminé') && { label: 'Rembourser', icon: 'fa-hand-holding-dollar', fn: `refundTxn('${txnId}')`, danger: true },
    (t.statut === 'en_attente' || t.statut === 'terminé') && { label: 'Suspendre', icon: 'fa-ban', fn: `openSuspendModal('${txnId}')` },
    t.statut === 'suspendue' && { label: 'Réactiver', icon: 'fa-arrow-rotate-right', fn: `reactivateTxn('${txnId}')` },
    currentUser.admin_level === 'super' && ['en_attente', 'suspendue', 'remboursé'].includes(t.statut) &&
      { label: 'Supprimer', icon: 'fa-trash', fn: `deleteTxn('${txnId}')`, danger: true },
    cabine && { label: 'Contacter la cabine (WhatsApp)', icon: 'fa-brands fa-whatsapp', fn: `adminContactWhatsapp('${cabine.whatsapp || cabine.telephone}','${cabine.prenom}')` },
    cabine && { label: 'Appeler la cabine', icon: 'fa-phone', fn: `adminCallPhone('${cabine.telephone}')` },
    cabine && { label: 'Voir le profil de la cabine', icon: 'fa-eye', fn: `viewUser('${cabine.id}')` },
    cabine && (cabine.statut === 'suspendu'
      ? { label: 'Débloquer la cabine', icon: 'fa-lock-open', fn: `toggleCabine('${cabine.id}',true)` }
      : cabine.statut === 'actif'
      ? { label: 'Suspendre la cabine', icon: 'fa-ban', fn: `openSuspendCabineModal('${cabine.id}')`, danger: true }
      : { label: 'Activer la cabine', icon: 'fa-toggle-on', fn: `toggleCabine('${cabine.id}',true)` }),
    cabine && { label: 'Se connecter en tant que cabine', icon: 'fa-user-secret', fn: `impersonateUser('${cabine.id}','${cabine.prenom} ${cabine.nom}')` },
    client && { label: 'Se connecter en tant que client', icon: 'fa-user-secret', fn: `impersonateUser('${client.id}','${client.prenom} ${client.nom}')` },
  ]);
}

/* Repli de la sidebar en rail d'icônes (bouton .topbar-menu-btn, voir
   <style> dans admin.html pour l'état visuel .sidebar.collapsed). État
   mémorisé pour rester cohérent d'une session à l'autre. */
const ADMIN_SIDEBAR_COLLAPSED_KEY = 'cbp_admin_sidebar_collapsed';
function toggleAdminSidebar() {
  const collapsed = document.querySelector('.sidebar')?.classList.toggle('collapsed');
  localStorage.setItem(ADMIN_SIDEBAR_COLLAPSED_KEY, collapsed ? 'true' : 'false');
}
function _restoreAdminSidebarCollapsed() {
  if (localStorage.getItem(ADMIN_SIDEBAR_COLLAPSED_KEY) === 'true') {
    document.querySelector('.sidebar')?.classList.add('collapsed');
  }
}

/* Écran de chargement (#page-loader, admin.html) — même composant et
   même comportement que js/client.js : filet de sécurité à 3s max, puis
   masqué au moins 800ms après la fin du boot (évite un flash si tout
   se charge instantanément). */
function hideLoader() {
  const l = document.getElementById('page-loader');
  if (!l) return;
  l.classList.add('pl-hide');
  setTimeout(() => l.remove(), 500);
}

/* ── Écran de connexion (aucune session admin valide sur cet appareil) ──
   Avant ce correctif, un lien direct vers /admin sans session active
   renvoyait silencieusement vers index.html (Auth.require()) — l'espace
   admin ne "sortait" jamais. Affiche désormais ici même un écran de
   connexion dédié (mêmes classes .adx-* que la modale admin d'index.html,
   voir css/style.css), sans jamais quitter cette page. Le tableau de bord
   (.app-wrapper) n'est pas masqué par défaut dans le HTML (seul le loader
   le recouvre pendant le boot normal) — on le masque donc explicitement
   ici pour ne jamais laisser transparaître un tableau de bord vide/non
   initialisé une fois le loader retiré. */
function showAdminLoginGate() {
  hideLoader();
  const wrapper = document.querySelector('.app-wrapper');
  if (wrapper) wrapper.style.display = 'none';
  const gate = document.getElementById('admin-login-gate');
  if (!gate) return;
  gate.style.display = 'flex';

  const boxes = document.querySelectorAll('#admin-login-pin-row .adx-pin-box');
  boxes.forEach((box, idx) => {
    box.oninput = () => {
      box.value = box.value.replace(/\D/g, '').slice(0, 1);
      if (box.value && idx < boxes.length - 1) {
        boxes[idx + 1].focus();
      } else if (box.value && idx === boxes.length - 1) {
        setTimeout(submitAdminLoginGate, 120);
      }
    };
    box.onkeydown = e => {
      if (e.key === 'Backspace' && !box.value && idx > 0) boxes[idx - 1].focus();
    };
  });

  setTimeout(() => document.getElementById('admin-login-email')?.focus(), 120);
}

async function submitAdminLoginGate() {
  const email    = (document.getElementById('admin-login-email')?.value || '').trim();
  const pin      = [...document.querySelectorAll('#admin-login-pin-row .adx-pin-box')].map(b => b.value).join('');
  const remember = !!document.getElementById('admin-login-remember')?.checked;
  const denied   = document.getElementById('admin-login-denied');
  denied.style.display = 'none';

  if (!Auth.isValidGmail(email)) { Toast.error('Adresse Gmail invalide (ex : nom@gmail.com).'); return; }
  if (!Auth.isValidPin(pin))     { Toast.error('Saisissez votre code PIN à 4 chiffres.'); return; }

  const res = await Auth.login(email, pin, remember, 'admin');
  if (!res.ok) { Toast.error(res.error); return; }

  if (res.user.role !== 'admin') {
    sessionStorage.removeItem('cbp_session');
    denied.style.display = 'flex';
    document.querySelectorAll('#admin-login-pin-row .adx-pin-box').forEach(b => { b.value = ''; });
    return;
  }

  // Le super admin n'est jamais éligible (voir Auth._hasDeviceLimit(),
  // js/auth.js) : rememberToken reste alors simplement absent, la case
  // cochée n'a aucun effet pour ce compte — cohérent avec le reste de
  // l'app, aucun cas particulier à gérer ici.
  if (res.rememberToken) localStorage.setItem(Auth.REMEMBER_TOKEN_KEY, res.rememberToken);

  window.location.reload();
}

/* Reprise "rester connecté" SANS redemander le PIN — même patron que
   _tryRememberMeRestore() côté cabine (js/cabine.js) et
   _tryRememberMeClientRestore() côté client (js/client.js), étendu ici à
   l'administrateur simple (le super admin n'a jamais de jeton à reprendre,
   voir Auth._hasDeviceLimit()). Toujours revérifié par le serveur
   (api/session_whoami.php) avant d'ouvrir quoi que ce soit. */
async function _tryRememberMeAdminRestore() {
  const token = localStorage.getItem(Auth.REMEMBER_TOKEN_KEY);
  if (!token) return;

  // Revalidé DIRECTEMENT auprès du serveur (source de vérité unique) —
  // voir le même correctif côté client/cabine (js/client.js/js/cabine.js) :
  // ne doit plus jamais dépendre d'un enregistrement local ("Mes appareils
  // connectés") trouvé au préalable, sous peine de supprimer un jeton
  // pourtant encore valide et de redemander le code à chaque ouverture.
  const res = await Auth.resumeSession(token);
  if (!res.ok) {
    // Hors ligne : on retente au prochain démarrage, le jeton reste
    // valable. Jeton réellement invalide/expiré ou compte suspendu/bloqué :
    // on l'oublie pour ne plus jamais réessayer avec un jeton mort.
    if (!res.networkError) localStorage.removeItem(Auth.REMEMBER_TOKEN_KEY);
    return;
  }
  if (res.user.role !== 'admin') {
    // Jeton valide mais lié à un autre rôle (ex. appareil partagé).
    sessionStorage.removeItem('cbp_session');
    localStorage.removeItem(Auth.REMEMBER_TOKEN_KEY);
    return;
  }
  // Bookkeeping "Mes appareils connectés" best-effort : recrée
  // l'enregistrement local s'il manquait, plutôt que d'abandonner une
  // session pourtant déjà validée par le serveur ci-dessus.
  const deviceId = Auth.getDeviceId();
  let rec = DB.partnerDevices.findByToken(deviceId, token);
  if (!rec) rec = DB.partnerDevices.register(res.user.id, deviceId, 'Appareil', true, token);
  DB.partnerDevices.touch(rec.id, true, token);
  await DB.partnerDevices.syncSelf(rec.device_id, rec.label, true);
}

// Synchronise le cache local des comptes (client/cabine) avec le serveur
// (voir api/list_profiles.php) — sans ça, le tableau de bord admin ne
// reflète que les comptes déjà connus sur SON appareil, jamais ceux
// inscrits par un client/cabine depuis son propre téléphone (voir le
// diagnostic du bug rapporté : "le super admin ne voit pas en temps réel
// le nombre de cabines/clients"). Jamais bloquant : les listes sont déjà
// affichées depuis le cache local avant cet appel (loadClients()/
// loadCabines() dans boot()) — celui-ci les rafraîchit une fois la
// synchronisation terminée, avec les mêmes filtres de recherche déjà en
// cours (voir _adminResume.filters).
async function refreshUsersFromServer() {
  if (!ServerAPI.isConfigured || !DB.Net.isOnline()) return;
  // Rôle admin inclus (voir api/list_profiles.php, déjà générique par
  // rôle) — jusqu'ici seuls client/cabine étaient tirés du serveur, la
  // liste "Administrateurs" restait figée depuis la connexion/création
  // locale et ne reflétait jamais un compte créé/modifié sur un autre poste.
  const [clientsRes, cabinesRes, adminsRes] = await Promise.all([
    ServerAPI.listProfiles('client'),
    ServerAPI.listProfiles('cabine'),
    ServerAPI.listProfiles('admin'),
  ]);
  if (clientsRes.ok) DB.users.mergeProfileList(clientsRes.profiles, 'client');
  if (cabinesRes.ok) DB.users.mergeProfileList(cabinesRes.profiles, 'cabine');
  if (adminsRes.ok) DB.users.mergeProfileList(adminsRes.profiles, 'admin');
  if (!clientsRes.ok && !cabinesRes.ok && !adminsRes.ok) return; // rien de nouveau, pas la peine de re-rendre
  loadClients(_adminResume.filters.clients || '');
  loadCabines(_adminResume.filters.cabines || '');
  loadDashboard();
  if (currentUser.admin_level === 'super' && typeof loadAdminsList === 'function') loadAdminsList();
}

async function boot() {
  const loaderSafety = setTimeout(hideLoader, 3000);
  // Vérification de mise à jour (voir js/update-notifier.js) — jamais
  // bloquant : sur le site web, recharge la page toute seule dès qu'un
  // déploiement plus récent est détecté ; dans l'app Android empaquetée,
  // propose le téléchargement du nouvel APK.
  UpdateNotifier.init();
  try {
    DB.init();
    // Rattrape une file de synchronisation laissée en attente (voir
    // DB.syncQueue) si la connexion est déjà là au lancement, et
    // resynchronise automatiquement dès qu'elle revient — jamais bloquant,
    // l'app reste utilisable hors ligne quoi qu'il arrive ici.
    if (DB.Net.isOnline()) DB.drainSyncQueue();
    DB.Net.onChange(() => { if (DB.Net.isOnline()) DB.drainSyncQueue(); });
    Theme.init();
    // Identité fixe (marine/crème, voir <style> dans admin.html) plutôt
    // que le mode sombre générique — même patron que l'espace client
    // (js/client.js) : on ignore un éventuel ancien réglage enregistré
    // pour ne pas afficher un rendu différent selon les sessions/le
    // thème laissé actif au dernier passage.
    document.body.classList.remove('dark');
    localStorage.removeItem('cbp_dark');

    // Connexion sans mot de passe via un lien généré par le super admin
    // (voir ServerAPI.adminCreateLoginLink()/api/admin_magic_login.php) —
    // prioritaire sur la reprise "rester connecté" ci-dessous. L'URL est
    // nettoyée immédiatement dans tous les cas (jeton à usage unique, on ne
    // doit jamais retenter le même au prochain rechargement de la page).
    const _loginToken = new URLSearchParams(location.search).get('login_token');
    if (_loginToken) {
      history.replaceState({}, '', location.pathname);
      const magicRes = await Auth.magicLogin(_loginToken);
      if (!magicRes.ok) Toast.error(magicRes.error || 'Lien de connexion invalide.');
    }

    // Aucune session active sur cet onglet, mais un jeton "rester connecté"
    // existe peut-être pour cet appareil (voir _tryRememberMeAdminRestore()
    // ci-dessus) — tenté AVANT d'afficher l'écran de connexion.
    if (!Auth.current()) await _tryRememberMeAdminRestore();
    currentUser = Auth.require('admin', { silent: true });
    if (!currentUser) { showAdminLoginGate(); return; }
    applyAdminPermissionGating();
    _refreshImpersonationBanner();
    _restoreAdminSidebarCollapsed();

    // Capturé avant les chargements par défaut plus bas : loadClients() etc.
    // appelés sans argument réécrivent _adminResume.filters.* à vide et le
    // sauvegardent, ce qui écraserait la sauvegarde réelle si on la relisait
    // seulement après (voir restoreAdminState()).
    const resumeSnapshot = ResumeState.load('admin');
    const resumedView = (resumeSnapshot && resumeSnapshot.view && _adminViewAllowed(resumeSnapshot.view))
      ? resumeSnapshot.view : null;
    if (resumedView) {
      const loader = _adminViewLoader(resumedView);
      if (loader) loader();
    }

    document.querySelector('.user-name').textContent = currentUser.prenom + ' ' + currentUser.nom;
    document.querySelector('.user-avatar').textContent = 'AD';
    document.querySelector('.user-role').textContent = currentUser.admin_level === 'super' ? 'Super administrateur' : (currentUser.poste || 'Administrateur simple');
    router = initRouter(resumedView || getDefaultAdminView(), (name) => {
      _adminResume.view = name;
      _saveAdminResume();
      // Le badge "en attente" d'un onglet (voir loadTransactions()/
      // loadRechargeUvAdmin()/loadExchangeAdmin()) disparaît dès qu'on
      // ouvre cet onglet — il ne représente que "des éléments à traiter
      // que vous n'avez pas encore regardés", pas besoin de le garder
      // affiché une fois qu'on est dessus.
      const badgeIdByView = { transactions: 'txn-badge', 'recharge-uv-admin': 'recharge-uv-badge', 'exchange-admin': 'exchange-badge' };
      const bid = badgeIdByView[name];
      if (bid) { const b = document.getElementById(bid); if (b) b.style.display = 'none'; }
    });
    initSidebar();

    document.querySelectorAll('.theme-toggle').forEach(b => b.addEventListener('click', Theme.toggle));

    DB.business.sweepStaleOrders();
    DB.business.sweepAutoUnsuspensions();
    DB.business.sweepQuotaDeadlines();
    // Cache local affiché immédiatement par les chargements ci-dessous
    // (jamais bloquant) ; resynchronise les commandes/retards en tâche de
    // fond (voir DB.transactions.refresh()/DB.retards.refresh(), js/db.js
    // — le moteur de commandes, Phase 4, écrit désormais côté serveur) et
    // rafraîchit ces mêmes vues une fois reçu.
    DB.transactions.refresh().then(() => { loadDashboard(); loadTransactions(); loadCabines(); });
    DB.retards.refresh().then(loadRetardsAdmin);

    loadDashboard();
    loadClients();
    loadCabines();
    // Cache local affiché immédiatement ci-dessus (jamais bloquant) ;
    // resynchronise en tâche de fond avec le serveur, puis rafraîchit ces
    // mêmes vues — voir refreshUsersFromServer() plus bas.
    refreshUsersFromServer();
    loadZeroTransactionAdmin();
    loadClientsInactifsAdmin();
    loadCabinesInactivesAdmin();
    loadTransactions();
    loadCommissionsAdmin();
    loadAdminNotifications();
    loadResetRequests();
    loadComptesBloquesAdmin();
    loadCabinesSuspenduesAdmin();
    loadAppareilsAdmin();
    loadRefundRequests();
    loadDiscussionsAdmin();
    loadAccessLogs();
    loadPartnerRequests();
    loadRetraitsAdmin();
    loadRechargeCabiniste();
    loadRechargeClient();
    loadRechargeUvAdmin();
    loadExchangeAdmin();
    loadRetardsAdmin();
    DB.notifications.refresh(currentUser.id).then(updateNotifBadge);
    updateNotifBadge();

    restoreAdminState(resumeSnapshot);

    // Présence en ligne (voir DB.presence, même mécanisme que cabine.js/client.js)
    DB.presence.ping(currentUser.id);
    DB.presence.refresh().then(loadDashboard);
    setInterval(async () => {
      // Signature avant rafraîchissement (voir DB.pollSignature, js/db.js) :
      // le re-rendu complet de la vue affichée plus bas ne se déclenche
      // que si elle a changé — évite de reconstruire tout le HTML à chaque
      // tick (coûteux sur Android) quand rien de nouveau ne s'est produit.
      const _pollBefore = DB.pollSignature(currentUser.id, 'admin');
      DB.presence.ping(currentUser.id);
      DB.presence.refresh();
      // Awaited désormais (ne l'était pas avant) : sans ça, la liste des
      // comptes fraîchement synchronisée n'était pas fiablement prise en
      // compte avant la comparaison de signature/le re-rendu ci-dessous.
      await refreshUsersFromServer();
      await DB.transactions.refresh();
      await DB.business.sweepStaleOrders();
      await DB.business.sweepAutoUnsuspensions();
      await DB.business.sweepQuotaDeadlines();
      // Notifications réelles (voir api/notifications_list.php) — reflète
      // désormais ce qui se passe partout, pas seulement ce que cet
      // appareil admin a lui-même déclenché.
      await DB.notifications.refresh(currentUser.id);
      updateNotifBadge();
      // Re-rend la vue ACTUELLEMENT affichée (voir _adminViewLoader() plus
      // haut, déjà réutilisée par le bouton "Actualiser") — couvre
      // automatiquement TOUS les onglets admin (retraits, réclamations,
      // comptes bloqués, zéro transaction...), remplace le repérage au cas
      // par cas d'avant (une seule vue, retraits-admin, était couverte) —
      // mais seulement si quelque chose a réellement changé depuis le tick
      // précédent. Exclut les vues "Assistant clientèle cabine/client" :
      // ce sont de simples formulaires (numéros WhatsApp) sans sauvegarde
      // au fil de l'eau — un rechargement recopierait par-dessus toute
      // ligne fraîchement ajoutée via "+ Ajouter un numéro" avant que
      // l'admin ait cliqué "Enregistrer", donnant l'impression que le
      // champ "se ferme tout seul". Même logique que le garde
      // hasPendingProof existant côté cabine (js/cabine.js).
      const NO_AUTORELOAD_VIEWS = ['assistant-cabine', 'assistant-client'];
      if (DB.pollSignature(currentUser.id, 'admin') !== _pollBefore
          && !NO_AUTORELOAD_VIEWS.includes(_adminResume.view)) {
        _adminViewLoader(_adminResume.view)?.();
      }
    }, DB.presence.HEARTBEAT_MS);
    window.addEventListener('beforeunload', () => DB.presence.leave(currentUser.id));

    // Notifications sonores : établit le compteur de référence tout de
    // suite (aucun son à l'ouverture), puis re-sonde toutes les 15s.
    _adminSoundWatch();
    setInterval(_adminSoundWatch, 15000);
  } catch (err) {
    console.error('[KBINE PLUS] Erreur au démarrage (admin) :', err);
  } finally {
    clearTimeout(loaderSafety);
    setTimeout(hideLoader, 800);
  }
}

/* Réapplique les filtres de recherche/statut sauvegardés par-dessus les
   chargements par défaut ci-dessus (chacun réécrit _adminResume.filters.*
   au passage, donc _adminResume finit cohérent avec l'écran affiché). */
function restoreAdminState(saved) {
  if (!saved) return;
  _adminResume = saved;

  const f = _adminResume.filters;
  if (f.clients)           { const el = document.getElementById('client-search');              if (el) el.value = f.clients; loadClients(f.clients); }
  if (f.cabines)           { const el = document.getElementById('cabine-search');               if (el) el.value = f.cabines; loadCabines(f.cabines); }
  if (f.rechargeCabiniste) { const el = document.getElementById('recharge-cabiniste-search');   if (el) el.value = f.rechargeCabiniste; loadRechargeCabiniste(f.rechargeCabiniste); }
  if (f.rechargeClient)    { const el = document.getElementById('recharge-client-search');      if (el) el.value = f.rechargeClient; loadRechargeClient(f.rechargeClient); }
  if (f.rechargeUv.q || f.rechargeUv.status) {
    const qEl = document.getElementById('recharge-uv-search'); const sEl = document.getElementById('recharge-uv-status');
    if (qEl) qEl.value = f.rechargeUv.q; if (sEl) sEl.value = f.rechargeUv.status;
    searchRechargeUvAdmin();
  }
  if (f.exchange.q || f.exchange.status) {
    const qEl = document.getElementById('exchange-admin-search'); const sEl = document.getElementById('exchange-admin-status');
    if (qEl) qEl.value = f.exchange.q; if (sEl) sEl.value = f.exchange.status;
    searchExchangeAdmin();
  }
  if (f.retards) { const el = document.getElementById('retards-admin-search'); if (el) { el.value = f.retards; searchRetardsAdmin(); } }
  if (f.transactions.q || f.transactions.status) {
    const qEl = document.getElementById('admin-txn-search'); const sEl = document.getElementById('admin-txn-status');
    if (qEl) qEl.value = f.transactions.q; if (sEl) sEl.value = f.transactions.status;
    searchTransactions();
  }
  if (f.admins) { const el = document.getElementById('admins-search'); if (el) { el.value = f.admins; searchAdminsList(); } }
}

function updateNotifBadge() {
  const c = DB.notifications.unread(currentUser.id);
  const b = document.getElementById('admin-notif-badge');
  if (b) { b.textContent = c; b.style.display = c ? 'inline' : 'none'; }
}

/* ── Notifications sonores (admin) ─────────────────────────────────
   Deux rôles de son, indépendamment personnalisables (préréglage +
   aperçu) : "commande" (nouvelle commande tous services confondus,
   nouvelle demande de partenariat, nouvelle cabine/nouveau client
   inscrit, nouveau "visiteur", nouvelle demande de remboursement) et
   "reclamation" (nouvelle réclamation, absente du sondage jusqu'ici).
   Par défaut, deux préréglages distincts (cloche / pop double) pour que
   les deux évènements soient déjà audiblement différents sans
   configuration. Générés via Web Audio, pas de fichier audio à ajouter
   au dépôt. */
const ADMIN_SOUND_PRESETS = [
  { key: 'cloche',   label: 'Cloche',       tones: [[880, 0, .18], [1175, .14, .22]] },
  { key: 'ding',     label: 'Ding',         tones: [[1046, 0, .28]] },
  { key: 'pop',      label: 'Pop double',   tones: [[600, 0, .08], [900, .06, .14]] },
  { key: 'douce',    label: 'Alerte douce', tones: [[587, 0, .2, 'triangle'], [494, .16, .24, 'triangle']] },
  { key: 'carillon', label: 'Carillon',     tones: [[784, 0, .16], [988, .11, .16], [1319, .22, .26]] },
];
const ADMIN_SOUND_DEFAULTS = { commande: 'cloche', reclamation: 'pop' };

const AdminSound = {
  ctx: null,
  _ctx() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    return this.ctx;
  },
  // Source de vérité = le compte (voir api/admin_update_own_sound.php)
  // quand déjà réglé ; le localStorage ne sert plus que de repli pour un
  // compte jamais synchronisé depuis l'ajout de ce réglage.
  isEnabled() {
    if (currentUser && currentUser.notif_son_actif !== undefined) return currentUser.notif_son_actif;
    return localStorage.getItem('kbine_admin_notif_sound') !== 'off';
  },
  _presetKey(role) { return role === 'reclamation' ? 'kbine_admin_notif_sound_preset_recla' : 'kbine_admin_notif_sound_preset'; },
  _presetField(role) { return role === 'reclamation' ? 'notif_son_preset_reclamation' : 'notif_son_preset_commande'; },
  currentPreset(role = 'commande') {
    const serverKey = currentUser && currentUser[this._presetField(role)];
    const key = serverKey || localStorage.getItem(this._presetKey(role)) || ADMIN_SOUND_DEFAULTS[role] || ADMIN_SOUND_PRESETS[0].key;
    return ADMIN_SOUND_PRESETS.find(p => p.key === key) || ADMIN_SOUND_PRESETS[0];
  },
  tone(freq, delay, duration = .16, type = 'sine') {
    try {
      const ctx = this._ctx();
      const start = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(0.16, start + .02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + duration + .02);
    } catch (e) { /* Web Audio indisponible — silencieux */ }
  },
  playPreset(preset) { preset.tones.forEach(t => this.tone(t[0], t[1], t[2] ?? .16, t[3] ?? 'sine')); },
  preview(key) {
    // Toujours audible, même en silencieux : on doit pouvoir écouter un
    // son avant de le choisir, indépendamment du réglage Activer/Muet.
    const preset = ADMIN_SOUND_PRESETS.find(p => p.key === key);
    if (preset) this.playPreset(preset);
  },
  notify(role = 'commande') {
    if (!this.isEnabled()) return;
    this.playPreset(this.currentPreset(role));
  },
};

function loadAdminNotifSoundSettings() {
  const el = document.getElementById('admin-notif-sound-content');
  if (!el) return;
  const enabled = AdminSound.isEnabled();
  const buildPicker = (role) => {
    const current = AdminSound.currentPreset(role).key;
    return ADMIN_SOUND_PRESETS.map(p => `
        <div class="admin-sound-option${p.key === current ? ' admin-sound-option--active' : ''}" data-sound="${p.key}" onclick="selectAdminSoundPreset('${p.key}','${role}')">
          <span class="admin-sound-option-radio"><i class="fa-solid fa-check"></i></span>
          <span class="admin-sound-option-label">${p.label}</span>
          <button type="button" class="admin-sound-preview-btn" onclick="event.stopPropagation();AdminSound.preview('${p.key}')" title="Écouter">
            <i class="fa-solid fa-play"></i>
          </button>
        </div>`).join('');
  };
  el.innerHTML = `
    <div class="admin-notif-toggle-row">
      <div>
        <div class="admin-notif-toggle-title">Activer les notifications sonores</div>
        <div class="admin-notif-toggle-sub">Nouvelle commande, nouvelle réclamation, nouvelle demande de partenariat, nouvelle cabine ou nouveau client inscrit, nouveau visiteur.</div>
      </div>
      <label class="switch">
        <input type="checkbox" id="admin-notif-sound-toggle" ${enabled ? 'checked' : ''} onchange="toggleAdminNotifSound()">
        <span class="slider"></span>
      </label>
    </div>
    <div class="form-label" style="margin-bottom:8px;">Son — Nouvelle commande</div>
    <div class="admin-sound-picker" id="admin-sound-picker">${buildPicker('commande')}</div>
    <div class="form-label" style="margin:14px 0 8px;">Son — Nouvelle réclamation</div>
    <div class="admin-sound-picker" id="admin-sound-picker-recla">${buildPicker('reclamation')}</div>`;
}

async function toggleAdminNotifSound() {
  const cb = document.getElementById('admin-notif-sound-toggle');
  const on = cb ? cb.checked : !AdminSound.isEnabled();
  localStorage.setItem('kbine_admin_notif_sound', on ? 'on' : 'off');
  if (on) AdminSound.tone(880, 0, .14);

  // Persisté côté serveur (voir api/admin_update_own_sound.php).
  const res = await ServerAPI.adminUpdateOwnSound({ notif_son_actif: on });
  if (!res.ok) { Toast.error(res.error || 'Échec de l\'enregistrement — réessayez.'); return; }
  DB.users.update(currentUser.id, { notif_son_actif: on });
  currentUser = Auth.refresh();
}

async function selectAdminSoundPreset(key, role = 'commande') {
  localStorage.setItem(AdminSound._presetKey(role), key);
  const scope = role === 'reclamation' ? '#admin-sound-picker-recla' : '#admin-sound-picker';
  document.querySelectorAll(`${scope} .admin-sound-option`).forEach(o =>
    o.classList.toggle('admin-sound-option--active', o.dataset.sound === key));
  AdminSound.preview(key);

  // Persisté côté serveur (voir api/admin_update_own_sound.php).
  const res = await ServerAPI.adminUpdateOwnSound({ [AdminSound._presetField(role)]: key });
  if (!res.ok) { Toast.error(res.error || 'Échec de l\'enregistrement — réessayez.'); return; }
  DB.users.update(currentUser.id, { [AdminSound._presetField(role)]: key });
  currentUser = Auth.refresh();
}

/* Sondage dédié (indépendant du heartbeat présence 10s) : détecte une
   hausse sur 7 compteurs et joue le son du rôle correspondant ("commande"
   pour tout sauf les réclamations). `null` initial → aucun son au premier
   passage, seulement sur les hausses suivantes. */
let _adminLastPendingCount = null;
let _adminLastPartnerCount = null;
let _adminLastCabineCount  = null;
let _adminLastClientCount  = null;
let _adminLastVisitorCount = null;
let _adminLastRefundCount  = null;
let _adminLastReclaCount   = null;

function _adminSoundWatch() {
  const pending = DB.transactions.pending().length;
  if (_adminLastPendingCount !== null && pending > _adminLastPendingCount) AdminSound.notify('commande');
  _adminLastPendingCount = pending;

  const reclaCount = DB.reclamations.pending().length;
  if (_adminLastReclaCount !== null && reclaCount > _adminLastReclaCount) AdminSound.notify('reclamation');
  _adminLastReclaCount = reclaCount;

  // Corrigé : lisait auparavant une clé localStorage 'cbp_applications' qui
  // n'a jamais existé (le cache réel est géré par DB.partnerApplications,
  // voir js/db.js) — cette alerte sonore ne se déclenchait donc jamais.
  const partnerPending = DB.partnerApplications.all().filter(a => a.statut === 'en_attente').length;
  if (_adminLastPartnerCount !== null && partnerPending > _adminLastPartnerCount) AdminSound.notify();
  _adminLastPartnerCount = partnerPending;

  const cabineCount = DB.users.byRole('cabine').length;
  if (_adminLastCabineCount !== null && cabineCount > _adminLastCabineCount) AdminSound.notify();
  _adminLastCabineCount = cabineCount;

  const clientCount = DB.users.byRole('client').length;
  if (_adminLastClientCount !== null && clientCount > _adminLastClientCount) AdminSound.notify();
  _adminLastClientCount = clientCount;

  const visitorCount = DB.presence.onlineTotalCount();
  if (_adminLastVisitorCount !== null && visitorCount > _adminLastVisitorCount) AdminSound.notify();
  _adminLastVisitorCount = visitorCount;

  const refundPending = DB.refundRequests.pending().length;
  if (_adminLastRefundCount !== null && refundPending > _adminLastRefundCount) AdminSound.notify();
  _adminLastRefundCount = refundPending;
}

/* â”€â”€ Dashboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
/* animateCountUp est désormais définie dans js/auth.js (chargé par les
   3 pages) pour être réutilisable depuis client.html — voir ce fichier. */

function loadDashboard() {
  const clients  = DB.users.byRole('client');
  const cabines  = DB.users.byRole('cabine');
  const stats    = DB.transactions.stats();

  animateCountUp(document.getElementById('admin-clients'), clients.length);
  animateCountUp(document.getElementById('admin-cabines'), cabines.length);
  animateCountUp(document.getElementById('admin-txns'), stats.total);
  animateCountUp(document.getElementById('admin-volume'), stats.volume, Fmt.money);
  animateCountUp(document.getElementById('admin-revenue'), stats.commissions, Fmt.money);
  animateCountUp(document.getElementById('admin-pending'), stats.pending);
  animateCountUp(document.getElementById('admin-done'), stats.done);
  animateCountUp(document.getElementById('admin-refused'), stats.refused);

  // Inscriptions du jour (tous rôles)
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const signupsToday = DB.users.all().filter(u => u.date_creation && new Date(u.date_creation) >= todayStart);
  animateCountUp(document.getElementById('admin-signups-today'), signupsToday.length);

  // Visiteurs en temps réel (comptes connectés, tous rôles — voir DB.presence)
  animateCountUp(document.getElementById('admin-online-count'), DB.presence.onlineTotalCount());

  // Réseaux activés par les cabines (persisté via reseaux_actifs, voir cabine.js toggleNetwork)
  animateCountUp(document.getElementById('admin-net-orange'), cabines.filter(c => c.reseaux_actifs?.orange).length);
  animateCountUp(document.getElementById('admin-net-moov'), cabines.filter(c => c.reseaux_actifs?.moov).length);
  animateCountUp(document.getElementById('admin-net-mtn'), cabines.filter(c => c.reseaux_actifs?.mtn).length);

  // Montant exact des ventes par réseau (commandes terminées, tout le système)
  const salesByNetwork = DB.transactions.volumeByNetwork();
  animateCountUp(document.getElementById('admin-sales-orange'), salesByNetwork.Orange, Fmt.money);
  animateCountUp(document.getElementById('admin-sales-moov'), salesByNetwork.Moov, Fmt.money);
  animateCountUp(document.getElementById('admin-sales-mtn'), salesByNetwork.MTN, Fmt.money);

  initCharts();
}

function openTodaySignups() {
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const signups = DB.users.all()
    .filter(u => u.date_creation && new Date(u.date_creation) >= todayStart)
    .sort((a,b) => new Date(b.date_creation) - new Date(a.date_creation));

  const content = document.getElementById('modal-today-signups-content');
  if (!content) return;

  if (!signups.length) {
    content.innerHTML = `<div class="empty-state" style="padding:24px"><div class="empty-title">Aucune inscription aujourd'hui</div></div>`;
  } else {
    content.innerHTML = signups.map(u => `
      <div class="stat-mini">
        <span class="stat-mini-label"><i class="fa-solid fa-user" style="margin-right:6px;color:var(--gray-400)"></i>${u.prenom} ${u.nom} <span class="badge" style="font-size:.45rem;padding:2px 6px;margin-left:4px;">${u.role}</span></span>
        <span class="stat-mini-val" style="text-align:right;font-size:.7rem;">${Fmt.phone(u.telephone)}<br><span style="color:var(--gray-400);font-weight:400;">${u.email || '—'}</span></span>
      </div>`).join('');
  }
  openModal('modal-today-signups');
}

function initCharts() {
  const isDark   = document.body.classList.contains('dark');
  const gridColor = isDark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.05)';
  const textColor = isDark ? '#8B949E' : '#718096';

  const daily = DB.transactions.dailyStats(7);
  const monthly = DB.transactions.monthlyStats(6);

  // Destroy existing
  Object.values(charts).forEach(c => c?.destroy());
  charts = {};

  // Volume chart (bar)
  const ctx1 = document.getElementById('chart-volume')?.getContext('2d');
  if (ctx1) {
    charts.volume = new Chart(ctx1, {
      type: 'bar',
      data: {
        labels: daily.map(d => d.label),
        datasets: [{
          label: 'Volume (F)',
          data: daily.map(d => d.volume),
          backgroundColor: 'rgba(255,98,0,.7)',
          borderColor: '#FF6200',
          borderWidth: 2,
          borderRadius: 8,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 11 } } },
          y: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 11 }, callback: v => Fmt.money(v).replace(' FCFA','') } },
        }
      }
    });
  }

  // Transactions count (line)
  const ctx2 = document.getElementById('chart-txns')?.getContext('2d');
  if (ctx2) {
    charts.txns = new Chart(ctx2, {
      type: 'line',
      data: {
        labels: daily.map(d => d.label),
        datasets: [{
          label: 'Transactions',
          data: daily.map(d => d.count),
          borderColor: '#009A44',
          backgroundColor: 'rgba(0,154,68,.1)',
          borderWidth: 2, pointRadius: 4,
          pointBackgroundColor: '#009A44',
          fill: true, tension: 0.4,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 11 } } },
          y: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 11 } }, beginAtZero: true },
        }
      }
    });
  }

  // Monthly (bar)
  const ctx3 = document.getElementById('chart-monthly')?.getContext('2d');
  if (ctx3) {
    charts.monthly = new Chart(ctx3, {
      type: 'bar',
      data: {
        labels: monthly.map(d => d.label),
        datasets: [
          { label: 'Volume (F)', data: monthly.map(d => d.volume), backgroundColor: 'rgba(255,98,0,.7)', borderRadius: 6, yAxisID: 'y' },
          { label: 'Transactions',  data: monthly.map(d => d.count),  backgroundColor: 'rgba(0,154,68,.7)', borderRadius: 6, yAxisID: 'y1' },
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: textColor, font: { size: 11 } } } },
        scales: {
          x:  { grid: { color: gridColor }, ticks: { color: textColor } },
          y:  { grid: { color: gridColor }, ticks: { color: textColor, callback: v => Fmt.money(v).replace(' FCFA','') }, position: 'left' },
          y1: { grid: { display: false }, ticks: { color: '#009A44' }, position: 'right' },
        }
      }
    });
  }

  // Pie: operators
  const all   = DB.transactions.all().filter(t => t.statut === 'terminé');
  const ops   = ['Orange','MTN','Moov'];
  const opData = ops.map(op => all.filter(t => t.operateur === op).length);
  const ctx4 = document.getElementById('chart-operators')?.getContext('2d');
  if (ctx4) {
    charts.ops = new Chart(ctx4, {
      type: 'doughnut',
      data: {
        labels: ops,
        datasets: [{ data: opData, backgroundColor: ['#FF6200','#FFCC00','#0066CC'], borderWidth: 0 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { color: textColor, padding: 16, font: { size: 11 } } } },
        cutout: '65%',
      }
    });
  }
}

/* â”€â”€ Clients â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function loadClients(query = '') {
  _adminResume.filters.clients = query;
  _saveAdminResume();
  let clients = DB.users.byRole('client');
  if (query) clients = clients.filter(c =>
    (c.nom + c.prenom + c.telephone + c.email).toLowerCase().includes(query.toLowerCase())
  );
  const tbody = document.getElementById('clients-tbody');
  if (!tbody) return;
  if (!clients.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state" style="padding:24px"><div class="empty-title">Aucun client trouvé</div></div></td></tr>`;
    return;
  }
  tbody.innerHTML = clients.map(c => {
    const txnCount = DB.transactions.byClient(c.id).length;
    return `<tr>
      <td><div class="user-chip"><div class="avatar">${Fmt.initials(c.nom,c.prenom)}</div><div><div class="name">${c.prenom} ${c.nom}</div><div style="font-size:.72rem;color:var(--gray-400)">${c.email}</div></div></div></td>
      <td><code>${Fmt.phone(c.telephone)}</code></td>
      <td><strong>${Fmt.money(c.solde)}</strong></td>
      <td><span class="badge badge-info">${txnCount}</span></td>
      <td>${c.statut === 'actif' ? '<span class="badge badge-success">Actif</span>' : c.statut === 'suspendu' ? '<span class="badge badge-failed">Suspendu</span>' : c.statut === 'bloqué' ? '<span class="badge badge-failed"><i class="fa-solid fa-lock"></i> Bloqué</span>' : '<span class="badge badge-pending">Inactif</span>'}</td>
      <td>${Fmt.date(c.date_creation)}</td>
      <td><button class="menu-btn-row" onclick="toggleClientRowMenu(this,'${c.id}')" title="Actions"><i class="fa-solid fa-ellipsis-vertical"></i></button></td>
    </tr>`;
  }).join('');
}

/* Actions de ligne pour un client — voir loadClients(). Même composant
   que toggleTxnRowMenu() (menu déroulant, remplace les 4 boutons icône
   sans texte empilés dans la cellule Actions). */
function toggleClientRowMenu(btn, clientId) {
  const c = DB.users.byId(clientId);
  if (!c) return;
  openRowMenu(btn, [
    { label: 'Voir le profil', icon: 'fa-eye', fn: `viewUser('${clientId}')` },
    { label: 'Se connecter en tant que', icon: 'fa-user-secret', fn: `impersonateUser('${clientId}','${c.prenom} ${c.nom}')` },
    c.statut === 'actif'
      ? { label: 'Suspendre', icon: 'fa-ban', fn: `suspendUser('${clientId}','${c.prenom} ${c.nom}')`, danger: true }
      : { label: 'Activer', icon: 'fa-check', fn: `activateUser('${clientId}','${c.prenom} ${c.nom}')` },
    { label: 'Supprimer', icon: 'fa-trash', fn: `deleteUser('${clientId}','${c.prenom} ${c.nom}')`, danger: true },
  ]);
}

/* â”€â”€ Cabines â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function loadCabines(query = '') {
  _adminResume.filters.cabines = query;
  _saveAdminResume();
  let cabines = DB.users.byRole('cabine');
  if (query) cabines = cabines.filter(c =>
    (c.nom + c.prenom + c.telephone + c.email + (c.zone||'')).toLowerCase().includes(query.toLowerCase())
  );
  const tbody = document.getElementById('cabines-tbody');
  if (!tbody) return;
  const nowTs = Date.now();
  tbody.innerHTML = cabines.map(c => {
    const txnCount = DB.transactions.byCabine(c.id).filter(t => t.statut === 'terminé').length;
    const pending  = DB.transactions.byCabine(c.id).filter(t => t.statut === 'en_attente');
    const retards  = pending.filter(t => nowTs - new Date(t.date).getTime() > DB.RETARD_MS).length;
    const suspendu = c.statut === 'suspendu';
    let statutBadge;
    if (suspendu) {
      let detail = '';
      if (c.suspendu_auto && c.suspendu_jusqu) {
        detail = ' (auto, jusqu\'au ' + Fmt.datetime(c.suspendu_jusqu) + ')';
      } else if (c.suspendu_by) {
        const byAdmin = DB.users.byId(c.suspendu_by);
        detail = ' (manuelle par ' + (byAdmin ? `${byAdmin.prenom} ${byAdmin.nom}` : 'un admin') + ')';
      }
      statutBadge = `<span class="badge badge-failed"><i class="fa-solid fa-ban"></i> Suspendu${detail}</span>`;
    } else if (c.statut === 'actif') {
      statutBadge = '<span class="badge badge-success"><i class="fa-solid fa-circle-check"></i> Actif</span>';
    } else {
      statutBadge = '<span class="badge badge-failed"><i class="fa-solid fa-circle-xmark"></i> Inactif</span>';
    }
    return `<tr>
      <td><div class="user-chip"><div class="avatar" style="background:linear-gradient(135deg,var(--secondary),var(--secondary-dark))">${Fmt.initials(c.nom,c.prenom)}</div><div><div class="name">${c.prenom} ${c.nom}</div><div style="font-size:.72rem;color:var(--gray-400)">${c.zone || 'N/A'}</div></div></div></td>
      <td><code>${Fmt.phone(c.telephone)}</code></td>
      <td><strong>${Fmt.money(DB.business.cabineSoldeDisponible(c))}</strong></td>
      <td><span class="commission-pill">${Fmt.money(c.commissions_total || 0)}</span></td>
      <td><span class="badge badge-info">${txnCount}</span></td>
      <td><span class="badge" style="background:rgba(139,92,246,.12);color:#8B5CF6;">${pending.length}</span></td>
      <td>${retards > 0 ? `<span class="badge badge-failed"><i class="fa-solid fa-triangle-exclamation"></i> ${retards}</span>` : `<span class="badge" style="background:var(--gray-100);color:var(--gray-500);">0</span>`}</td>
      <td>${statutBadge}</td>
      <td><button class="menu-btn-row" onclick="toggleCabineRowMenu(this,'${c.id}')" title="Actions"><i class="fa-solid fa-ellipsis-vertical"></i></button></td>
    </tr>`;
  }).join('');
}

/* ── Permission Cabine (super admin uniquement) ────────────────────
   Services de commande (Factures/Exchange/Recharge UV) autorisés par
   cabine — voir DB.business.cabineAcceptsService() dans js/db.js pour le
   filtre appliqué à l'assignation des commandes. La vue elle-même est
   masquée côté HTML pour un admin simple (SUPER_ONLY_VIEWS) ; cette
   garde reste nécessaire même appelée directement (ex. console). */
const CABINE_SERVICES = [
  { key: 'facture',     label: 'Factures' },
  { key: 'exchange',    label: 'Exchange' },
  { key: 'recharge_uv', label: 'Recharge UV' },
];

function loadPermissionCabine(query = '') {
  if (currentUser.admin_level !== 'super') return;

  let cabines = DB.users.byRole('cabine');
  if (query) cabines = cabines.filter(c =>
    (c.nom + c.prenom + c.telephone + (c.zone || '')).toLowerCase().includes(query.toLowerCase())
  );
  const tbody = document.getElementById('permcab-tbody');
  if (!tbody) return;

  if (!cabines.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:24px;color:var(--gray-400)">Aucune cabine trouvée</td></tr>`;
    return;
  }

  tbody.innerHTML = cabines.map(c => {
    const svcs = c.services_actifs || { facture: true, exchange: true, recharge_uv: true };
    return `<tr>
      <td><div class="user-chip"><div class="avatar" style="background:linear-gradient(135deg,var(--secondary),var(--secondary-dark))">${Fmt.initials(c.nom,c.prenom)}</div><div><div class="name">${c.prenom} ${c.nom}</div><div style="font-size:.72rem;color:var(--gray-400)">${c.zone || 'N/A'}</div></div></div></td>
      ${CABINE_SERVICES.map(s => `
      <td>
        <label class="switch">
          <input type="checkbox" ${svcs[s.key] ? 'checked' : ''} onchange="toggleCabinePermission('${c.id}','${s.key}',this)">
          <span class="slider"></span>
        </label>
      </td>`).join('')}
    </tr>`;
  }).join('');
}

async function toggleCabinePermission(cabineId, service, checkboxEl) {
  const cab = DB.users.byId(cabineId);
  if (!cab) return;
  const current = cab.services_actifs || { facture: true, exchange: true, recharge_uv: true };
  const next = { ...current, [service]: checkboxEl.checked };

  if (checkboxEl.checked === false && !Object.values(next).some(Boolean)) {
    checkboxEl.checked = true;
    Toast.error('Une cabine doit garder au moins un service actif.');
    return;
  }

  // Persisté côté serveur (voir api/admin_update_user.php) — sans ça, le
  // moteur d'attribution des commandes (qui lit services_actifs
  // directement en base) ignorait totalement ce réglage.
  const res = await ServerAPI.adminUpdateUser({ id: cabineId, servicesActifs: next });
  if (!res.ok) { checkboxEl.checked = !checkboxEl.checked; Toast.error(res.error || 'Échec de l\'enregistrement.'); return; }
  DB.users.update(cabineId, { services_actifs: next });
  DB.permissionLogs.create({
    admin_id: currentUser.id, admin_name: `${currentUser.prenom} ${currentUser.nom}`,
    cabine_id: cabineId, cabine_name: cab.cabine_nom || `${cab.prenom} ${cab.nom}`,
    service, active: checkboxEl.checked,
  });
  const label = (CABINE_SERVICES.find(s => s.key === service) || {}).label || service;
  Toast.success(`${label} ${checkboxEl.checked ? 'activé' : 'désactivé'} pour ${cab.cabine_nom || cab.prenom + ' ' + cab.nom}.`);
}

/* Actions de ligne pour une cabine — voir loadCabines(). */
function toggleCabineRowMenu(btn, cabineId) {
  const c = DB.users.byId(cabineId);
  if (!c) return;
  const suspendu = c.statut === 'suspendu';
  openRowMenu(btn, [
    { label: 'Voir le profil', icon: 'fa-eye', fn: `viewUser('${cabineId}')` },
    { label: 'Contacter (WhatsApp)', icon: 'fa-brands fa-whatsapp', fn: `adminContactWhatsapp('${c.whatsapp || c.telephone}','${c.prenom}')` },
    { label: 'Appeler', icon: 'fa-phone', fn: `adminCallPhone('${c.telephone}')` },
    { label: 'Se connecter en tant que', icon: 'fa-user-secret', fn: `impersonateUser('${cabineId}','${c.prenom} ${c.nom}')` },
    suspendu
      ? { label: 'Débloquer', icon: 'fa-lock-open', fn: `toggleCabine('${cabineId}',true)` }
      : c.statut === 'actif'
      ? { label: 'Suspendre', icon: 'fa-ban', fn: `openSuspendCabineModal('${cabineId}')`, danger: true }
      : { label: 'Activer', icon: 'fa-toggle-on', fn: `toggleCabine('${cabineId}',true)` },
    (!suspendu && c.statut === 'actif') && { label: 'Désactiver', icon: 'fa-toggle-off', fn: `toggleCabine('${cabineId}',false)` },
    { label: 'Supprimer', icon: 'fa-trash', fn: `deleteUser('${cabineId}','${c.prenom} ${c.nom}')`, danger: true },
  ]);
}

/* ── Retraits (onglet admin) ─────────────────────────────────────────
   Une ligne par cabine : solde disponible, moyen/numero de paiement
   renseignes a l'inscription (paiement_vers / numero_compte), et deux
   actions admin : corriger le moyen de paiement, ou traiter un retrait
   (deduit le montant du solde et l'enregistre via DB.retraits.create). */
function loadRetraitsAdmin() {
  const cabines = DB.users.byRole('cabine');
  const tbody = document.getElementById('retraits-admin-tbody');
  if (!tbody) return;

  if (!cabines.length) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state" style="padding:24px"><div class="empty-title">Aucune cabine</div></div></td></tr>`;
    return;
  }

  tbody.innerHTML = cabines.map(c => `
    <tr>
      <td><div class="user-chip"><div class="avatar" style="background:linear-gradient(135deg,var(--secondary),var(--secondary-dark))">${Fmt.initials(c.nom,c.prenom)}</div><div><div class="name">${c.prenom} ${c.nom}</div><div style="font-size:.72rem;color:var(--gray-400)">${c.zone || 'N/A'}</div></div></div></td>
      <td><strong>${Fmt.money(DB.business.cabineSoldeDisponible(c))}</strong></td>
      <td>${c.paiement_vers ? `<span class="badge badge-info">${c.paiement_vers}</span>` : '<span style="color:var(--gray-400)">Non renseigné</span>'}</td>
      <td>${c.numero_compte ? `<code>${c.numero_compte}</code>` : '<span style="color:var(--gray-400)">—</span>'}${c.retrait_derniere_maj ? `<div style="font-size:.65rem;color:var(--gray-400);margin-top:3px;">Modifié le ${Fmt.datetime(c.retrait_derniere_maj)}</div>` : ''}</td>
      <td><button class="menu-btn-row" onclick="toggleRetraitRowMenu(this,'${c.id}')" title="Actions"><i class="fa-solid fa-ellipsis-vertical"></i></button></td>
    </tr>`).join('');
}

/* Actions de ligne pour une cabine — voir loadRetraitsAdmin(). */
function toggleRetraitRowMenu(btn, cabineId) {
  const c = DB.users.byId(cabineId);
  if (!c) return;
  openRowMenu(btn, [
    { label: 'Modifier le moyen de paiement', icon: 'fa-credit-card', fn: `openEditPaymentModal('${cabineId}')` },
    DB.business.cabineSoldeDisponible(c) > 0 && { label: 'Traiter un retrait', icon: 'fa-money-bill-wave', fn: `openProcessRetraitModal('${cabineId}')` },
  ]);
}

/* ── Historique des retraits (super admin uniquement) ─────────────────
   A la difference de loadRetraitsAdmin() ci-dessus (1 ligne par cabine,
   solde courant), ici 1 ligne par retrait deja effectue (DB.retraits),
   toutes cabines confondues — recherche par cabine, filtre par periode,
   pagination. Inclut aussi les sanctions (retraits punitifs crees par
   business.refundTransaction(), reperees par type==='sanction') pour
   rester fidele a "tous les retraits". */
const RHIST_PAGE_SIZE = 20;

async function loadRetraitsHistorique(page = 1) {
  const tbody = document.getElementById('rhist-tbody');
  if (!tbody) return;
  await DB.retraits.refresh();

  const query     = (document.getElementById('rhist-search')?.value || '').trim().toLowerCase();
  const dateDebut = document.getElementById('rhist-date-debut')?.value || '';
  const dateFin   = document.getElementById('rhist-date-fin')?.value || '';

  let retraits = DB.retraits.all()
    .map(r => ({ ...r, cabine: DB.users.byId(r.cabine_id) }))
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  if (query) retraits = retraits.filter(r => {
    const c = r.cabine;
    const label = c ? `${c.cabine_nom || ''} ${c.prenom} ${c.nom} ${c.zone || ''}` : '';
    return label.toLowerCase().includes(query);
  });
  if (dateDebut) retraits = retraits.filter(r => r.date >= dateDebut);
  if (dateFin)   retraits = retraits.filter(r => r.date <= dateFin + 'T23:59:59');

  const totalPages = Math.max(1, Math.ceil(retraits.length / RHIST_PAGE_SIZE));
  if (page > totalPages) page = totalPages;
  const start = (page - 1) * RHIST_PAGE_SIZE;
  const pageItems = retraits.slice(start, start + RHIST_PAGE_SIZE);

  if (!pageItems.length) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state" style="padding:24px"><div class="empty-title">Aucun retrait</div></div></td></tr>`;
  } else {
    tbody.innerHTML = pageItems.map(r => {
      const c = r.cabine;
      const nom = c ? (c.cabine_nom || `${c.prenom} ${c.nom}`) : 'Cabine supprimée';
      const zone = c?.zone || 'N/A';
      const sanction = r.type === 'sanction'
        ? ` <span class="badge badge-failed" title="${r.motif || ''}"><i class="fa-solid fa-triangle-exclamation"></i> Sanction</span>`
        : '';
      return `<tr>
        <td><div class="user-chip"><div class="avatar" style="background:linear-gradient(135deg,var(--secondary),var(--secondary-dark))">${c ? Fmt.initials(c.nom, c.prenom) : '?'}</div><div><div class="name">${nom}</div><div style="font-size:.72rem;color:var(--gray-400)">${zone}</div></div></div></td>
        <td><strong>${Fmt.money(r.montant)}</strong></td>
        <td>${r.methode_retrait || '<span style="color:var(--gray-400)">—</span>'}${sanction}</td>
        <td>${Fmt.status(r.statut)}</td>
        <td>${Fmt.datetime(r.date)}</td>
      </tr>`;
    }).join('');
  }

  renderRhistPagination(totalPages, page);
}

function renderRhistPagination(totalPages, page) {
  const el = document.getElementById('rhist-pagination');
  if (!el) return;
  if (totalPages <= 1) { el.innerHTML = ''; return; }

  let html = `<button class="page-btn" ${page === 1 ? 'disabled' : ''} onclick="loadRetraitsHistorique(${page - 1})"><i class="fa-solid fa-chevron-left"></i></button>`;
  for (let n = 1; n <= totalPages; n++) {
    html += `<button class="page-btn${n === page ? ' active' : ''}" onclick="loadRetraitsHistorique(${n})">${n}</button>`;
  }
  html += `<button class="page-btn" ${page === totalPages ? 'disabled' : ''} onclick="loadRetraitsHistorique(${page + 1})"><i class="fa-solid fa-chevron-right"></i></button>`;
  el.innerHTML = html;
}

let _editPaymentCabineId = null;

function openEditPaymentModal(cabineId) {
  const c = DB.users.byId(cabineId);
  if (!c) return;
  _editPaymentCabineId = cabineId;
  document.getElementById('edit-payment-methode').value = c.paiement_vers || 'Orange Money';
  document.getElementById('edit-payment-numero').value  = c.numero_compte || '';
  openModal('modal-edit-payment');
}

async function confirmEditPayment() {
  const methode = document.getElementById('edit-payment-methode').value;
  const numero  = document.getElementById('edit-payment-numero').value.trim();
  if (!numero) { Toast.error('Le numéro de paiement est obligatoire.'); return; }
  const res = await DB.retraits.setInfo(methode, numero, _editPaymentCabineId);
  if (!res.ok) { Toast.error(res.error); return; }
  await refreshUsersFromServer();
  closeModal('modal-edit-payment');
  Toast.success('Moyen de paiement mis à jour.');
  loadRetraitsAdmin();
}

let _processRetraitCabineId = null;

function openProcessRetraitModal(cabineId) {
  const c = DB.users.byId(cabineId);
  if (!c) return;
  _processRetraitCabineId = cabineId;
  const dispo = DB.business.cabineSoldeDisponible(c);
  document.getElementById('process-retrait-dispo').textContent = Fmt.money(dispo);
  document.getElementById('process-retrait-restant').textContent = Fmt.money(dispo);
  const montantInput = document.getElementById('process-retrait-montant');
  montantInput.value = '';
  montantInput.max = dispo;
  montantInput.oninput = () => {
    const montant = parseFloat(montantInput.value) || 0;
    document.getElementById('process-retrait-restant').textContent = Fmt.money(Math.max(0, dispo - montant));
  };
  openModal('modal-process-retrait');
}

async function confirmProcessRetrait() {
  const c = DB.users.byId(_processRetraitCabineId);
  if (!c) return;
  const montant = parseFloat(document.getElementById('process-retrait-montant').value);
  if (isNaN(montant) || montant <= 0) { Toast.error('Montant invalide.'); return; }
  if (montant > DB.business.cabineSoldeDisponible(c)) { Toast.error('Le montant dépasse le solde disponible.'); return; }

  const res = await DB.retraits.process(c.id, montant);
  if (!res.ok) { Toast.error(res.error); return; }
  await refreshUsersFromServer();

  closeModal('modal-process-retrait');
  Toast.success(`Retrait de ${Fmt.money(montant)} traité pour ${c.prenom} ${c.nom}.`);
  loadRetraitsAdmin();
  loadCabines();
  loadDashboard();
}

/* ── Recharge cabiniste (onglet admin) ────────────────────────────────
   Crédite directement le solde d'un cabiniste via DB.business.recharge. */
function loadRechargeCabiniste(query = '') {
  _adminResume.filters.rechargeCabiniste = query;
  _saveAdminResume();
  let cabines = DB.users.byRole('cabine');
  if (query) cabines = cabines.filter(c =>
    `${c.prenom} ${c.nom} ${c.cabine_nom || ''} ${c.telephone}`.toLowerCase().includes(query.toLowerCase())
  );

  const tbody = document.getElementById('recharge-cabiniste-tbody');
  if (!tbody) return;

  if (!cabines.length) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state" style="padding:24px"><div class="empty-title">Aucune cabine</div></div></td></tr>`;
    return;
  }

  tbody.innerHTML = cabines.map(c => `
    <tr>
      <td><div class="user-chip"><div class="avatar" style="background:linear-gradient(135deg,var(--secondary),var(--secondary-dark))">${Fmt.initials(c.nom,c.prenom)}</div><div><div class="name">${c.prenom} ${c.nom}</div><div style="font-size:.72rem;color:var(--gray-400)">${c.cabine_nom || c.zone || 'N/A'}</div></div></div></td>
      <td><code>${Fmt.phone(c.telephone)}</code></td>
      <td><strong>${Fmt.money(DB.business.cabineSoldeDisponible(c))}</strong></td>
      <td><span class="badge ${c.statut === 'actif' ? 'badge-success' : 'badge-failed'}">${c.statut}</span></td>
      <td>
        <button class="btn btn-sm btn-secondary" onclick="openRechargeCabinisteModal('${c.id}')" title="Recharger le solde"><i class="fa-solid fa-wallet"></i> Recharger</button>
      </td>
    </tr>`).join('');
}

let _rechargeCabinisteId = null;

function openRechargeCabinisteModal(cabineId) {
  const c = DB.users.byId(cabineId);
  if (!c) return;
  _rechargeCabinisteId = cabineId;
  document.getElementById('recharge-cabiniste-label').textContent = `${c.prenom} ${c.nom} (${c.cabine_nom || c.zone || 'N/A'})`;
  document.getElementById('recharge-cabiniste-solde').textContent = Fmt.money(DB.business.cabineSoldeDisponible(c));
  document.getElementById('recharge-cabiniste-apres').textContent = Fmt.money(DB.business.cabineSoldeDisponible(c));
  document.getElementById('recharge-cabiniste-montant').value = '';
  openModal('modal-recharge-cabiniste');
}

function updateRechargeCabinistePreview() {
  const c = DB.users.byId(_rechargeCabinisteId);
  if (!c) return;
  const montant = parseFloat(document.getElementById('recharge-cabiniste-montant').value) || 0;
  document.getElementById('recharge-cabiniste-apres').textContent = Fmt.money(DB.business.cabineSoldeDisponible(c) + montant);
}

async function confirmRechargeCabiniste() {
  const c = DB.users.byId(_rechargeCabinisteId);
  if (!c) return;
  const montant = parseFloat(document.getElementById('recharge-cabiniste-montant').value);
  if (isNaN(montant) || montant <= 0) { Toast.error('Montant invalide.'); return; }

  const res = await DB.business.recharge(c.id, montant);
  if (!res.ok) { Toast.error(res.error); return; }

  closeModal('modal-recharge-cabiniste');
  Toast.success(`${Fmt.money(montant)} crédités au compte de ${c.prenom} ${c.nom}.`);
  loadRechargeCabiniste();
  loadCabines();
  loadDashboard();
}

/* ── Recharge client (onglet admin) ───────────────────────────────────
   Crédite directement le solde d'un client via DB.business.recharge. */
function loadRechargeClient(query = '') {
  _adminResume.filters.rechargeClient = query;
  _saveAdminResume();
  let clients = DB.users.byRole('client');
  if (query) clients = clients.filter(c =>
    `${c.prenom} ${c.nom} ${c.telephone} ${c.email || ''}`.toLowerCase().includes(query.toLowerCase())
  );

  const tbody = document.getElementById('recharge-client-tbody');
  if (!tbody) return;

  if (!clients.length) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state" style="padding:24px"><div class="empty-title">Aucun client</div></div></td></tr>`;
    return;
  }

  tbody.innerHTML = clients.map(c => `
    <tr>
      <td><div class="user-chip"><div class="avatar" style="background:linear-gradient(135deg,var(--primary),var(--primary-dark))">${Fmt.initials(c.nom,c.prenom)}</div><div><div class="name">${c.prenom} ${c.nom}</div></div></div></td>
      <td><code>${Fmt.phone(c.telephone)}</code></td>
      <td><strong>${Fmt.money(c.solde)}</strong></td>
      <td><span class="badge ${c.statut === 'actif' ? 'badge-success' : 'badge-failed'}">${c.statut}</span></td>
      <td>
        <button class="btn btn-sm btn-primary" onclick="openRechargeClientModal('${c.id}')" title="Recharger le solde"><i class="fa-solid fa-sack-dollar"></i> Recharger</button>
        <button class="btn btn-sm btn-ghost" onclick="openRetraitClientModal('${c.id}')" title="Retirer du solde"><i class="fa-solid fa-money-bill-transfer"></i> Retirer</button>
      </td>
    </tr>`).join('');
}

let _rechargeClientId = null;

function openRechargeClientModal(clientId) {
  const c = DB.users.byId(clientId);
  if (!c) return;
  _rechargeClientId = clientId;
  document.getElementById('recharge-client-label').textContent = `${c.prenom} ${c.nom}`;
  document.getElementById('recharge-client-solde').textContent = Fmt.money(c.solde);
  document.getElementById('recharge-client-apres').textContent = Fmt.money(c.solde);
  document.getElementById('recharge-client-montant').value = '';
  openModal('modal-recharge-client');
}

function updateRechargeClientPreview() {
  const c = DB.users.byId(_rechargeClientId);
  if (!c) return;
  const montant = parseFloat(document.getElementById('recharge-client-montant').value) || 0;
  document.getElementById('recharge-client-apres').textContent = Fmt.money(c.solde + montant);
}

async function confirmRechargeClient() {
  const c = DB.users.byId(_rechargeClientId);
  if (!c) return;
  const montant = parseFloat(document.getElementById('recharge-client-montant').value);
  if (isNaN(montant) || montant <= 0) { Toast.error('Montant invalide.'); return; }

  const res = await DB.business.recharge(c.id, montant);
  if (!res.ok) { Toast.error(res.error); return; }

  closeModal('modal-recharge-client');
  Toast.success(`${Fmt.money(montant)} crédités au compte de ${c.prenom} ${c.nom}.`);
  loadRechargeClient();
  loadClients();
  loadDashboard();
}

let _retraitClientId = null;

// Retrait admin depuis un compte client — même patron que
// openRechargeClientModal()/confirmRechargeClient() ci-dessus, réutilise
// DB.retraits.process() (déjà générique côté paramètres : voir
// api/retraits_create.php, désormais ouvert aux rôles client ET cabine).
function openRetraitClientModal(clientId) {
  const c = DB.users.byId(clientId);
  if (!c) return;
  _retraitClientId = clientId;
  document.getElementById('retrait-client-label').textContent = `${c.prenom} ${c.nom}`;
  document.getElementById('retrait-client-solde').textContent = Fmt.money(c.solde);
  document.getElementById('retrait-client-apres').textContent = Fmt.money(c.solde);
  document.getElementById('retrait-client-montant').value = '';
  openModal('modal-retrait-client');
}

function updateRetraitClientPreview() {
  const c = DB.users.byId(_retraitClientId);
  if (!c) return;
  const montant = parseFloat(document.getElementById('retrait-client-montant').value) || 0;
  document.getElementById('retrait-client-apres').textContent = Fmt.money(Math.max(0, c.solde - montant));
}

async function confirmRetraitClient() {
  const c = DB.users.byId(_retraitClientId);
  if (!c) return;
  const montant = parseFloat(document.getElementById('retrait-client-montant').value);
  if (isNaN(montant) || montant <= 0) { Toast.error('Montant invalide.'); return; }
  if (montant > (c.solde || 0)) { Toast.error('Le montant dépasse le solde disponible : ' + Fmt.money(c.solde || 0)); return; }

  const res = await DB.retraits.process(c.id, montant);
  if (!res.ok) { Toast.error(res.error); return; }

  closeModal('modal-retrait-client');
  Toast.success(`${Fmt.money(montant)} retirés du compte de ${c.prenom} ${c.nom}.`);
  loadRechargeClient();
  loadClients();
  loadDashboard();
}

/* ── Recharge UV (onglet admin) ───────────────────────────────────────
   Liste les commandes de recharge d'unités virtuelles (type
   'recharge_uv') passées par les clients ; réutilise les actions
   génériques de gestion de commande (réassigner/rembourser/suspendre). */
function loadRechargeUvAdmin(query = '', statusFilter = 'all') {
  const uvBadge = document.getElementById('recharge-uv-badge');
  if (uvBadge) {
    const pendingCount = DB.transactions.all().filter(t => t.type === 'recharge_uv' && t.statut === 'en_attente').length;
    uvBadge.textContent = pendingCount;
    uvBadge.style.display = (pendingCount > 0 && !_isNavActive('recharge-uv-admin')) ? 'inline-flex' : 'none';
  }
  let txns = DB.transactions.all().filter(t => t.type === 'recharge_uv').sort((a,b) => new Date(b.date)-new Date(a.date));
  if (statusFilter !== 'all') txns = txns.filter(t => t.statut === statusFilter);
  if (query) txns = txns.filter(t =>
    t.id.includes(query) ||
    (t.numero_beneficiaire || '').includes(query) ||
    (t.operateur || '').toLowerCase().includes(query.toLowerCase()) ||
    (DB.users.byId(t.client_id)?.nom || '').toLowerCase().includes(query.toLowerCase())
  );

  const tbody = document.getElementById('recharge-uv-admin-tbody');
  if (!tbody) return;
  if (!txns.length) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state" style="padding:24px"><div class="empty-title">Aucune commande de recharge UV</div></div></td></tr>`;
    return;
  }
  tbody.innerHTML = txns.map(t => renderCommandeRow(t, 9)).join('');
}

function searchRechargeUvAdmin() {
  const q = document.getElementById('recharge-uv-search').value.trim();
  const s = document.getElementById('recharge-uv-status').value;
  _adminResume.filters.rechargeUv = { q, status: s };
  _saveAdminResume();
  loadRechargeUvAdmin(q, s);
}

/* ── Exchange (onglet admin) ──────────────────────────────────────────
   Liste les commandes d'échange entre réseaux (type 'exchange'). */
function loadExchangeAdmin(query = '', statusFilter = 'all') {
  const exBadge = document.getElementById('exchange-badge');
  if (exBadge) {
    const pendingCount = DB.transactions.all().filter(t => t.type === 'exchange' && t.statut === 'en_attente').length;
    exBadge.textContent = pendingCount;
    exBadge.style.display = (pendingCount > 0 && !_isNavActive('exchange-admin')) ? 'inline-flex' : 'none';
  }
  let txns = DB.transactions.all().filter(t => t.type === 'exchange').sort((a,b) => new Date(b.date)-new Date(a.date));
  if (statusFilter !== 'all') txns = txns.filter(t => t.statut === statusFilter);
  if (query) txns = txns.filter(t =>
    t.id.includes(query) ||
    (t.numero_beneficiaire || '').includes(query) ||
    (t.operateur || '').toLowerCase().includes(query.toLowerCase()) ||
    (DB.users.byId(t.client_id)?.nom || '').toLowerCase().includes(query.toLowerCase())
  );

  const tbody = document.getElementById('exchange-admin-tbody');
  if (!tbody) return;
  if (!txns.length) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state" style="padding:24px"><div class="empty-title">Aucune commande d'exchange</div></div></td></tr>`;
    return;
  }
  tbody.innerHTML = txns.map(t => {
    const client = DB.users.byId(t.client_id);
    const cabine = DB.users.byId(t.cabine_id);
    const d = t.details || {};
    const canReassign   = t.statut === 'en_attente';
    const canRefund     = t.statut === 'en_attente' || t.statut === 'terminé';
    const canSuspend    = t.statut === 'en_attente' || t.statut === 'terminé';
    const canReactivate = t.statut === 'suspendue';
    const canDelete      = currentUser.admin_level === 'super' && ['en_attente', 'suspendue', 'remboursé'].includes(t.statut);
    const rc = Fmt.rowColors(t);
    return `<tr style="background:${rc.bg};">
      <td style="box-shadow:inset 3px 0 0 ${rc.line};"><code style="font-size:.72rem;color:var(--primary)">${Fmt.ref(t.id)}</code></td>
      <td>${client ? `${client.prenom} ${client.nom}` : '?'}</td>
      <td>${cabine ? `${cabine.prenom} ${cabine.nom}` : '<span style="color:var(--gray-400)">—</span>'}</td>
      <td>${Fmt.operator(d.debit_network || '')} <code>${Fmt.phone(d.debit_numero) || ''}</code></td>
      <td>${Fmt.operator(d.recep_network || t.operateur || '')} <code>${Fmt.phone(d.recep_numero || t.numero_beneficiaire) || ''}</code></td>
      <td><strong>${Fmt.money(t.montant)}</strong></td>
      <td>${Fmt.statusBadge(t)}${t.statut === 'suspendue' && t.motif_suspension ? `<div style="font-size:.62rem;color:var(--gray-400);margin-top:2px;font-style:italic;">${t.motif_suspension}</div>` : ''}</td>
      <td>${Fmt.datetime(t.date)}</td>
      <td>${(canReassign || canRefund || canSuspend || canReactivate || canDelete) ? `<button class="menu-btn-row" onclick="toggleTxnRowMenu(this,'${t.id}')" title="Actions"><i class="fa-solid fa-ellipsis-vertical"></i></button>` : '<span style="color:var(--gray-400);font-size:.7rem;">—</span>'}</td>
    </tr>`;
  }).join('');
}

function searchExchangeAdmin() {
  const q = document.getElementById('exchange-admin-search').value.trim();
  const s = document.getElementById('exchange-admin-status').value;
  _adminResume.filters.exchange = { q, status: s };
  _saveAdminResume();
  loadExchangeAdmin(q, s);
}

/* Ligne de tableau générique pour une commande (recharge UV, etc.) avec
   les actions standard de gestion — même logique que loadTransactions(). */
function renderCommandeRow(t) {
  const client = DB.users.byId(t.client_id);
  const cabine = DB.users.byId(t.cabine_id);
  const canReassign   = t.statut === 'en_attente';
  const canRefund     = t.statut === 'en_attente' || t.statut === 'terminé';
  const canSuspend    = t.statut === 'en_attente' || t.statut === 'terminé';
  const canReactivate = t.statut === 'suspendue';
  const canDelete      = currentUser.admin_level === 'super' && ['en_attente', 'suspendue', 'remboursé'].includes(t.statut);
  const rc = Fmt.rowColors(t);
  return `<tr style="background:${rc.bg};">
    <td style="box-shadow:inset 3px 0 0 ${rc.line};"><code style="font-size:.72rem;color:var(--primary)">${Fmt.ref(t.id)}</code></td>
    <td>${client ? `${client.prenom} ${client.nom}` : '?'}</td>
    <td>${cabine ? `${cabine.prenom} ${cabine.nom}` : '<span style="color:var(--gray-400)">—</span>'}</td>
    <td>${Fmt.operator(t.operateur || '')}</td>
    <td><code>${Fmt.phone(t.numero_beneficiaire) || ''}</code></td>
    <td><strong>${Fmt.money(t.montant)}</strong></td>
    <td>${Fmt.statusBadge(t)}${t.statut === 'suspendue' && t.motif_suspension ? `<div style="font-size:.62rem;color:var(--gray-400);margin-top:2px;font-style:italic;">${t.motif_suspension}</div>` : ''}</td>
    <td>${Fmt.datetime(t.date)}</td>
    <td>${(client || canReassign || canRefund || canSuspend || canReactivate || canDelete) ? `<button class="menu-btn-row" onclick="toggleCommandeRowMenu(this,'${t.id}')" title="Actions"><i class="fa-solid fa-ellipsis-vertical"></i></button>` : '<span style="color:var(--gray-400);font-size:.7rem;">—</span>'}</td>
  </tr>`;
}

/* Actions de ligne pour une commande (recharge UV, etc.) — voir
   renderCommandeRow(). Comme toggleTxnRowMenu() mais avec en plus le
   contact WhatsApp du client quand il existe. */
function toggleCommandeRowMenu(btn, txnId) {
  const t = DB.transactions.byId(txnId);
  if (!t) return;
  const client = DB.users.byId(t.client_id);
  openRowMenu(btn, [
    client && { label: 'Contacter via WhatsApp', icon: 'fa-brands fa-whatsapp', fn: `adminContactWhatsapp('${client.telephone}','${client.prenom}')` },
    t.statut === 'en_attente' && { label: 'Réassigner', icon: 'fa-shuffle', fn: `openReassignModal('${txnId}')` },
    (t.statut === 'en_attente' || t.statut === 'terminé') && { label: 'Rembourser', icon: 'fa-hand-holding-dollar', fn: `refundTxn('${txnId}')`, danger: true },
    (t.statut === 'en_attente' || t.statut === 'terminé') && { label: 'Suspendre', icon: 'fa-ban', fn: `openSuspendModal('${txnId}')` },
    t.statut === 'suspendue' && { label: 'Réactiver', icon: 'fa-arrow-rotate-right', fn: `reactivateTxn('${txnId}')` },
    currentUser.admin_level === 'super' && ['en_attente', 'suspendue', 'remboursé'].includes(t.statut) &&
      { label: 'Supprimer', icon: 'fa-trash', fn: `deleteTxn('${txnId}')`, danger: true },
  ]);
}

/* ── Commandes en retard (onglet admin, feature 6) ────────────────────
   Historique persistant (DB.retards), à ne pas confondre avec le badge
   "Retards" en direct de loadCabines() qui ne reflète que les commandes
   encore en attente au moment du rendu. */
function loadRetardsAdmin(query = '') {
  let rows = DB.retards.all().sort((a,b) => new Date(b.date)-new Date(a.date));
  if (query) rows = rows.filter(r => {
    const cabine = DB.users.byId(r.cabine_id);
    return r.transaction_id.includes(query) ||
      (cabine && `${cabine.prenom} ${cabine.nom} ${cabine.cabine_nom || ''}`.toLowerCase().includes(query.toLowerCase()));
  });

  const tbody = document.getElementById('retards-admin-tbody');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state" style="padding:24px"><div class="empty-title">Aucun retard enregistré</div></div></td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const cabine = DB.users.byId(r.cabine_id);
    const txn    = DB.transactions.byId(r.transaction_id);
    const target = r.reassigned_to_cabine_id ? DB.users.byId(r.reassigned_to_cabine_id) : null;
    let outcome;
    if (r.triggered_suspension) outcome = `<span class="badge badge-failed"><i class="fa-solid fa-ban"></i> A déclenché une suspension</span>`;
    else if (target) outcome = `<span class="badge badge-info">Réassignée à ${target.prenom} ${target.nom}</span>`;
    else outcome = `<span class="badge badge-pending">Renvoyée en attente (non assignée)</span>`;

    return `<tr>
      <td>${Fmt.datetime(r.date)}</td>
      <td>${cabine ? `${cabine.prenom} ${cabine.nom} (${cabine.cabine_nom || cabine.zone || 'N/A'})` : '?'}</td>
      <td><code style="font-size:.72rem;color:var(--primary)">${Fmt.ref(r.transaction_id)}</code></td>
      <td>${txn ? Fmt.money(txn.montant) : '—'}</td>
      <td>${txn ? Fmt.operator(txn.operateur || '') : '—'}</td>
      <td>${outcome}</td>
    </tr>`;
  }).join('');
}

function searchRetardsAdmin() {
  const q = document.getElementById('retards-admin-search').value.trim();
  _adminResume.filters.retards = q;
  _saveAdminResume();
  loadRetardsAdmin(q);
}

/* â”€â”€ Transactions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function loadTransactions(query = '', statusFilter = 'all') {
  // Badge de la sidebar : total en_attente indépendant de la recherche/du
  // filtre de statut affiché — même motif que partner-badge/reset-badge/
  // refund-badge (voir loadPartnerRequests()/loadResetRequests()/loadRefundRequests()).
  const txnBadge = document.getElementById('txn-badge');
  if (txnBadge) {
    const pendingCount = DB.transactions.all().filter(t => t.statut === 'en_attente').length;
    txnBadge.textContent = pendingCount;
    txnBadge.style.display = (pendingCount > 0 && !_isNavActive('transactions')) ? 'inline-flex' : 'none';
  }
  let txns = DB.transactions.all().sort((a,b) => new Date(b.date)-new Date(a.date));
  // "en_retard" n'est pas un statut stocké en base (voir Fmt.isLate) : c'est
  // un sous-ensemble de "en_attente" dérivé de la date d'assignation — filtre
  // dédié plutôt qu'une simple égalité de statut comme les autres valeurs.
  if (statusFilter === 'en_retard') txns = txns.filter(t => Fmt.isLate(t));
  else if (statusFilter !== 'all') txns = txns.filter(t => t.statut === statusFilter);
  if (query) txns = txns.filter(t =>
    t.id.includes(query) ||
    Fmt.ref(t.id).toLowerCase().includes(query.toLowerCase()) ||
    // Certains types (réabonnement, cadeau, factures avancées...) n'ont ni
    // opérateur ni numéro bénéficiaire — sans ce filet, une recherche
    // plantait dès que la liste contenait ne serait-ce qu'une seule de ces
    // transactions.
    (t.numero_beneficiaire || '').includes(query) ||
    (t.operateur || '').toLowerCase().includes(query.toLowerCase()) ||
    (DB.users.byId(t.client_id)?.nom || '').toLowerCase().includes(query.toLowerCase())
  );

  const tbody = document.getElementById('admin-txn-tbody');
  if (!tbody) return;
  if (!txns.length) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state" style="padding:24px"><div class="empty-title">Aucune transaction</div></div></td></tr>`;
    updateBulkReassignBar();
    return;
  }
  // Couleurs de badge par réseau (mêmes teintes que Fmt.operator, en
  // version pastille pleine plutôt que texte coloré + icône signal).
  const OP_COLORS = {
    Orange: { fg: '#B84B00', bg: 'rgba(255,98,0,.14)' },
    MTN:    { fg: '#8A6D00', bg: 'rgba(255,203,5,.20)' },
    Moov:   { fg: '#0055AA', bg: 'rgba(0,102,204,.12)' },
  };
  tbody.innerHTML = txns.map(t => {
    const client = DB.users.byId(t.client_id);
    const cabine = DB.users.byId(t.cabine_id);
    const canReassign   = t.statut === 'en_attente';
    const canRefund     = t.statut === 'en_attente' || t.statut === 'terminé';
    const canSuspend    = t.statut === 'en_attente' || t.statut === 'terminé';
    const canReactivate = t.statut === 'suspendue';
    const canDelete      = currentUser.admin_level === 'super' && ['en_attente', 'suspendue', 'remboursé'].includes(t.statut);
    const hasActions    = canReassign || canRefund || canSuspend || canReactivate || canDelete;
    const op = OP_COLORS[t.operateur] || { fg: 'var(--gray-600)', bg: 'var(--gray-100)' };
    // Code couleur de ligne par statut (+ "en retard" dérivé) — voir
    // Fmt.rowColors()/STATUS_COLORS dans js/auth.js, source unique
    // réutilisée par tous les tableaux/listes de commandes de l'app.
    // Liseré + fond très légèrement teinté, le texte des cellules reste
    // neutre : seul le badge Fmt.status() porte la couleur saturée.
    const rc = Fmt.rowColors(t);
    return `<tr style="background:${rc.bg};">
      <td style="box-shadow:inset 3px 0 0 ${rc.line};">${canReassign ? `<input type="checkbox" class="txn-bulk-chk" value="${t.id}" onchange="updateBulkReassignBar()">` : ''}</td>
      <td><code style="font-size:.7rem;color:var(--primary);font-weight:700;">${Fmt.ref(t.id)}</code></td>
      <td>
        <div class="user-chip">
          <div class="avatar" style="background:linear-gradient(135deg,#3B82F6,#2563EB)">${client ? Fmt.initials(client.nom, client.prenom) : '?'}</div>
          <div>
            <div class="name">${client ? `${client.prenom} ${client.nom}` : '?'}</div>
            <div style="font-size:.68rem;color:var(--gray-400)">${cabine ? `Cabine : ${cabine.prenom} ${cabine.nom}` : 'Cabine —'}</div>
          </div>
        </div>
      </td>
      <td><span style="display:inline-flex;padding:4px 10px;border-radius:999px;font-size:.72rem;font-weight:800;color:${op.fg};background:${op.bg};">${t.operateur}</span></td>
      <td><code>${Fmt.phone(t.numero_beneficiaire)}</code></td>
      <td>
        <strong>${Fmt.money(t.montant)}</strong>
        ${t.statut === 'terminé' ? `<div style="font-size:.62rem;color:var(--gray-400);margin-top:2px;">Commission ${Fmt.money(t.commission)}</div>` : ''}
      </td>
      <td>${Fmt.statusBadge(t)}${t.statut === 'suspendue' && t.motif_suspension ? `<div style="font-size:.62rem;color:var(--gray-400);margin-top:2px;font-style:italic;">${t.motif_suspension}</div>` : ''}</td>
      <td>${Fmt.datetime(t.date)}</td>
      <td>${hasActions ? `<button class="menu-btn-row" onclick="toggleTxnRowMenu(this,'${t.id}')" title="Actions"><i class="fa-solid fa-ellipsis-vertical"></i></button>` : '<span style="color:var(--gray-400);font-size:.7rem;">—</span>'}</td>
    </tr>`;
  }).join('');
  document.getElementById('admin-txn-check-all').checked = false;
  updateBulkReassignBar();
}

/* ── Assignation multiple (feature 2) ─────────────────────────────── */
function toggleAllTxnChecks(checked) {
  document.querySelectorAll('.txn-bulk-chk').forEach(chk => { chk.checked = checked; });
  updateBulkReassignBar();
}

function updateBulkReassignBar() {
  const bar = document.getElementById('bulk-reassign-bar');
  if (!bar) return;
  const count = document.querySelectorAll('.txn-bulk-chk:checked').length;
  bar.style.display = count > 0 ? 'inline-flex' : 'none';
  const countEl = document.getElementById('bulk-reassign-count');
  if (countEl) countEl.textContent = `${count} sélectionnée(s)`;
}

function openBulkReassignModal() {
  const ids = [...document.querySelectorAll('.txn-bulk-chk:checked')].map(chk => chk.value);
  if (!ids.length) { Toast.error('Sélectionnez au moins une commande.'); return; }
  _bulkReassignIds = ids;

  const select = document.getElementById('bulk-reassign-cabine-select');
  const cabs = DB.users.byRole('cabine').filter(c => c.statut === 'actif');
  select.innerHTML = cabs.length
    ? cabs.map(c => `<option value="${c.id}">${c.prenom} ${c.nom} (${c.cabine_nom || c.zone || 'N/A'})</option>`).join('')
    : `<option value="">Aucune cabine active disponible</option>`;

  document.getElementById('bulk-reassign-summary').textContent = `${ids.length} commande(s) sélectionnée(s) seront réassignées vers la cabine choisie.`;
  openModal('modal-bulk-reassign');
}

let _bulkReassignIds = [];

async function confirmBulkReassign() {
  const newCabineId = document.getElementById('bulk-reassign-cabine-select').value;
  if (!newCabineId) { Toast.error('Sélectionnez une cabine.'); return; }

  const res = await DB.business.bulkReassign(_bulkReassignIds, newCabineId);
  closeModal('modal-bulk-reassign');
  Toast.success(`${res.okCount} réassignée(s)${res.failCount ? `, ${res.failCount} échec(s)` : ''}.`);
  loadTransactions();
  loadCabines();
}

function searchTransactions() {
  const q = document.getElementById('admin-txn-search').value.trim();
  const s = document.getElementById('admin-txn-status').value;
  _adminResume.filters.transactions = { q, status: s };
  _saveAdminResume();
  loadTransactions(q, s);
}

/* ── Réassignation d'une commande (en attente uniquement) ─────────── */
let _reassignTxnId = null;

function openReassignModal(txnId) {
  const txn = DB.transactions.byId(txnId);
  if (!txn) return;
  _reassignTxnId = txnId;

  const select = document.getElementById('reassign-cabine-select');
  const cabs = DB.users.byRole('cabine').filter(c => c.statut === 'actif' && c.id !== txn.cabine_id);
  if (!cabs.length) {
    select.innerHTML = `<option value="">Aucune autre cabine active disponible</option>`;
  } else {
    select.innerHTML = cabs.map(c => `<option value="${c.id}">${c.prenom} ${c.nom} (${c.zone || 'N/A'})</option>`).join('');
  }
  openModal('modal-reassign-txn');
}

async function confirmReassign() {
  const newCabineId = document.getElementById('reassign-cabine-select').value;
  if (!newCabineId) { Toast.error('Sélectionnez une cabine.'); return; }
  const res = await DB.business.reassignTransaction(_reassignTxnId, newCabineId);
  if (!res.ok) { Toast.error(res.error); return; }
  Toast.success('Commande réassignée.');
  closeModal('modal-reassign-txn');
  loadTransactions();
  loadCabines();
}

/* ── Remboursement d'une commande (en attente ou terminée) ─────────── */
async function refundTxn(txnId) {
  if (!confirm('Rembourser le client pour cette commande ?')) return;
  const res = await DB.business.refundTransaction(txnId);
  if (!res.ok) { Toast.error(res.error); return; }
  Toast.success('Commande remboursée au client.');
  loadTransactions();
  loadClients();
  loadCabines();
  loadDashboard();
}

/* ── Demandes de remboursement (soumises par une cabine suite à une
   réclamation reconnue — voir DB.refundRequests dans js/db.js) ─────── */
function loadRefundRequests() {
  _renderRefundRequests();
  DB.refundRequests.refresh().then(_renderRefundRequests);
}

function _renderRefundRequests() {
  const list  = DB.refundRequests.all();
  const el    = document.getElementById('refund-admin-list');
  const badge = document.getElementById('refund-badge');
  if (!el) return;

  const pending = list.filter(r => r.statut === 'en_attente').length;
  if (badge) { badge.textContent = pending; badge.style.display = pending > 0 ? 'inline-flex' : 'none'; }

  if (list.length === 0) {
    el.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:.8rem;">
      <i class="fa-solid fa-check-circle" style="font-size:2rem;color:var(--success);display:block;margin-bottom:10px;"></i>
      Aucune demande de remboursement en cours.
    </div>`;
    return;
  }

  const sorted = [...list].sort((a, b) => new Date(b.date_created) - new Date(a.date_created));
  el.innerHTML = sorted.map(r => {
    const isPending = r.statut === 'en_attente';
    const txn     = DB.transactions.byId(r.transaction_id);
    const cabine  = DB.users.byId(r.cabine_id);
    const client  = DB.users.byId(r.client_id);
    const dateStr = new Date(r.date_created).toLocaleString('fr-CI', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
    const badgeHtml = isPending
      ? `<span class="badge badge-pending"><i class="fa-solid fa-clock"></i> En attente</span>`
      : `<span class="badge badge-success"><i class="fa-solid fa-check"></i> Traité</span>`;
    const actions = isPending ? `
      <button class="btn btn-sm btn-danger" onclick="adminProcessRefund('${r.id}')" style="font-size:.62rem;padding:5px 12px;">
        <i class="fa-solid fa-rotate-left"></i> Rembourser
      </button>` : '';
    return `<div class="rst-admin-row">
      <div class="rst-admin-info">
        <div class="rst-admin-name"><i class="fa-solid fa-receipt"></i> Commande ${Fmt.ref(r.transaction_id)}${txn ? ` · ${Fmt.money(txn.montant)}` : ''}</div>
        <div class="rst-admin-meta"><i class="fa-solid fa-store"></i> ${cabine ? `${cabine.prenom} ${cabine.nom}` : '—'} · <i class="fa-solid fa-user"></i> ${client ? `${client.prenom} ${client.nom}` : '—'}</div>
        <div class="rst-admin-meta" style="font-style:italic;">"${r.motif}"</div>
        <div class="rst-admin-date"><i class="fa-regular fa-clock"></i> ${dateStr}</div>
      </div>
      <div class="rst-admin-actions">
        ${badgeHtml}
        <div style="display:flex;gap:6px;margin-top:6px;">${actions}</div>
      </div>
    </div>`;
  }).join('');
}

/* ── Discussion client-cabine (supervision, lecture seule) ────────────
   Liste toutes les réclamations (DB.reclamations) tous clients/cabines
   confondus, avec accès au fil complet de chacune — voir
   renderRclHubThread() dans js/client.js pour le patron de rendu côté
   client (repris ici en lecture seule, sans les boutons de réponse). */
function loadDiscussionsAdmin() {
  _renderDiscussionsAdmin();
  DB.reclamations.refresh().then(_renderDiscussionsAdmin);
}

function _renderDiscussionsAdmin() {
  const list = DB.reclamations.all();
  const el   = document.getElementById('discussions-admin-list');
  if (!el) return;

  if (!list.length) {
    el.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:.8rem;">
      <i class="fa-solid fa-comments" style="font-size:2rem;color:var(--gray-300);display:block;margin-bottom:10px;"></i>
      Aucune discussion pour le moment.
    </div>`;
    return;
  }

  const sorted = [...list].sort((a, b) => new Date(b.date_created) - new Date(a.date_created));
  el.innerHTML = sorted.map(r => {
    const client = DB.users.byId(r.client_id);
    const cabine = DB.users.byId(r.cabine_id);
    const dateStr = new Date(r.date_created).toLocaleString('fr-CI', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
    const statutLbl = r.statut === 'en_attente' ? 'En attente' : r.statut === 'résolue' ? 'Résolue'
      : r.statut === 'remboursement_demande' ? 'Remboursement en cours' : r.statut === 'remboursée' ? 'Remboursée' : r.statut;
    const nbMsg = (r.messages || []).length;
    return `<div class="rst-admin-row">
      <div class="rst-admin-info">
        <div class="rst-admin-name"><i class="fa-solid fa-user"></i> ${client ? client.prenom + ' ' + client.nom : 'Client inconnu'} <i class="fa-solid fa-arrow-right-arrow-left" style="font-size:.6rem;color:var(--gray-400);"></i> ${cabine ? (cabine.cabine_nom || cabine.prenom + ' ' + cabine.nom) : 'Cabine inconnue'}</div>
        <div class="rst-admin-meta"><i class="fa-solid fa-receipt"></i> ${Fmt.ref(r.transaction_id)} — ${statutLbl} — ${nbMsg} message(s)</div>
        <div class="rst-admin-date"><i class="fa-regular fa-clock"></i> ${dateStr}</div>
      </div>
      <div class="rst-admin-actions">
        <button class="btn btn-sm btn-ghost" onclick="openAdminReclaThread('${r.id}')" title="Voir la discussion"><i class="fa-solid fa-eye"></i></button>
      </div>
    </div>`;
  }).join('');
}

function openAdminReclaThread(id) {
  const r = DB.reclamations.all().find(x => x.id === id);
  if (!r) return;
  const client = DB.users.byId(r.client_id);
  const cabine = DB.users.byId(r.cabine_id);
  const statutLbl = r.statut === 'en_attente' ? 'En attente' : r.statut === 'résolue' ? 'Résolue'
    : r.statut === 'remboursement_demande' ? 'Remboursement en cours' : r.statut === 'remboursée' ? 'Remboursée' : r.statut;

  const metaEl = document.getElementById('admin-recla-thread-meta');
  if (metaEl) metaEl.innerHTML = `
    <div style="font-size:.75rem;color:var(--gray-500);">
      <strong>${client ? client.prenom + ' ' + client.nom : 'Client inconnu'}</strong> ↔
      <strong>${cabine ? (cabine.cabine_nom || cabine.prenom + ' ' + cabine.nom) : 'Cabine inconnue'}</strong>
      — commande ${Fmt.ref(r.transaction_id)} — ${statutLbl}
      ${r.relances_apres_preuve ? ` — ${r.relances_apres_preuve} relance(s) après preuve` : ''}
    </div>`;

  const bodyEl = document.getElementById('admin-recla-thread-body');
  if (bodyEl) {
    bodyEl.innerHTML = (r.messages || []).map(m => {
      const content = m.type === 'image'
        ? `<img src="${m.image}" class="rh-thread-img" onclick="window.open('${m.image}','_blank')" alt="Capture">`
        : m.texte;
      if (m.sender === 'client') {
        return `<div class="rh-msg-row user"><div class="rh-msg-bubble">${content}</div></div>`;
      }
      return `<div class="rh-msg-row">
        <div class="rh-msg-avatar"><i class="fa-solid fa-store"></i></div>
        <div class="rh-msg-bubble">${content}</div>
      </div>`;
    }).join('');
  }

  openModal('modal-admin-recla-thread');
}

/* ── Journal des accès (impersonation admin) ─────────────────────────
   Lecture seule — voir Auth.startImpersonation() dans js/auth.js et
   DB.accessLogs dans js/db.js. Cache local affiché immédiatement, puis
   resynchronisé depuis le serveur (partagé entre tous les
   administrateurs, pas seulement celui qui a effectué l'accès sur cet
   appareil). */
function loadAccessLogs() {
  _renderAccessLogs();
  DB.accessLogs.refresh().then(_renderAccessLogs);
}

function _renderAccessLogs() {
  const list = DB.accessLogs.all();
  const el   = document.getElementById('access-logs-list');
  if (!el) return;

  if (list.length === 0) {
    el.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:.8rem;">
      <i class="fa-solid fa-shield-halved" style="font-size:2rem;color:var(--gray-300);display:block;margin-bottom:10px;"></i>
      Aucun accès journalisé pour le moment.
    </div>`;
    return;
  }

  const sorted = [...list].sort((a, b) => new Date(b.date) - new Date(a.date));
  el.innerHTML = sorted.map(l => {
    const dateStr = new Date(l.date).toLocaleString('fr-CI', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
    const roleLbl = l.target_role === 'cabine' ? 'Espace partenaire' : l.target_role === 'admin' ? 'Espace administrateur' : 'Espace client';
    return `<div class="rst-admin-row">
      <div class="rst-admin-info">
        <div class="rst-admin-name"><i class="fa-solid fa-user-shield"></i> ${l.admin_name || '—'}</div>
        <div class="rst-admin-meta"><i class="fa-solid fa-right-to-bracket"></i> ${roleLbl} — ${l.target_name || '—'}</div>
        <div class="rst-admin-date"><i class="fa-regular fa-clock"></i> ${dateStr}</div>
      </div>
      <div class="rst-admin-actions">
        <span class="badge" style="background:rgba(146,64,14,.1);color:#92400E;"><i class="fa-solid fa-key"></i> Sans mot de passe</span>
      </div>
    </div>`;
  }).join('');
}

async function loadReabonnementCabine() {
  const el = document.getElementById('reabonnement-cabine-list');
  if (!el) return;
  await DB.resubscriptions.refresh();
  const list = DB.resubscriptions.all();

  if (list.length === 0) {
    el.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:.8rem;">
      <i class="fa-solid fa-rotate" style="font-size:2rem;color:var(--gray-300);display:block;margin-bottom:10px;"></i>
      Aucun réabonnement pour le moment.
    </div>`;
    return;
  }

  const sorted = [...list].sort((a, b) => new Date(b.date) - new Date(a.date));
  el.innerHTML = sorted.map(r => {
    const cab = DB.users.byId(r.cabine_id);
    const dateStr = new Date(r.date).toLocaleString('fr-CI', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
    return `<div class="rst-admin-row">
      <div class="rst-admin-info">
        <div class="rst-admin-name"><i class="fa-solid fa-store"></i> ${cab ? (cab.cabine_nom || cab.prenom + ' ' + cab.nom) : 'Cabine supprimée'}</div>
        <div class="rst-admin-meta"><i class="fa-solid fa-rotate"></i> Formule ${r.formule} — ${r.prix.toLocaleString()} FCFA</div>
        <div class="rst-admin-date"><i class="fa-regular fa-clock"></i> ${dateStr}</div>
      </div>
      ${cab ? `<div class="rst-admin-actions" style="flex-direction:row;gap:6px;">
        <button class="ztA-copy" onclick="adminContactWhatsapp('${cab.whatsapp || cab.telephone}','${cab.prenom}')" title="Contacter via WhatsApp"><i class="fa-brands fa-whatsapp"></i></button>
        <button class="ztA-copy" onclick="adminCallPhone('${cab.telephone}')" title="Appeler"><i class="fa-solid fa-phone"></i></button>
      </div>` : ''}
    </div>`;
  }).join('');
}

async function adminProcessRefund(requestId) {
  if (!confirm('Valider ce remboursement ? Le client sera recrédité et la commande passera au statut "Remboursé".')) return;
  const res = await DB.business.processRefundRequest(requestId, currentUser.id);
  if (!res.ok) { Toast.error(res.error); return; }
  Toast.success('Remboursement validé et notifié.');
  loadRefundRequests();
  loadTransactions();
  loadClients();
  loadCabines();
  loadDashboard();
}

/* ── Suspension d'une commande (motif obligatoire) ─────────────────── */
let _suspendTxnId = null;

function openSuspendModal(txnId) {
  _suspendTxnId = txnId;
  document.getElementById('suspend-motif').value = '';
  document.getElementById('suspend-motif-error').style.display = 'none';
  openModal('modal-suspend-txn');
}

async function confirmSuspend() {
  const motifEl  = document.getElementById('suspend-motif');
  const errorEl  = document.getElementById('suspend-motif-error');
  const motif    = motifEl.value.trim();
  if (!motif) { errorEl.style.display = 'block'; motifEl.focus(); return; }
  errorEl.style.display = 'none';

  const res = await DB.business.suspendTransaction(_suspendTxnId, motif);
  if (!res.ok) { Toast.error(res.error); return; }
  Toast.success('Commande suspendue.');
  closeModal('modal-suspend-txn');
  loadTransactions();
  loadCabines();
}

async function reactivateTxn(txnId) {
  if (!confirm('Réactiver cette commande ?')) return;
  const res = await DB.business.reactivateTransaction(txnId);
  if (!res.ok) { Toast.error(res.error); return; }
  Toast.success('Commande réactivée.');
  loadTransactions();
  loadCabines();
}

/* Super admin uniquement — voir api/orders_delete.php (bloqué côté serveur
   pour une commande 'terminé', la rembourser d'abord). */
async function deleteTxn(txnId) {
  if (currentUser.admin_level !== 'super') { Toast.error('Seul le super administrateur peut supprimer une commande.'); return; }
  if (!confirm('Supprimer définitivement cette commande ? Cette action est irréversible et effacera aussi sa réclamation éventuelle.')) return;
  const res = await DB.business.deleteTransaction(txnId);
  if (!res.ok) { Toast.error(res.error); return; }
  Toast.success('Commande supprimée.');
  loadTransactions();
  loadCabines();
}

/* â”€â”€ Commission settings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function loadCommissionsAdmin() {
  _renderCommissionsAdmin();
  DB.commissions.refresh().then(_renderCommissionsAdmin);
}

function _renderCommissionsAdmin() {
  const rule = DB.commissions.active();
  document.getElementById('comm-rate-input').value = rule.pourcentage;
  const tbody = document.getElementById('admin-comm-tbody');
  if (!tbody) return;
  tbody.innerHTML = DB.commissions.all().map(c => `
    <tr>
      <td>${c.label}</td>
      <td><strong>${c.pourcentage}%</strong></td>
      <td>${c.actif ? '<span class="badge badge-success">Actif</span>' : '<span class="badge badge-pending">Inactif</span>'}</td>
      <td>${Fmt.date(c.date)}</td>
    </tr>`).join('');
}

async function saveCommissionRate(e) {
  e.preventDefault();
  const rate = parseFloat(document.getElementById('comm-rate-input').value);
  if (isNaN(rate) || rate < 0 || rate > 50) { Toast.error('Taux invalide (0–50%).'); return; }
  const res = await DB.commissions.updateRate(rate);
  if (!res.ok) { Toast.error(res.error); return; }
  Toast.success(`Taux de commission mis à jour à ${rate}%.`);
  loadCommissionsAdmin();
  loadDashboard();
}

/* â”€â”€ User management â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
/* Tout administrateur (super ou simple) peut consulter — en lecture
   seule — son propre profil, cliquable depuis le bloc identité de la
   barre latérale. Réutilise viewUser(), dont le garde-fou autorise déjà
   la consultation de son propre compte. */
function viewOwnAdminProfile() {
  viewUser(currentUser.id);
}

/* Changement rapide de la photo de profil du super admin, directement
   depuis la carte "Détails du compte" (icône appareil photo sur
   l'avatar) — sans passer par le formulaire complet d'édition. */
function quickSetOwnAdminPhoto(input) {
  const file = input.files[0];
  if (!file) return;
  adminReadFileAsDataUrl(file).then(async (photoUrl) => {
    // Persisté côté serveur (voir api/admin_update_profile.php) — sans ça,
    // la photo restait locale à l'appareil et disparaissait sur un autre
    // appareil connecté au même compte.
    const res = await ServerAPI.adminUpdateProfile({ id: currentUser.id, photo: photoUrl });
    if (!res.ok) { Toast.error(res.error || 'Échec de l\'enregistrement de la photo.'); return; }
    DB.users.update(currentUser.id, { photo: photoUrl });
    currentUser = Auth.refresh();
    Toast.success('Photo de profil mise à jour.');
    viewOwnAdminProfile();
  });
}

/* Accès direct sans mot de passe à l'espace cabine/client d'un compte —
   voir Auth.startImpersonation() dans js/auth.js (journalisé dans
   DB.accessLogs, onglet admin "Journal des accès"). */
function impersonateUser(id, name) {
  if (!confirm(`Se connecter directement en tant que ${name}, sans mot de passe ? Cet accès sera journalisé.`)) return;
  const res = Auth.startImpersonation(id);
  if (!res.ok) { Toast.error(res.error); return; }
  window.location.href = res.role === 'cabine' ? 'cabine.html' : res.role === 'admin' ? 'admin.html' : 'client.html';
}

/* ── Bandeau impersonation (super admin → administrateur simple) ──────
   La cible reste sur admin.html (juste sous une autre session) — même
   principe que le bandeau déjà présent dans cabine.html/client.html
   (voir _refreshImpersonationBanner()/returnFromImpersonation() dans
   js/cabine.js) pour les cas admin → partenaire/client. */
function _refreshImpersonationBanner() {
  const banner = document.getElementById('impersonation-banner');
  if (!banner) return;
  if (!Auth.isImpersonating()) { banner.style.display = 'none'; return; }
  const info = Auth.impersonationInfo();
  const nameEl = document.getElementById('impersonation-admin-name');
  if (nameEl) nameEl.textContent = info?.admin_name || 'un administrateur';
  banner.style.display = 'flex';
}

function returnFromImpersonation() {
  const restored = Auth.endImpersonation();
  if (!restored) return;
  // On est déjà sur admin.html : un rechargement suffit à réinitialiser
  // currentUser et tout l'état affiché avec la session restaurée (qui
  // peut elle-même être un niveau intermédiaire de la pile, voir
  // Auth.endImpersonation() dans js/auth.js).
  window.location.reload();
}

/* Ouvre une conversation WhatsApp (click-to-chat) avec un numéro donné —
   voir Fmt.whatsappLink() dans js/auth.js pour la normalisation du numéro.
   Prend directement un numéro (pas un id) pour rester utilisable aussi
   bien pour un compte DB.users que pour une candidature partenaire pas
   encore transformée en compte (voir cbp_applications ci-dessous). */
function adminContactWhatsapp(phone, prenom) {
  const link = Fmt.whatsappLink(phone, `Bonjour ${prenom || ''}, ici l'administration KBINE PLUS.`);
  if (!link) { Toast.error('Aucun numéro de téléphone enregistré.'); return; }
  window.open(link, '_blank');
}

/* Déclenche un appel direct (tel:) vers un numéro donné — même patron
   que adminContactWhatsapp(), prend directement un numéro pour rester
   utilisable même sans compte DB.users complet. */
function adminCallPhone(phone) {
  const digits = (phone || '').toString().replace(/\D/g, '');
  if (!digits) { Toast.error('Aucun numéro de téléphone enregistré.'); return; }
  window.location.href = 'tel:' + digits;
}

function viewUser(id) {
  const u = DB.users.byId(id);
  if (!u) return;

  // Consulter le profil d'UN AUTRE administrateur est un droit exclusif du
  // super admin. Un admin simple peut consulter (en lecture seule — aucun
  // bouton "Modifier" n'existe sur cette vue, quel que soit qui la consulte)
  // uniquement son propre profil ; le profil du super admin, lui, n'est
  // jamais visible par personne d'autre que lui-même.
  if (u.role === 'admin' && currentUser.admin_level !== 'super' && u.id !== currentUser.id) {
    Toast.error('Seul le super administrateur peut consulter le profil d\'un autre administrateur.');
    return;
  }

  if (u.role === 'admin') {
    const avatarInner = u.photo
      ? `<img src="${u.photo}" alt="">`
      : Fmt.initials(u.nom, u.prenom);
    const localisation = [u.quartier, u.ville, u.pays].filter(Boolean).join(', ');
    const isSelf = u.id === currentUser.id;
    const isSelfSuper = u.admin_level === 'super' && isSelf;
    document.getElementById('modal-user-content').innerHTML = `
      <div class="profile-dark-card">
        <div class="profile-dark-avatar-wrap">
          <div class="profile-dark-avatar">${avatarInner}</div>
          ${isSelfSuper ? `
          <label class="profile-photo-btn" title="Changer la photo de profil">
            <i class="fa-solid fa-camera"></i>
            <input type="file" accept="image/*" style="display:none" onchange="quickSetOwnAdminPhoto(this)">
          </label>` : ''}
        </div>
        <div class="profile-dark-name">${u.prenom} ${u.nom}</div>
        <div class="profile-dark-email">${u.email}</div>
        <span class="profile-dark-badge"><i class="fa-solid fa-shield-halved"></i> ${u.admin_level === 'super' ? 'Super administrateur' : 'Administrateur simple'}</span>
        <div class="profile-dark-list">
          <div class="profile-dark-row"><div class="ico"><i class="fa-solid fa-briefcase"></i></div><div><div class="k">Poste</div><div class="v${u.poste ? '' : ' dim'}">${u.poste || '—'}</div></div></div>
          <div class="profile-dark-row"><div class="ico"><i class="fa-solid fa-phone"></i></div><div><div class="k">Téléphone</div><div class="v">${Fmt.phone(u.telephone)}</div></div></div>
          <div class="profile-dark-row"><div class="ico"><i class="fa-brands fa-whatsapp"></i></div><div><div class="k">WhatsApp</div><div class="v${u.whatsapp ? '' : ' dim'}">${Fmt.phone(u.whatsapp) || '—'}</div></div></div>
          <div class="profile-dark-row"><div class="ico"><i class="fa-solid fa-cake-candles"></i></div><div><div class="k">Date de naissance</div><div class="v${u.date_naissance ? '' : ' dim'}">${u.date_naissance ? Fmt.date(u.date_naissance) : '—'}</div></div></div>
          <div class="profile-dark-row"><div class="ico"><i class="fa-solid fa-lock"></i></div><div><div class="k">Permissions</div><div class="v">${u.admin_level === 'super' ? 'Toutes' : `${(u.permissions||[]).length} section(s)`}</div></div></div>
          <div class="profile-dark-row"><div class="ico"><i class="fa-solid fa-calendar-check"></i></div><div><div class="k">Membre depuis</div><div class="v">${Fmt.date(u.date_creation)}</div></div></div>
          <div class="profile-dark-row"><div class="ico"><i class="fa-solid fa-location-dot"></i></div><div><div class="k">Localisation</div><div class="v${localisation ? '' : ' dim'}">${localisation || '—'}</div></div></div>
          <div class="profile-dark-row"><div class="ico"><i class="fa-solid fa-circle-check"></i></div><div><div class="k">Statut</div><div class="v${u.statut === 'actif' ? ' status-active' : ''}">${u.statut}</div></div></div>
        </div>
        ${isSelfSuper ? `
        <button class="profile-dark-edit-btn" onclick="closeModal('modal-view-user');openEditAdminProfileModal('${u.id}')">
          <i class="fa-solid fa-pen"></i> Modifier mon profil
        </button>` : ''}
      </div>`;
    openModal('modal-view-user');
    return;
  }

  const txns = u.role === 'client' ? DB.transactions.byClient(id) : DB.transactions.byCabine(id);
  const done = txns.filter(t => t.statut === 'terminé');
  document.getElementById('modal-user-content').innerHTML = `
    <div style="text-align:center;margin-bottom:20px;">
      <div style="width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,var(--primary),var(--secondary));display:flex;align-items:center;justify-content:center;font-size:1.5rem;font-weight:800;color:#fff;margin:0 auto 12px;">${Fmt.initials(u.nom,u.prenom)}</div>
      <div style="font-size:1.1rem;font-weight:700;">${u.prenom} ${u.nom}</div>
      <div style="font-size:.8rem;color:var(--gray-500)">${u.email}</div>
    </div>
    <div class="stat-mini"><span class="stat-mini-label">Rôle</span><span class="stat-mini-val">${u.role}</span></div>
    <div class="stat-mini"><span class="stat-mini-label">Téléphone</span><span class="stat-mini-val">${Fmt.phone(u.telephone)}</span></div>
    <div class="stat-mini"><span class="stat-mini-label">Solde</span><span class="stat-mini-val">${Fmt.money(DB.business.cabineSoldeDisponible(u))}</span></div>
    <div class="stat-mini"><span class="stat-mini-label">Statut</span><span class="stat-mini-val">${u.statut}</span></div>
    <div class="stat-mini"><span class="stat-mini-label">Transactions</span><span class="stat-mini-val">${txns.length}</span></div>
    <div class="stat-mini"><span class="stat-mini-label">Volume</span><span class="stat-mini-val">${Fmt.money(done.reduce((s,t)=>s+t.montant,0))}</span></div>
    ${u.role === 'cabine' ? `<div class="stat-mini"><span class="stat-mini-label">Commissions</span><span class="stat-mini-val" style="color:var(--secondary)">${Fmt.money(u.commissions_total||0)}</span></div>` : ''}
    ${u.role === 'cabine' ? `<div class="stat-mini"><span class="stat-mini-label">Limite de commandes</span><span class="stat-mini-val">${u.limite_commandes ? u.limite_commandes : 'Aucune'}</span></div>` : ''}
    <div class="stat-mini"><span class="stat-mini-label">Membre depuis</span><span class="stat-mini-val">${Fmt.date(u.date_creation)}</span></div>
    <button class="btn btn-sm btn-full" style="margin-top:14px;background:#25D36622;color:#25D366;" onclick="adminContactWhatsapp('${u.telephone}','${u.prenom}')">
      <i class="fa-brands fa-whatsapp"></i> Contacter via WhatsApp
    </button>
    <button class="btn btn-secondary btn-sm btn-full" style="margin-top:8px;" onclick="editUserForm('${u.id}')">
      <i class="fa-solid fa-pen"></i> Modifier le compte
    </button>`;
  openModal('modal-view-user');
}

/* Édition d'un compte (solde + coordonnées), client ou cabine */
function editUserForm(id) {
  const u = DB.users.byId(id);
  if (!u) return;
  document.getElementById('modal-user-content').innerHTML = `
    <div class="form-group">
      <label class="form-label">Prénom</label>
      <input class="form-control" id="edit-user-prenom" value="${u.prenom || ''}">
    </div>
    <div class="form-group">
      <label class="form-label">Nom</label>
      <input class="form-control" id="edit-user-nom" value="${u.nom || ''}">
    </div>
    <div class="form-group">
      <label class="form-label">Téléphone</label>
      <input class="form-control" id="edit-user-telephone" value="${Fmt.phone(u.telephone)}" oninput="formatPhoneInput(this)">
    </div>
    <div class="form-group">
      <label class="form-label">Email</label>
      <input class="form-control" id="edit-user-email" value="${u.email || ''}">
    </div>
    <div class="form-group">
      <label class="form-label">Solde (F)</label>
      <input class="form-control" type="number" id="edit-user-solde" value="${u.solde || 0}">
    </div>
    ${u.role === 'cabine' ? `
    <div class="form-group">
      <label class="form-label">Limite de commandes simultanées</label>
      <input class="form-control" type="number" min="0" id="edit-user-limite" value="${u.limite_commandes || ''}" placeholder="Aucune limite">
      <div style="font-size:.68rem;color:var(--gray-500);margin-top:4px;">Laisser vide ou 0 = pas de limite. Au-delà, cette cabine ne recevra plus de nouvelles commandes.</div>
    </div>
    <div class="form-group" style="border-top:1px solid var(--gray-100);padding-top:10px;">
      <label class="form-label" style="font-weight:700;">Renseignements de partenariat</label>
      <div style="font-size:.68rem;color:var(--gray-500);margin-bottom:8px;">Enregistrés à l'inscription — la cabine peut aussi les modifier elle-même.</div>
    </div>
    <div class="form-group">
      <label class="form-label">Années d'expérience</label>
      <select class="form-control" id="edit-user-exp">
        <option value="" ${!u.experience ? 'selected' : ''}>— Sélectionnez —</option>
        <option value="Moins d'1 an" ${u.experience === "Moins d'1 an" ? 'selected' : ''}>Moins d'1 an</option>
        <option value="1 à 3 ans" ${u.experience === '1 à 3 ans' ? 'selected' : ''}>1 à 3 ans</option>
        <option value="3 à 5 ans" ${u.experience === '3 à 5 ans' ? 'selected' : ''}>3 à 5 ans</option>
        <option value="Plus de 5 ans" ${u.experience === 'Plus de 5 ans' ? 'selected' : ''}>Plus de 5 ans</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Motivation</label>
      <textarea class="form-control" id="edit-user-motivation" rows="3">${u.motivation || ''}</textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Puces téléphoniques disponibles</label>
      <div style="display:flex;gap:8px;">
        <input class="form-control" type="number" min="0" id="edit-user-puce-orange" placeholder="Orange" value="${(u.puces && u.puces.orange) || 0}">
        <input class="form-control" type="number" min="0" id="edit-user-puce-mtn" placeholder="MTN" value="${(u.puces && u.puces.mtn) || 0}">
        <input class="form-control" type="number" min="0" id="edit-user-puce-moov" placeholder="Moov" value="${(u.puces && u.puces.moov) || 0}">
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Paiement de l'abonnement via</label>
      <select class="form-control" id="edit-user-paiement-abo">
        <option value="" ${!u.paiement_abo ? 'selected' : ''}>— Sélectionnez —</option>
        <option value="Orange Money" ${u.paiement_abo === 'Orange Money' ? 'selected' : ''}>Orange Money</option>
        <option value="MTN MoMo" ${u.paiement_abo === 'MTN MoMo' ? 'selected' : ''}>MTN MoMo</option>
        <option value="Moov Money" ${u.paiement_abo === 'Moov Money' ? 'selected' : ''}>Moov Money</option>
        <option value="Wave" ${u.paiement_abo === 'Wave' ? 'selected' : ''}>Wave</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Réception des versements via</label>
      <select class="form-control" id="edit-user-paiement-vers">
        <option value="" ${!u.paiement_vers ? 'selected' : ''}>— Sélectionnez —</option>
        <option value="Orange Money" ${u.paiement_vers === 'Orange Money' ? 'selected' : ''}>Orange Money</option>
        <option value="MTN MoMo" ${u.paiement_vers === 'MTN MoMo' ? 'selected' : ''}>MTN MoMo</option>
        <option value="Moov Money" ${u.paiement_vers === 'Moov Money' ? 'selected' : ''}>Moov Money</option>
        <option value="Djamo" ${u.paiement_vers === 'Djamo' ? 'selected' : ''}>Djamo</option>
        <option value="Wave Business" ${u.paiement_vers === 'Wave Business' ? 'selected' : ''}>Wave Business</option>
        <option value="Wave Normal" ${u.paiement_vers === 'Wave Normal' ? 'selected' : ''}>Wave Normal</option>
        <option value="Compte bancaire" ${u.paiement_vers === 'Compte bancaire' ? 'selected' : ''}>Compte bancaire</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Numéro de compte de réception</label>
      <input class="form-control" id="edit-user-numero-compte" value="${u.numero_compte || ''}">
    </div>` : ''}
    ${u.role === 'cabine' && currentUser.admin_level === 'super' ? `
    <div class="form-group" style="border:1px dashed var(--primary);border-radius:10px;padding:10px;">
      <label class="form-label"><i class="fa-solid fa-crown" style="color:var(--primary)"></i> Formule d'abonnement (super admin)</label>
      <div style="font-size:.68rem;color:var(--gray-500);margin-bottom:8px;">Formule actuelle : <strong>${u.abonnement || 'Premium'}</strong> — ce changement contourne le quota (droit de veto).</div>
      <div style="display:flex;gap:8px;">
        <select class="form-control" id="edit-cabine-abonnement">
          <option value="Premium" ${u.abonnement === 'Premium' ? 'selected' : ''}>Premium</option>
          <option value="VIP" ${u.abonnement === 'VIP' ? 'selected' : ''}>VIP</option>
          <option value="VVIP" ${u.abonnement === 'VVIP' ? 'selected' : ''}>VVIP</option>
        </select>
        <button type="button" class="btn btn-secondary btn-sm" onclick="adminChangeAbonnementCabine('${u.id}')">
          <i class="fa-solid fa-bolt"></i> Changer instantanément
        </button>
      </div>
    </div>` : ''}
    <div style="display:flex;gap:8px;margin-top:8px;">
      <button class="btn btn-ghost btn-sm" style="flex:1;" onclick="viewUser('${u.id}')">Annuler</button>
      <button class="btn btn-primary btn-sm" style="flex:1;" onclick="saveUserEdits('${u.id}')">
        <i class="fa-solid fa-floppy-disk"></i> Enregistrer
      </button>
    </div>`;
}

/* Droit de veto du super admin : change instantanément la formule d'une
   cabine sans passer par le flux self-service (aucun débit de solde,
   aucune vérification de quota) — voir business.adminSetCabineAbonnement
   dans js/db.js. */
async function adminChangeAbonnementCabine(cabineId) {
  if (currentUser.admin_level !== 'super') { Toast.error('Seul le super administrateur peut effectuer ce changement.'); return; }
  const formule = document.getElementById('edit-cabine-abonnement').value;
  if (!confirm(`Changer instantanément la formule de ce cabiniste en ${formule} ? Cette action contourne le quota en cours.`)) return;

  const res = await DB.business.adminSetCabineAbonnement(cabineId, formule);
  if (!res.ok) { Toast.error(res.error); return; }

  Toast.success(`Formule changée en ${formule}.`);
  editUserForm(cabineId);
  loadCabines();
}

async function saveUserEdits(id) {
  const u = DB.users.byId(id);
  if (!u) return;

  const prenom    = document.getElementById('edit-user-prenom').value.trim();
  const nom       = document.getElementById('edit-user-nom').value.trim();
  const telephone = document.getElementById('edit-user-telephone').value.replace(/\D/g, '');
  const email     = document.getElementById('edit-user-email').value.trim();
  const nouveauSolde = parseFloat(document.getElementById('edit-user-solde').value);

  if (!prenom || !telephone) { Toast.error('Prénom et téléphone sont obligatoires.'); return; }
  if (isNaN(nouveauSolde) || nouveauSolde < 0) { Toast.error('Solde invalide.'); return; }

  const existing = DB.users.byPhoneAndRole(telephone, u.role);
  if (existing && existing.id !== id) { Toast.error('Ce numéro est déjà utilisé par un autre compte de ce type.'); return; }

  const updates = { prenom, nom, telephone, email };
  let limite;
  if (u.role === 'cabine') {
    const limiteEl = document.getElementById('edit-user-limite');
    limite = limiteEl ? parseInt(limiteEl.value) : 0;
    updates.limite_commandes = isNaN(limite) || limite <= 0 ? null : limite;

    updates.experience    = document.getElementById('edit-user-exp')?.value || '';
    updates.motivation    = document.getElementById('edit-user-motivation')?.value.trim() || '';
    updates.paiement_abo  = document.getElementById('edit-user-paiement-abo')?.value || '';
    updates.paiement_vers = document.getElementById('edit-user-paiement-vers')?.value || '';
    updates.numero_compte = document.getElementById('edit-user-numero-compte')?.value.trim() || '';
    updates.puces = {
      orange: parseInt(document.getElementById('edit-user-puce-orange')?.value) || 0,
      mtn:    parseInt(document.getElementById('edit-user-puce-mtn')?.value)    || 0,
      moov:   parseInt(document.getElementById('edit-user-puce-moov')?.value)   || 0,
    };
  }

  // Persisté côté serveur (voir api/admin_update_user.php) — sans ça, ce
  // formulaire ne modifiait que le cache local de l'admin qui cliquait
  // (jamais visible d'un autre appareil, ni conservé après rechargement).
  const res = await ServerAPI.adminUpdateUser({
    id, prenom, nom, telephone, email,
    limiteCommandes: u.role === 'cabine' ? updates.limite_commandes : undefined,
    nouveauSolde,
    experience: updates.experience, motivation: updates.motivation,
    paiementAbo: updates.paiement_abo, paiementVers: updates.paiement_vers,
    numeroCompte: updates.numero_compte, puces: updates.puces,
  });
  if (!res.ok) { Toast.error(res.error); return; }

  DB.users.update(id, { ...updates, solde: nouveauSolde });

  Toast.success(`Compte de ${prenom} ${nom} mis à jour.`);
  viewUser(id);
  loadClients();
  loadCabines();
  loadDashboard();
}

async function suspendUser(id, name) {
  if (!confirm(`Suspendre le compte de ${name} ?`)) return;
  // Persisté côté serveur (voir api/admin_set_account_status.php) — sans
  // ça, le compte restait pleinement fonctionnel malgré la suspension
  // affichée localement.
  const res = await ServerAPI.adminSetAccountStatus(id, 'suspendu');
  if (!res.ok) { Toast.error(res.error || 'Échec de la suspension.'); return; }
  DB.users.update(id, { statut: 'suspendu' });
  Toast.warning(`${name} suspendu.`);
  loadClients();
  loadDashboard();
}

async function activateUser(id, name) {
  const res = await ServerAPI.adminSetAccountStatus(id, 'actif');
  if (!res.ok) { Toast.error(res.error || 'Échec de la réactivation.'); return; }
  DB.users.update(id, { statut: 'actif', tentatives_echouees: 0 });
  Toast.success(`${name} réactivé.`);
  loadClients();
  loadDashboard();
}

async function toggleCabine(id, activate) {
  // Une suspension MANUELLE (suspendu_by non nul) ne peut être levée que
  // par l'administrateur qui l'a posée, ou par le super administrateur —
  // une suspension automatique (suspendu_by === null) reste débloquable
  // par n'importe quel admin (voir objectifs 6/7, DB.business.suspendCabineManually/Auto).
  // Revérifié aussi côté serveur (api/admin_set_account_status.php),
  // cette vérification locale n'est qu'un retour rapide à l'écran.
  if (activate) {
    const cab = DB.users.byId(id);
    if (cab && cab.statut === 'suspendu' && cab.suspendu_by && cab.suspendu_by !== currentUser.id && currentUser.admin_level !== 'super') {
      const byAdmin = DB.users.byId(cab.suspendu_by);
      const byName  = byAdmin ? `${byAdmin.prenom} ${byAdmin.nom}` : 'l\'administrateur à l\'origine';
      Toast.error(`Seul ${byName} ou le super administrateur peut débloquer ce compte.`);
      return;
    }
  }

  const wasSuspended = activate && DB.users.byId(id)?.statut === 'suspendu';

  // Persisté côté serveur (voir api/admin_set_account_status.php) — sans
  // ça, le moteur d'attribution des commandes (qui lit statut/en_pause
  // directement en base) ignorait totalement l'activation/désactivation.
  const res = await ServerAPI.adminSetAccountStatus(id, activate ? 'actif' : 'inactif');
  if (!res.ok) { Toast.error(res.error || 'Échec de l\'opération.'); return; }

  const updates = { statut: activate ? 'actif' : 'inactif' };
  // Un déblocage (manuel ou via "Activer") efface toujours les champs de
  // suspension (auto et manuelle), pour éviter qu'une expiration passée ne
  // réactive plus tard un compte que l'admin a explicitement bloqué.
  if (activate) { updates.suspendu_auto = false; updates.suspendu_by = null; updates.suspendu_motif = null; updates.suspendu_jusqu = null; updates.tentatives_echouees = 0; }
  DB.users.update(id, updates);
  if (wasSuspended) DB.suspensionLogs.close(id, currentUser.id);
  Toast.success(activate ? 'Cabine activée/débloquée.' : 'Cabine désactivée.');
  loadCabines();
  loadCabinesSuspenduesAdmin();
  loadDashboard();
}

/* Suspension manuelle indéfinie d'une cabine (motif obligatoire) — voir
   DB.business.suspendCabineManually(). Distincte de "Désactiver"
   (statut: 'inactif', réversible sans restriction) — voir toggleCabine(). */
let _suspendCabineId = null;

function openSuspendCabineModal(cabineId) {
  _suspendCabineId = cabineId;
  document.getElementById('suspend-cabine-motif').value = '';
  document.getElementById('suspend-cabine-motif-error').style.display = 'none';
  openModal('modal-suspend-cabine');
}

async function confirmSuspendCabine() {
  const motifEl = document.getElementById('suspend-cabine-motif');
  const errorEl = document.getElementById('suspend-cabine-motif-error');
  const motif   = motifEl.value.trim();
  if (!motif) { errorEl.style.display = 'block'; motifEl.focus(); return; }
  errorEl.style.display = 'none';

  const res = await DB.business.suspendCabineManually(_suspendCabineId, motif, currentUser.id);
  if (!res.ok) { Toast.error(res.error); return; }
  closeModal('modal-suspend-cabine');
  Toast.success('Cabine suspendue.');
  loadCabines();
  loadDashboard();
}

// Remplace le retrait purement local (DB.users.delete()), qui ne
// supprimait jamais rien côté serveur — le compte réapparaissait au
// prochain rafraîchissement (refreshUsersFromServer()). Réservé au super
// admin (voir api/admin_delete_account.php).
async function deleteUser(id, name) {
  if (currentUser.admin_level !== 'super') { Toast.error('Seul le super administrateur peut supprimer un compte.'); return; }
  if (!confirm(`Supprimer définitivement le compte de ${name} ?\nCette action est irréversible : toutes ses données (transactions, réclamations, etc.) seront aussi supprimées.`)) return;
  const res = await ServerAPI.adminDeleteAccount(id);
  if (!res.ok) { Toast.error(res.error); return; }
  DB.users.delete(id);
  Toast.success(`${name} supprimé.`);
  loadClients();
  loadCabines();
  loadDashboard();
}

/* â”€â”€ Create User â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

/* ── Droits administrateurs (super admin unique) ──────────────────────
   TRA BI BONAVENTURE VANIE HOLLAND (u_admin, admin_level:'super') est
   l'unique administrateur principal. Droits exclusifs : créer des
   comptes admin, définir leurs permissions, les suspendre, consulter le
   profil des autres admins, voir les admins connectés, consulter son
   propre profil (invisible pour tout autre admin — voir viewUser()). */
const ADMIN_PERMISSIONS = [
  { key: 'dashboard',            label: 'Tableau de bord' },
  { key: 'clients',             label: 'Clients' },
  { key: 'cabines',              label: 'Cabines' },
  { key: 'retraits-admin',       label: 'Retraits' },
  { key: 'discussions-admin',    label: 'Discussion client-cabine' },
  { key: 'recharge-cabiniste',   label: 'Recharge cabiniste' },
  { key: 'recharge-client',      label: 'Recharge client' },
  { key: 'recharge-uv-admin',    label: 'Recharge UV' },
  { key: 'exchange-admin',       label: 'Exchange' },
  { key: 'retards-admin',        label: 'Commandes en retard' },
  { key: 'transactions',         label: 'Transactions' },
  { key: 'commissions-admin',    label: 'Commissions' },
  { key: 'maintenance-admin',    label: 'Maintenance' },
  { key: 'partner-requests',     label: 'Demandes de partenariat' },
  { key: 'rankings',             label: 'Classements' },
  { key: 'zero-transaction',     label: 'Zéro transaction' },
  { key: 'clients-inactifs',     label: 'Client moins actif' },
  { key: 'cabines-inactives',    label: 'Cabines moins actives' },
  { key: 'reset-requests',       label: 'Réinitialisations' },
  { key: 'comptes-bloques',      label: 'Comptes bloqués' },
  { key: 'reports',              label: 'Rapports' },
  { key: 'notifications-admin',  label: 'Notifications' },
  { key: 'settings',             label: 'Paramètres' },
];

/* Appelée au boot() juste après Auth.require('admin'). Le super admin
   voit tout, y compris l'onglet "Administrateurs" (masqué par défaut
   dans le HTML) ; un admin simple ne voit que les sections cochées dans
   currentUser.permissions — "Tableau de bord" inclus, c'est une
   permission comme les autres, accordable/retirable par le super admin —
   et n'a jamais accès à l'option "Administrateur" du formulaire de
   création. */
const SUPER_ONLY_VIEWS = ['administrateurs', 'permission-cabine', 'gestion-admins', 'reabonnement-cabine', 'assistant-cabine', 'assistant-client', 'appareils-admin', 'retraits-historique', 'bilan', 'forfaits', 'uv-cabine-admin', 'dispo-services-admin'];

function applyAdminPermissionGating() {
  if (currentUser.admin_level === 'super') {
    SUPER_ONLY_VIEWS.forEach(view => {
      const nav = document.querySelector(`.nav-item[data-view="${view}"]`);
      if (nav) nav.style.display = '';
    });
    return;
  }
  const perms = currentUser.permissions || [];
  document.querySelectorAll('.nav-item[data-view]').forEach(item => {
    const view = item.dataset.view;
    if (SUPER_ONLY_VIEWS.includes(view)) return;
    item.style.display = perms.includes(view) ? '' : 'none';
  });
  const adminOption = document.querySelector('#new-role option[value="admin"]');
  if (adminOption) adminOption.remove();
}

/* ── Recherche d'onglets (barre globale de la sidebar) ─────────────────
   Filtrage instantané par libellé, sans redirection automatique — voir
   plan. Utilise une classe dédiée (nav-item--search-hidden) plutôt que
   style.display directement, pour ne jamais interférer avec
   applyAdminPermissionGating() ci-dessus (qui pose déjà style.display
   selon les permissions) : un onglet déjà masqué par permission
   (style.display === 'none') n'est jamais retouché ici. */
function filterAdminNav(query) {
  const q = query.trim().toLowerCase();
  document.querySelectorAll('.nav-item[data-view]').forEach(item => {
    if (item.style.display === 'none') return;
    const label = (item.querySelector('.nav-label')?.textContent || '').toLowerCase();
    item.classList.toggle('nav-item--search-hidden', !!q && !label.includes(q));
  });
}

/* Vue par défaut à l'ouverture : le tableau de bord si l'admin y a droit
   (toujours le cas pour le super admin), sinon la première section
   permise, pour ne jamais atterrir sur un onglet masqué. */
function getDefaultAdminView() {
  if (currentUser.admin_level === 'super') return 'dashboard';
  const perms = currentUser.permissions || [];
  if (perms.includes('dashboard')) return 'dashboard';
  return perms[0] || 'dashboard';
}

/* ══ Forfaits (super admin uniquement) ═══════════════════════════════
   Ajout/suppression du catalogue DB.forfaits — relu en direct côté
   Client (tfRenderCats()/tfRenderForfaits() dans js/client.js), donc
   aucune synchronisation supplémentaire n'est nécessaire ici. */
let _admForfaitOp = 'Orange';
let _editingForfaitId = null;

async function loadForfaits() {
  const op = document.getElementById('frf-add-op')?.value || 'Orange';
  populateForfaitCatSelect(op);
  updateForfaitUssdPlaceholders(op);
  renderForfaitsList();
  DB.forfaits.refresh().then(() => { populateForfaitCatSelect(op); renderForfaitsList(); });
  await loadUssdTemplates();
}

/* Exemple affiché dans le champ "Modèle USSD" du formulaire, propre au
   réseau choisi, pour guider le super admin (voir updateForfaitUssdPlaceholders()
   appelé au changement de réseau). Un seul modèle par réseau désormais. */
const FORFAIT_USSD_PLACEHOLDERS = {
  Orange: '#161*{numero_destinataire}*...#',
  MTN:    '*133*6*2*{numero_destinataire}#',
  Moov:   '*155*6*2*{numero_destinataire}#',
};
function updateForfaitUssdPlaceholders(op) {
  const f1 = document.getElementById('frf-add-ussd');
  if (f1) f1.placeholder = FORFAIT_USSD_PLACEHOLDERS[op] || FORFAIT_USSD_PLACEHOLDERS.Orange;
}

/* Modèle USSD "transfert direct" MTN/Moov (settings.ussd_templates) —
   distinct du catalogue de forfaits Orange ci-dessus, qui a son propre
   ussdTemplate par forfait (voir addForfait()/editForfait()). */
async function loadUssdTemplates() {
  const t = (await DB.settings.get()).ussd_templates || {};
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  set('ussdtpl-mtn', t.mtn);
  set('ussdtpl-moov-marchand', t.moov_marchand);
}

async function saveUssdTemplates(event) {
  event.preventDefault();
  if (currentUser.admin_level !== 'super') { Toast.error('Seul le super administrateur peut modifier ces modèles.'); return; }

  const mtn          = document.getElementById('ussdtpl-mtn').value.trim();
  const moovMarchand  = document.getElementById('ussdtpl-moov-marchand').value.trim();

  if (!mtn || !moovMarchand) { Toast.error('Veuillez remplir les 2 modèles.'); return; }

  await DB.settings.update({ ussd_templates: { mtn, moov_marchand: moovMarchand } });
  Toast.success('Modèles USSD enregistrés.');
}

function _setForfaitOpActive(op) {
  _admForfaitOp = op;
  document.querySelectorAll('.frf-op-btn').forEach(b => b.classList.toggle('active', b.dataset.op === op));
}

function selectForfaitReseau(op) {
  _setForfaitOpActive(op);
  renderForfaitsList();
}

function _frfRowHtml(f) {
  return `
        <div class="frf-row">
          <div>
            <div class="frf-row-nom">${f.nom}</div>
            <div class="frf-row-meta">${f.detail} · ${f.duree}</div>
            ${f.ussdTemplate ? `<div class="frf-row-ussd">${f.ussdTemplate}${f.verified === false ? ' — ⚠ à vérifier' : ''}</div>` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:10px;">
            <span class="frf-row-prix">${Fmt.money(f.prix)}</span>
            <button type="button" class="frf-row-edit" onclick="editForfait('${f.id}')" title="Modifier"><i class="fa-solid fa-pen"></i></button>
            <button type="button" class="frf-row-del" onclick="deleteForfait('${f.id}')" title="Supprimer"><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>`;
}

function renderForfaitsList() {
  const body = document.getElementById('forfaits-list-body');
  if (!body) return;
  const cats = DB.forfaits.categoriesByOperator(_admForfaitOp);
  if (!cats.length) {
    body.innerHTML = '<div style="text-align:center;padding:24px;color:var(--gray-400);font-size:.85rem;">Aucun forfait pour ce réseau.</div>';
    return;
  }
  const byCat = DB.forfaits.byOperator(_admForfaitOp);
  body.innerHTML = cats.map(cat => {
    const items = byCat.filter(f => f.categorie === cat);
    const hasSub = items.some(f => f.sousCategorie);
    let rowsHtml;
    if (!hasSub) {
      rowsHtml = items.map(_frfRowHtml).join('');
    } else {
      const bySub = [];
      items.forEach(f => {
        const key = f.sousCategorie || '';
        let group = bySub.find(g => g.key === key);
        if (!group) { group = { key, items: [] }; bySub.push(group); }
        group.items.push(f);
      });
      rowsHtml = bySub.map(g => `
        ${g.key ? `<div class="frf-subcat-title">${g.key}</div>` : ''}
        ${g.items.map(_frfRowHtml).join('')}`).join('');
    }
    return `
    <div class="frf-cat-group">
      <div class="frf-cat-title">${cat}</div>
      ${rowsHtml}
    </div>`;
  }).join('');
}

function populateForfaitCatSelect(op) {
  const sel = document.getElementById('frf-add-cat');
  if (!sel) return;
  const cats = DB.forfaits.categoriesByOperator(op);
  sel.innerHTML = cats.map(c => `<option value="${c}">${c}</option>`).join('')
    + '<option value="__new__">+ Nouvelle catégorie</option>';
  toggleForfaitNewCatField(sel.value);
}

function toggleForfaitNewCatField(val) {
  const field = document.getElementById('frf-add-cat-new');
  if (field) field.style.display = val === '__new__' ? 'block' : 'none';
}

async function addForfait(event) {
  event.preventDefault();
  if (currentUser.admin_level !== 'super') { Toast.error('Seul le super administrateur peut gérer les forfaits.'); return; }

  const operateur = document.getElementById('frf-add-op').value;
  const catSel     = document.getElementById('frf-add-cat').value;
  const catNew     = document.getElementById('frf-add-cat-new').value.trim();
  const categorie  = catSel === '__new__' ? catNew : catSel;
  const nom        = document.getElementById('frf-add-nom').value.trim();
  const detail     = document.getElementById('frf-add-detail').value.trim();
  const duree      = document.getElementById('frf-add-duree').value.trim();
  const prix       = parseInt(document.getElementById('frf-add-prix').value) || 0;
  const ussd       = document.getElementById('frf-add-ussd').value.trim();

  if (!categorie)                        { Toast.error('Veuillez indiquer une catégorie.'); return; }
  if (!nom || !detail || !duree || prix <= 0) { Toast.error('Veuillez remplir tous les champs obligatoires.'); return; }

  if (_editingForfaitId) {
    const res = await DB.forfaits.update(_editingForfaitId, { operateur, categorie, nom, detail, duree, prix, ussdTemplate: ussd || null });
    if (!res.ok) { Toast.error(res.error); return; }
    Toast.success(`Forfait "${nom}" modifié.`);
    cancelEditForfait();
  } else {
    const res = await DB.forfaits.create({ operateur, categorie, nom, detail, duree, prix, ussdTemplate: ussd || null, verified: true });
    if (!res.ok) { Toast.error(res.error); return; }
    Toast.success(`Forfait "${nom}" ajouté.`);
    event.target.reset();
    document.getElementById('frf-add-op').value = operateur;
    populateForfaitCatSelect(operateur);
    updateForfaitUssdPlaceholders(operateur);
  }

  _setForfaitOpActive(operateur);
  renderForfaitsList();
}

/* Réutilise le formulaire "Ajouter un forfait" en mode édition : mêmes
   champs, pré-remplis, addForfait() bascule sur DB.forfaits.update()
   tant que _editingForfaitId est renseigné (voir cancelEditForfait()). */
function editForfait(id) {
  if (currentUser.admin_level !== 'super') { Toast.error('Seul le super administrateur peut gérer les forfaits.'); return; }
  const f = DB.forfaits.all().find(x => x.id === id);
  if (!f) return;

  _editingForfaitId = id;
  document.getElementById('frf-add-op').value = f.operateur;
  populateForfaitCatSelect(f.operateur);
  updateForfaitUssdPlaceholders(f.operateur);
  document.getElementById('frf-add-cat').value = f.categorie;
  toggleForfaitNewCatField(f.categorie);
  document.getElementById('frf-add-nom').value    = f.nom;
  document.getElementById('frf-add-detail').value = f.detail;
  document.getElementById('frf-add-duree').value  = f.duree;
  document.getElementById('frf-add-prix').value   = f.prix;
  document.getElementById('frf-add-ussd').value   = f.ussdTemplate || '';

  document.getElementById('frf-form-title').innerHTML = '<i class="fa-solid fa-pen" style="color:var(--primary)"></i> Modifier le forfait';
  document.getElementById('frf-submit-btn').innerHTML = '<i class="fa-solid fa-check"></i> Enregistrer les modifications';
  document.getElementById('frf-cancel-edit-btn').style.display = 'inline-flex';
  document.getElementById('frf-form-title').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function cancelEditForfait() {
  _editingForfaitId = null;
  document.querySelector('#frf-form-title')?.closest('.card').querySelector('form').reset();
  document.getElementById('frf-add-op').value = _admForfaitOp;
  populateForfaitCatSelect(_admForfaitOp);
  updateForfaitUssdPlaceholders(_admForfaitOp);
  document.getElementById('frf-form-title').innerHTML = '<i class="fa-solid fa-plus" style="color:var(--primary)"></i> Ajouter un forfait';
  document.getElementById('frf-submit-btn').innerHTML = '<i class="fa-solid fa-plus"></i> Ajouter le forfait';
  document.getElementById('frf-cancel-edit-btn').style.display = 'none';
}

async function deleteForfait(id) {
  if (currentUser.admin_level !== 'super') { Toast.error('Seul le super administrateur peut gérer les forfaits.'); return; }
  const f = DB.forfaits.all().find(x => x.id === id);
  if (!f) return;
  if (!confirm(`Supprimer le forfait "${f.nom}" ? Cette action est irréversible.`)) return;
  const res = await DB.forfaits.remove(id);
  if (!res.ok) { Toast.error(res.error); return; }
  if (_editingForfaitId === id) cancelEditForfait();
  Toast.success('Forfait supprimé.');
  renderForfaitsList();
}

function toggleCreateUserFields() {
  const role = document.getElementById('new-role').value;
  document.getElementById('create-admin-fields').style.display  = role === 'admin'  ? 'block' : 'none';
  document.getElementById('create-client-fields').style.display = role === 'client' ? 'block' : 'none';
  document.getElementById('create-cabine-fields').style.display = role === 'cabine' ? 'block' : 'none';
  document.querySelectorAll('.type-card').forEach(c => c.classList.toggle('sel', c.dataset.role === role));
  if (role === 'admin') renderNewAdminPermsChecklist();
  toggleAdminQrField();
}

/* Carte de type de compte du formulaire "Créer un nouveau compte" —
   met à jour le <select id="new-role"> masqué (logique déjà en place
   inchangée) puis resynchronise l'affichage via toggleCreateUserFields(). */
function selectAccountType(role) {
  document.getElementById('new-role').value = role;
  toggleCreateUserFields();
}

function renderNewAdminPermsChecklist(checked = []) {
  const box = document.getElementById('new-admin-perms');
  if (!box) return;
  box.innerHTML = ADMIN_PERMISSIONS.map(p => `
    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
      <input type="checkbox" class="new-admin-perm-chk" value="${p.key}" ${checked.includes(p.key) ? 'checked' : ''}> ${p.label}
    </label>`).join('');
}

/* ── Onglet Administrateurs (super admin uniquement) ──────────────────
   Liste tous les comptes admin, avec statut en ligne (droit 5 : voir les
   admins connectés avec leurs noms), et les actions réservées au super
   admin : consulter un profil (viewUser, durci plus haut), modifier les
   permissions, suspendre/réactiver (droits 2, 3, 4). */
function loadAdminsList(query = '') {
  // Défense en profondeur : même appelée directement (ex. console), cette
  // fonction ne doit jamais exposer les autres comptes admin à un admin
  // simple — la vue elle-même est déjà masquée côté HTML pour eux.
  if (currentUser.admin_level !== 'super') return;
  let admins = DB.users.byRole('admin');
  if (query) admins = admins.filter(a => `${a.prenom} ${a.nom} ${a.telephone}`.toLowerCase().includes(query.toLowerCase()));

  const onlineIds = DB.presence.onlineIds();
  const summaryEl = document.getElementById('admins-online-summary');
  if (summaryEl) {
    const onlineAdmins = DB.users.byRole('admin').filter(a => onlineIds.includes(a.id));
    summaryEl.innerHTML = onlineAdmins.length
      ? `<i class="fa-solid fa-circle" style="color:#16A34A;font-size:.55rem;"></i> ${onlineAdmins.length} administrateur(s) connecté(s) : ${onlineAdmins.map(a => `${a.prenom} ${a.nom}`).join(', ')}`
      : `Aucun administrateur connecté.`;
  }

  const tbody = document.getElementById('admins-tbody');
  if (!tbody) return;
  if (!admins.length) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state" style="padding:24px"><div class="empty-title">Aucun administrateur</div></div></td></tr>`;
    return;
  }

  tbody.innerHTML = admins.map(a => {
    const isSuper = a.admin_level === 'super';
    const online  = onlineIds.includes(a.id);
    const permCount = (a.permissions || []).length;
    return `<tr>
      <td><div class="user-chip"><div class="avatar">${Fmt.initials(a.nom, a.prenom)}</div><div><div class="name">${a.prenom} ${a.nom}</div><div style="font-size:.72rem;color:var(--gray-400)"><code>${Fmt.phone(a.telephone)}</code></div></div></div></td>
      <td>${isSuper ? '<span class="badge" style="background:rgba(255,98,0,.12);color:var(--primary);">Super admin</span>' : '<span class="badge badge-info">Simple</span>'}</td>
      <td>${isSuper ? 'Toutes' : `${permCount} section(s)`}</td>
      <td>${online ? '<span class="badge badge-success"><i class="fa-solid fa-circle"></i> En ligne</span>' : '<span style="color:var(--gray-400);font-size:.75rem;">Hors ligne</span>'}${a.statut === 'suspendu' ? '<div><span class="badge badge-failed" style="margin-top:4px;">Suspendu</span></div>' : ''}</td>
      <td><button class="menu-btn-row" onclick="toggleAdminRowMenu(this,'${a.id}')" title="Actions"><i class="fa-solid fa-ellipsis-vertical"></i></button></td>
    </tr>`;
  }).join('');
}

/* Actions de ligne pour un administrateur — voir loadAdminsList(). */
function toggleAdminRowMenu(btn, adminId) {
  const a = DB.users.byId(adminId);
  if (!a) return;
  const isSuper = a.admin_level === 'super';
  openRowMenu(btn, [
    { label: 'Consulter le profil', icon: 'fa-eye', fn: `viewUser('${adminId}')` },
    !isSuper && { label: 'Se connecter à son espace', icon: 'fa-right-to-bracket', fn: `impersonateUser('${adminId}','${a.prenom} ${a.nom}')` },
    !isSuper && { label: 'Modifier les coordonnées', icon: 'fa-id-card', fn: `openEditAdminProfileModal('${adminId}')` },
    !isSuper && { label: 'Modifier les permissions', icon: 'fa-shield-halved', fn: `openEditAdminPermsModal('${adminId}')` },
    !isSuper && { label: 'Générer un lien de connexion', icon: 'fa-link', fn: `generateAdminLoginLink('${adminId}','${a.prenom} ${a.nom}')` },
    !isSuper && a.statut === 'actif' && { label: 'Suspendre', icon: 'fa-ban', fn: `adminRowToggleSuspend('${adminId}','${a.prenom} ${a.nom}',true)`, danger: true },
    !isSuper && a.statut !== 'actif' && { label: 'Réactiver', icon: 'fa-check', fn: `adminRowToggleSuspend('${adminId}','${a.prenom} ${a.nom}',false)` },
    !isSuper && { label: 'Supprimer', icon: 'fa-trash', fn: `adminRowDelete('${adminId}','${a.prenom} ${a.nom}')`, danger: true },
  ]);
}

function searchAdminsList() {
  const q = document.getElementById('admins-search').value.trim();
  _adminResume.filters.admins = q;
  _saveAdminResume();
  loadAdminsList(q);
}

/* ── Gestion des Administrateurs (programmation, super admin) ─────────
   Un administrateur simple ne peut se connecter que s'il a au moins une
   programmation enregistrée à son nom (voir Auth.login(), js/auth.js) —
   simple vérification d'existence, pas un contrôle d'horaire en direct.
   Stocké dans settings.admin_schedules, même patron que
   assistant_client.schedule (jours 0-6 alignés sur Date.getDay()). */
const GA_JOURS_LBL = { 0: 'Dim', 1: 'Lun', 2: 'Mar', 3: 'Mer', 4: 'Jeu', 5: 'Ven', 6: 'Sam' };

function _gaSimpleAdmins() {
  return DB.users.byRole('admin').filter(a => a.admin_level === 'simple');
}

async function loadGestionAdminsAdmin() {
  if (currentUser.admin_level !== 'super') return;
  const admins = _gaSimpleAdmins();
  const optionsHtml = admins.length
    ? admins.map(a => `<option value="${a.id}">${a.prenom} ${a.nom} — ${Fmt.phone(a.telephone)}</option>`).join('')
    : '<option value="">Aucun administrateur simple</option>';
  const autoSel   = document.getElementById('ga-auto-admin');
  const manuelSel = document.getElementById('ga-manuel-admin');
  if (autoSel)   autoSel.innerHTML   = optionsHtml;
  if (manuelSel) manuelSel.innerHTML = optionsHtml;

  const schedules = (await DB.settings.get()).admin_schedules || [];
  const el = document.getElementById('gestion-admins-list');
  if (!el) return;

  if (!schedules.length) {
    el.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:.8rem;">
      <i class="fa-solid fa-calendar-xmark" style="font-size:2rem;color:var(--gray-300);display:block;margin-bottom:10px;"></i>
      Aucune programmation enregistrée.
    </div>`;
    return;
  }

  const sorted = [...schedules].sort((a, b) => new Date(b.date_creation) - new Date(a.date_creation));
  el.innerHTML = sorted.map(s => {
    const admin = DB.users.byId(s.admin_id);
    const nom = admin ? `${admin.prenom} ${admin.nom}` : 'Administrateur supprimé';
    const creneauLbl = s.mode === 'auto'
      ? 'Toujours disponible'
      : `${(s.jours || []).map(j => GA_JOURS_LBL[j]).join(', ')} · ${s.debut}–${s.fin}`;
    return `<div class="rst-admin-row">
      <div class="rst-admin-info">
        <div class="rst-admin-name"><i class="fa-solid fa-user-shield"></i> ${nom}</div>
        <div class="rst-admin-meta">${s.mode === 'auto' ? '<i class="fa-solid fa-bolt"></i>' : '<i class="fa-regular fa-calendar"></i>'} ${creneauLbl}</div>
        <div class="rst-admin-date"><i class="fa-regular fa-clock"></i> Programmé le ${Fmt.datetime(s.date_creation)}</div>
      </div>
      <div class="rst-admin-actions">
        <button class="btn btn-sm btn-danger" onclick="supprimerProgrammationAdmin('${s.id}')" title="Supprimer"><i class="fa-solid fa-trash"></i></button>
      </div>
    </div>`;
  }).join('');
}

async function genererProgrammationAuto() {
  if (currentUser.admin_level !== 'super') return;
  const adminId = document.getElementById('ga-auto-admin').value;
  if (!adminId) { Toast.error('Choisissez un administrateur simple.'); return; }

  const s = await DB.settings.get();
  const schedules = s.admin_schedules || [];
  schedules.push({
    id: 'gas_' + DB.uid(), admin_id: adminId,
    jours: [0, 1, 2, 3, 4, 5, 6], debut: '00:00', fin: '23:59',
    mode: 'auto', date_creation: DB.now(),
  });
  await DB.settings.update({ admin_schedules: schedules });

  Toast.success('Programmation automatique générée — connexion débloquée.');
  await loadGestionAdminsAdmin();
}

async function enregistrerProgrammationManuelle() {
  if (currentUser.admin_level !== 'super') return;
  const adminId = document.getElementById('ga-manuel-admin').value;
  if (!adminId) { Toast.error('Choisissez un administrateur simple.'); return; }

  const jours = [...document.querySelectorAll('.ga-manuel-jour:checked')].map(cb => parseInt(cb.value, 10));
  const debut = document.getElementById('ga-manuel-debut').value;
  const fin   = document.getElementById('ga-manuel-fin').value;
  if (!jours.length) { Toast.error('Choisissez au moins un jour.'); return; }
  if (!debut || !fin) { Toast.error('Renseignez l\'heure de début et de fin.'); return; }

  const s = await DB.settings.get();
  const schedules = s.admin_schedules || [];
  schedules.push({
    id: 'gas_' + DB.uid(), admin_id: adminId,
    jours, debut, fin, mode: 'manuel', date_creation: DB.now(),
  });
  await DB.settings.update({ admin_schedules: schedules });

  Toast.success('Programmation manuelle enregistrée — connexion débloquée.');
  document.querySelectorAll('.ga-manuel-jour').forEach(cb => cb.checked = false);
  await loadGestionAdminsAdmin();
}

async function supprimerProgrammationAdmin(scheduleId) {
  if (currentUser.admin_level !== 'super') return;
  if (!confirm('Supprimer cette programmation ? L\'administrateur concerné ne pourra plus se connecter si c\'était sa seule programmation.')) return;

  const s = await DB.settings.get();
  const schedules = (s.admin_schedules || []).filter(x => x.id !== scheduleId);
  await DB.settings.update({ admin_schedules: schedules });

  Toast.success('Programmation supprimée.');
  await loadGestionAdminsAdmin();
}

function adminRowToggleSuspend(id, name, suspend) {
  if (currentUser.admin_level !== 'super') { Toast.error('Seul le super administrateur peut suspendre un administrateur.'); return; }
  if (id === currentUser.id) { Toast.error('Vous ne pouvez pas agir sur votre propre compte.'); return; }
  if (suspend) suspendUser(id, name); else activateUser(id, name);
  loadAdminsList();
}

/* Supprimer un administrateur simple — droit exclusif du super admin.
   deleteUser() gère déjà la confirmation avant suppression. */
function adminRowDelete(id, name) {
  if (currentUser.admin_level !== 'super') { Toast.error('Seul le super administrateur peut supprimer un administrateur.'); return; }
  const target = DB.users.byId(id);
  if (target && target.admin_level === 'super') { Toast.error('Impossible de supprimer le super administrateur.'); return; }
  if (id === currentUser.id) { Toast.error('Vous ne pouvez pas supprimer votre propre compte.'); return; }
  deleteUser(id, name);
  loadAdminsList();
}

let _editAdminPermsId = null;

function openEditAdminPermsModal(id) {
  if (currentUser.admin_level !== 'super') { Toast.error('Seul le super administrateur peut définir les permissions.'); return; }
  const a = DB.users.byId(id);
  if (!a) return;
  _editAdminPermsId = id;
  document.getElementById('edit-admin-perms-label').textContent = `${a.prenom} ${a.nom}`;
  const box = document.getElementById('edit-admin-perms-box');
  box.innerHTML = ADMIN_PERMISSIONS.map(p => `
    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
      <input type="checkbox" class="edit-admin-perm-chk" value="${p.key}" ${(a.permissions || []).includes(p.key) ? 'checked' : ''}> ${p.label}
    </label>`).join('');
  openModal('modal-edit-admin-perms');
}

async function saveAdminPerms() {
  if (currentUser.admin_level !== 'super') { Toast.error('Seul le super administrateur peut définir les permissions.'); return; }
  const permissions = [...document.querySelectorAll('.edit-admin-perm-chk:checked')].map(chk => chk.value);
  const res = await ServerAPI.adminUpdateProfile({ id: _editAdminPermsId, permissions });
  if (!res.ok) { Toast.error(res.error); return; }
  DB.users.update(_editAdminPermsId, { permissions });
  closeModal('modal-edit-admin-perms');
  Toast.success('Permissions mises à jour.');
  loadAdminsList();
}

/* ── Modifier les coordonnées / le mot de passe d'un admin simple ─────
   Droit exclusif du super admin (voir en tête de section). Les 3 champs
   fichier sont optionnels à la modification : un champ laissé vide
   conserve le document déjà enregistré. Le super admin peut en plus
   modifier ses propres coordonnées via ce même modal (bouton "Modifier
   mon profil" sur son propre profil, voir viewUser()) — le champ Poste,
   qui ne concerne que les admins simples, est masqué dans ce cas. */
let _editAdminProfileId = null;

function openEditAdminProfileModal(id) {
  if (currentUser.admin_level !== 'super') { Toast.error('Seul le super administrateur peut modifier un administrateur.'); return; }
  const a = DB.users.byId(id);
  const isSelf = a && a.id === currentUser.id;
  if (!a || (a.admin_level === 'super' && !isSelf)) return;
  _editAdminProfileId = id;

  document.getElementById('edit-admin-profile-label').textContent = `${a.prenom} ${a.nom}`;
  document.getElementById('edit-admin-nom').value       = a.nom || '';
  document.getElementById('edit-admin-prenom').value    = a.prenom || '';
  document.getElementById('edit-admin-email').value     = a.email || '';
  document.getElementById('edit-admin-dob').value       = a.date_naissance || '';
  document.getElementById('edit-admin-cni-recto').value = '';
  document.getElementById('edit-admin-cni-verso').value = '';
  document.getElementById('edit-admin-photo').value     = '';
  document.getElementById('edit-admin-pays').value      = a.pays || '';
  document.getElementById('edit-admin-ville').value     = a.ville || '';
  document.getElementById('edit-admin-quartier').value  = a.quartier || '';
  document.getElementById('edit-admin-poste').value     = a.poste || 'Assistant clientèle';
  document.getElementById('edit-admin-whatsapp').value  = Fmt.phone(a.whatsapp);
  document.getElementById('edit-admin-new-pin').value         = '';
  document.getElementById('edit-admin-new-pin-confirm').value = '';
  document.getElementById('edit-admin-poste-group').style.display = a.admin_level === 'super' ? 'none' : '';

  openModal('modal-edit-admin-profile');
}

async function saveAdminProfile() {
  if (currentUser.admin_level !== 'super') { Toast.error('Seul le super administrateur peut modifier un administrateur.'); return; }
  const target = DB.users.byId(_editAdminProfileId);
  const isSelf = target && target.id === currentUser.id;
  if (!target || (target.admin_level === 'super' && !isSelf)) return;

  const nom       = document.getElementById('edit-admin-nom').value.trim();
  const prenom    = document.getElementById('edit-admin-prenom').value.trim();
  const email     = document.getElementById('edit-admin-email').value.trim();
  const dob       = document.getElementById('edit-admin-dob').value;
  const pays      = document.getElementById('edit-admin-pays').value.trim();
  const ville     = document.getElementById('edit-admin-ville').value.trim();
  const quartier  = document.getElementById('edit-admin-quartier').value.trim();
  const poste     = document.getElementById('edit-admin-poste').value;
  const whatsapp  = document.getElementById('edit-admin-whatsapp').value.replace(/\s/g, '');
  const rectoFile = document.getElementById('edit-admin-cni-recto').files[0];
  const versoFile = document.getElementById('edit-admin-cni-verso').files[0];
  const photoFile = document.getElementById('edit-admin-photo').files[0];
  const newPin    = document.getElementById('edit-admin-new-pin').value;
  const newPin2   = document.getElementById('edit-admin-new-pin-confirm').value;

  if (!nom || !prenom) { Toast.error('Le nom et le prénom sont obligatoires.'); return; }
  if (!Auth.isValidGmail(email)) { Toast.error('Adresse Gmail invalide (ex : nom@gmail.com).'); return; }
  if (DB.users.byEmail(email) && DB.users.byEmail(email).id !== target.id) { Toast.error('Cet email est déjà utilisé par un autre compte.'); return; }
  if (!dob) { Toast.error('La date de naissance est obligatoire.'); return; }
  if (!pays || !ville || !quartier) { Toast.error('Pays, ville et quartier sont obligatoires.'); return; }
  if (!whatsapp) { Toast.error('Le numéro WhatsApp est obligatoire.'); return; }
  if (newPin || newPin2) {
    if (!Auth.isValidPin(newPin)) { Toast.error('Le nouveau mot de passe doit contenir exactement 4 chiffres.'); return; }
    if (newPin !== newPin2) { Toast.error('Les deux mots de passe ne correspondent pas.'); return; }
  }

  const photoUrl = await adminReadFileAsDataUrl(photoFile);
  const updates = {
    nom, prenom, email, dateNaissance: dob, pays, ville, quartier, whatsapp,
  };
  if (target.admin_level !== 'super') updates.poste = poste;
  if (rectoFile || versoFile) {
    updates.docs = { ...(target.docs || {}) };
    if (rectoFile) updates.docs.cni_recto = rectoFile.name;
    if (versoFile) updates.docs.cni_verso = versoFile.name;
  }
  if (photoFile) updates.photo = photoUrl;
  if (newPin) updates.pin = newPin;

  const res = await ServerAPI.adminUpdateProfile({ id: _editAdminProfileId, ...updates });
  if (!res.ok) { Toast.error(res.error); return; }

  const localUpdates = { ...updates };
  if (localUpdates.pin) { localUpdates.mot_de_passe = localUpdates.pin; delete localUpdates.pin; }
  if (localUpdates.dateNaissance !== undefined) { localUpdates.date_naissance = localUpdates.dateNaissance; delete localUpdates.dateNaissance; }
  DB.users.update(_editAdminProfileId, localUpdates);
  closeModal('modal-edit-admin-profile');

  if (isSelf) {
    currentUser = Auth.refresh();
    document.querySelector('.user-name').textContent = currentUser.prenom + ' ' + currentUser.nom;
    Toast.success('Votre profil a été mis à jour.');
    viewOwnAdminProfile();
  } else {
    Toast.success(`Coordonnées de ${prenom} ${nom} mises à jour.`);
    loadAdminsList();
  }
}

function adminReadFileAsDataUrl(file) {
  return new Promise((resolve) => {
    if (!file) { resolve(''); return; }
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}

/* Informations demandees identiques aux parcours classiques (inscription
   client / candidature partenaire de client.html), selon le role choisi. */
function handleCreateUser(e) {
  e.preventDefault();
  const role = document.getElementById('new-role').value;
  const tel  = document.getElementById('new-tel').value.replace(/\s/g, '');

  if (!/^0[0-9]{9}$/.test(tel)) { Toast.error('Numero de telephone invalide.'); return; }
  if (DB.users.byPhoneAndRole(tel, role)) { Toast.error('Ce numéro est déjà utilisé par un autre compte de ce type.'); return; }

  // Client et administrateur : uniquement telephone + code a 4 chiffres,
  // pas de nom/prenom demande (voir cabine ci-dessous pour le formulaire complet).
  if (role === 'admin') {
    // Créer un compte administrateur est un droit exclusif du super admin —
    // défense en profondeur même si l'option est déjà masquée côté UI pour
    // les admins simples (voir applyAdminPermissionGating).
    if (currentUser.admin_level !== 'super') { Toast.error('Seul le super administrateur peut créer un compte administrateur.'); return; }

    const pin           = document.getElementById('new-pin-admin').value;
    const prenom        = document.getElementById('new-admin-prenom').value.trim();
    const nom           = document.getElementById('new-admin-nom').value.trim();
    const email         = document.getElementById('new-admin-email').value.trim();
    const dateNaissance = document.getElementById('new-admin-dob').value;
    const rectoFile     = document.getElementById('new-admin-cni-recto').files[0];
    const versoFile     = document.getElementById('new-admin-cni-verso').files[0];
    const photoFile     = document.getElementById('new-admin-photo').files[0];
    const pays          = document.getElementById('new-admin-pays').value.trim();
    const ville         = document.getElementById('new-admin-ville').value.trim();
    const quartier      = document.getElementById('new-admin-quartier').value.trim();
    const poste         = document.getElementById('new-admin-poste').value;
    const whatsapp      = document.getElementById('new-admin-whatsapp').value.replace(/\s/g, '');
    const permissions   = [...document.querySelectorAll('.new-admin-perm-chk:checked')].map(chk => chk.value);

    if (!prenom || !nom) { Toast.error('Le prénom et le nom sont obligatoires.'); return; }
    if (!Auth.isValidGmail(email)) { Toast.error('Adresse Gmail invalide (ex : nom@gmail.com).'); return; }
    if (DB.users.byEmail(email)) { Toast.error('Cet email est déjà utilisé par un autre compte.'); return; }
    if (!dateNaissance) { Toast.error('La date de naissance est obligatoire.'); return; }
    if (!rectoFile || !versoFile || !photoFile) { Toast.error('Les 3 pièces (recto, verso, photo) sont obligatoires.'); return; }
    if (!pays || !ville || !quartier) { Toast.error('Pays, ville et quartier sont obligatoires.'); return; }
    if (!whatsapp) { Toast.error('Le numéro WhatsApp est obligatoire.'); return; }
    if (!/^\d{4}$/.test(pin)) { Toast.error('Le code PIN doit contenir exactement 4 chiffres.'); return; }

    adminReadFileAsDataUrl(photoFile).then((photoDataUrl) => {
      finishCreateUser({
        prenom, nom, telephone: tel, email, mot_de_passe: pin, role: 'admin', solde: 0,
        admin_level: 'simple', permissions,
        date_naissance: dateNaissance, pays, ville, quartier, poste, whatsapp,
        docs: { cni_recto: rectoFile.name, cni_verso: versoFile.name, photo: photoFile.name },
        photo: photoDataUrl,
      });
    });
    return;
  }

  if (role === 'client') {
    const pin = document.getElementById('new-pin-client').value;
    if (!/^\d{4}$/.test(pin)) { Toast.error('Le code PIN doit contenir exactement 4 chiffres.'); return; }
    finishCreateUser({ prenom: tel, nom: '', telephone: tel, mot_de_passe: pin, role: 'client', solde: 0 });
    return;
  }

  // role === 'cabine' -- memes informations que la candidature partenaire classique
  const prenom       = document.getElementById('new-prenom').value.trim();
  const nom          = document.getElementById('new-nom').value.trim();
  const email        = document.getElementById('new-email-cabine').value.trim();
  const whatsapp     = document.getElementById('new-whatsapp').value.replace(/\s/g, '');
  const cabineNom    = document.getElementById('new-cabine-nom').value.trim();
  const pin          = document.getElementById('new-pin-cabine').value;
  const pin2         = document.getElementById('new-pin-cabine-confirm').value;
  const rectoFile    = document.getElementById('new-cni-recto').files[0];
  const versoFile    = document.getElementById('new-cni-verso').files[0];
  const photoFile    = document.getElementById('new-photo').files[0];
  const abonnement   = document.getElementById('new-abonnement').value;
  const motivation   = document.getElementById('new-motivation').value.trim();
  const experience   = document.getElementById('new-experience').value;
  const paiementAbo  = document.getElementById('new-paiement-abo').value;
  const paiementVers = document.getElementById('new-paiement-vers').value;
  const numeroCompte = document.getElementById('new-numero-compte').value.trim();
  const qrFile        = document.getElementById('new-qr').files[0];
  const zone         = document.getElementById('new-zone').value.trim();
  const puces = {
    orange: parseInt(document.getElementById('new-puce-orange').value) || 0,
    mtn:    parseInt(document.getElementById('new-puce-mtn').value)    || 0,
    moov:   parseInt(document.getElementById('new-puce-moov').value)   || 0,
  };
  const isWaveVers = paiementVers === 'Wave Business' || paiementVers === 'Wave Normal';

  if (!prenom || !nom) { Toast.error('Prenom et nom sont obligatoires.'); return; }
  if (!Auth.isValidGmail(email)) { Toast.error('Adresse Gmail invalide (ex : nom@gmail.com).'); return; }
  if (DB.users.byEmail(email)) { Toast.error('Cet email est déjà utilisé par un autre compte.'); return; }
  if (!whatsapp) { Toast.error('Le numero WhatsApp est obligatoire.'); return; }
  if (!cabineNom) { Toast.error('Le nom de la cabine est obligatoire.'); return; }
  if (!/^\d{4}$/.test(pin)) { Toast.error('Le code PIN doit contenir exactement 4 chiffres.'); return; }
  if (pin !== pin2) { Toast.error('Les deux codes PIN ne correspondent pas.'); return; }
  if (!rectoFile || !versoFile || !photoFile) { Toast.error('Les 3 pieces (recto, verso, photo) sont obligatoires.'); return; }
  if (!motivation) { Toast.error('La motivation est obligatoire.'); return; }
  if (!experience) { Toast.error("L'experience est obligatoire."); return; }
  if (!numeroCompte) { Toast.error('Le numero de compte est obligatoire.'); return; }
  if (isWaveVers && !qrFile) { Toast.error('Le code QR de reception Wave est obligatoire.'); return; }

  Promise.all([adminReadFileAsDataUrl(photoFile), adminReadFileAsDataUrl(qrFile)]).then(([photoDataUrl, qrDataUrl]) => {
    finishCreateUser({
      prenom, nom, telephone: tel, email, mot_de_passe: pin, role: 'cabine',
      zone, solde: 0, abonnement, whatsapp, motivation, experience, puces,
      paiement_abo: paiementAbo, paiement_vers: paiementVers, numero_compte: numeroCompte,
      docs: { cni_recto: rectoFile.name, cni_verso: versoFile.name, photo: photoFile.name, qr: qrFile?.name || '' },
      photo: photoDataUrl, code_qr: qrDataUrl,
    });
  });
}

function toggleAdminQrField() {
  const paiementVers = document.getElementById('new-paiement-vers').value;
  const isWave = paiementVers === 'Wave Business' || paiementVers === 'Wave Normal';
  document.getElementById('new-qr-field').style.display = isWave ? 'block' : 'none';
}

async function finishCreateUser(data) {
  // Création côté serveur d'abord quand c'est possible (voir
  // api/create_account.php/api/admin_create_account.php) — pour que ce
  // compte soit utilisable sur N'IMPORTE QUEL appareil dès sa création, pas
  // seulement celui de l'admin (voir le diagnostic du bug de connexion
  // multi-appareil). Repli local seul si hors ligne/serveur non configuré :
  // Auth.login() resynchronisera ce compte dès sa prochaine connexion en
  // ligne, si le serveur est configuré entretemps.
  if (ServerAPI.isConfigured && DB.Net.isOnline()) {
    const payload = {
      role: data.role, nom: data.nom, prenom: data.prenom, telephone: data.telephone,
      pin: data.mot_de_passe, email: data.email, cabineNom: data.cabine_nom,
    };
    const res = data.role === 'admin'
      ? await ServerAPI.adminCreateAccount({
          ...payload, adminLevel: data.admin_level, permissions: data.permissions,
          whatsapp: data.whatsapp, photo: data.photo, poste: data.poste,
          pays: data.pays, ville: data.ville, quartier: data.quartier,
          dateNaissance: data.date_naissance, docs: data.docs,
        })
      : await ServerAPI.createAccount(payload);
    if (!res.ok) { Toast.error(res.error || 'Échec de la création du compte.'); return; }
    data = { ...data, id: res.profile.id };
  }

  DB.users.create(data);
  closeModal('modal-create-user');
  document.getElementById('create-user-form').reset();
  toggleCreateUserFields();
  Toast.success(`Compte ${data.role} cree pour ${data.prenom} ${data.nom}.`);
  loadClients();
  loadCabines();
  loadDashboard();
  if (data.role === 'admin' && currentUser.admin_level === 'super') loadAdminsList();
}

/* ══ Bilan (super admin uniquement) ═══════════════════════════════════
   Tableau de bord statistique global, filtrable par période (jour/mois/
   année/toute la période) — chaque chiffre est cliquable et ouvre le
   détail exact des éléments comptés (openBilanDetail). Droit d'accès
   contrôlé à 3 niveaux comme les autres vues super-admin (nav-item
   style="display:none" démasqué par applyAdminPermissionGating() +
   garde ici + garde dans exportCSV('bilan')) — voir SUPER_ONLY_VIEWS. */

// service === ... pour Transfert direct/Forfait (aucun `type` posé par
// business.createTransfer()) ; type === ... pour les flux "avancés"
// (voir _svcDebitAndRecord() dans js/client.js). Le réabonnement cabine
// est traité séparément plus bas (formules, pas statuts de transaction).
const BILAN_SERVICES = [
  { key: 'transfert_direct', label: 'Transfert direct', icon: 'fa-paper-plane',       match: t => t.service === 'Transfert direct' },
  { key: 'forfait',          label: 'Forfait',           icon: 'fa-box',              match: t => t.service === 'Forfait' },
  { key: 'transfert_client', label: 'Transfert client',  icon: 'fa-right-left',       match: t => t.type === 'transfert_client' },
  { key: 'recharge_uv',      label: 'Recharge UV',       icon: 'fa-bolt-lightning',   match: t => t.type === 'recharge_uv' },
  { key: 'exchange',         label: 'Exchange',          icon: 'fa-arrows-rotate',    match: t => t.type === 'exchange' },
  { key: 'facture',          label: 'Facture',           icon: 'fa-file-invoice-dollar', match: t => t.type === 'facture' },
];
const BILAN_STATUTS = [
  { key: 'terminé',    label: 'Terminées' },
  { key: 'en_attente', label: 'En attente' },
  { key: 'remboursé',  label: 'Remboursées' },
  { key: 'refusé',     label: 'Refusées' },
  { key: 'suspendue',  label: 'Suspendues' },
];
const BILAN_FORMULES = ['Premium', 'VIP', 'VVIP'];

function bilanChangePeriodMode() {
  const mode = document.getElementById('bilan-period-mode').value;
  document.getElementById('bilan-period-day').style.display   = mode === 'day'   ? '' : 'none';
  document.getElementById('bilan-period-month').style.display = mode === 'month' ? '' : 'none';
  document.getElementById('bilan-period-year').style.display  = mode === 'year'  ? '' : 'none';
  loadBilan();
}

/* [début, fin] en ISO (bornes inclusives, comparaison de chaînes — même
   technique que loadRetraitsHistorique()) selon le mode choisi, ou
   [null, null] pour "Toute la période" (aucun filtre appliqué). */
function _bilanRange() {
  const mode = document.getElementById('bilan-period-mode')?.value || 'month';
  if (mode === 'day') {
    const v = document.getElementById('bilan-period-day')?.value;
    return v ? [v, v + 'T23:59:59'] : [null, null];
  }
  if (mode === 'month') {
    const v = document.getElementById('bilan-period-month')?.value;
    if (!v) return [null, null];
    const [y, m] = v.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    return [`${v}-01`, `${v}-${String(lastDay).padStart(2, '0')}T23:59:59`];
  }
  if (mode === 'year') {
    const v = document.getElementById('bilan-period-year')?.value;
    return v ? [`${v}-01-01`, `${v}-12-31T23:59:59`] : [null, null];
  }
  return [null, null];
}

function _bilanPeriodLabel() {
  const mode = document.getElementById('bilan-period-mode')?.value || 'month';
  if (mode === 'day') {
    const v = document.getElementById('bilan-period-day')?.value;
    return v ? `Journée du ${Fmt.date(v)}` : 'Aucune date sélectionnée';
  }
  if (mode === 'month') {
    const v = document.getElementById('bilan-period-month')?.value;
    if (!v) return 'Aucun mois sélectionné';
    const [y, m] = v.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('fr-CI', { month: 'long', year: 'numeric' });
  }
  if (mode === 'year') {
    const v = document.getElementById('bilan-period-year')?.value;
    return v ? `Année ${v}` : 'Aucune année sélectionnée';
  }
  return 'Toute la période';
}

function _bilanFilterByDate(list, dateField = 'date') {
  const [start, end] = _bilanRange();
  if (!start) return list;
  return list.filter(x => x[dateField] >= start && x[dateField] <= end);
}

function _bilanEmptyState() {
  return `<div class="empty-state" style="padding:24px"><div class="empty-title">Aucun élément pour cette période</div></div>`;
}

function loadBilan() {
  if (currentUser.admin_level !== 'super') return;

  const monthEl = document.getElementById('bilan-period-month');
  if (monthEl && !monthEl.value) monthEl.value = new Date().toISOString().slice(0, 7);
  const dayEl = document.getElementById('bilan-period-day');
  if (dayEl && !dayEl.value) dayEl.value = new Date().toISOString().slice(0, 10);
  const yearSel = document.getElementById('bilan-period-year');
  if (yearSel && !yearSel.options.length) {
    const nowYear = new Date().getFullYear();
    for (let y = nowYear; y >= 2024; y--) yearSel.innerHTML += `<option value="${y}">${y}</option>`;
  }

  const periodLabel = _bilanPeriodLabel();
  document.getElementById('bilan-period-summary').textContent = `Période affichée : ${periodLabel}.`;
  document.getElementById('bilan-print-period-label').textContent =
    `KBINE PLUS — Bilan · ${periodLabel} · généré le ${Fmt.datetime(new Date().toISOString())}`;

  const txns = _bilanFilterByDate(DB.transactions.all());
  const cabinesNouvelles = _bilanFilterByDate(DB.users.byRole('cabine'), 'date_creation');
  const clientsNouveaux  = _bilanFilterByDate(DB.users.byRole('client'), 'date_creation');
  const rembourses  = txns.filter(t => t.statut === 'remboursé');
  const retards     = _bilanFilterByDate(DB.retards.all());
  const retraitsList = _bilanFilterByDate(DB.retraits.all().filter(r => r.type !== 'sanction'));

  // "Ventes du jour" : toujours aujourd'hui, indépendamment de la période
  // sélectionnée (comme "Inscriptions du jour" sur le tableau de bord) —
  // volume des commandes terminées sur la journée calendaire en cours.
  const todayStr = new Date().toISOString().slice(0, 10);
  const ventesJour = DB.transactions.all().filter(t => t.statut === 'terminé' && (t.date || '').slice(0, 10) === todayStr);
  const ventesJourVolume = ventesJour.reduce((s, t) => s + (t.montant || 0), 0);

  // Frais de service : prélevés dès la création de la commande (montant +
  // frais débités immédiatement, voir business.createTransfer()/
  // _svcDebitAndRecord() dans js/client.js), donc acquis à la plateforme
  // quel que soit le statut final — additionnés sur toutes les commandes
  // de la période, pas seulement les terminées.
  const fraisTotal = txns.reduce((s, t) => s + (t.frais_service || 0), 0);

  const overviewItems = [
    { label: 'Cabines inscrites',       value: cabinesNouvelles.length,        color: 'blue',   fn: `openBilanDetail('cabines')` },
    { label: 'Clients inscrits',        value: clientsNouveaux.length,         color: 'green',  fn: `openBilanDetail('clients')` },
    { label: 'Transactions effectuées', value: txns.length,                    color: 'orange', fn: `openBilanDetail('transactions')` },
    { label: 'Commandes remboursées',   value: rembourses.length,              color: 'purple', fn: `openBilanDetail('rembourses')` },
    { label: 'Commandes en retard',     value: retards.length,                 color: 'orange', fn: `openBilanDetail('retards')` },
    { label: 'Retraits effectués',      value: retraitsList.length,            color: 'green',  fn: `openBilanDetail('retraits')` },
    { label: 'Ventes du jour',          value: Fmt.money(ventesJourVolume),    color: 'purple', fn: `openBilanDetail('ventes_jour')`, sub: `${ventesJour.length} commande(s) — aujourd'hui` },
    { label: 'Frais de service gagnés', value: Fmt.money(fraisTotal),          color: 'blue',   fn: `openBilanDetail('frais')` },
  ];
  document.getElementById('bilan-overview-grid').innerHTML = overviewItems.map(it => `
    <div class="stat-card ${it.color} clickable" onclick="${it.fn}">
      <div class="stat-info">
        <div class="stat-label">${it.label}</div>
        <div class="stat-value">${it.value}</div>
        ${it.sub ? `<div class="stat-sub">${it.sub}</div>` : ''}
      </div>
    </div>`).join('');

  const svcCards = BILAN_SERVICES.map(svc => {
    const items  = txns.filter(svc.match);
    const volume = items.reduce((s, t) => s + (t.montant || 0), 0);
    const rows = BILAN_STATUTS.map(st => {
      const count = items.filter(t => t.statut === st.key).length;
      return `<div class="stat-mini clickable" onclick="openBilanDetail('service','${svc.key}','${st.key}')">
        <span class="stat-mini-label">${st.label}</span><span class="stat-mini-val">${count}</span>
      </div>`;
    }).join('');
    return `<div class="bilan-service-card">
      <div class="bilan-service-hd">
        <span class="name"><i class="fa-solid ${svc.icon}" style="color:var(--primary);margin-right:7px;"></i>${svc.label}</span>
        <span class="total">${items.length} · ${Fmt.money(volume)}</span>
      </div>
      <div class="bilan-service-body">
        <div class="stat-mini clickable" onclick="openBilanDetail('service','${svc.key}')">
          <span class="stat-mini-label">Toutes</span><span class="stat-mini-val">${items.length}</span>
        </div>
        ${rows}
      </div>
    </div>`;
  }).join('');

  const reabonnements = _bilanFilterByDate(DB.resubscriptions.all());
  const reabonnementVolume = reabonnements.reduce((s, r) => s + (r.prix || 0), 0);
  const reabonnementRows = BILAN_FORMULES.map(f => {
    const count = reabonnements.filter(r => r.formule === f).length;
    return `<div class="stat-mini clickable" onclick="openBilanDetail('reabonnement','${f}')">
      <span class="stat-mini-label">${f}</span><span class="stat-mini-val">${count}</span>
    </div>`;
  }).join('');
  const reabonnementCard = `<div class="bilan-service-card">
    <div class="bilan-service-hd">
      <span class="name"><i class="fa-solid fa-crown" style="color:var(--primary);margin-right:7px;"></i>Réabonnement cabine</span>
      <span class="total">${reabonnements.length} · ${Fmt.money(reabonnementVolume)}</span>
    </div>
    <div class="bilan-service-body">
      <div class="stat-mini clickable" onclick="openBilanDetail('reabonnement')">
        <span class="stat-mini-label">Toutes formules</span><span class="stat-mini-val">${reabonnements.length}</span>
      </div>
      ${reabonnementRows}
    </div>
  </div>`;

  document.getElementById('bilan-services-grid').innerHTML = svcCards + reabonnementCard;
}

/* Détail cliquable derrière chaque statistique du Bilan — recalcule
   toujours à partir de DB.* (même période que loadBilan()) plutôt que de
   faire transiter des tableaux déjà calculés à travers le onclick. */
function openBilanDetail(kind, arg1, arg2) {
  if (currentUser.admin_level !== 'super') return;
  let title = 'Détail';
  let body  = '';
  const period = _bilanPeriodLabel();

  const userRow = (u, sub) => `<div class="rst-admin-row">
    <div class="rst-admin-info">
      <div class="rst-admin-name"><i class="fa-solid fa-user"></i> ${u.cabine_nom || `${u.prenom} ${u.nom}`}</div>
      <div class="rst-admin-meta">${sub}</div>
      <div class="rst-admin-date"><i class="fa-regular fa-clock"></i> Inscrit(e) le ${Fmt.datetime(u.date_creation)}</div>
    </div>
  </div>`;

  if (kind === 'cabines') {
    title = `Cabines inscrites — ${period}`;
    const list = _bilanFilterByDate(DB.users.byRole('cabine'), 'date_creation').sort((a, b) => new Date(b.date_creation) - new Date(a.date_creation));
    body = list.length ? list.map(c => userRow(c, `${Fmt.phone(c.telephone)} · ${c.zone || 'N/A'}`)).join('') : _bilanEmptyState();

  } else if (kind === 'clients') {
    title = `Clients inscrits — ${period}`;
    const list = _bilanFilterByDate(DB.users.byRole('client'), 'date_creation').sort((a, b) => new Date(b.date_creation) - new Date(a.date_creation));
    body = list.length ? list.map(c => userRow(c, Fmt.phone(c.telephone))).join('') : _bilanEmptyState();

  } else if (kind === 'transactions' || kind === 'rembourses' || kind === 'service' || kind === 'ventes_jour') {
    let list = kind === 'ventes_jour' ? DB.transactions.all() : _bilanFilterByDate(DB.transactions.all());
    if (kind === 'rembourses') {
      title = `Commandes remboursées — ${period}`;
      list = list.filter(t => t.statut === 'remboursé');
    } else if (kind === 'service') {
      const svc = BILAN_SERVICES.find(s => s.key === arg1);
      list = svc ? list.filter(svc.match) : [];
      const statutLbl = arg2 ? ' · ' + (BILAN_STATUTS.find(s => s.key === arg2)?.label || arg2) : '';
      title = `${svc ? svc.label : 'Service'}${statutLbl} — ${period}`;
      if (arg2) list = list.filter(t => t.statut === arg2);
    } else if (kind === 'ventes_jour') {
      // Toujours "aujourd'hui", indépendant du filtre de période — voir
      // le commentaire sur ventesJour dans loadBilan().
      const todayStr = new Date().toISOString().slice(0, 10);
      list = list.filter(t => t.statut === 'terminé' && (t.date || '').slice(0, 10) === todayStr);
      title = `Ventes du jour — ${Fmt.date(todayStr)}`;
    } else {
      title = `Transactions effectuées — ${period}`;
    }
    list.sort((a, b) => new Date(b.date) - new Date(a.date));
    body = list.length ? `<div class="table-wrapper"><table><thead><tr>
        <th>ID</th><th>Client</th><th>Cabine</th><th>Service</th><th>Montant</th><th>Statut</th><th>Date</th>
      </tr></thead><tbody>${list.map(t => {
        const cl = DB.users.byId(t.client_id), cab = DB.users.byId(t.cabine_id);
        return `<tr>
          <td><code>${Fmt.ref(t.id)}</code></td>
          <td>${cl ? `${cl.prenom} ${cl.nom}` : '—'}</td>
          <td>${cab ? (cab.cabine_nom || `${cab.prenom} ${cab.nom}`) : '—'}</td>
          <td>${t.service || t.type || '—'}</td>
          <td>${Fmt.money(t.montant)}</td>
          <td>${Fmt.status(t.statut)}</td>
          <td>${Fmt.datetime(t.date)}</td>
        </tr>`;
      }).join('')}</tbody></table></div>` : _bilanEmptyState();

  } else if (kind === 'retards') {
    title = `Commandes en retard — ${period}`;
    const list = _bilanFilterByDate(DB.retards.all()).sort((a, b) => new Date(b.date) - new Date(a.date));
    body = list.length ? list.map(r => {
      const cab = DB.users.byId(r.cabine_id);
      return `<div class="rst-admin-row">
        <div class="rst-admin-info">
          <div class="rst-admin-name"><i class="fa-solid fa-triangle-exclamation"></i> Commande ${Fmt.ref(r.transaction_id)}</div>
          <div class="rst-admin-meta">Cabine : ${cab ? (cab.cabine_nom || `${cab.prenom} ${cab.nom}`) : '—'}${r.triggered_suspension ? ' · a entraîné une suspension' : ''}</div>
          <div class="rst-admin-date"><i class="fa-regular fa-clock"></i> ${Fmt.datetime(r.date)}</div>
        </div>
      </div>`;
    }).join('') : _bilanEmptyState();

  } else if (kind === 'retraits') {
    title = `Retraits effectués — ${period}`;
    const list = _bilanFilterByDate(DB.retraits.all().filter(r => r.type !== 'sanction')).sort((a, b) => new Date(b.date) - new Date(a.date));
    body = list.length ? list.map(r => {
      const cab = DB.users.byId(r.cabine_id);
      return `<div class="rst-admin-row">
        <div class="rst-admin-info">
          <div class="rst-admin-name"><i class="fa-solid fa-money-bill-wave"></i> ${cab ? (cab.cabine_nom || `${cab.prenom} ${cab.nom}`) : 'Cabine supprimée'}</div>
          <div class="rst-admin-meta">${r.methode_retrait || '—'} · ${Fmt.money(r.montant)}</div>
          <div class="rst-admin-date"><i class="fa-regular fa-clock"></i> ${Fmt.datetime(r.date)}</div>
        </div>
      </div>`;
    }).join('') : _bilanEmptyState();

  } else if (kind === 'reabonnement') {
    title = `Réabonnements${arg1 ? ' · ' + arg1 : ''} — ${period}`;
    let list = _bilanFilterByDate(DB.resubscriptions.all());
    if (arg1) list = list.filter(r => r.formule === arg1);
    list.sort((a, b) => new Date(b.date) - new Date(a.date));
    body = list.length ? list.map(r => {
      const cab = DB.users.byId(r.cabine_id);
      return `<div class="rst-admin-row">
        <div class="rst-admin-info">
          <div class="rst-admin-name"><i class="fa-solid fa-crown"></i> ${cab ? (cab.cabine_nom || `${cab.prenom} ${cab.nom}`) : 'Cabine supprimée'}</div>
          <div class="rst-admin-meta">Formule ${r.formule} — ${Fmt.money(r.prix)}</div>
          <div class="rst-admin-date"><i class="fa-regular fa-clock"></i> ${Fmt.datetime(r.date)}</div>
        </div>
      </div>`;
    }).join('') : _bilanEmptyState();

  } else if (kind === 'frais') {
    title = `Frais de service gagnés — ${period}`;
    const list = _bilanFilterByDate(DB.transactions.all())
      .filter(t => (t.frais_service || 0) > 0)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    body = list.length ? `<div class="table-wrapper"><table><thead><tr>
        <th>ID</th><th>Client</th><th>Service</th><th>Montant</th><th>Frais</th><th>Date</th>
      </tr></thead><tbody>${list.map(t => {
        const cl = DB.users.byId(t.client_id);
        return `<tr>
          <td><code>${Fmt.ref(t.id)}</code></td>
          <td>${cl ? `${cl.prenom} ${cl.nom}` : '—'}</td>
          <td>${t.service || t.type || '—'}</td>
          <td>${Fmt.money(t.montant)}</td>
          <td><strong>${Fmt.money(t.frais_service)}</strong></td>
          <td>${Fmt.datetime(t.date)}</td>
        </tr>`;
      }).join('')}</tbody></table></div>` : _bilanEmptyState();
  }

  document.getElementById('bilan-detail-title').textContent = title;
  document.getElementById('bilan-detail-body').innerHTML = body;
  openModal('modal-bilan-detail');
}

function exportCSV(type) {
  let data, filename, headers;
  if (type === 'transactions') {
    const txns = DB.transactions.all();
    headers = ['ID','Client','Cabine','Opérateur','N° Bénéficiaire','Montant','Commission','Statut','Date'];
    data = txns.map(t => {
      const c = DB.users.byId(t.client_id);
      const cab = DB.users.byId(t.cabine_id);
      return [t.id, c ? `${c.prenom} ${c.nom}` : '?', cab ? `${cab.prenom} ${cab.nom}` : '?',
              t.operateur, t.numero_beneficiaire, t.montant, t.commission, t.statut,
              new Date(t.date).toLocaleString('fr-CI')];
    });
    filename = 'transactions_kbineplus.csv';
  } else if (type === 'clients') {
    const clients = DB.users.byRole('client');
    headers = ['ID','Prénom','Nom','Téléphone','Email','Solde','Statut','Date création'];
    data = clients.map(c => [c.id, c.prenom, c.nom, c.telephone, c.email, c.solde, c.statut, new Date(c.date_creation).toLocaleDateString('fr-CI')]);
    filename = 'clients_kbineplus.csv';
  } else if (type === 'cabines') {
    const cabines = DB.users.byRole('cabine');
    headers = ['ID','Prénom','Nom','Téléphone','Zone','Solde','Commissions','Statut'];
    data = cabines.map(c => [c.id, c.prenom, c.nom, c.telephone, c.zone||'', DB.business.cabineSoldeDisponible(c), c.commissions_total||0, c.statut]);
    filename = 'cabines_kbineplus.csv';
  } else if (type === 'bilan') {
    if (currentUser.admin_level !== 'super') { Toast.error('Seul le super administrateur peut exporter le bilan.'); return; }
    const label = _bilanPeriodLabel();
    const txns  = _bilanFilterByDate(DB.transactions.all());
    const cabinesNouvelles = _bilanFilterByDate(DB.users.byRole('cabine'), 'date_creation');
    const clientsNouveaux  = _bilanFilterByDate(DB.users.byRole('client'), 'date_creation');
    const rembourses = txns.filter(t => t.statut === 'remboursé');
    const retards     = _bilanFilterByDate(DB.retards.all());
    const retraitsList = _bilanFilterByDate(DB.retraits.all().filter(r => r.type !== 'sanction'));
    const reabonnements = _bilanFilterByDate(DB.resubscriptions.all());
    const vol = (list, field = 'montant') => list.reduce((s, x) => s + (x[field] || 0), 0);

    const todayStr = new Date().toISOString().slice(0, 10);
    const ventesJour = DB.transactions.all().filter(t => t.statut === 'terminé' && (t.date || '').slice(0, 10) === todayStr);
    const fraisTotal = vol(txns, 'frais_service');

    headers = ['Statistique', 'Détail', 'Nombre', 'Volume (F)'];
    data = [
      ['Cabines inscrites', '', cabinesNouvelles.length, ''],
      ['Clients inscrits', '', clientsNouveaux.length, ''],
      ['Transactions effectuées', '', txns.length, vol(txns)],
      ['Commandes remboursées', '', rembourses.length, vol(rembourses)],
      ['Commandes en retard', '', retards.length, ''],
      ['Retraits effectués', '', retraitsList.length, vol(retraitsList)],
      ['Ventes du jour', Fmt.date(todayStr), ventesJour.length, vol(ventesJour)],
      ['Frais de service gagnés', '', txns.filter(t => (t.frais_service||0) > 0).length, fraisTotal],
    ];
    BILAN_SERVICES.forEach(svc => {
      const items = txns.filter(svc.match);
      data.push([svc.label, 'Toutes', items.length, vol(items)]);
      BILAN_STATUTS.forEach(st => {
        const sub = items.filter(t => t.statut === st.key);
        if (sub.length) data.push([svc.label, st.label, sub.length, vol(sub)]);
      });
    });
    data.push(['Réabonnement cabine', 'Toutes formules', reabonnements.length, vol(reabonnements, 'prix')]);
    ['Premium', 'VIP', 'VVIP'].forEach(f => {
      const sub = reabonnements.filter(r => r.formule === f);
      if (sub.length) data.push(['Réabonnement cabine', f, sub.length, vol(sub, 'prix')]);
    });
    filename = `bilan_${label.replace(/\s+/g, '_')}_kbineplus.csv`;
  } else {
    return;
  }
  const csv = [headers, ...data].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
  const blob = new Blob(['ï»¿' + csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  Toast.success(`Rapport "${filename}" téléchargé.`);
}

/* â”€â”€ Admin notifications â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
async function loadAdminNotifications() {
  const list = document.getElementById('admin-notif-list');
  if (!list) return;
  await DB.notifications.refresh(currentUser.id);
  const notifs = DB.notifications.forUser(currentUser.id);
  if (!notifs.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon"><i class="fa-solid fa-bell-slash"></i></div><div class="empty-title">Aucune notification</div></div>`;
    return;
  }
  list.innerHTML = notifs.map(n => `
    <div class="notif-item ${n.lu ? '' : 'unread'}" onclick="markAdminNotifRead('${n.id}',this)">
      <div class="notif-icon"><i class="fa-solid fa-circle-info"></i></div>
      <div class="notif-content">
        <div class="notif-msg">${n.message}</div>
        <div class="notif-time">${Fmt.datetime(n.date)}</div>
      </div>
      ${!n.lu ? '<div class="notif-unread-dot"></div>' : ''}
    </div>`).join('');
  updateNotifBadge();
}

async function markAdminNotifRead(id, el) {
  el.classList.remove('unread');
  el.querySelector('.notif-unread-dot')?.remove();
  updateNotifBadge();
  await DB.notifications.markRead(id);
}

/* ── Réinitialisations mot de passe ───────────────────────────────
   Le nouveau mot de passe est désormais choisi par le demandeur lui-même
   (voir submitResetRequest() dans js/client.js) et haché côté serveur DÈS
   la création (voir api/reset_requests_create.php) — l'admin n'a plus qu'à
   vérifier l'identité via WhatsApp puis appliquer la demande, jamais
   accès au PIN en clair. Le filtrage "demande admin visible seulement du
   super admin" est déjà fait côté serveur (reset_requests_list.php) — la
   liste reçue ici est déjà la bonne portée. */
async function loadResetRequests() {
  const el    = document.getElementById('rst-admin-list');
  const badge = document.getElementById('reset-badge');
  if (!el) return;
  await DB.resetRequests.refresh();
  const list = DB.resetRequests.all();

  const pending = list.filter(r => r.statut === 'en_attente').length;
  if (badge) { badge.textContent = pending; badge.style.display = pending > 0 ? 'inline-flex' : 'none'; }

  if (list.length === 0) {
    el.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:.8rem;">
      <i class="fa-solid fa-check-circle" style="font-size:2rem;color:var(--success);display:block;margin-bottom:10px;"></i>
      Aucune demande de réinitialisation en cours.
    </div>`;
    return;
  }

  const sorted = [...list].sort((a, b) => new Date(b.date_created) - new Date(a.date_created));
  el.innerHTML = sorted.map(r => {
    const isPending = r.statut === 'en_attente';
    const dateStr   = new Date(r.date_created).toLocaleString('fr-CI', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
    const badge     = isPending
      ? `<span class="badge badge-pending"><i class="fa-solid fa-clock"></i> En attente</span>`
      : r.statut === 'traité'
        ? `<span class="badge badge-success"><i class="fa-solid fa-check"></i> Traité</span>`
        : `<span class="badge badge-failed"><i class="fa-solid fa-xmark"></i> Refusé</span>`;
    const actions = isPending ? `
      <button class="btn btn-sm btn-primary" onclick="adminTraiterReset('${r.id}')" style="font-size:.62rem;padding:5px 12px;">
        <i class="fa-solid fa-check"></i> Traiter la demande
      </button>
      <button class="btn btn-sm btn-danger" onclick="refuseReset('${r.id}')" style="font-size:.62rem;padding:5px 12px;">
        <i class="fa-solid fa-ban"></i> Refuser
      </button>` : '';
    // Nom du titulaire recalculé en direct (plutôt que le seul r.nom figé
    // à la création) + lien WhatsApp cliquable pour recontacter le demandeur.
    const holder  = DB.users.all().find(u => u.telephone === r.telephone && u.role === r.role);
    const holderName = holder ? `${holder.prenom || ''} ${holder.nom || ''}`.trim() : (r.nom || '—');
    const waLink  = Fmt.whatsappLink(r.telephone, `Bonjour ${holderName}, au sujet de votre demande de réinitialisation KBINE PLUS.`);
    return `<div class="rst-admin-row">
      <div class="rst-admin-info">
        <div class="rst-admin-name"><i class="fa-solid fa-user"></i> ${holderName || '—'}</div>
        <div class="rst-admin-meta">
          ${waLink ? `<a href="${waLink}" target="_blank" rel="noopener" style="color:#128c4a;font-weight:700;text-decoration:none;"><i class="fa-brands fa-whatsapp"></i> ${Fmt.phone(r.telephone)}</a>` : Fmt.phone(r.telephone)}
          · <span class="badge" style="font-size:.45rem;padding:2px 6px;">${r.role}</span>
        </div>
        <div class="rst-admin-date"><i class="fa-regular fa-clock"></i> ${dateStr}</div>
      </div>
      <div class="rst-admin-actions">
        ${badge}
        <div style="display:flex;gap:6px;margin-top:6px;">${actions}</div>
      </div>
    </div>`;
  }).join('');
}

async function adminTraiterReset(reqId) {
  const r = DB.resetRequests.all().find(x => x.id === reqId);
  if (!r) return;
  if (!confirm(`Appliquer le nouveau mot de passe soumis par ${r.nom || Fmt.phone(r.telephone)} ?`)) return;

  // Le hash a déjà été calculé et validé à la création de la demande
  // (api/reset_requests_create.php) — appliqué atomiquement ici, jamais
  // de PIN en clair à voir ni à revalider côté admin.
  const res = await DB.resetRequests.apply(reqId);
  if (!res.ok) { Toast.error(res.error); return; }

  Toast.success(`Mot de passe réinitialisé pour ${r.nom || Fmt.phone(r.telephone)}.`);
  loadResetRequests();
}

async function refuseReset(reqId) {
  if (!confirm('Refuser cette demande de réinitialisation ?')) return;
  const res = await DB.resetRequests.refuse(reqId);
  if (!res.ok) { Toast.error(res.error); return; }
  Toast.info('Demande refusée.');
  loadResetRequests();
}

/* ── Comptes bloqués (3 mots de passe incorrects consécutifs) ─────────
   Liste unique fusionnée client/cabine/admin (comme "Journal des accès")
   plutôt que 3 onglets séparés — voir Auth.login() dans js/auth.js pour
   le blocage lui-même. Une ligne admin n'est visible que du super admin,
   même règle que loadResetRequests() ci-dessus. */
function loadComptesBloquesAdmin() {
  const all  = DB.users.all().filter(u => u.statut === 'bloqué');
  const list = currentUser.admin_level === 'super' ? all : all.filter(u => u.role !== 'admin');
  const el   = document.getElementById('comptes-bloques-list');
  if (!el) return;

  if (!list.length) {
    el.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:.8rem;">
      <i class="fa-solid fa-lock-open" style="font-size:2rem;color:var(--gray-300);display:block;margin-bottom:10px;"></i>
      Aucun compte bloqué pour le moment.
    </div>`;
    return;
  }

  el.innerHTML = list.map(u => {
    const name = `${u.prenom || ''} ${u.nom || ''}`.trim() || u.cabine_nom || Fmt.phone(u.telephone);
    return `<div class="rst-admin-row">
      <div class="rst-admin-info">
        <div class="rst-admin-name"><i class="fa-solid fa-user-lock"></i> ${name}</div>
        <div class="rst-admin-meta">${Fmt.phone(u.telephone)} · <span class="badge" style="font-size:.45rem;padding:2px 6px;">${u.role}</span></div>
      </div>
      <div class="rst-admin-actions">
        <button class="btn btn-sm btn-primary" onclick="debloquerCompte('${u.id}')" style="font-size:.62rem;padding:5px 12px;">
          <i class="fa-solid fa-lock-open"></i> Débloquer
        </button>
      </div>
    </div>`;
  }).join('');
}

async function debloquerCompte(userId) {
  const user = DB.users.byId(userId);
  if (!user) return;
  if (!confirm(`Débloquer le compte de ${user.prenom || Fmt.phone(user.telephone)} ?`)) return;
  // Persisté côté serveur (voir api/admin_set_account_status.php) — sans
  // ça, le compte restait "bloqué" en base pour toujours (login.php
  // vérifie exactement statut = 'bloqué') malgré le déblocage affiché ici.
  const res = await ServerAPI.adminSetAccountStatus(userId, 'actif');
  if (!res.ok) { Toast.error(res.error || 'Échec du déblocage.'); return; }
  DB.users.update(userId, { statut: 'actif', tentatives_echouees: 0 });
  Toast.success('Compte débloqué.');
  loadComptesBloquesAdmin();
}

/* ── Cabines suspendues (retards/renvois/remboursements répétés, ou
   suspension manuelle) ────────────────────────────────────────────────
   À distinguer de "Comptes bloqués" ci-dessus (3 mots de passe
   incorrects, statut 'bloqué') — ceci liste statut === 'suspendu',
   affiche l'échéance exacte pour une suspension automatique, et réutilise
   toggleCabine(id, true) tel quel pour la levée manuelle (la règle de
   propriété admin/super-admin déjà en place s'y applique automatiquement). */
function loadCabinesSuspenduesAdmin() {
  const list = DB.users.byRole('cabine').filter(c => c.statut === 'suspendu');
  const el   = document.getElementById('cabines-suspendues-list');
  if (!el) return;

  if (!list.length) {
    el.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:.8rem;">
      <i class="fa-solid fa-circle-check" style="font-size:2rem;color:var(--gray-300);display:block;margin-bottom:10px;"></i>
      Aucune cabine suspendue pour le moment.
    </div>`;
    return;
  }

  el.innerHTML = list.map(c => {
    const name  = `${c.prenom || ''} ${c.nom || ''}`.trim() || c.cabine_nom || Fmt.phone(c.telephone);
    const until = c.suspendu_auto && c.suspendu_jusqu
      ? `Déblocage automatique prévu : ${Fmt.datetime(c.suspendu_jusqu)}`
      : `Suspension manuelle — sans échéance automatique`;
    return `<div class="rst-admin-row">
      <div class="rst-admin-info">
        <div class="rst-admin-name"><i class="fa-solid fa-ban"></i> ${name} ${c.cabine_nom ? `(${c.cabine_nom})` : ''}</div>
        <div class="rst-admin-meta">Motif : ${c.suspendu_motif || 'non précisé'}</div>
        <div class="rst-admin-date"><i class="fa-regular fa-clock"></i> ${until}</div>
      </div>
      <div class="rst-admin-actions">
        <button class="btn btn-sm btn-primary" onclick="toggleCabine('${c.id}', true)" style="font-size:.62rem;padding:5px 12px;">
          <i class="fa-solid fa-lock-open"></i> Lever la suspension
        </button>
      </div>
    </div>`;
  }).join('');
}

/* ── Appareils connectés (super administrateur uniquement) ────────────
   Client + Administrateur simple seulement — la cabine garde sa propre
   gestion en libre-service (toggleCabDevicesSection(), js/cabine.js),
   pas dupliquée ici. Réutilise DB.partnerDevices tel quel (déjà générique
   par user_id, voir js/db.js) — voir aussi Auth._hasDeviceLimit (js/auth.js). */
async function loadAppareilsAdmin() {
  const el = document.getElementById('appareils-admin-list');
  if (!el) return;
  await DB.partnerDevices.refresh();

  const devices = DB.partnerDevices.allFromServer().filter(d => {
    const u = DB.users.byId(d.profile_id);
    return u && (u.role === 'client' || (u.role === 'admin' && u.admin_level === 'simple'));
  });

  if (!devices.length) {
    el.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:.8rem;">
      <i class="fa-solid fa-mobile-screen-button" style="font-size:2rem;color:var(--gray-300);display:block;margin-bottom:10px;"></i>
      Aucun appareil connecté pour le moment.
    </div>`;
    return;
  }

  // Regroupé par compte, trié par appareil le plus récent en premier.
  const byUser = {};
  devices.forEach(d => { (byUser[d.profile_id] = byUser[d.profile_id] || []).push(d); });

  el.innerHTML = Object.entries(byUser).map(([userId, list]) => {
    const u = DB.users.byId(userId);
    const name = `${u.prenom || ''} ${u.nom || ''}`.trim() || Fmt.phone(u.telephone);
    const rows = list.sort((a, b) => new Date(b.last_seen_at) - new Date(a.last_seen_at)).map(d => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-top:1px solid var(--gray-100);">
        <div style="font-size:.75rem;">
          <div style="font-weight:700;">${d.label || 'Appareil'}</div>
          <div style="color:var(--gray-400);font-size:.68rem;">Vu le ${Fmt.datetime(d.last_seen_at)}${d.remembered ? ' · Mémorisé' : ''}</div>
        </div>
        <button class="btn btn-sm btn-danger" onclick="deconnecterAppareil('${d.id}')" style="font-size:.6rem;padding:4px 10px;">
          <i class="fa-solid fa-power-off"></i> Déconnecter
        </button>
      </div>`).join('');
    return `<div class="rst-admin-row" style="display:block;">
      <div class="rst-admin-name"><i class="fa-solid fa-user"></i> ${name} <span class="badge" style="font-size:.45rem;padding:2px 6px;">${u.role}</span></div>
      ${rows}
    </div>`;
  }).join('');
}

async function deconnecterAppareil(deviceRecordId) {
  if (!confirm('Déconnecter cet appareil ? Le compte devra se reconnecter depuis celui-ci.')) return;
  const res = await DB.partnerDevices.revoke(deviceRecordId);
  if (!res.ok) { Toast.error(res.error); return; }
  Toast.success('Appareil déconnecté.');
  loadAppareilsAdmin();
}

/* ── Demandes de partenariat ─────────────────────────────────────
   Remplace la lecture localStorage directe (clé 'cbp_applications',
   écrite par prgSubmit() dans js/client.js) — voir
   api/partner_applications_*.php. */
async function loadPartnerRequests() {
  const el    = document.getElementById('partner-admin-list');
  const badge = document.getElementById('partner-badge');
  if (!el) return;
  await DB.partnerApplications.refresh();
  const list = DB.partnerApplications.all();

  const pending = list.filter(a => a.statut === 'en_attente').length;
  if (badge) { badge.textContent = pending; badge.style.display = pending > 0 ? 'inline-flex' : 'none'; }

  if (!list.length) {
    el.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:.8rem;">
      <i class="fa-solid fa-check-circle" style="font-size:2rem;color:var(--success);display:block;margin-bottom:10px;"></i>
      Aucune demande de partenariat en cours.
    </div>`;
    return;
  }

  const sorted = [...list].sort((a, b) => new Date(b.date_created) - new Date(a.date_created));
  el.innerHTML = sorted.map(a => {
    const isPending = a.statut === 'en_attente';
    const dateStr   = new Date(a.date_created).toLocaleString('fr-CI', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
    const badgeHtml = isPending
      ? `<span class="badge badge-pending"><i class="fa-solid fa-clock"></i> En attente</span>`
      : a.statut === 'validée'
        ? `<span class="badge badge-success"><i class="fa-solid fa-check"></i> Validée</span>`
        : `<span class="badge badge-failed"><i class="fa-solid fa-xmark"></i> Refusée</span>`;
    const actions = `
      ${a.telephone ? `<button class="btn btn-sm" style="background:#25D36622;color:#25D366;font-size:.62rem;padding:5px 12px;" onclick="adminContactWhatsapp('${a.telephone}','${a.prenom || ''}')" title="Contacter via WhatsApp">
        <i class="fa-brands fa-whatsapp"></i> WhatsApp
      </button>` : ''}
      ${a.telephone ? `<button class="btn btn-sm" style="background:var(--gray-100);color:var(--gray-600);font-size:.62rem;padding:5px 12px;" onclick="adminCallPhone('${a.telephone}')" title="Appeler">
        <i class="fa-solid fa-phone"></i> Appeler
      </button>` : ''}
      ${isPending ? `
      <button class="btn btn-sm btn-primary" onclick="validatePartnerRequest('${a.id}')" style="font-size:.62rem;padding:5px 12px;">
        <i class="fa-solid fa-check"></i> Valider
      </button>
      <button class="btn btn-sm btn-danger" onclick="refusePartnerRequest('${a.id}')" style="font-size:.62rem;padding:5px 12px;">
        <i class="fa-solid fa-ban"></i> Refuser
      </button>` : ''}
      <button class="btn btn-sm" style="background:var(--gray-100);color:var(--danger);font-size:.62rem;padding:5px 12px;" onclick="deletePartnerRequest('${a.id}','${(a.prenom||'')} ${(a.nom||'')}')" title="Supprimer définitivement">
        <i class="fa-solid fa-trash"></i> Supprimer
      </button>`;
    const puces = a.puces ? `Orange: ${a.puces.orange||0} · Moov: ${a.puces.moov||0} · MTN: ${a.puces.mtn||0}` : '';
    const paiement = (a.paiement_vers || a.numero_compte)
      ? `<div class="rst-admin-meta">${a.paiement_vers ? 'Paiement via ' + a.paiement_vers : ''}${a.numero_compte ? ' · Compte : ' + Fmt.phone(a.numero_compte) : ''}</div>`
      : '';
    return `<div class="rst-admin-row">
      ${a.photo ? `<img src="${a.photo}" alt="Photo" style="width:44px;height:44px;border-radius:50%;object-fit:cover;flex-shrink:0;margin-right:10px;">` : ''}
      <div class="rst-admin-info">
        <div class="rst-admin-name"><i class="fa-solid fa-user"></i> ${a.prenom || ''} ${a.nom || ''}</div>
        <div class="rst-admin-meta"><i class="fa-solid fa-phone"></i> ${Fmt.phone(a.telephone) || '—'} · <i class="fa-regular fa-envelope"></i> ${a.email || '—'}</div>
        ${a.whatsapp ? `<div class="rst-admin-meta"><i class="fa-brands fa-whatsapp"></i> ${Fmt.phone(a.whatsapp)}</div>` : ''}
        <div class="rst-admin-meta">${a.cabine_nom ? 'Cabine : ' + a.cabine_nom + ' · ' : ''}${puces}</div>
        ${(a.abonnement || a.experience) ? `<div class="rst-admin-meta">${a.abonnement ? 'Abonnement souhaité : ' + a.abonnement : ''}${a.experience ? ' · Expérience : ' + a.experience : ''}</div>` : ''}
        ${paiement}
        ${a.motivation ? `<div class="rst-admin-meta" style="font-style:italic;">"${a.motivation}"</div>` : ''}
        <div class="rst-admin-date"><i class="fa-regular fa-clock"></i> ${dateStr}</div>
      </div>
      <div class="rst-admin-actions">
        ${badgeHtml}
        <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">${actions}</div>
      </div>
    </div>`;
  }).join('');
}

async function validatePartnerRequest(appId) {
  const app = DB.partnerApplications.all().find(a => a.id === appId);
  if (!app) { Toast.error('Candidature introuvable.'); return; }
  if (!confirm(`Valider la candidature de ${app.prenom} ${app.nom} et créer son compte cabine ?`)) return;

  // Le hash du PIN a déjà été calculé et l'email déjà validé (Gmail) à la
  // création de la candidature (api/partner_applications_create.php) — le
  // compte cabine est créé atomiquement côté serveur avec ce hash, jamais
  // de PIN en clair à aucun moment de ce flux.
  const res = await DB.partnerApplications.validate(appId);
  if (!res.ok) { Toast.error(res.error); return; }
  await refreshUsersFromServer();

  Toast.success(`Compte cabine créé pour ${app.prenom} ${app.nom}.`);
  loadPartnerRequests();
  loadCabines();
  loadDashboard();
}

async function refusePartnerRequest(appId) {
  if (!confirm('Refuser cette demande de partenariat ?')) return;
  const res = await DB.partnerApplications.refuse(appId);
  if (!res.ok) { Toast.error(res.error); return; }
  Toast.info('Demande de partenariat refusée.');
  loadPartnerRequests();
}

async function deletePartnerRequest(appId, name) {
  if (!confirm(`Supprimer définitivement la demande de ${name.trim() || 'ce candidat'} ? Cette action est irréversible.`)) return;
  const res = await DB.partnerApplications.remove(appId);
  if (!res.ok) { Toast.error(res.error); return; }
  Toast.success('Demande supprimée.');
  loadPartnerRequests();
}

/* ── Classements ──────────────────────────────────────────────────── */
function loadRankings() {
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);

  // Cabinistes du jour : nombre de commandes terminées aujourd'hui, par cabine
  const doneToday = DB.transactions.all().filter(t => t.statut === 'terminé' && new Date(t.date) >= todayStart);
  const todayCounts = {};
  doneToday.forEach(t => { if (t.cabine_id) todayCounts[t.cabine_id] = (todayCounts[t.cabine_id] || 0) + 1; });
  const todayRanked = Object.entries(todayCounts)
    .map(([id, count]) => ({ user: DB.users.byId(id), count }))
    .filter(r => r.user)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  document.getElementById('rank-today-list').innerHTML =
    renderRankList(todayRanked, r => `${r.count} commande${r.count > 1 ? 's' : ''}`);

  // Meilleurs cabinistes : commissions cumulées
  const cabinesRanked = DB.users.byRole('cabine')
    .slice()
    .sort((a, b) => (b.commissions_total || 0) - (a.commissions_total || 0))
    .slice(0, 10)
    .map(u => ({ user: u }));
  document.getElementById('rank-cabines-list').innerHTML =
    renderRankList(cabinesRanked, r => Fmt.money(r.user.commissions_total || 0));

  // Meilleurs clients : volume total transféré (commandes terminées)
  const clientsRanked = DB.users.byRole('client')
    .map(u => ({ user: u, volume: DB.transactions.byClient(u.id).filter(t => t.statut === 'terminé').reduce((s, t) => s + t.montant, 0) }))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 10);
  document.getElementById('rank-clients-list').innerHTML =
    renderRankList(clientsRanked, r => Fmt.money(r.volume));

  // Cabines ayant le plus renvoyé de commandes
  const renvoyeesRanked = DB.users.byRole('cabine')
    .filter(u => (u.commandes_renvoyees || 0) > 0)
    .sort((a, b) => (b.commandes_renvoyees || 0) - (a.commandes_renvoyees || 0))
    .slice(0, 10)
    .map(u => ({ user: u }));
  document.getElementById('rank-renvoyees-list').innerHTML =
    renderRankList(renvoyeesRanked, r => `${r.user.commandes_renvoyees || 0} renvoi${(r.user.commandes_renvoyees||0) > 1 ? 's' : ''}`);

  // Cabines ayant reçu le plus de remboursements (sur leurs commandes terminées)
  const remboursementsRanked = DB.users.byRole('cabine')
    .filter(u => (u.remboursements_recus || 0) > 0)
    .sort((a, b) => (b.remboursements_recus || 0) - (a.remboursements_recus || 0))
    .slice(0, 10)
    .map(u => ({ user: u }));
  document.getElementById('rank-remboursements-list').innerHTML =
    renderRankList(remboursementsRanked, r => `${r.user.remboursements_recus || 0} remboursement${(r.user.remboursements_recus||0) > 1 ? 's' : ''}`);

  // Cabines par palier d'abonnement (VVIP > VIP > Premium), à palier égal : commissions cumulées
  const TIER_RANK = { VVIP: 3, VIP: 2, Premium: 1 };
  const abonnementRanked = DB.users.byRole('cabine')
    .slice()
    .sort((a, b) => {
      const tierDiff = (TIER_RANK[b.abonnement] || 0) - (TIER_RANK[a.abonnement] || 0);
      return tierDiff !== 0 ? tierDiff : (b.commissions_total || 0) - (a.commissions_total || 0);
    })
    .slice(0, 15)
    .map(u => ({ user: u }));
  document.getElementById('rank-abonnement-list').innerHTML =
    renderRankList(abonnementRanked, r => r.user.abonnement || 'Premium');

  renderCabineRankingTable();

  // Ventes par réseau, une liste par opérateur (commandes terminées)
  ['Orange', 'Moov', 'MTN'].forEach(net => {
    const el = document.getElementById(`rank-network-${net.toLowerCase()}-list`);
    if (!el) return;
    const ranked = DB.users.byRole('cabine')
      .map(u => ({ user: u, montant: DB.transactions.byCabine(u.id).filter(t => t.statut === 'terminé' && t.operateur === net).reduce((s, t) => s + t.montant, 0) }))
      .filter(r => r.montant > 0)
      .sort((a, b) => b.montant - a.montant)
      .slice(0, 10);
    el.innerHTML = renderRankList(ranked, r => Fmt.money(r.montant));
  });
}

/* ── Zéro transaction / Client moins actif / Cabines moins actives ────
   Listes purement calculées à l'affichage à partir de DB.transactions
   (déjà triées par date décroissante via byClient()/byCabine(), voir
   js/db.js) — aucun champ dédié ni job périodique, recalcul instantané
   à chaque chargement de l'onglet. */
const INACTIVITE_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours

function loadZeroTransactionAdmin(filterStatut = 'all') {
  const el = document.getElementById('zero-transaction-list');
  if (!el) return;
  let list = DB.users.byRole('client')
    .filter(c => DB.transactions.byClient(c.id).length === 0)
    .sort((a, b) => new Date(b.date_creation) - new Date(a.date_creation));
  if (filterStatut !== 'all') list = list.filter(c => (c.appel_statut || '') === filterStatut);

  if (!list.length) {
    el.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:.8rem;">
      <i class="fa-solid fa-circle-check" style="font-size:2rem;color:var(--success);display:block;margin-bottom:10px;"></i>
      Aucun compte sans commande pour le moment.
    </div>`;
    return;
  }

  el.innerHTML = list.map(c => {
    const stCls = c.appel_statut === 'en_cours' ? 'wip' : c.appel_statut === 'termine' ? 'done' : 'none';
    const note  = c.motif_zero_txn || '';
    return `<div class="ztA-row ${stCls}">
      <div class="ztA-avatar"><i class="fa-solid fa-user"></i></div>
      <div class="ztA-body">
        <div class="ztA-top">
          <span class="ztA-phone">
            <a href="tel:${c.telephone}" style="color:inherit;text-decoration:none;">${Fmt.phone(c.telephone)}</a>
            <button class="ztA-copy" onclick="adminCopyPhone('${c.telephone}')" title="Copier le numéro"><i class="fa-regular fa-copy"></i></button>
          </span>
          <select class="ztA-pill ${stCls}" onchange="setZeroTxnAppelStatut('${c.id}', this.value)">
            <option value=""        ${!c.appel_statut ? 'selected' : ''}>Non classé</option>
            <option value="en_cours" ${c.appel_statut === 'en_cours' ? 'selected' : ''}>En cours d'appel</option>
            <option value="termine"  ${c.appel_statut === 'termine' ? 'selected' : ''}>Appel terminé</option>
          </select>
        </div>
        <div class="ztA-meta"><i class="fa-regular fa-clock"></i> Inscrit le ${Fmt.datetime(c.date_creation)}</div>
        ${note
          ? `<div class="ztA-note-preview" onclick="toggleNoteEditor(this)">« ${note} »</div>`
          : `<div class="ztA-note-toggle" onclick="toggleNoteEditor(this)"><i class="fa-solid fa-plus"></i> Ajouter un commentaire</div>`}
        <textarea class="ztA-note-edit" placeholder="Motif / commentaire (pourquoi aucune commande ?)…"
          onblur="saveZeroTxnNote('${c.id}', this.value)">${note}</textarea>
      </div>
    </div>`;
  }).join('');
}

/* Bascule un repère "note" (aperçu ou lien "+ Ajouter…") vers le
   textarea éditable associé, dans la foulée du modèle A retenu pour
   les listes Classements (voir .ztA-* dans admin.html). La sauvegarde
   (onblur du textarea) déclenche un nouveau rendu qui revient
   automatiquement à l'aperçu. */
function toggleNoteEditor(el) {
  el.style.display = 'none';
  const ta = el.parentElement.querySelector('.ztA-note-edit');
  if (!ta) return;
  ta.style.display = 'block';
  ta.focus();
}

function adminCopyPhone(phone) {
  navigator.clipboard.writeText(phone || '').then(() => Toast.success('Numéro copié !'));
}

/* Génère un lien de connexion sans mot de passe pour un administrateur
   simple (voir ServerAPI.adminCreateLoginLink()/api/admin_magic_login.php et
   la vérification côté boot() qui le consomme via ?login_token=). */
async function generateAdminLoginLink(adminId, name) {
  if (currentUser.admin_level !== 'super') { Toast.error('Seul le super administrateur peut générer un lien de connexion.'); return; }
  const res = await ServerAPI.adminCreateLoginLink(adminId);
  if (!res.ok) { Toast.error(res.error); return; }
  const url = `${location.origin}${location.pathname}?login_token=${res.token}`;
  document.getElementById('admin-login-link-name').textContent = name;
  document.getElementById('admin-login-link-input').value = url;
  openModal('modal-admin-login-link');
}

function copyAdminLoginLink() {
  const input = document.getElementById('admin-login-link-input');
  navigator.clipboard.writeText(input.value || '').then(() => Toast.success('Lien copié !'));
}

async function saveZeroTxnNote(id, value) {
  const c = DB.users.byId(id);
  if (!c || (c.motif_zero_txn || '') === value) return;
  // Persisté côté serveur (voir api/admin_update_user.php) — sans ça, ce
  // commentaire de suivi restait invisible pour les autres administrateurs.
  const res = await ServerAPI.adminUpdateUser({ id, motifZeroTxn: value });
  if (!res.ok) { Toast.error(res.error || 'Échec de l\'enregistrement.'); return; }
  DB.users.update(id, { motif_zero_txn: value });
  Toast.success('Commentaire enregistré.');
}

async function setZeroTxnAppelStatut(id, value) {
  const res = await ServerAPI.adminUpdateUser({ id, appelStatut: value || null });
  if (!res.ok) { Toast.error(res.error || 'Échec de l\'enregistrement.'); return; }
  DB.users.update(id, { appel_statut: value || null });
  const filter = document.getElementById('zt-appel-filter');
  loadZeroTransactionAdmin(filter ? filter.value : 'all');
}

function loadClientsInactifsAdmin(filterStatut = 'all') {
  const el = document.getElementById('clients-inactifs-list');
  if (!el) return;
  const now = Date.now();
  let list = DB.users.byRole('client')
    .map(c => ({ user: c, last: DB.transactions.byClient(c.id)[0] || null }))
    .filter(r => r.last && (now - new Date(r.last.date).getTime()) >= INACTIVITE_MS)
    .sort((a, b) => new Date(a.last.date) - new Date(b.last.date));
  if (filterStatut !== 'all') list = list.filter(r => (r.user.appel_statut || '') === filterStatut);

  if (!list.length) {
    el.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:.8rem;">
      <i class="fa-solid fa-circle-check" style="font-size:2rem;color:var(--success);display:block;margin-bottom:10px;"></i>
      Aucun client inactif depuis 7 jours ou plus.
    </div>`;
    return;
  }

  el.innerHTML = list.map(({ user: c, last }) => {
    const stCls = c.appel_statut === 'en_cours' ? 'wip' : c.appel_statut === 'termine' ? 'done' : 'none';
    const note  = c.motif_inactif || '';
    return `<div class="ztA-row ${stCls}">
      <div class="ztA-avatar"><i class="fa-solid fa-user-clock"></i></div>
      <div class="ztA-body">
        <div class="ztA-top">
          <span class="ztA-phone">
            <a href="tel:${c.telephone}" style="color:inherit;text-decoration:none;">${Fmt.phone(c.telephone)}</a>
            <button class="ztA-copy" onclick="adminCopyPhone('${c.telephone}')" title="Copier le numéro"><i class="fa-regular fa-copy"></i></button>
          </span>
          <select class="ztA-pill ${stCls}" onchange="setInactifAppelStatut('${c.id}', this.value, false)">
            <option value=""        ${!c.appel_statut ? 'selected' : ''}>Non classé</option>
            <option value="en_cours" ${c.appel_statut === 'en_cours' ? 'selected' : ''}>En cours d'appel</option>
            <option value="termine"  ${c.appel_statut === 'termine' ? 'selected' : ''}>Appel terminé</option>
          </select>
        </div>
        <div class="ztA-meta">${last.service || last.type || 'Service'}</div>
        <div class="ztA-meta"><i class="fa-regular fa-clock"></i> Dernière commande le ${Fmt.datetime(last.date)}</div>
        ${note
          ? `<div class="ztA-note-preview" onclick="toggleNoteEditor(this)">« ${note} »</div>`
          : `<div class="ztA-note-toggle" onclick="toggleNoteEditor(this)"><i class="fa-solid fa-plus"></i> Ajouter un commentaire</div>`}
        <textarea class="ztA-note-edit" placeholder="Motif / commentaire…"
          onblur="saveInactifNote('${c.id}', this.value)">${note}</textarea>
      </div>
    </div>`;
  }).join('');
}

function loadCabinesInactivesAdmin(filterStatut = 'all') {
  const el = document.getElementById('cabines-inactives-list');
  if (!el) return;
  const now = Date.now();
  let list = DB.users.byRole('cabine')
    .map(c => ({ user: c, last: DB.transactions.byCabine(c.id).filter(t => t.statut === 'terminé')[0] || null }))
    .filter(r => r.last && (now - new Date(r.last.date).getTime()) >= INACTIVITE_MS)
    .sort((a, b) => new Date(a.last.date) - new Date(b.last.date));
  if (filterStatut !== 'all') list = list.filter(r => (r.user.appel_statut || '') === filterStatut);

  if (!list.length) {
    el.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:.8rem;">
      <i class="fa-solid fa-circle-check" style="font-size:2rem;color:var(--success);display:block;margin-bottom:10px;"></i>
      Aucune cabine inactive depuis 7 jours ou plus.
    </div>`;
    return;
  }

  el.innerHTML = list.map(({ user: c, last }) => {
    const stCls = c.appel_statut === 'en_cours' ? 'wip' : c.appel_statut === 'termine' ? 'done' : 'none';
    const note  = c.motif_inactif || '';
    return `<div class="ztA-row ${stCls}">
      <div class="ztA-avatar"><i class="fa-solid fa-store-slash"></i></div>
      <div class="ztA-body">
        <div class="ztA-top">
          <span class="ztA-phone">${c.cabine_nom || (c.prenom + ' ' + c.nom)}</span>
          <select class="ztA-pill ${stCls}" onchange="setInactifAppelStatut('${c.id}', this.value, true)">
            <option value=""        ${!c.appel_statut ? 'selected' : ''}>Non classé</option>
            <option value="en_cours" ${c.appel_statut === 'en_cours' ? 'selected' : ''}>En cours d'appel</option>
            <option value="termine"  ${c.appel_statut === 'termine' ? 'selected' : ''}>Appel terminé</option>
          </select>
        </div>
        <div class="ztA-meta">
          <i class="fa-brands fa-whatsapp"></i> ${c.whatsapp ? Fmt.phone(c.whatsapp) : '—'}
          · <i class="fa-solid fa-phone"></i>
          <a href="tel:${c.telephone}" style="color:inherit;text-decoration:none;">${Fmt.phone(c.telephone)}</a>
          <button class="ztA-copy" onclick="adminCopyPhone('${c.telephone}')" title="Copier le numéro"><i class="fa-regular fa-copy"></i></button>
        </div>
        <div class="ztA-meta"><i class="fa-regular fa-clock"></i> Dernier service le ${Fmt.datetime(last.date)}</div>
        ${note
          ? `<div class="ztA-note-preview" onclick="toggleNoteEditor(this)">« ${note} »</div>`
          : `<div class="ztA-note-toggle" onclick="toggleNoteEditor(this)"><i class="fa-solid fa-plus"></i> Ajouter un commentaire</div>`}
        <textarea class="ztA-note-edit" placeholder="Motif / commentaire…"
          onblur="saveInactifNote('${c.id}', this.value)">${note}</textarea>
      </div>
    </div>`;
  }).join('');
}

async function saveInactifNote(id, value) {
  const c = DB.users.byId(id);
  if (!c || (c.motif_inactif || '') === value) return;
  // Persisté côté serveur (voir api/admin_update_user.php) — sans ça, ce
  // commentaire de suivi restait invisible pour les autres administrateurs.
  const res = await ServerAPI.adminUpdateUser({ id, motifInactif: value });
  if (!res.ok) { Toast.error(res.error || 'Échec de l\'enregistrement.'); return; }
  DB.users.update(id, { motif_inactif: value });
  Toast.success('Commentaire enregistré.');
}

async function setInactifAppelStatut(id, value, isCabine) {
  const res = await ServerAPI.adminUpdateUser({ id, appelStatut: value || null });
  if (!res.ok) { Toast.error(res.error || 'Échec de l\'enregistrement.'); return; }
  DB.users.update(id, { appel_statut: value || null });
  if (isCabine) {
    const f = document.getElementById('cai-appel-filter');
    loadCabinesInactivesAdmin(f ? f.value : 'all');
  } else {
    const f = document.getElementById('ci-appel-filter');
    loadClientsInactifsAdmin(f ? f.value : 'all');
  }
}

/* Classement combiné des cabines (commandes validées, remboursements,
   ventes) — colonnes triables indépendamment plutôt qu'un score combiné
   (choix acté avec l'utilisateur), même patron que les autres tableaux
   admin (ex. loadRetardsAdmin). */
let _cabRankSort = { field: 'ventes', dir: 'desc' };

function sortCabineRanking(field) {
  _cabRankSort.dir = (_cabRankSort.field === field && _cabRankSort.dir === 'desc') ? 'asc' : 'desc';
  _cabRankSort.field = field;
  renderCabineRankingTable();
}

function renderCabineRankingTable() {
  const tbody = document.getElementById('rank-cabine-table-tbody');
  if (!tbody) return;

  ['commandes', 'remboursements', 'ventes'].forEach(f => {
    const ico = document.getElementById('rank-sort-ico-' + f);
    if (!ico) return;
    if (f !== _cabRankSort.field) { ico.className = 'fa-solid fa-sort'; return; }
    ico.className = _cabRankSort.dir === 'desc' ? 'fa-solid fa-sort-down' : 'fa-solid fa-sort-up';
  });

  const rows = DB.users.byRole('cabine').map(u => {
    const done = DB.transactions.byCabine(u.id).filter(t => t.statut === 'terminé');
    return {
      user: u,
      commandes: done.length,
      remboursements: u.remboursements_recus || 0,
      ventes: done.reduce((s, t) => s + t.montant, 0),
    };
  });

  rows.sort((a, b) => (b[_cabRankSort.field] - a[_cabRankSort.field]) * (_cabRankSort.dir === 'desc' ? 1 : -1));

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state" style="padding:24px"><div class="empty-title">Aucune cabine</div></div></td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => `<tr>
    <td><div class="user-chip"><div class="avatar" style="background:linear-gradient(135deg,var(--secondary),var(--secondary-dark))">${Fmt.initials(r.user.nom, r.user.prenom)}</div><div><div class="name">${r.user.prenom} ${r.user.nom}</div></div></div></td>
    <td><span class="badge badge-info">${r.commandes}</span></td>
    <td>${r.remboursements > 0 ? `<span class="badge badge-failed">${r.remboursements}</span>` : '<span style="color:var(--gray-400)">0</span>'}</td>
    <td><strong>${Fmt.money(r.ventes)}</strong></td>
  </tr>`).join('');
}

function renderRankList(items, valueFn) {
  if (!items.length) return `<div class="empty-state" style="padding:24px"><div class="empty-title">Aucune donnée</div></div>`;
  return items.map((r, i) => `
    <div class="rst-admin-row">
      <div style="width:26px;height:26px;border-radius:50%;background:${i < 3 ? '#FEF3C7' : 'var(--gray-100)'};color:${i < 3 ? '#CA8A04' : 'var(--gray-500)'};display:flex;align-items:center;justify-content:center;font-weight:800;font-size:.72rem;flex-shrink:0;">${i + 1}</div>
      <div class="rst-admin-info">
        <div class="rst-admin-name"><i class="fa-solid fa-user"></i> ${r.user.prenom} ${r.user.nom}</div>
        <div class="rst-admin-meta">${Fmt.phone(r.user.telephone)}</div>
      </div>
      <div class="rst-admin-actions">
        <span style="font-weight:800;color:var(--secondary);">${valueFn(r)}</span>
      </div>
    </div>`).join('');
}

/* ── Settings ─────────────────────────────────────────────────────── */
async function loadSettings() {
  const s = await DB.settings.get();
  const d = _adminResume.settingsDraft; // brouillon non enregistré, prioritaire sur la valeur en base
  const el = document.getElementById('settings-content');
  if (!el) return;
  el.innerHTML = `
    <div class="form-group"><label class="form-label">Nom de la plateforme</label>
      <input type="text" class="form-control" id="s-name" value="${(d ? d.platformName : s.platformName) || 'KBINE PLUS'}" oninput="_saveSettingsDraft()" /></div>
    <div class="form-group"><label class="form-label">Devise</label>
      <input type="text" class="form-control" id="s-currency" value="${(d ? d.currency : s.currency) || 'F'}" oninput="_saveSettingsDraft()" /></div>
    <div class="grid-2" style="gap:12px;">
      <div class="form-group"><label class="form-label">Transfert minimum (F)</label>
        <input type="number" class="form-control" id="s-min" value="${(d ? d.minTransfer : s.minTransfer) || 500}" oninput="_saveSettingsDraft()" /></div>
      <div class="form-group"><label class="form-label">Transfert maximum (F)</label>
        <input type="number" class="form-control" id="s-max" value="${(d ? d.maxTransfer : s.maxTransfer) || 100000}" oninput="_saveSettingsDraft()" /></div>
    </div>
    <button class="btn btn-primary" onclick="saveSettings()"><i class="fa-solid fa-save"></i> Enregistrer</button>`;
}

/* ── Actualités (bandeau accueil client) ──────────────────────────────
   Remplace l'ancien bandeau Football/Politique codé en dur (aucun
   rapport avec l'app) — voir renderActualites(), js/client.js. Stockée
   dans settings.actualites (JSON), même patron que maintenance/assistance
   déjà en place : aucun nouvel endpoint, juste DB.settings.update(). */
async function loadActualitesAdmin() {
  const el = document.getElementById('actu-admin-list');
  if (!el) return;
  const items = ((await DB.settings.get()).actualites || []).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  if (!items.length) {
    el.innerHTML = `<div style="padding:12px 0;color:var(--gray-400);font-size:.78rem;">Aucune actualité publiée pour le moment.</div>`;
    return;
  }
  el.innerHTML = items.map(a => `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:10px 0;border-top:1px solid var(--gray-100);">
      <div style="min-width:0;">
        <div style="font-weight:700;font-size:.8rem;">${a.titre}</div>
        ${a.message ? `<div style="font-size:.74rem;color:var(--gray-500);margin-top:2px;">${a.message}</div>` : ''}
        <div style="font-size:.66rem;color:var(--gray-400);margin-top:4px;">${Fmt.datetime(a.date)}</div>
      </div>
      <button class="btn btn-sm btn-danger" onclick="deleteActualite('${a.id}')" style="font-size:.6rem;padding:4px 10px;flex-shrink:0;">
        <i class="fa-solid fa-trash"></i>
      </button>
    </div>`).join('');
}

async function publishActualite() {
  const titre = document.getElementById('actu-new-titre').value.trim();
  const message = document.getElementById('actu-new-message').value.trim();
  if (!titre) { Toast.error('Le titre est obligatoire.'); return; }

  const current = (await DB.settings.get()).actualites || [];
  const updated = [...current, { id: 'actu_' + Date.now(), titre, message, date: new Date().toISOString() }];
  await DB.settings.update({ actualites: updated });

  document.getElementById('actu-new-titre').value = '';
  document.getElementById('actu-new-message').value = '';
  Toast.success('Actualité publiée.');
  loadActualitesAdmin();
}

async function deleteActualite(id) {
  if (!confirm('Supprimer cette actualité ?')) return;
  const current = (await DB.settings.get()).actualites || [];
  await DB.settings.update({ actualites: current.filter(a => a.id !== id) });
  Toast.success('Actualité supprimée.');
  loadActualitesAdmin();
}

function _saveSettingsDraft() {
  _adminResume.settingsDraft = {
    platformName: document.getElementById('s-name').value,
    currency:     document.getElementById('s-currency').value,
    minTransfer:  parseInt(document.getElementById('s-min').value),
    maxTransfer:  parseInt(document.getElementById('s-max').value),
  };
  _saveAdminResume();
}

async function saveSettings() {
  await DB.settings.update({
    platformName: document.getElementById('s-name').value,
    currency:     document.getElementById('s-currency').value,
    minTransfer:  parseInt(document.getElementById('s-min').value),
    maxTransfer:  parseInt(document.getElementById('s-max').value),
  });
  _adminResume.settingsDraft = null;
  _saveAdminResume();
  Toast.success('Paramètres enregistrés.');
}

/* ── Maintenance ──────────────────────────────────────────────────────
   Message global (bandeau côté client) et maintenance par service (les 6
   boutons d'action rapide de l'espace privé client). Le client est
   averti/bloqué à l'usage — voir js/client.js. Recharge UV et les 3
   réseaux (Orange/MTN/Moov) sont gérés exclusivement depuis l'onglet
   "UV Cabine" (super admin uniquement, voir loadUvCabineAdmin ci-dessous)
   — retirés d'ici pour qu'un admin simple habilité sur cet onglet ne
   puisse pas les modifier indirectement via le même indicateur partagé. */
const MAINTENANCE_SERVICE_LABELS = {
  recharger: 'Recharger', depenses: 'Dépenses', transferer: 'Transférer',
  historique: 'Historique', facture: 'Facture', exchange: 'Exchange',
};

async function loadMaintenanceAdmin() {
  const m = (await DB.settings.get()).maintenance || {};
  const draft    = _adminResume.maintenanceDraft; // brouillon non enregistré, prioritaire sur la base
  const global   = draft ? draft.global   : (m.global   || { enabled: false, message: '' });
  const services = draft ? draft.services : (m.services || {});

  document.getElementById('maint-global-enabled').checked = !!global.enabled;
  document.getElementById('maint-global-message').value   = global.message || '';
  document.getElementById('maint-global-enabled').onchange = _saveMaintenanceDraft;
  document.getElementById('maint-global-message').oninput  = _saveMaintenanceDraft;

  document.getElementById('maint-services-content').innerHTML = Object.entries(MAINTENANCE_SERVICE_LABELS).map(([key, label]) => `
    <label class="chip-toggle">
      <input type="checkbox" class="maint-service-chk" data-key="${key}" ${services[key] ? 'checked' : ''} onchange="_saveMaintenanceDraft()">
      <span class="chip-dot"><i class="fa-solid fa-check"></i></span>${label}
    </label>`).join('');
}

function _saveMaintenanceDraft() {
  const services = {};
  document.querySelectorAll('.maint-service-chk').forEach(chk => { services[chk.dataset.key] = chk.checked; });
  _adminResume.maintenanceDraft = {
    global: {
      enabled: document.getElementById('maint-global-enabled').checked,
      message: document.getElementById('maint-global-message').value,
    },
    services,
  };
  _saveAdminResume();
}

async function saveMaintenanceAdmin() {
  // Relit l'objet maintenance courant : recharge_uv/networks appartiennent
  // désormais à l'onglet "UV Cabine" et ne doivent jamais être écrasés par
  // une sauvegarde faite depuis cet onglet-ci (DB.settings.update fait une
  // fusion superficielle — {maintenance:{...}} remplace tout l'objet).
  const current  = (await DB.settings.get()).maintenance || {};
  const services = { ...current.services };
  document.querySelectorAll('.maint-service-chk').forEach(chk => { services[chk.dataset.key] = chk.checked; });

  await DB.settings.update({
    maintenance: {
      global: {
        enabled: document.getElementById('maint-global-enabled').checked,
        message: document.getElementById('maint-global-message').value.trim(),
      },
      services,
      networks: current.networks,
    },
  });
  _adminResume.maintenanceDraft = null;
  _saveAdminResume();
  Toast.success('Maintenance mise à jour.');
}

/* ── UV Cabine (super admin uniquement) ────────────────────────────────
   Bloque/débloque le service Recharge UV et les réseaux (Orange/MTN/Moov)
   dans l'espace cabine — réutilise exactement les mêmes indicateurs que
   l'onglet "Maintenance" générique (maintenance.services.recharge_uv /
   maintenance.networks), donc un blocage ici affecte aussi la Recharge UV
   côté client (voulu, un seul interrupteur pour les deux espaces). Chaque
   bascule s'enregistre et se journalise immédiatement (DB.maintenanceLogs),
   sur le patron de toggleCabinePermission ci-dessus, plutôt que le patron
   brouillon-puis-bouton de l'onglet Maintenance générique. Accessible
   uniquement au super admin : masqué côté nav (SUPER_ONLY_VIEWS) ET
   revérifié ici à chaque action (défense en profondeur, aucun accès
   direct aux fonctions de sauvegarde possible sans passer par l'UI). */
async function loadUvCabineAdmin() {
  if (currentUser.admin_level !== 'super') return;
  const m = (await DB.settings.get()).maintenance || {};
  const services = m.services || {};
  const networks = m.networks || {};
  document.getElementById('uvcab-recharge-uv-chk').checked = !!services.recharge_uv;
  ['Orange', 'MTN', 'Moov'].forEach(net => {
    const el = document.getElementById(`uvcab-net-${net}`);
    if (el) el.checked = !!networks[net];
  });
  loadUvCabineLogs();
}

async function toggleUvCabineService(checkboxEl) {
  if (currentUser.admin_level !== 'super') {
    Toast.error('Seul le super administrateur peut effectuer ce changement.');
    checkboxEl.checked = !checkboxEl.checked;
    return;
  }
  const current  = (await DB.settings.get()).maintenance || {};
  const services = { ...current.services, recharge_uv: checkboxEl.checked };
  await DB.settings.update({ maintenance: { ...current, services } });
  DB.maintenanceLogs.create({
    admin_id: currentUser.id, admin_name: `${currentUser.prenom} ${currentUser.nom}`,
    action: 'service', key: 'recharge_uv', active: checkboxEl.checked,
  });
  Toast.success(`Recharge UV ${checkboxEl.checked ? 'bloquée' : 'débloquée'} (cabine et client).`);
  loadUvCabineLogs();
}

async function toggleUvCabineNetwork(net, checkboxEl) {
  if (currentUser.admin_level !== 'super') {
    Toast.error('Seul le super administrateur peut effectuer ce changement.');
    checkboxEl.checked = !checkboxEl.checked;
    return;
  }
  const current  = (await DB.settings.get()).maintenance || {};
  const networks = { ...current.networks, [net]: checkboxEl.checked };
  await DB.settings.update({ maintenance: { ...current, networks } });
  DB.maintenanceLogs.create({
    admin_id: currentUser.id, admin_name: `${currentUser.prenom} ${currentUser.nom}`,
    action: 'network', key: net, active: checkboxEl.checked,
  });
  Toast.success(`${net} ${checkboxEl.checked ? 'bloqué (Indisponible)' : 'débloqué'} côté cabine et client.`);
  loadUvCabineLogs();
}

function loadUvCabineLogs() {
  _renderUvCabineLogs();
  DB.maintenanceLogs.refresh().then(_renderUvCabineLogs);
}

function _renderUvCabineLogs() {
  const el = document.getElementById('uvcab-logs-list');
  if (!el) return;
  // Exclut les entrées des nouveaux réseaux par service / messages Facture
  // (champ `service`, voir onglet "Disponibilité services") pour que ce
  // journal reste focalisé sur la Recharge UV / les réseaux partagés.
  const list = DB.maintenanceLogs.all().filter(l => !l.service).sort((a, b) => new Date(b.date) - new Date(a.date));
  if (!list.length) {
    el.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:.8rem;">
      <i class="fa-solid fa-clock-rotate-left" style="font-size:2rem;color:var(--gray-300);display:block;margin-bottom:10px;"></i>
      Aucune action journalisée.
    </div>`;
    return;
  }
  el.innerHTML = list.map(l => {
    const dateStr = new Date(l.date).toLocaleString('fr-CI', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
    const what = l.action === 'service' ? 'Recharge UV' : l.key;
    return `<div class="rst-admin-row">
      <div class="rst-admin-info">
        <div class="rst-admin-name"><i class="fa-solid fa-user-shield"></i> ${l.admin_name || '—'}</div>
        <div class="rst-admin-meta">${what} — ${l.active ? 'bloqué' : 'débloqué'}</div>
        <div class="rst-admin-date"><i class="fa-regular fa-clock"></i> ${dateStr}</div>
      </div>
    </div>`;
  }).join('');
}

/* ── Disponibilité des services (super admin uniquement) ──────────────
   Réseaux indépendants par service (Exchange/Recharge) + messages
   d'indisponibilité par service Facture — voir maintenance.networksByService/
   maintenance.factureServices (js/db.js) et isNetworkInMaintenanceForService.
   Distinct de l'onglet "UV Cabine" (qui édite l'objet réseaux partagé
   historique) et de "Maintenance" (interrupteurs de service globaux). */
const DISPO_FACTURE_SERVICES = ['cie_prepaye', 'cie_facture', 'sodeci', 'canal_plus', 'canalbox', 'sotra'];
const DISPO_FACTURE_LABELS = {
  cie_prepaye: 'Prépayé CIE', cie_facture: 'Facture CIE', sodeci: 'SODECI',
  canal_plus: 'CANAL+', canalbox: 'CANALBOX', sotra: 'SOTRA',
};

async function loadDispoServicesAdmin() {
  if (currentUser.admin_level !== 'super') return;
  const m = (await DB.settings.get()).maintenance || {};
  ['Orange', 'MTN', 'Moov'].forEach(n => {
    const el = document.getElementById(`dispo-exchange-${n}`);
    if (el) el.checked = !!m.networksByService?.exchange?.[n];
  });
  ['Orange', 'MTN', 'Moov', 'Wave'].forEach(n => {
    const el = document.getElementById(`dispo-recharge-${n}`);
    if (el) el.checked = !!m.networksByService?.recharge?.[n];
  });
  DISPO_FACTURE_SERVICES.forEach(key => {
    const fs  = m.factureServices?.[key] || { blocked: false, message: '' };
    const chk = document.getElementById(`dispo-fact-blocked-${key}`);
    const txt = document.getElementById(`dispo-fact-msg-${key}`);
    if (chk) chk.checked = !!fs.blocked;
    if (txt) txt.value = fs.message || '';
  });
  loadDispoLogs();
}

async function toggleServiceNetwork(service, net, checkboxEl) {
  if (currentUser.admin_level !== 'super') { Toast.error('Réservé au super administrateur.'); return; }
  const current = (await DB.settings.get()).maintenance || {};
  const networksByService = { ...current.networksByService, [service]: { ...current.networksByService?.[service], [net]: checkboxEl.checked } };
  await DB.settings.update({ maintenance: { ...current, networksByService } });
  DB.maintenanceLogs.create({
    admin_id: currentUser.id, admin_name: `${currentUser.prenom} ${currentUser.nom}`,
    action: 'network', service, key: net, active: checkboxEl.checked,
  });
  Toast.success(`${net} ${checkboxEl.checked ? 'bloqué' : 'débloqué'} pour ${service === 'exchange' ? 'Exchange' : 'Recharge'}.`);
  loadDispoLogs();
}

async function saveDispoFactureMessages() {
  if (currentUser.admin_level !== 'super') { Toast.error('Réservé au super administrateur.'); return; }
  const current = (await DB.settings.get()).maintenance || {};
  const factureServices = { ...current.factureServices };
  DISPO_FACTURE_SERVICES.forEach(key => {
    const chk    = document.getElementById(`dispo-fact-blocked-${key}`);
    const txt    = document.getElementById(`dispo-fact-msg-${key}`);
    const before = factureServices[key] || { blocked: false, message: '' };
    const after  = { blocked: !!chk?.checked, message: (txt?.value || '').trim() };
    if (before.blocked !== after.blocked || before.message !== after.message) {
      DB.maintenanceLogs.create({
        admin_id: currentUser.id, admin_name: `${currentUser.prenom} ${currentUser.nom}`,
        action: 'facture_message', service: 'facture', key, active: after.blocked, message: after.message,
      });
    }
    factureServices[key] = after;
  });
  await DB.settings.update({ maintenance: { ...current, factureServices } });
  Toast.success('Messages Facture mis à jour.');
  loadDispoLogs();
}

function loadDispoLogs() {
  _renderDispoLogs();
  DB.maintenanceLogs.refresh().then(_renderDispoLogs);
}

function _renderDispoLogs() {
  const el = document.getElementById('dispo-logs-list');
  if (!el) return;
  const list = DB.maintenanceLogs.all()
    .filter(l => ['exchange', 'recharge', 'facture'].includes(l.service))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  if (!list.length) {
    el.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:.8rem;">
      <i class="fa-solid fa-clock-rotate-left" style="font-size:2rem;color:var(--gray-300);display:block;margin-bottom:10px;"></i>
      Aucune action journalisée.
    </div>`;
    return;
  }
  el.innerHTML = list.map(l => {
    const dateStr = new Date(l.date).toLocaleString('fr-CI', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
    let what, state;
    if (l.action === 'network') {
      what = `Réseau ${l.key} — ${l.service === 'exchange' ? 'Exchange' : 'Recharge'}`;
      state = l.active ? 'bloqué' : 'débloqué';
    } else {
      what = `Message Facture — ${DISPO_FACTURE_LABELS[l.key] || l.key}`;
      state = l.active ? `bloqué — "${l.message || ''}"` : 'débloqué';
    }
    return `<div class="rst-admin-row">
      <div class="rst-admin-info">
        <div class="rst-admin-name"><i class="fa-solid fa-user-shield"></i> ${l.admin_name || '—'}</div>
        <div class="rst-admin-meta">${what} — ${state}</div>
        <div class="rst-admin-date"><i class="fa-regular fa-clock"></i> ${dateStr}</div>
      </div>
    </div>`;
  }).join('');
}

/* ── Assistance (numéros WhatsApp ×100 max, email, Facebook, Snapchat) ── */
let _assistanceWhatsapp = [];

async function loadAssistanceAdmin() {
  const a = (await DB.settings.get()).assistance || {};
  const draft = _adminResume.assistanceDraft; // brouillon non enregistré, prioritaire sur la base
  _assistanceWhatsapp = draft ? [...draft.whatsapp] : (Array.isArray(a.whatsapp) ? [...a.whatsapp] : []);

  const el = document.getElementById('assistance-content');
  if (!el) return;
  el.innerHTML = `
    <div class="form-group">
      <label class="form-label">Numéros WhatsApp d'assistance (max 100)</label>
      <div id="assistance-whatsapp-list"></div>
      <button type="button" class="btn btn-ghost btn-sm" style="margin-top:6px;" onclick="addWhatsappNumberField()">
        <i class="fa-solid fa-plus"></i> Ajouter un numéro
      </button>
    </div>
    <div class="grid-2" style="gap:12px;">
      <div class="form-group"><label class="form-label">Email de contact</label>
        <input type="email" class="form-control" id="assist-email" value="${(draft ? draft.email : a.email) || ''}" oninput="_saveAssistanceDraft()" /></div>
      <div class="form-group"><label class="form-label">Lien Facebook</label>
        <input type="text" class="form-control" id="assist-facebook" value="${(draft ? draft.facebook : a.facebook) || ''}" oninput="_saveAssistanceDraft()" /></div>
    </div>
    <div class="form-group"><label class="form-label">Lien Snapchat</label>
      <input type="text" class="form-control" id="assist-snapchat" value="${(draft ? draft.snapchat : a.snapchat) || ''}" oninput="_saveAssistanceDraft()" /></div>
    <button class="btn btn-primary" onclick="saveAssistanceAdmin()"><i class="fa-solid fa-save"></i> Enregistrer</button>`;

  renderWhatsappNumberFields();
}

function renderWhatsappNumberFields() {
  const box = document.getElementById('assistance-whatsapp-list');
  if (!box) return;
  if (!_assistanceWhatsapp.length) {
    box.innerHTML = `<div style="font-size:.75rem;color:var(--gray-400);">Aucun numéro renseigné.</div>`;
    return;
  }
  box.innerHTML = _assistanceWhatsapp.map((num, idx) => `
    <div style="display:flex;gap:8px;margin-bottom:6px;">
      <input type="tel" class="form-control assistance-wa-input" data-idx="${idx}" value="${num}" placeholder="XX XX XX XX XX" oninput="_saveAssistanceDraft()" />
      <button type="button" class="btn btn-sm btn-danger" onclick="removeWhatsappNumberField(${idx})"><i class="fa-solid fa-trash"></i></button>
    </div>`).join('');
}

function _saveAssistanceDraft() {
  _adminResume.assistanceDraft = {
    whatsapp: [...document.querySelectorAll('.assistance-wa-input')].map(inp => inp.value),
    email:    document.getElementById('assist-email')?.value || '',
    facebook: document.getElementById('assist-facebook')?.value || '',
    snapchat: document.getElementById('assist-snapchat')?.value || '',
  };
  _saveAdminResume();
}

function addWhatsappNumberField() {
  if (_assistanceWhatsapp.length >= 100) { Toast.error('Maximum 100 numéros.'); return; }
  _assistanceWhatsapp.push('');
  renderWhatsappNumberFields();
  _saveAssistanceDraft();
}

function removeWhatsappNumberField(idx) {
  _assistanceWhatsapp.splice(idx, 1);
  renderWhatsappNumberFields();
  _saveAssistanceDraft();
}

async function saveAssistanceAdmin() {
  const whatsapp = [...document.querySelectorAll('.assistance-wa-input')]
    .map(inp => inp.value.replace(/\s/g, '').trim())
    .filter(Boolean);

  await DB.settings.update({
    assistance: {
      whatsapp,
      email:    document.getElementById('assist-email').value.trim(),
      facebook: document.getElementById('assist-facebook').value.trim(),
      snapchat: document.getElementById('assist-snapchat').value.trim(),
    },
  });
  _assistanceWhatsapp = whatsapp;
  _adminResume.assistanceDraft = null;
  _saveAdminResume();
  Toast.success('Coordonnées d\'assistance enregistrées.');
}

/* ── Assistant clientèle cabine (numéros WhatsApp, indépendant de
   l'Assistance générale ci-dessus) — alimente le bouton WhatsApp du
   bottom-nav cabine, voir openCabWhatsappPicker() dans js/cabine.js. */
let _assistantCabineWhatsapp = [];

async function loadAssistantCabineAdmin() {
  const a = (await DB.settings.get()).assistant_cabine || {};
  _assistantCabineWhatsapp = Array.isArray(a.whatsapp) ? a.whatsapp.map(DB.normalizeContact) : [];
  renderAssistantCabineFields();
}

function renderAssistantCabineFields() {
  const box = document.getElementById('assistant-cabine-list');
  if (!box) return;
  if (!_assistantCabineWhatsapp.length) {
    box.innerHTML = `<div style="font-size:.75rem;color:var(--gray-400);">Aucun numéro renseigné.</div>`;
    return;
  }
  box.innerHTML = _assistantCabineWhatsapp.map((c, idx) => `
    <div style="display:flex;gap:8px;margin-bottom:6px;">
      <input type="text" class="form-control assistant-cabine-nom" data-idx="${idx}" value="${c.nom || ''}" placeholder="Nom" style="max-width:130px;" />
      <input type="tel" class="form-control assistant-cabine-input" data-idx="${idx}" value="${c.numero || ''}" placeholder="XX XX XX XX XX" />
      <button type="button" class="btn btn-sm btn-danger" onclick="removeAssistantCabineField(${idx})"><i class="fa-solid fa-trash"></i></button>
    </div>`).join('');
}

function addAssistantCabineField() {
  _assistantCabineWhatsapp.push({ nom: '', numero: '' });
  renderAssistantCabineFields();
}

function removeAssistantCabineField(idx) {
  _assistantCabineWhatsapp.splice(idx, 1);
  renderAssistantCabineFields();
}

async function saveAssistantCabineAdmin() {
  const noms    = [...document.querySelectorAll('.assistant-cabine-nom')].map(inp => inp.value.trim());
  const numeros = [...document.querySelectorAll('.assistant-cabine-input')].map(inp => inp.value.replace(/\s/g, '').trim());
  const whatsapp = noms.map((nom, i) => ({ nom, numero: numeros[i] })).filter(c => c.numero);
  await DB.settings.update({ assistant_cabine: { whatsapp } });
  _assistantCabineWhatsapp = whatsapp;
  renderAssistantCabineFields();
  Toast.success('Numéros WhatsApp cabine enregistrés.');
}

/* ── Assistant clientèle client (numéros + programmation horaire) ──
   Liste totalement indépendante de la liste cabine ci-dessus. Alimente
   le bouton Aide du bottom-nav client : sélection manuelle par défaut,
   redirection directe sans choix quand un créneau programmé est actif
   (voir activeScheduledAssistant()/handleClientWhatsappClick() dans
   js/client.js). */
let _assistantClientWhatsapp = [];
let _assistantClientSchedule = [];

const ASSISTANT_CLIENT_DAYS = [
  { val: 1, lbl: 'Lun' }, { val: 2, lbl: 'Mar' }, { val: 3, lbl: 'Mer' },
  { val: 4, lbl: 'Jeu' }, { val: 5, lbl: 'Ven' }, { val: 6, lbl: 'Sam' },
  { val: 0, lbl: 'Dim' },
];

async function loadAssistantClientAdmin() {
  const a = (await DB.settings.get()).assistant_client || {};
  _assistantClientWhatsapp = Array.isArray(a.whatsapp) ? a.whatsapp.map(DB.normalizeContact) : [];
  _assistantClientSchedule = Array.isArray(a.schedule) ? a.schedule.map(s => ({ ...s })) : [];
  renderAssistantClientFields();
  renderAssistantClientSchedule();
}

function renderAssistantClientFields() {
  const box = document.getElementById('assistant-client-list');
  if (!box) return;
  if (!_assistantClientWhatsapp.length) {
    box.innerHTML = `<div style="font-size:.75rem;color:var(--gray-400);">Aucun numéro renseigné.</div>`;
    return;
  }
  box.innerHTML = _assistantClientWhatsapp.map((c, idx) => `
    <div style="display:flex;gap:8px;margin-bottom:6px;">
      <input type="text" class="form-control assistant-client-nom" data-idx="${idx}" value="${c.nom || ''}" placeholder="Nom" style="max-width:130px;" />
      <input type="tel" class="form-control assistant-client-input" data-idx="${idx}" value="${c.numero || ''}" placeholder="XX XX XX XX XX" />
      <button type="button" class="btn btn-sm btn-danger" onclick="removeAssistantClientField(${idx})"><i class="fa-solid fa-trash"></i></button>
    </div>`).join('');
}

function addAssistantClientField() {
  _assistantClientWhatsapp.push({ nom: '', numero: '' });
  renderAssistantClientFields();
}

function removeAssistantClientField(idx) {
  const removed = _assistantClientWhatsapp[idx];
  _assistantClientWhatsapp.splice(idx, 1);
  // Un créneau programmé sur un numéro supprimé n'a plus de sens.
  _assistantClientSchedule = _assistantClientSchedule.filter(s => s.numero !== removed?.numero);
  renderAssistantClientFields();
  renderAssistantClientSchedule();
}

function _currentAssistantClientContacts() {
  const noms    = [...document.querySelectorAll('.assistant-client-nom')].map(inp => inp.value.trim());
  const numeros = [...document.querySelectorAll('.assistant-client-input')].map(inp => inp.value.replace(/\s/g, '').trim());
  return noms.map((nom, i) => ({ nom, numero: numeros[i] })).filter(c => c.numero);
}

function renderAssistantClientSchedule() {
  const box = document.getElementById('assistant-client-schedule-list');
  if (!box) return;
  const contacts = _currentAssistantClientContacts();

  if (!_assistantClientSchedule.length) {
    box.innerHTML = `<div style="font-size:.75rem;color:var(--gray-400);margin-bottom:8px;">Aucun créneau programmé — le client verra toujours la liste de choix.</div>`;
    return;
  }

  box.innerHTML = _assistantClientSchedule.map(s => `
    <div class="assistant-client-sched-row" data-id="${s.id}" style="border:1px solid var(--gray-200);border-radius:10px;padding:10px;margin-bottom:8px;">
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
        ${ASSISTANT_CLIENT_DAYS.map(d => `
          <label style="display:flex;align-items:center;gap:4px;font-size:.72rem;">
            <input type="checkbox" class="assistant-client-sched-day" value="${d.val}" ${s.jours.includes(d.val) ? 'checked' : ''} /> ${d.lbl}
          </label>`).join('')}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <input type="time" class="form-control assistant-client-sched-debut" value="${s.debut || ''}" style="max-width:120px;" />
        <span style="font-size:.75rem;color:var(--gray-400);">à</span>
        <input type="time" class="form-control assistant-client-sched-fin" value="${s.fin || ''}" style="max-width:120px;" />
        <select class="form-control assistant-client-sched-numero" style="max-width:180px;">
          ${contacts.length ? contacts.map(c => `<option value="${c.numero}" ${c.numero === s.numero ? 'selected' : ''}>${c.nom || c.numero}</option>`).join('') : '<option value="">Aucun numéro disponible</option>'}
        </select>
        <button type="button" class="btn btn-sm btn-danger" onclick="removeAssistantClientScheduleRow('${s.id}')"><i class="fa-solid fa-trash"></i></button>
      </div>
    </div>`).join('');
}

function addAssistantClientScheduleRow() {
  const contacts = _currentAssistantClientContacts();
  if (!contacts.length) { Toast.error('Ajoutez au moins un numéro WhatsApp avant de programmer un créneau.'); return; }
  _assistantClientSchedule.push({ id: 'sch_' + DB.uid(), jours: [], debut: '08:00', fin: '18:00', numero: contacts[0].numero });
  renderAssistantClientSchedule();
}

function removeAssistantClientScheduleRow(id) {
  _assistantClientSchedule = _assistantClientSchedule.filter(s => s.id !== id);
  renderAssistantClientSchedule();
}

async function saveAssistantClientAdmin() {
  const whatsapp = _currentAssistantClientContacts();

  const schedule = [...document.querySelectorAll('.assistant-client-sched-row')].map(row => {
    const jours = [...row.querySelectorAll('.assistant-client-sched-day:checked')].map(cb => parseInt(cb.value, 10));
    return {
      id: row.dataset.id,
      jours,
      debut: row.querySelector('.assistant-client-sched-debut')?.value || '',
      fin: row.querySelector('.assistant-client-sched-fin')?.value || '',
      numero: row.querySelector('.assistant-client-sched-numero')?.value || '',
    };
  }).filter(s => s.jours.length && s.debut && s.fin && s.numero);

  await DB.settings.update({ assistant_client: { whatsapp, schedule } });
  _assistantClientWhatsapp = whatsapp;
  _assistantClientSchedule = schedule;
  renderAssistantClientFields();
  renderAssistantClientSchedule();
  Toast.success('Assistant clientèle client enregistré.');
}

/* ── Déconnexion avec choix (au lieu d'un Auth.logout() direct) ────────
   Voir Auth.hasClientBackup()/restoreClientBackup() dans auth.js : une
   session client mise de côté au moment de la connexion admin permet de
   proposer un retour direct vers l'espace client. */
function openLogoutChoice() {
  const btn = document.getElementById('logout-return-client-btn');
  if (btn) btn.style.display = Auth.hasClientBackup() ? 'flex' : 'none';
  openModal('modal-logout-choice');
}

function logoutSwitchAccount() {
  if (currentUser) ResumeState.clearAllForUser(currentUser.id);
  sessionStorage.removeItem('cbp_session');
  sessionStorage.setItem('cbp_auto_login', 'admin');
  window.location.href = 'client.html';
}

function logoutReturnToClient() {
  // Filet de sécurité : si la sauvegarde a disparu entre l'ouverture du
  // choix et le clic, on se déconnecte quand même plutôt que de laisser la
  // session admin active rebondir vers admin.html au chargement de client.html.
  if (currentUser) ResumeState.clearAllForUser(currentUser.id);
  if (!Auth.restoreClientBackup()) sessionStorage.removeItem('cbp_session');
  window.location.href = 'client.html';
}

window.addEventListener('DOMContentLoaded', boot);
// Re-init charts on theme change
document.addEventListener('themeChange', initCharts);



