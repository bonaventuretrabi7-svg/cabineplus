/* ================================================================
   KBINE PLUS | Espace Cabine — version mobile-first
   ================================================================ */

let currentUser = null;
let _cabFilter  = 'all';
let _cabNetworks = { orange: true, moov: true, mtn: true };
let _cabUssdEnabled = { orange: true, mtn: true, moov: true };

/* ── Reprise d'état au rechargement (voir ResumeState dans auth.js) ──
   Un seul objet en mémoire, sauvegardé à chaque mutation et relu une
   fois au boot (restoreCabState()). */
let _cabResume = {
  section: null, orderFilter: null, reclaFilter: null,
  pauseDraft: null, transferDraft: null, holds: {}, openOrderDetailId: null,
};
function _saveCabResume() { ResumeState.save('cabine', _cabResume); }

/* Sections dont les données ne sont pas peuplées par loadCabHome() —
   il faut rappeler leur loader explicitement quand on y restaure
   directement au boot (même logique que les onclick correspondants
   dans cabine.html, ex: showCabSection('commissions'); loadCommissions();). */
function _cabSectionLoader(name) {
  return ({
    retraits:      loadCabRetraits,
    transfert:      loadCabTransferHistory,
    'cmd-daily':    loadCabCmdDaily,
    'comm-daily':   loadCabCommDaily,
    commissions:    loadCommissions,
    reclamations:   loadCabReclamations,
    profile:        loadProfile,
    notifications:  loadCabNotifications,
  })[name];
}

function restoreCabState() {
  const saved = ResumeState.load('cabine');
  if (!saved) return;

  if (saved.orderFilter) {
    const btn = document.querySelector(`#cab-sec-home .cof-ctab[data-filter="${saved.orderFilter}"]`);
    if (btn) filterCabOrders(saved.orderFilter, btn);
  }
  if (saved.reclaFilter) {
    const btn = document.querySelector(`#cab-sec-reclamations .cof-ctab[data-filter="${saved.reclaFilter}"]`);
    if (btn) filterCabReclamations(saved.reclaFilter, btn);
  }

  if (saved.section && saved.section !== 'home') {
    const loader = _cabSectionLoader(saved.section);
    if (loader) loader();
    showCabSection(saved.section);
  }

  if (saved.holds) {
    Object.keys(saved.holds).forEach(txnId => {
      const startedAt = saved.holds[txnId];
      const txn = DB.transactions.byId(txnId);
      const remaining = 300 - Math.floor((Date.now() - startedAt) / 1000);
      if (txn && txn.statut === 'en_attente' && remaining > 0) {
        _cabResume.holds[txnId] = startedAt;
        _startHoldCountdown(txnId, remaining);
      }
    });
  }

  if (saved.openOrderDetailId && DB.transactions.byId(saved.openOrderDetailId)) {
    openCabOrderDetail(saved.openOrderDetailId);
  }

  if (saved.pauseDraft && saved.pauseDraft.isOpen) {
    openModal('modal-cab-pause');
    const select   = document.getElementById('cqk-reason-select');
    const otherTxt = document.getElementById('cqk-reason-other');
    if (select)   select.value = saved.pauseDraft.motif || '';
    if (otherTxt) otherTxt.value = saved.pauseDraft.note || '';
    onCabPauseReasonChange();
    _cabSyncReasonList('cqk-reason-select', 'cqk-reason-list');
  }

  if (saved.transferDraft) {
    const nomEl     = document.getElementById('cab-transfer-nom');
    const montantEl = document.getElementById('cab-transfer-montant');
    if (nomEl)     nomEl.value = saved.transferDraft.nom || '';
    if (montantEl) montantEl.value = saved.transferDraft.montant || '';
    if (saved.transferDraft.nom) handleCabTransferLookup(saved.transferDraft.nom);
    else handleCabTransferMontantChange();
  }
}

/* ── Boot ──────────────────────────────────────────────────────── */
// Reprise "rester connecté" : si aucun onglet actif n'a de session mais
// qu'un jeton existe pour cet appareil, on tente de rouvrir la session sans
// redemander le code PIN — mais ce jeton (voir Auth._applyDeviceBookkeeping,
// js/auth.js) est désormais le jeton de session SERVEUR lui-même, toujours
// revérifié par api/session_whoami.php avant d'ouvrir quoi que ce soit.
// Plus aucune session ne s'ouvre depuis des données purement locales : hors
// ligne, ou jeton expiré/invalide, l'écran de connexion s'affiche comme si
// "rester connecté" n'était pas activé.
async function _tryRememberMeRestore() {
  if (Auth.current()) return;
  const token = localStorage.getItem(Auth.REMEMBER_TOKEN_KEY);
  if (!token) return;

  // Revalidé DIRECTEMENT auprès du serveur (source de vérité unique) —
  // voir le même correctif côté client (_tryRememberMeClientRestore(),
  // js/client.js) : ne doit plus jamais dépendre d'un enregistrement local
  // ("Mes appareils connectés") trouvé au préalable, sous peine de
  // supprimer un jeton pourtant encore valide et de redemander le code à
  // chaque ouverture.
  const res = await Auth.resumeSession(token);
  if (!res.ok) {
    // Hors ligne (networkError) : on retente au prochain démarrage, le
    // jeton reste valable. Jeton réellement invalide/expiré ou compte
    // suspendu/bloqué : on l'oublie pour ne plus jamais réessayer avec un
    // jeton mort.
    if (!res.networkError) localStorage.removeItem(Auth.REMEMBER_TOKEN_KEY);
    return;
  }
  if (res.user.role !== 'cabine') {
    // Jeton valide mais lié à un autre rôle (ex. appareil partagé) — même
    // repli que submitCabineLoginGate() : on efface juste la session tout
    // juste ouverte, sans les à-côtés d'une vraie déconnexion (pas
    // d'appel serveur, pas de redirection en plein démarrage).
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

/* ── Écran de connexion (aucune session cabine valide sur cet appareil) ──
   Avant ce correctif, un lien direct vers /cabine sans session active
   renvoyait silencieusement vers index.html (Auth.require()) — l'espace
   cabine ne "sortait" jamais. Affiche désormais ici même un écran de
   connexion dédié (mêmes classes .pln-* que la modale partenaire
   d'index.html, voir css/style.css), sans jamais quitter cette page. */
function showCabineLoginGate() {
  const loader = document.getElementById('page-loader');
  const gate   = document.getElementById('cab-login-gate');
  if (loader) loader.classList.add('pl-hide');
  if (!gate) return;
  gate.style.display = 'flex';

  const boxes = document.querySelectorAll('#cab-login-pin-row .pln-pin-box');
  boxes.forEach((box, idx) => {
    box.oninput = () => {
      box.value = box.value.replace(/\D/g, '').slice(0, 1);
      if (box.value && idx < boxes.length - 1) {
        boxes[idx + 1].focus();
      } else if (box.value && idx === boxes.length - 1) {
        setTimeout(submitCabineLoginGate, 120);
      }
    };
    box.onkeydown = e => {
      if (e.key === 'Backspace' && !box.value && idx > 0) boxes[idx - 1].focus();
    };
  });

  setTimeout(() => document.getElementById('cab-login-email')?.focus(), 120);
}

async function submitCabineLoginGate() {
  const email    = (document.getElementById('cab-login-email')?.value || '').trim();
  const pin      = [...document.querySelectorAll('#cab-login-pin-row .pln-pin-box')].map(b => b.value).join('');
  const remember = !!document.getElementById('cab-login-remember')?.checked;
  const denied   = document.getElementById('cab-login-denied');
  denied.style.display = 'none';

  if (!Auth.isValidGmail(email)) { Toast.error('Adresse Gmail invalide (ex : nom@gmail.com).'); return; }
  if (!Auth.isValidPin(pin))     { Toast.error('Saisissez votre code PIN à 4 chiffres.'); return; }

  const res = await Auth.login(email, pin, remember, 'cabine');
  if (!res.ok) { Toast.error(res.error); return; }

  if (res.user.role !== 'cabine') {
    sessionStorage.removeItem('cbp_session');
    denied.style.display = 'flex';
    document.querySelectorAll('#cab-login-pin-row .pln-pin-box').forEach(b => { b.value = ''; });
    return;
  }

  if (res.rememberToken) localStorage.setItem(Auth.REMEMBER_TOKEN_KEY, res.rememberToken);

  window.location.reload();
}

async function boot() {
  // Vérification de mise à jour (voir js/update-notifier.js) — jamais
  // bloquant : sur le site web, recharge la page toute seule dès qu'un
  // déploiement plus récent est détecté ; dans l'app Android empaquetée,
  // propose le téléchargement du nouvel APK.
  UpdateNotifier.init();

  DB.init();
  // Rattrape une file de synchronisation laissée en attente (voir
  // DB.syncQueue) si la connexion est déjà là au lancement, et
  // resynchronise automatiquement dès qu'elle revient — jamais bloquant,
  // l'app reste utilisable hors ligne quoi qu'il arrive ici.
  if (DB.Net.isOnline()) DB.drainSyncQueue();
  DB.Net.onChange(() => { if (DB.Net.isOnline()) DB.drainSyncQueue(); });
  await _tryRememberMeRestore();
  currentUser = Auth.require('cabine', { silent: true });
  if (!currentUser) { showCabineLoginGate(); return; }

  Theme.init();
  _refreshCabDarkBtn();
  _refreshCabPauseUI();
  _refreshCabNotifSoundUI();
  _refreshImpersonationBanner();

  // Réseaux actifs : la source de vérité est désormais le compte (voir
  // api/cabine_update_self.php/toggleNetwork() plus bas), déjà repris dans
  // currentUser par Auth.require()/_tryRememberMeRestore() ci-dessus — le
  // localStorage ne sert plus que de repli pour un compte jamais
  // synchronisé depuis l'ajout de ce réglage (ancienne installation).
  _cabNetworks = currentUser.reseaux_actifs || JSON.parse(localStorage.getItem('kbine_cab_nets') || 'null') || _cabNetworks;
  localStorage.setItem('kbine_cab_nets', JSON.stringify(_cabNetworks));

  // Toggles USSD par réseau (voir toggleUssdNetwork() plus bas) — même
  // patron que ci-dessus.
  _cabUssdEnabled = currentUser.ussd_enabled || JSON.parse(localStorage.getItem('kbine_cab_ussd_enabled') || 'null') || _cabUssdEnabled;
  localStorage.setItem('kbine_cab_ussd_enabled', JSON.stringify(_cabUssdEnabled));
  _refreshUssdTogglesUI();

  // Show app, hide loader
  const loader = document.getElementById('page-loader');
  const app    = document.getElementById('cab-app');
  setTimeout(() => {
    if (loader) loader.classList.add('pl-hide');
    if (app)    app.style.display = 'flex';
  }, 900);

  renderTopbarUser();
  renderTopbarAvatar();
  startCabPresence();
  // Dès la connexion, synchronise les commandes depuis le serveur (voir
  // DB.transactions.refresh(), js/db.js) : le cache local peut être
  // obsolète (une commande traitée sur un autre appareil pendant que
  // celui-ci était fermé).
  await DB.transactions.refresh();
  // Reprend aussi son propre profil (solde compris) dès l'ouverture — une
  // recharge/un changement de formule fait par l'administration pendant que
  // l'app était fermée doit apparaître dès la réouverture, sans attendre le
  // premier cycle de sondage (voir plus bas, toutes les 30s).
  await DB.users.refreshSelf();
  currentUser = Auth.refresh() || currentUser;
  DB.notifications.refresh(currentUser.id).then(updateNotifBadge);
  // Reprend les commandes en attente non assignées (pool "administration")
  // — voir DB.business.assignPendingToCabine().
  await DB.business.assignPendingToCabine(currentUser.id);
  // Doit tourner avant loadCabHome() : sinon une commande déjà en retard
  // (>3min) au moment de l'ouverture de la page est encore comptée "en
  // cours" dans les stats, alors qu'elle est sur le point d'être
  // réattribuée ailleurs.
  await DB.business.sweepStaleOrders();
  await DB.business.sweepAutoUnsuspensions();
  updateNotifBadge();
  loadCabHome();
  restoreCabState();
  _initCabNavAutoHide();

  // Restore toggle states visually
  ['orange','moov','mtn'].forEach(n => {
    const btn = document.getElementById('toggle-' + n);
    if (btn) btn.classList.toggle('active', _cabNetworks[n]);
    _setNetLineState(n, _cabNetworks[n]);
    _setNetStatusLabel(n, _cabNetworks[n]);
  });

  // Sondage automatique — voir plan "temps réel" (DB.presence.HEARTBEAT_MS,
  // même constante partagée que client.js/admin.js, resserrée depuis 30s
  // puis 3s : le meilleur compromis possible sans WebSocket/SSE sur cet
  // hébergement mutualisé, sans le saturer de requêtes).
  setInterval(async () => {
    // Signature avant rafraîchissement (voir DB.pollSignature, js/db.js) :
    // les re-rendus lourds plus bas (liste de commandes, section affichée)
    // ne se déclenchent que si elle a changé — évite de reconstruire tout
    // le HTML à chaque tick (coûteux sur Android) quand rien de nouveau ne
    // s'est produit.
    const _pollBefore = DB.pollSignature(currentUser.id, 'cabine');
    await DB.transactions.refresh();
    await DB.business.sweepStaleOrders();
    await DB.business.sweepAutoUnsuspensions();
    // Reprend son propre profil (solde compris) — une recharge/un
    // changement de formule fait par l'administration doit apparaître ici
    // sans que le partenaire ait besoin de se déconnecter/reconnecter (voir
    // DB.users.refreshSelf(), js/db.js).
    await DB.users.refreshSelf();
    currentUser = Auth.refresh();
    // Compte supprimé entre-temps : déconnexion. Une suspension (auto ou
    // manuelle) ne déconnecte plus le partenaire — il doit rester connecté
    // pour voir le bandeau d'alerte sur son tableau de bord (voir
    // loadCabBalanceCard/_refreshSuspensionBanner) ; la réception de
    // nouvelles commandes reste bloquée côté serveur simulé (js/db.js).
    if (!currentUser) { Auth.logout(); return; }
    // Notifications réelles (voir api/notifications_list.php) — reflète
    // désormais ce qui se passe partout (recharge admin, remboursement...),
    // pas seulement ce que cet appareil a lui-même déclenché.
    await DB.notifications.refresh(currentUser.id);
    updateNotifBadge();
    loadCabBalanceCard();
    loadCabRealtimeStats();
    _refreshSuspensionBanner(currentUser);
    const pollChanged = DB.pollSignature(currentUser.id, 'cabine') !== _pollBefore;
    // Ne pas re-rendre la liste tant qu'une preuve de paiement (facture)
    // est en cours de sélection/aperçu : un re-rendu complet remplacerait
    // le <input type="file"> et l'aperçu affiché, faisant perdre au
    // cabiniste sa sélection avant qu'il ait pu cliquer "Terminer".
    const hasPendingProof = Object.keys(_facturePendingProofs).length > 0;
    if (pollChanged && !hasPendingProof && (_cabFilter === 'all' || _cabFilter === 'en_attente')) loadCabOrders(_cabFilter);
    // Re-rend la section ACTUELLEMENT affichée (voir _cabSectionLoader()
    // ci-dessus) — couvre automatiquement tous les onglets (retraits,
    // transferts, réclamations, profil...), pas seulement le tableau de
    // bord comme avant. 'home' déjà couvert ci-dessus (loadCabBalanceCard/
    // loadCabRealtimeStats), pas la peine de le rappeler une 2e fois.
    if (pollChanged && _cabResume.section && _cabResume.section !== 'home') _cabSectionLoader(_cabResume.section)?.();
  }, DB.presence.HEARTBEAT_MS);
}

/* ── Barre de navigation : masquée pendant le scroll, réapparaît à l'arrêt ── */
function _initCabNavAutoHide() {
  const content = document.querySelector('.cab-content');
  const nav     = document.getElementById('cab-bnav');
  if (!content || !nav) return;

  let hideTimer = null;
  content.addEventListener('scroll', () => {
    nav.classList.add('cab-bottom-nav--scroll-hidden');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      nav.classList.remove('cab-bottom-nav--scroll-hidden');
    }, 200);
  }, { passive: true });
}

/* ── Navigation ────────────────────────────────────────────────── */
// Table "section -> fonction(s) de rechargement", même patron que
// _adminViewLoader() (js/admin.js) — réutilisée par le sondage périodique
// (boot(), setInterval) pour que la section ACTUELLEMENT affichée se
// remette à jour toute seule. Chaque bouton de navigation (cabine.html)
// appelle déjà son propre loader au clic (showCabSection('x'); loadX())
// — cette table ne fait que centraliser cette même association.
function _cabSectionLoader(name) {
  return ({
    home:         loadCabHome,
    retraits:     loadCabRetraits,
    transfert:    loadCabTransferHistory,
    historique:   loadCabHistory,
    commissions:  loadCommissions,
    'comm-daily': loadCabCommDaily,
    'cmd-daily':  loadCabCmdDaily,
    reclamations: loadCabReclamations,
    notifications: loadCabNotifications,
    profile:      loadProfile,
  })[name];
}

function showCabSection(name) {
  document.querySelectorAll('.cab-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.cab-bnav-tab').forEach(t => t.classList.remove('active'));

  const sec = document.getElementById('cab-sec-' + name);
  if (sec) sec.classList.add('active');

  const tab = document.getElementById('tab-' + name);
  if (tab) tab.classList.add('active');

  const content = document.querySelector('.cab-content');
  if (content) content.scrollTop = 0;

  _cabResume.section = name;
  _saveCabResume();
}

/* ── Bandeau impersonation admin ──────────────────────────────────
   Affiché uniquement quand l'admin a accédé à cet espace sans mot de passe
   (voir Auth.startImpersonation() dans js/auth.js). */
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
  const admin = Auth.endImpersonation();
  if (!admin) return;
  window.location.href = 'admin.html';
}

/* ── Top bar user ──────────────────────────────────────────────── */
function renderTopbarUser() {
  const user = DB.users.byId(currentUser.id);
  const avatar = document.getElementById('cab-chip-avatar');
  const name   = document.getElementById('cab-chip-name');
  const sub    = document.getElementById('cab-chip-sub');
  if (avatar) avatar.textContent = Fmt.initials(user.nom, user.prenom);
  if (name)   name.textContent   = user.prenom + ' ' + user.nom;
  if (sub)    sub.textContent    = user.abonnement || 'Partenaire';
}

/* ── Photo d'identité (topnav gauche) ──────────────────────────────
   Affiche la photo fournie à l'inscription (user.photo, data URL) ;
   à défaut, repli sur les initiales du partenaire. */
function renderTopbarAvatar() {
  const user = DB.users.byId(currentUser.id);
  const img      = document.getElementById('cab-tnav-avatar-img');
  const fallback = document.getElementById('cab-tnav-avatar-fallback');
  if (user.photo) {
    if (img)      { img.src = user.photo; img.style.display = 'block'; }
    if (fallback) fallback.style.display = 'none';
  } else {
    if (img)      img.style.display = 'none';
    if (fallback) { fallback.textContent = Fmt.initials(user.nom, user.prenom); fallback.style.display = 'block'; }
  }
}

/* ── Présence en ligne : partenaires connectés en temps réel ──────── */
// Garde le device record "vivant" pendant toute la durée d'un onglet
// ouvert (voir DB.partnerDevices.forUser dans js/db.js — une session non
// mémorisée sans activité depuis 24h serait sinon considérée expirée même
// si l'onglet est resté ouvert sans jamais recharger la page).
function _touchCurrentCabDevice() {
  const rec = DB.partnerDevices.forUser(currentUser.id).find(d => d.device_id === Auth.getDeviceId());
  if (rec) DB.partnerDevices.touch(rec.id, !!rec.remember_token);
}

function startCabPresence() {
  DB.presence.ping(currentUser.id);
  _refreshOnlineCount();
  _touchCurrentCabDevice();
  DB.presence.refresh().then(_refreshOnlineCount);

  setInterval(() => {
    DB.presence.ping(currentUser.id);
    _refreshOnlineCount();
    _touchCurrentCabDevice();
    DB.presence.refresh().then(_refreshOnlineCount);
  }, DB.presence.HEARTBEAT_MS);

  window.addEventListener('beforeunload', () => DB.presence.leave(currentUser.id));

  // Un autre onglet/partenaire se connecte ou se déconnecte → on rafraîchit.
  // Une commande remboursée depuis l'administration (voir
  // DB.business.processRefundRequest dans js/db.js) se reflète ici sans
  // rechargement manuel — même principe, sur la clé 'cbp_transactions'.
  window.addEventListener('storage', (e) => {
    if (e.key === 'cbp_presence') _refreshOnlineCount();
    if (e.key === 'cbp_transactions') {
      loadCabHome();
      loadCabReclamations();
      loadCabRetraits();
      currentUser = Auth.refresh();
    }
  });
}

function _refreshOnlineCount() {
  const el = document.getElementById('cab-online-count');
  if (el) el.textContent = DB.presence.onlineCabineCount();
  checkMissingNetworks();
}

/* Si aucune cabine actuellement connectée n'a un réseau donné activé
   (reseaux_actifs), avertit ce cabiniste via une puce compacte dans la
   top nav qui affiche directement les réseaux concernés (plus besoin de
   taper dessus pour les découvrir) — même cadence de rafraîchissement
   que le badge "cabines connectées". */
function checkMissingNetworks() {
  const chipEl = document.getElementById('cab-missing-network-alert');
  if (!chipEl) return;
  const textEl = document.getElementById('cab-missing-network-text');

  const onlineIds = DB.presence.onlineCabineIds();
  const onlineCabines = onlineIds.map(id => DB.users.byId(id)).filter(Boolean);
  const NETWORKS = [{ key: 'mtn', label: 'MTN' }, { key: 'moov', label: 'Moov' }, { key: 'orange', label: 'Orange' }];
  const missing = NETWORKS.filter(n => !onlineCabines.some(c => c.reseaux_actifs?.[n.key])).map(n => n.label);

  if (missing.length) {
    if (textEl) textEl.textContent = 'Indisponibles : ' + missing.join(', ');
    chipEl.style.display = 'flex';
  } else {
    chipEl.style.display = 'none';
  }
}

/* ── Badges notifications ──────────────────────────────────────── */
/* _cabLastPendingCount / _cabLastReclaCount restent à `null` jusqu'au
   premier appel, pour ne jamais jouer de son sur le chargement initial
   de la page — seulement sur une hausse détectée lors des sondages
   suivants (voir boucle 30s dans boot()). */
let _cabLastPendingCount = null;
let _cabLastReclaCount   = null;

function updateNotifBadge() {
  const notifCount = DB.notifications.unread(currentUser.id);
  const notifBadge = document.getElementById('notif-badge');
  const notifDot   = document.getElementById('cab-notif-dot');
  if (notifBadge) { notifBadge.textContent = notifCount; notifBadge.style.display = notifCount ? 'flex' : 'none'; }
  if (notifDot)   notifDot.style.display = notifCount ? 'block' : 'none';

  const pending = DB.transactions.pending().filter(t => t.cabine_id === currentUser.id).length;
  const pendingBadge = document.getElementById('pending-badge');
  if (pendingBadge) {
    pendingBadge.textContent = pending;
    pendingBadge.style.display = pending ? 'flex' : 'none';
  }
  if (_cabLastPendingCount !== null && pending > _cabLastPendingCount) CabSound.notify('commande');
  _cabLastPendingCount = pending;

  const reclaCount = DB.reclamations.byCabine(currentUser.id).filter(r => r.statut === 'en_attente').length;
  const rBadge = document.getElementById('recla-badge');
  if (rBadge) { rBadge.textContent = reclaCount; rBadge.style.display = reclaCount ? 'flex' : 'none'; }
  if (_cabLastReclaCount !== null && reclaCount > _cabLastReclaCount) CabSound.notify('reclamation');
  _cabLastReclaCount = reclaCount;
  _refreshReclamationBlockBanner(reclaCount);
}

/* Bandeau rouge tant qu'au moins une réclamation est en attente — la
   cabine ne reçoit alors plus de nouvelle commande (voir
   DB.business.hasBlockingReclamation() dans js/db.js, appliqué dans
   assignCabine/findReassignmentTarget/assignPendingToCabine). */
function _refreshReclamationBlockBanner(reclaCount) {
  const banner = document.getElementById('recla-block-banner');
  const card   = document.getElementById('cbc-card');
  if (!banner) return;
  if (!reclaCount) {
    banner.style.display = 'none';
    if (card) card.style.display = '';
    return;
  }
  const textEl = document.getElementById('recla-block-text');
  if (textEl) {
    textEl.textContent = reclaCount > 1
      ? `${reclaCount} réclamations non traitées — vous ne recevez plus de nouvelles commandes tant qu'elles ne sont pas toutes traitées.`
      : `1 réclamation non traitée — vous ne recevez plus de nouvelles commandes tant qu'elle n'est pas traitée.`;
  }
  banner.style.display = 'flex';
  // Le tableau de solde reste masqué tant que la réclamation bloque la
  // réception de commandes — le bandeau rouge ci-dessus prend sa place.
  if (card) card.style.display = 'none';
}

/* ── Page Accueil ──────────────────────────────────────────────── */
function loadCabHome() {
  loadCabBalanceCard();
  loadCabQuota();
  loadCabStats();
  loadCabRealtimeStats();
  loadCabOrders(_cabFilter);
}

/* ── Quota de commission du forfait ───────────────────────────────
   Chaque forfait a un plafond de commission ; une fois atteint,
   l'abonnement prend fin avant la fin du mois (voir DB.business.acceptRequest). */
function loadCabQuota() {
  const user  = DB.users.byId(currentUser.id);
  const plan  = user.abonnement || 'Premium';
  const quota = DB.SUBSCRIPTION_QUOTAS[plan] || DB.SUBSCRIPTION_QUOTAS.Premium;
  const acc   = user.commissions_total || 0;
  const pct   = Math.min(100, (acc / quota) * 100);
  const reached = acc >= quota;

  const planEl    = document.getElementById('cqt-plan');
  const currentEl = document.getElementById('cqt-current');
  const quotaEl   = document.getElementById('cqt-quota');
  const noteEl    = document.getElementById('cqt-note');
  const ringEl    = document.getElementById('cqt-ring');
  const ringPctEl = document.getElementById('cqt-ring-pct');
  const expiryEl  = document.getElementById('cqt-expiry');

  if (planEl)    planEl.textContent    = plan;
  if (currentEl) currentEl.textContent = Fmt.money(acc);
  if (quotaEl)   quotaEl.textContent   = Fmt.money(quota);
  if (ringEl)    ringEl.style.setProperty('--pct', pct);
  if (ringPctEl) ringPctEl.textContent = Math.round(pct) + '%';
  if (expiryEl) {
    expiryEl.textContent = user.date_expiration
      ? new Date(user.date_expiration).toLocaleDateString('fr-CI', { day: '2-digit', month: 'short', year: 'numeric' })
      : '—';
  }

  if (noteEl) {
    if (reached) {
      noteEl.className = 'cqt-note cqt-note--full';
      noteEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> <span>Quota atteint — votre abonnement ${plan} a pris fin avant la fin du mois.</span>`;
    } else {
      const reste = quota - acc;
      noteEl.className = 'cqt-note' + (pct >= 80 ? ' cqt-note--warn' : '');
      noteEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> <span>Encore ${Fmt.money(reste)} avant la fin anticipée de votre abonnement ${plan}.</span>`;
    }
  }
}

/* Couleur personnalisée de la carte de solde (.cbc-card), indépendante
   du palier d'abonnement — voir .cbc-card--c-* dans css/style.css.
   Persistée sur le compte (user.carte_couleur), null = "Automatique"
   (couleur du palier). */
const CAB_CARD_COLORS = [
  { key: 'auto',      label: 'Automatique', swatch: 'linear-gradient(135deg,#FF6200,#16a34a)' },
  { key: 'bleu',      label: 'Bleu',        swatch: '#1e40af' },
  { key: 'violet',    label: 'Violet',      swatch: '#6d28d9' },
  { key: 'rose',      label: 'Rose',        swatch: '#9d174d' },
  { key: 'turquoise', label: 'Turquoise',   swatch: '#0f766e' },
  { key: 'rouge',     label: 'Rouge',       swatch: '#991b1b' },
  { key: 'gris',      label: 'Gris',        swatch: '#374151' },
];

function openCabCardColorPicker() {
  const user = DB.users.byId(currentUser.id);
  const current = user.carte_couleur || 'auto';
  const strip = document.getElementById('cab-color-strip');
  const lbls  = document.getElementById('cab-color-strip-lbls');
  if (strip) {
    strip.innerHTML = CAB_CARD_COLORS.map(c => `
      <span class="cab-color-dot${c.key === current ? ' sel' : ''}" id="cab-color-dot-${c.key}"
        style="background:${c.swatch}" onclick="previewCabCardColor('${c.key}')">
        ${c.key === 'auto' ? '<i class="fa-solid fa-wand-magic-sparkles"></i>' : ''}
      </span>`).join('');
  }
  if (lbls) lbls.innerHTML = CAB_CARD_COLORS.map(c => `<span class="cab-color-strip-lbl">${c.label}</span>`).join('');
  _renderCabColorPreview(current);
  openModal('modal-cab-card-color');
}

/* Mini-carte d'aperçu du sélecteur de couleur — réutilise directement
   .cbc-card/.cbc-card--* pour un rendu strictement identique à la vraie
   carte de solde (voir loadCabBalanceCard()). */
function _renderCabColorPreview(key) {
  const user = DB.users.byId(currentUser.id);
  const preview = document.getElementById('cab-color-preview');
  if (!preview) return;
  const tierClass = 'cbc-card--' + (user.abonnement || 'Premium').toLowerCase();
  preview.className = 'cab-color-preview cbc-card ' + (key === 'auto' ? tierClass : 'cbc-card--c-' + key);
  document.getElementById('cab-color-preview-name').textContent = user.cabine_nom || (user.prenom + ' ' + user.nom);
  document.getElementById('cab-color-preview-val').textContent = Fmt.money(user.solde || 0);
}

/* Applique la couleur immédiatement (pas de bouton "Valider" séparé) et
   met à jour l'aperçu + la vraie carte derrière la fenêtre, qui reste
   ouverte pour comparer plusieurs teintes de suite. */
async function previewCabCardColor(key) {
  document.querySelectorAll('.cab-color-dot').forEach(d => d.classList.remove('sel'));
  document.getElementById('cab-color-dot-' + key)?.classList.add('sel');
  _renderCabColorPreview(key);
  loadCabBalanceCard();

  // Persisté côté serveur (voir api/cabine_update_self.php) — sans ça, ce
  // choix restait local à l'appareil et se perdait sur un autre appareil
  // connecté au même compte.
  const res = await DB.business.cabineUpdateSelf(currentUser.id, { carte_couleur: key === 'auto' ? null : key });
  if (!res.ok) { Toast.error(res.error || 'Échec de l\'enregistrement — réessayez.'); return; }
  currentUser = Auth.refresh();
}

function loadCabBalanceCard() {
  const user  = DB.users.byId(currentUser.id);
  const txns  = DB.transactions.byCabine(currentUser.id);
  const done  = txns.filter(t => t.statut === 'terminé');

  // Solde en attente = solde opérationnel de la cabine
  const pending = user.solde || 0;
  // Solde payé = commissions totales reçues
  const paid    = user.commissions_total || done.reduce((s, t) => s + (t.commission || 0), 0);

  const card       = document.getElementById('cbc-card');
  const subsType   = document.getElementById('cab-subs-type');
  const pill       = document.getElementById('cbc-subs-pill');
  const pelEl      = document.getElementById('cab-bal-pending');
  const paidEl     = document.getElementById('cab-bal-paid');
  const nameTag    = document.getElementById('cbc-cabine-name-tag');
  const statusPill = document.getElementById('cbc-status-pill');
  const statusTxt  = document.getElementById('cab-status-text');

  const cabNom  = user.cabine_nom || (user.prenom + ' ' + user.nom);
  if (nameTag) nameTag.textContent = cabNom;

  const subs = user.abonnement || 'Premium';
  if (subsType) subsType.textContent = subs;
  // Palette de la carte de solde : par défaut selon le palier (Premium →
  // orange, VIP → vert, VVIP → blanc et orange), sauf si la cabine a
  // choisi une couleur personnalisée (voir openCabCardColorPicker() /
  // setCabCardColor() ci-dessous) — voir .cbc-card--* dans style.css.
  if (card) {
    card.classList.remove('cbc-card--premium', 'cbc-card--vip', 'cbc-card--vvip',
      ...CAB_CARD_COLORS.filter(c => c.key !== 'auto').map(c => 'cbc-card--c-' + c.key));
    card.classList.add(user.carte_couleur ? 'cbc-card--c-' + user.carte_couleur : 'cbc-card--' + subs.toLowerCase());
  }
  if (pill) {
    pill.className = 'cbc-subs-pill';
    pill.style.cssText = 'background:rgba(255,255,255,.15);border-color:rgba(255,255,255,.25);color:#fff;';
    if (subs === 'VIP')  { pill.style.background = 'rgba(167,139,250,.3)'; }
    if (subs === 'VVIP') { pill.style.background = 'rgba(251,191,36,.3)';  }
  }

  const statut = user.statut || 'inactif';
  if (statusTxt)  statusTxt.textContent = statut.charAt(0).toUpperCase() + statut.slice(1);
  if (statusPill) statusPill.style.background = statut === 'actif' ? '#16a34a' : '#dc2626';

  if (pelEl)  pelEl.textContent  = Fmt.money(pending);
  if (paidEl) paidEl.textContent = Fmt.money(paid);

  _refreshSuspensionBanner(user);
}

/* Bandeau "Compte suspendu" sous le tableau de solde — visible pour une
   suspension automatique (motif + heure de déblocage exacte, 24h) ou
   manuelle (motif + message générique, pas d'échéance : seul l'admin à
   l'origine ou le super admin peut la lever, voir js/admin.js). */
function _refreshSuspensionBanner(user) {
  // Le bouton "Recharge UV" disparaît tant que la cabine est suspendue
  // (le blocage réel se fait côté serveur dans DB.business.cabineSelfRecharge,
  // js/db.js — ce masquage n'est qu'un confort d'interface).
  const uvBtn = document.getElementById('cbc-uv-btn');
  if (uvBtn) uvBtn.style.display = user.statut === 'suspendu' ? 'none' : '';

  const banner = document.getElementById('cab-suspension-banner');
  if (!banner) return;
  if (user.statut !== 'suspendu') { banner.style.display = 'none'; return; }

  const motifEl = document.getElementById('cab-suspension-motif');
  const untilEl = document.getElementById('cab-suspension-until');
  if (motifEl) motifEl.textContent = 'Motif : ' + (user.suspendu_motif || 'non précisé');
  if (untilEl) {
    untilEl.textContent = user.suspendu_jusqu
      ? 'Déblocage prévu : ' + Fmt.datetime(user.suspendu_jusqu)
      : 'Suspendu par l\'administration — contactez-la pour plus d\'informations.';
  }
  banner.style.display = 'flex';
}

let _cabBalanceHidden = false;
function toggleCabBalance() {
  _cabBalanceHidden = !_cabBalanceHidden;
  const ids  = ['cab-bal-pending', 'cab-bal-paid'];
  const icon = document.getElementById('cab-eye-icon');
  if (_cabBalanceHidden) {
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.dataset.val = el.textContent; el.textContent = '••••••'; }
    });
    if (icon) icon.className = 'fa-solid fa-eye-slash';
  } else {
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el && el.dataset.val) el.textContent = el.dataset.val;
    });
    if (icon) icon.className = 'fa-solid fa-eye';
  }
}

function loadCabStats() {
  const user  = DB.users.byId(currentUser.id);
  const txns  = DB.transactions.byCabine(currentUser.id);
  const done  = txns.filter(t => t.statut === 'terminé');

  const now   = new Date();
  const h24   = new Date(now - 86400000);
  const done24 = done.filter(t => new Date(t.date) >= h24);

  const comm24     = done24.reduce((s, t) => s + (t.commission || 0), 0);
  const cmd24      = done24.length;
  const commTotal  = user.commissions_total || done.reduce((s, t) => s + (t.commission || 0), 0);
  const cmdTotal   = user.transferts_total  || done.length;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('cab-comm24',          comm24 > 0 ? Fmt.money(comm24) : '0');
  set('cab-cmd24',           cmd24);
  set('cab-comm-total-home', Fmt.money(commTotal));
  set('cab-cmd-total',       cmdTotal);
}

/* ── Statistiques temps réel : en cours / terminées / retards ─────
   Une commande "en retard" est une commande reçue dans les dernières
   24h, toujours en attente au-delà du seuil ci-dessous (DB.RETARD_MS,
   3 minutes — même règle que loadCabines() dans admin.js et que la
   réattribution automatique de DB.business.sweepStaleOrders). */
function loadCabRealtimeStats() {
  const txns  = DB.transactions.byCabine(currentUser.id);
  const now   = new Date();
  // Minuit local du jour courant — "Terminées" ET "Retards" repartent
  // naturellement à zéro chaque jour (pas une fenêtre glissante de 24h) :
  // seules les commandes réellement traitées/en retard DEPUIS minuit
  // comptent, remis à zéro au changement de jour.
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // "En cours" affiche le nombre exact de commandes en attente pour cette
  // cabine, sans exclure celles en retard (une commande en retard reste
  // une commande en cours — "Retards" n'est qu'un sous-ensemble mis en
  // évidence séparément, pas une catégorie qui la retire d'ici). Redescend
  // immédiatement dès qu'une commande est traitée (loadCabHome() est
  // appelée juste après chaque action — voir acceptRequest() etc.).
  const pendingAll    = txns.filter(t => t.statut === 'en_attente');
  // Date de fin réelle (date_fin) plutôt que date de création : une
  // commande créée hier mais terminée aujourd'hui doit compter aujourd'hui.
  const doneToday     = txns.filter(t => t.statut === 'terminé' && new Date(t.date_fin || t.date) >= todayStart);
  // "Retards" compte les évènements de retard réellement survenus
  // aujourd'hui (journal DB.retards, posé par sweepStaleOrders dès
  // qu'une commande dépasse RETARD_MS) — pas seulement les commandes
  // encore en attente à l'instant présent, sinon traiter une commande en
  // retard la ferait disparaître du total du jour alors qu'elle a bien
  // compté comme un retard.
  const retardsToday  = DB.retards.byCabine(currentUser.id).filter(r => new Date(r.date) >= todayStart);

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('crt-en-cours',  pendingAll.length);
  set('crt-terminees', doneToday.length);
  set('crt-retards',   retardsToday.length);
}

/* ── Cumul commissions / commandes — détail par jour, groupé par mois ──
   Modèle "accordéon" : un en-tête par mois (replié par défaut, sauf le
   plus récent) affiche le total du mois, et se déplie pour révéler ses
   jours en lignes compactes. ── */
function _cabDailyGroups() {
  const done  = DB.transactions.byCabine(currentUser.id).filter(t => t.statut === 'terminé');
  const byDay = {};
  done.forEach(t => {
    const key = new Date(t.date).toDateString();
    if (!byDay[key]) byDay[key] = { date: t.date, commission: 0, count: 0 };
    byDay[key].commission += (t.commission || 0);
    byDay[key].count += 1;
  });
  return Object.values(byDay).sort((a, b) => new Date(b.date) - new Date(a.date));
}

// Regroupe une liste de jours (triée du plus récent au plus ancien) par mois calendaire.
function _cabMonthGroups(days) {
  const groups = [];
  const byKey = {};
  days.forEach(d => {
    const dt  = new Date(d.date);
    const key = dt.getFullYear() + '-' + dt.getMonth();
    if (!byKey[key]) {
      byKey[key] = { year: dt.getFullYear(), month: dt.getMonth(), days: [] };
      groups.push(byKey[key]);
    }
    byKey[key].days.push(d);
  });
  return groups;
}

function toggleCabDailyGroup(headEl) {
  headEl.closest('.grpB').classList.toggle('open');
}

// Accordéon partagé par les deux listes ci-dessous : en-tête de mois
// (titre + nombre de jours actifs + total + variation % vs le mois
// précédent) qui se déplie sur un mini-graphique comparatif des jours
// du mois, puis les lignes de jours elles-mêmes.
function _cabDailyAccordion(monthGroups, idPrefix, opts) {
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  return monthGroups.map((g, i) => {
    const monthLabel = cap(new Date(g.year, g.month, 1).toLocaleDateString('fr-CI', { month: 'long' }));

    // Variation % vs le mois précédent (groupe suivant dans le tableau,
    // puisque monthGroups est trié du plus récent au plus ancien).
    let pctHtml = '';
    const prevGroup = monthGroups[i + 1];
    if (prevGroup) {
      const curVal  = opts.totalValueFn(g.days);
      const prevVal = opts.totalValueFn(prevGroup.days);
      if (prevVal > 0) {
        const pct = Math.round(((curVal - prevVal) / prevVal) * 100);
        const up  = pct >= 0;
        pctHtml = `<span class="grpB-pct ${up ? 'grpB-pct--up' : 'grpB-pct--down'}"><i class="fa-solid fa-arrow-${up ? 'up' : 'down'}"></i>${Math.abs(pct)}%</span>`;
      }
    }

    // Mini-graphique comparatif : un bâton par jour du mois, hauteur
    // proportionnelle à sa valeur — visible seulement s'il y a au moins
    // 2 jours à comparer.
    const daysAsc = g.days.slice().reverse();
    let chartHtml = '';
    if (daysAsc.length > 1) {
      const maxVal = Math.max(...daysAsc.map(opts.barValueFn), 1);
      chartHtml = `<div class="grpB-chart">${daysAsc.map(d => {
        const v   = opts.barValueFn(d);
        const h   = Math.max(Math.round((v / maxVal) * 100), 6);
        const day = new Date(d.date).toLocaleDateString('fr-CI', { day: '2-digit' });
        return `<div class="chart-bar-wrap">
          <div class="chart-bar ${opts.barClass}" style="height:${h}%" title="${day} : ${opts.totalLabelFn([d])}"></div>
          <div class="chart-bar-lbl">${day}</div>
        </div>`;
      }).join('')}</div>`;
    }

    return `
    <div class="grpB${i === 0 ? ' open' : ''}" id="${idPrefix}-grp-${g.year}-${g.month}">
      <div class="grpB-head" onclick="toggleCabDailyGroup(this)">
        <div class="grpB-head-l">
          <span class="grpB-chev"><i class="fa-solid fa-chevron-right"></i></span>
          <div>
            <div class="grpB-title">${monthLabel} ${g.year}</div>
            <div class="grpB-sub">${g.days.length} jour${g.days.length > 1 ? 's' : ''} actif${g.days.length > 1 ? 's' : ''}</div>
          </div>
        </div>
        <div class="grpB-total-wrap">
          ${pctHtml}
          <span class="grpB-total">${opts.totalLabelFn(g.days)}</span>
        </div>
      </div>
      <div class="grpB-body">
        ${chartHtml}
        ${g.days.map(opts.rowFn).join('')}
      </div>
    </div>`;
  }).join('');
}

function _cabDailyRowB(d, pillHtml, subHtml) {
  const dt  = new Date(d.date);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const day     = dt.toLocaleDateString('fr-CI', { day: '2-digit' });
  const weekday = cap(dt.toLocaleDateString('fr-CI', { weekday: 'short' })).replace('.', '');
  return `
    <div class="rowB">
      <div class="rowB-info">
        <div class="rowB-day">${day} <span>· ${weekday}</span></div>
        ${subHtml ? `<div class="rowB-sub">${subHtml}</div>` : ''}
      </div>
      <span class="pillB">${pillHtml}</span>
    </div>`;
}

function loadCabCommDaily() {
  const list = document.getElementById('cab-comm-daily-list');
  if (!list) return;
  const days = _cabDailyGroups();
  if (!days.length) {
    list.innerHTML = `<div class="cab-empty-state cab-empty-state--light">
      <i class="fa-solid fa-calendar-xmark" style="font-size:2rem;opacity:.3;margin-bottom:8px;display:block;"></i>
      <div>Aucune commission enregistrée</div>
    </div>`;
    return;
  }
  const groups = _cabMonthGroups(days);
  list.innerHTML = _cabDailyAccordion(groups, 'comm', {
    totalValueFn: (ds) => ds.reduce((s, d) => s + d.commission, 0),
    totalLabelFn: (ds) => Fmt.money(ds.reduce((s, d) => s + d.commission, 0)),
    barValueFn:   (d)  => d.commission,
    barClass:     'chart-bar--money',
    rowFn:        (d)  => _cabDailyRowB(d, Fmt.money(d.commission), `${d.count} transfert${d.count > 1 ? 's' : ''}`),
  });
}

function loadCabCmdDaily() {
  const list = document.getElementById('cab-cmd-daily-list');
  if (!list) return;
  const days = _cabDailyGroups();
  if (!days.length) {
    list.innerHTML = `<div class="cab-empty-state cab-empty-state--light">
      <i class="fa-solid fa-calendar-xmark" style="font-size:2rem;opacity:.3;margin-bottom:8px;display:block;"></i>
      <div>Aucune commande enregistrée</div>
    </div>`;
    return;
  }
  const groups = _cabMonthGroups(days);
  list.innerHTML = _cabDailyAccordion(groups, 'cmd', {
    totalValueFn: (ds) => ds.reduce((s, d) => s + d.count, 0),
    totalLabelFn: (ds) => { const n = ds.reduce((s, d) => s + d.count, 0); return `${n} commande${n > 1 ? 's' : ''}`; },
    barValueFn:   (d)  => d.count,
    barClass:     'chart-bar--count',
    rowFn:        (d)  => _cabDailyRowB(d, `${d.count} commande${d.count > 1 ? 's' : ''}`, null),
  });
}

/* ── Commandes (home) ──────────────────────────────────────────── */
let _cabCurrentOrders = [];

function loadCabOrders(filter = 'all') {
  _cabFilter = filter;
  let txns = DB.transactions.byCabine(currentUser.id);

  // Filtre réseau : ne s'applique qu'aux commandes pas encore traitées.
  // Un réseau désactivé bloque les nouvelles commandes, mais celles déjà
  // traitées (terminées/refusées) restent visibles quel que soit l'état du toggle.
  txns = txns.filter(t => {
    if (t.statut !== 'en_attente') return true;
    const op = (t.operateur || '').toLowerCase();
    if (op.includes('orange') && !_cabNetworks.orange) return false;
    if (op.includes('moov')   && !_cabNetworks.moov)   return false;
    if (op.includes('mtn')    && !_cabNetworks.mtn)    return false;
    return true;
  });

  let hiddenDoneCount = 0;
  const now        = new Date();
  const todayStart  = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Date de fin réelle (date_fin) plutôt que date de création : une
  // commande créée hier mais terminée aujourd'hui doit compter aujourd'hui
  // (même logique que loadCabRealtimeStats()).
  const finishedAt  = t => new Date(t.date_fin || t.date);

  if (filter !== 'all') {
    txns = txns.filter(t => t.statut === filter);
    // Onglet "Traitées" : uniquement les commandes traitées dans la
    // journée en cours (minuit local), 30 dernières max — pour
    // l'historique complet, direction la section Commissions (voir
    // loadCommissions()). Même plafond que l'onglet "Toutes" ci-dessous.
    if (filter === 'terminé') {
      txns = txns.filter(t => finishedAt(t) >= todayStart).sort((a, b) => finishedAt(b) - finishedAt(a));
      hiddenDoneCount = Math.max(0, txns.length - 30);
      txns = txns.slice(0, 30);
    }
  } else {
    // "Tous" : commandes actionnables (en attente/refusées/remboursées)
    // illimitées, mais seules les commandes terminées AUJOURD'HUI sont
    // affichées (30 dernières max) — au-delà, direction l'historique
    // complet (section Commissions, déjà plafonnée à 30 avec recherche —
    // voir loadCommissions()). Le total (et le badge) repart donc
    // naturellement à zéro chaque minuit, comme "Terminées" ci-dessus.
    const notDone   = txns.filter(t => t.statut !== 'terminé');
    const doneToday = txns.filter(t => t.statut === 'terminé' && finishedAt(t) >= todayStart)
      .sort((a, b) => finishedAt(b) - finishedAt(a));
    hiddenDoneCount = Math.max(0, doneToday.length - 30);
    txns = [...notDone, ...doneToday.slice(0, 30)];
  }
  // Trie par date d'arrivée DANS L'ESPACE DE CETTE CABINE (date_assignation),
  // pas par date de création de la commande — sinon une commande réattribuée
  // (qui garde sa date de création d'origine, potentiellement ancienne) peut
  // se retrouver sous une commande plus récente déjà présente, alors qu'elle
  // vient tout juste d'arriver chez cette cabine.
  txns = [...txns].sort((a, b) => new Date(b.date_assignation || b.date) - new Date(a.date_assignation || a.date));
  _cabCurrentOrders = txns;

  renderCabOrders(txns);
  updateNotifBadge();

  const badge = document.getElementById('cof-total-badge');
  if (badge) badge.textContent = txns.length + ' commande' + (txns.length !== 1 ? 's' : '');

  const historyLink = document.getElementById('cab-orders-history-link');
  if (historyLink) historyLink.style.display = hiddenDoneCount > 0 ? 'flex' : 'none';
}

function renderCabOrders(txns) {
  const list = document.getElementById('cab-orders-list');
  if (!list) return;

  if (!txns.length) {
    list.innerHTML = `<div class="cab-empty-state">
      <i class="fa-solid fa-inbox" style="font-size:2rem;opacity:.3;margin-bottom:8px;display:block;"></i>
      <div>Aucune commande trouvée</div>
    </div>`;
    return;
  }

  const OP_COLOR = { Orange:'#FF6200', MTN:'#FFCC00', Moov:'#0066CC' };
  const OP_BG    = { Orange:'#FFF3E6', MTN:'#FFFAE0', Moov:'#E8F3FF' };

  list.innerHTML = txns.map(t => {
    const client  = DB.users.byId(t.client_id);
    const name    = client ? client.prenom + ' ' + client.nom : 'Client inconnu';
    const opClr   = OP_COLOR[t.operateur] || '#6b7280';
    const opBg    = OP_BG[t.operateur]    || '#fff';
    const isPend  = t.statut === 'en_attente';
    // Code couleur de statut (+ "en retard" dérivé) — voir Fmt.rowColors()
    // dans js/auth.js, source unique réutilisée dans toute l'app. La
    // bordure gauche/le fond de la carte restent réservés à l'opérateur
    // (déjà en place) ; le statut est signalé séparément par le liseré
    // droit + le point/pastille déjà existants, recolorés ici.
    const late    = Fmt.isLate(t);
    const rc      = Fmt.rowColors(t);
    const STLBL   = { 'terminé':'TERMINÉ', 'en_attente':'EN COURS', 'remboursé':'REMBOURSÉ', 'refusé':'REFUSÉ', 'suspendue':'SUSPENDUE' };
    const stDot   = rc.line;
    const stLbl   = late ? 'EN RETARD' : (STLBL[t.statut] || t.statut.toUpperCase());
    const ref     = Fmt.ref(t.id);
    const dt      = new Date(t.date);
    const time    = dt.toLocaleTimeString('fr-CI', { hour:'2-digit', minute:'2-digit' });
    const svcLbl  = t.service || (t.type === 'recharge_uv' ? 'Recharge UV' : 'Transfert Direct');
    const numero  = t.numero_beneficiaire || '—';
    const numeroFmt = numero !== '—' ? Fmt.phone(numero) : numero;
    const comm    = t.commission ? Fmt.money(t.commission) : null;

    const stPillBg  = rc.bg;
    const stPillClr = rc.text;

    return `<div class="cov-card fade-in" id="req-${t.id}" style="border-left-color:${opClr};background:${opBg};border-right:4px solid ${rc.line};">

      <!-- Ligne statut + ref -->
      <div class="cov-top">
        <div class="cov-status-row">
          <span class="cov-dot" style="background:${stDot}"></span>
          <span class="cov-status-lbl" style="color:${stDot}">${stLbl}</span>
        </div>
        <span class="cov-ref">${ref}</span>
      </div>

      <!-- Numéro destinataire — section spéciale bleu marine -->
      <div class="cov-num-row">
        <span class="cov-num cov-num--dial" onclick="dialCabNumber('${t.id}')" role="button" tabindex="0" title="Composer">${numeroFmt}</span>
        <button class="cov-copy-btn" onclick="event.stopPropagation(); navigator.clipboard.writeText('${numero}')" title="Copier">
          <i class="fa-regular fa-copy"></i>
        </button>
      </div>

      <!-- Méta : opérateur, service, client -->
      <div class="cov-meta-row">
        <span class="cov-meta-tag" style="color:${opClr};border-color:${opClr}55">${t.operateur}</span>
        <span class="cov-meta-tag">${svcLbl}</span>
        ${name !== 'Client inconnu' ? `<span class="cov-meta-tag cov-meta-tag--client"><i class="fa-solid fa-user"></i></span>` : ''}
      </div>

      <!-- Montant -->
      <div class="cov-amount-row">
        <span class="cov-amount">${Fmt.money(t.montant)}</span>
        ${comm ? `<span class="cov-comm">+${comm} commission</span>` : ''}
      </div>

      <!-- Pied : heure + statut -->
      <div class="cov-inner-foot">
        <span class="cov-inner-time">${time}</span>
        ${isPend ? `<span class="cov-countdown" data-assigned="${t.date_assignation || t.date}"><i class="fa-solid fa-clock"></i> —</span>` : ''}
        <span class="cov-inner-status" style="background:${stPillBg};color:${stPillClr}">
          <span style="background:${stDot};width:6px;height:6px;border-radius:50%;display:inline-block;margin-right:4px;"></span>
          ${stLbl}
        </span>
      </div>

      <!-- Boutons action (commandes en cours uniquement) -->
      ${isPend ? `
      <div class="cov-actions">
        <div class="cov-actions-row">
          <button class="cov-btn cov-btn--hold" onclick="holdRequest('${t.id}')" ${t.hold_used ? 'disabled' : ''}>
            <i class="fa-solid ${t.hold_used ? 'fa-lock-open' : 'fa-lock'}"></i> ${t.hold_used ? 'Déjà utilisé' : 'Conserver 5min'}
          </button>
          <button class="cov-btn cov-btn--refuse" onclick="refuseRequest('${t.id}')">
            <i class="fa-solid fa-circle-xmark"></i> Ramener
          </button>
        </div>
        ${t.type === 'facture' ? `
        <div class="factp-wrap" id="factp-wrap-${t.id}">
          <input type="file" id="factp-file-${t.id}" class="factp-file-input" onchange="handleFactureProofSelect('${t.id}', this)">
          <label for="factp-file-${t.id}" class="factp-upload-btn" id="factp-upload-lbl-${t.id}">
            <i class="fa-solid fa-camera"></i> Téléverser la preuve de paiement
          </label>
          <img id="factp-preview-${t.id}" class="factp-upload-preview" style="display:none" alt="Aperçu de la preuve">
          <button class="factp-submit-btn" onclick="submitFactureProofAndComplete('${t.id}')">
            <i class="fa-solid fa-check"></i> Terminer avec preuve
          </button>
        </div>` : `
        <button class="cov-btn cov-btn--done" onclick="acceptRequest('${t.id}')">
          <i class="fa-solid fa-check"></i> Terminer
        </button>`}
      </div>` : ''}

    </div>`;
  }).join('');

  _startOrderCountdownTick();
}

/* Décompte visible (min:s) du délai de 3 min (RETARD_MS) avant
   réattribution automatique — un seul intervalle partagé qui met à jour
   toutes les cartes en attente affichées, plutôt qu'un minuteur par
   carte (voir _startHoldCountdown pour le hold "Garder 5min", séparé).
   Redémarré à chaque rendu de la liste puisque le DOM est reconstruit. */
let _orderCountdownIv = null;

function _startOrderCountdownTick() {
  if (_orderCountdownIv) clearInterval(_orderCountdownIv);
  const tick = () => {
    const els = Array.from(document.querySelectorAll('.cov-countdown'));
    if (!els.length) { clearInterval(_orderCountdownIv); _orderCountdownIv = null; return; }

    // Une seule commande à la fois affiche son décompte actif — la plus
    // ancienne assignée. Les autres patientent visuellement jusqu'à ce
    // que celle-ci soit traitée ou disparaisse (passé 3 min). La règle des
    // 3 min / réattribution reste indépendante par commande côté données
    // (DB.business.sweepStaleOrders(), poll 30s) — ceci ne change que
    // l'affichage.
    els.sort((a, b) => new Date(a.dataset.assigned) - new Date(b.dataset.assigned));
    const active = els[0];

    els.forEach(el => {
      if (el !== active) {
        el.classList.add('cov-countdown--queued');
        el.innerHTML = '<i class="fa-solid fa-hourglass-half"></i> En attente de la commande précédente';
        return;
      }
      el.classList.remove('cov-countdown--queued');
      const assignedAt = new Date(el.dataset.assigned).getTime();
      const remaining = DB.RETARD_MS - (Date.now() - assignedAt);
      if (remaining <= 0) {
        // Retrait visuel immédiat de la carte dès les 3 min écoulées — la
        // réattribution réelle côté données suit son cours indépendamment
        // (voir commentaire ci-dessus). La stat "En cours" se resynchronise
        // au prochain sondage 30s (sweepStaleOrders) une fois la commande
        // réellement réattribuée côté données.
        const card = el.closest('.cov-card');
        if (card) card.remove();
        loadCabRealtimeStats();
        updateNotifBadge();
        return;
      }
      const s = Math.floor(remaining / 1000);
      const m = Math.floor(s / 60), sec = s % 60;
      el.innerHTML = `<i class="fa-solid fa-clock"></i> ${m}:${String(sec).padStart(2, '0')} avant réattribution`;
    });
  };
  tick();
  _orderCountdownIv = setInterval(tick, 1000);
}

/* ── Filtrage ──────────────────────────────────────────────────── */
function filterCabOrders(filter, btn) {
  _cabFilter = filter;
  document.querySelectorAll('.cof-ctab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  loadCabOrders(filter);
  _cabResume.orderFilter = filter;
  _saveCabResume();
}

/* ── Notifications sonores ─────────────────────────────────────────
   Deux rôles de son, indépendamment personnalisables (préréglage +
   aperçu) : "commande" (nouvelle commande, mais aussi commande validée/
   "Terminer" et réservée/"Garder 5min" — même famille d'évènement) et
   "reclamation" (nouvelle réclamation) — détectés par le sondage 30s de
   boot() (voir updateNotifBadge). Par défaut, deux préréglages distincts
   (cloche / pop double) pour que les deux évènements soient déjà
   audiblement différents sans configuration. Générées via Web Audio
   plutôt que des fichiers audio, pour ne pas ajouter d'assets binaires
   au dépôt (même principe que l'espace admin). */
const CAB_SOUND_PRESETS = [
  { key: 'cloche',   label: 'Cloche',       tones: [[880, 0, .18], [1175, .14, .22]] },
  { key: 'ding',     label: 'Ding',         tones: [[1046, 0, .28]] },
  { key: 'pop',      label: 'Pop double',   tones: [[600, 0, .08], [900, .06, .14]] },
  { key: 'douce',    label: 'Alerte douce', tones: [[587, 0, .2, 'triangle'], [494, .16, .24, 'triangle']] },
  { key: 'carillon', label: 'Carillon',     tones: [[784, 0, .16], [988, .11, .16], [1319, .22, .26]] },
];
const CAB_SOUND_DEFAULTS = { commande: 'cloche', reclamation: 'pop' };

const CabSound = {
  ctx: null,
  _ctx() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    return this.ctx;
  },
  isEnabled() { return localStorage.getItem('kbine_cab_notif_sound') !== 'off'; },
  _presetKey(role) { return role === 'reclamation' ? 'kbine_cab_notif_sound_preset_recla' : 'kbine_cab_notif_sound_preset'; },
  currentPreset(role = 'commande') {
    const key = localStorage.getItem(this._presetKey(role)) || CAB_SOUND_DEFAULTS[role] || CAB_SOUND_PRESETS[0].key;
    return CAB_SOUND_PRESETS.find(p => p.key === key) || CAB_SOUND_PRESETS[0];
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
    const preset = CAB_SOUND_PRESETS.find(p => p.key === key);
    if (preset) this.playPreset(preset);
  },
  notify(role = 'commande') {
    if (!this.isEnabled()) return;
    this.playPreset(this.currentPreset(role));
  },
};

function toggleCabNotifSound() {
  const nowOn = !CabSound.isEnabled();
  localStorage.setItem('kbine_cab_notif_sound', nowOn ? 'on' : 'off');
  _refreshCabNotifSoundUI();
  if (nowOn) CabSound.tone(880, 0, .14);
}

function toggleCabSoundPicker(role = 'commande') {
  const suffix  = role === 'reclamation' ? '-recla' : '';
  const section = document.getElementById(`cab-sound-picker${suffix}`);
  const icon    = document.getElementById(`cab-sound-icon${suffix}`);
  const btn     = document.getElementById(`cab-sound-btn${suffix}`);
  if (!section) return;
  const isOpen = section.style.display !== 'none';
  section.style.display = isOpen ? 'none' : 'flex';
  icon?.classList.toggle('open', !isOpen);
  btn?.classList.toggle('open', !isOpen);
  if (!isOpen) section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function selectCabSoundPreset(key, role = 'commande') {
  const suffix = role === 'reclamation' ? '-recla' : '';
  localStorage.setItem(CabSound._presetKey(role), key);
  document.querySelectorAll(`#cab-sound-picker${suffix} .cab-sound-option`).forEach(o =>
    o.classList.toggle('cab-sound-option--active', o.dataset.sound === key));
  CabSound.preview(key);
  const label = document.getElementById(`cab-sound-current${suffix}`);
  const preset = CAB_SOUND_PRESETS.find(p => p.key === key);
  if (label && preset) label.textContent = preset.label;
}

function _refreshCabNotifSoundUI() {
  const on     = CabSound.isEnabled();
  const toggle = document.getElementById('cab-notif-sound-toggle');
  const status = document.getElementById('cab-notif-sound-status');
  if (toggle) { toggle.classList.toggle('active', on); toggle.setAttribute('aria-checked', on); }
  if (status) { status.textContent = on ? 'Activées' : 'En silencieux'; status.classList.toggle('cab-notif-row-status--off', !on); }

  ['commande', 'reclamation'].forEach(role => {
    const suffix = role === 'reclamation' ? '-recla' : '';
    const currentLbl = document.getElementById(`cab-sound-current${suffix}`);
    if (currentLbl) currentLbl.textContent = CabSound.currentPreset(role).label;

    const picker = document.getElementById(`cab-sound-picker${suffix}`);
    if (picker && !picker.dataset.built) {
      const current = CabSound.currentPreset(role).key;
      picker.innerHTML = CAB_SOUND_PRESETS.map(p => `
        <div class="cab-sound-option${p.key === current ? ' cab-sound-option--active' : ''}" data-sound="${p.key}" onclick="selectCabSoundPreset('${p.key}','${role}')">
          <span class="cab-sound-option-radio"><i class="fa-solid fa-check"></i></span>
          <span class="cab-sound-option-label">${p.label}</span>
          <button type="button" class="cab-sound-preview-btn" onclick="event.stopPropagation();CabSound.preview('${p.key}')" title="Écouter">
            <i class="fa-solid fa-play"></i>
          </button>
        </div>`).join('');
      picker.dataset.built = '1';
    }
  });
}

/* ── Actions rapides : mode sombre ────────────────────────────────── */
function toggleCabDarkMode() {
  Theme.toggle();
  _refreshCabDarkBtn();
}

function _refreshCabDarkBtn() {
  const on   = document.body.classList.contains('dark');
  const btn  = document.getElementById('cqk-dark-btn');
  const ico  = document.getElementById('cqk-dark-ico');
  const lbl  = document.getElementById('cqk-dark-lbl');
  if (btn) { btn.classList.toggle('cqk-btn--on', on); btn.title = on ? 'Mode clair' : 'Mode sombre'; }
  if (ico) ico.className = on ? 'fa-regular fa-sun' : 'fa-regular fa-moon';
  if (lbl) lbl.textContent = on ? 'Mode clair' : 'Mode sombre';
}

/* ── Actions rapides : pause / reprise du service ─────────────────── */
async function toggleCabPause() {
  const user = DB.users.byId(currentUser.id);
  if (user.en_pause) {
    // Reprise immédiate, pas besoin de justification. Persisté côté
    // serveur (voir api/cabine_update_self.php) — c'est cette valeur,
    // jamais le cache local, que le moteur d'attribution des commandes
    // consulte pour savoir si de nouvelles commandes doivent t'être
    // envoyées.
    const res = await DB.business.cabineUpdateSelf(currentUser.id, { en_pause: false, pause_raison: null, pause_note: null, pause_debut: null });
    if (!res.ok) { Toast.error(res.error || 'Échec de la reprise — réessayez.'); return; }
    _refreshCabPauseUI();
    Toast.success(`Bon retour, ${user.prenom || 'partenaire'} ! Votre espace est de nouveau en service.`);
  } else {
    const form = document.getElementById('cab-pause-form');
    if (form) form.reset();
    const otherWrap = document.getElementById('cqk-reason-other-wrap');
    if (otherWrap) otherWrap.style.display = 'none';
    openModal('modal-cab-pause');
    _cabResume.pauseDraft = { isOpen: true, motif: '', note: '' };
    _saveCabResume();
  }
}

function closeCabPauseModal() {
  _cabResume.pauseDraft = null;
  _saveCabResume();
  closeModal('modal-cab-pause');
}

/* Liste de motifs à cocher (modals "Mettre en pause" / "Renvoyer la
   commande") — le vrai <select> reste la source de vérité (masqué), ces
   deux fonctions ne font que le garder synchronisé avec l'état visuel
   des lignes .cqk-reason-row. */
function _cabSyncReasonList(selectId, listId) {
  const select = document.getElementById(selectId);
  const value  = select ? select.value : '';
  document.querySelectorAll('#' + listId + ' .cqk-reason-row').forEach(row => {
    row.classList.toggle('sel', row.dataset.value === value);
  });
}

function _cabPickReason(selectId, listId, value) {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.value = value;
  select.dispatchEvent(new Event('change'));
  _cabSyncReasonList(selectId, listId);
}

function _saveCabPauseDraft() {
  const select  = document.getElementById('cqk-reason-select');
  const otherTxt = document.getElementById('cqk-reason-other');
  _cabResume.pauseDraft = {
    isOpen: true,
    motif: select ? select.value : '',
    note: otherTxt ? otherTxt.value : '',
  };
  _saveCabResume();
}

function onCabPauseReasonChange() {
  const select    = document.getElementById('cqk-reason-select');
  const otherWrap = document.getElementById('cqk-reason-other-wrap');
  const otherTxt  = document.getElementById('cqk-reason-other');
  const isOther   = select && select.value === 'Autre';
  if (otherWrap) otherWrap.style.display = isOther ? 'block' : 'none';
  if (otherTxt)  otherTxt.required = isOther;
  _saveCabPauseDraft();
}

async function handleCabPauseSubmit(event) {
  event.preventDefault();
  const select = document.getElementById('cqk-reason-select');
  if (!select || !select.value) { Toast.error('Choisissez un motif.'); return; }

  const raison = select.value;
  let note = null;
  if (raison === 'Autre') {
    const txt = (document.getElementById('cqk-reason-other')?.value || '').trim();
    if (!txt) { Toast.error('Merci de préciser le motif de la pause.'); return; }
    note = txt;
  }

  const pauseDebut = new Date().toISOString();
  const res = await DB.business.cabineUpdateSelf(currentUser.id, { en_pause: true, pause_raison: raison, pause_note: note, pause_debut: pauseDebut });
  if (!res.ok) { Toast.error(res.error || 'Échec de la mise en pause — réessayez.'); return; }
  closeModal('modal-cab-pause');
  _cabResume.pauseDraft = null;
  _saveCabResume();
  _refreshCabPauseUI();
  const heure = new Date(pauseDebut).toLocaleTimeString('fr-CI', { hour: '2-digit', minute: '2-digit' });
  Toast.info(`Espace mis en pause à ${heure} — ${raison}${note ? ' : ' + note : ''}.`);
}

function _refreshCabPauseUI() {
  const user   = DB.users.byId(currentUser.id);
  const paused = !!(user && user.en_pause);
  const btn    = document.getElementById('cqk-pause-btn');
  const ico    = document.getElementById('cqk-pause-ico');
  const lbl    = document.getElementById('cqk-pause-lbl');
  const status = document.getElementById('cqk-pause-status');
  const since  = document.getElementById('cqk-pause-since');
  if (btn) { btn.classList.toggle('cqk-btn--paused', paused); btn.title = paused ? 'En pause' : 'Pause'; }
  if (ico) ico.className = paused ? 'fa-regular fa-circle-play' : 'fa-regular fa-circle-pause';
  if (lbl) lbl.textContent = paused ? 'En pause' : 'Pause';
  if (status) status.style.display = paused ? 'flex' : 'none';
  if (since && paused && user.pause_debut) {
    since.textContent = new Date(user.pause_debut).toLocaleTimeString('fr-CI', { hour: '2-digit', minute: '2-digit' });
  }
}

/* ── Actions rapides : actualiser ─────────────────────────────────── */
function refreshCabPage(btn) {
  const ico = document.getElementById('cqk-refresh-ico');
  if (ico) ico.classList.add('cqk-spin');
  if (btn) btn.disabled = true;
  setTimeout(() => location.reload(), 350);
}

/* ── Recherche par ID ──────────────────────────────────────────── */
function searchCabOrder(query) {
  const clearBtn = document.getElementById('cab-search-clear');
  if (clearBtn) clearBtn.style.display = query ? 'flex' : 'none';

  if (!query.trim()) { loadCabOrders(_cabFilter); return; }

  const q    = query.trim().toLowerCase();
  const txns = DB.transactions.byCabine(currentUser.id).filter(t =>
    t.id.toLowerCase().includes(q) ||
    Fmt.ref(t.id).toLowerCase().includes(q) ||
    (t.numero_beneficiaire || '').includes(q)
  );
  renderCabOrders(txns);
}

function clearCabSearch() {
  const input = document.getElementById('cab-order-search');
  if (input) input.value = '';
  const clearBtn = document.getElementById('cab-search-clear');
  if (clearBtn) clearBtn.style.display = 'none';
  loadCabOrders(_cabFilter);
}

/* ── Toggle réseaux ────────────────────────────────────────────── */
function _setNetStatusLabel(net, on) {
  const el = document.getElementById('status-' + net);
  if (!el) return;
  el.textContent = on ? 'Actif' : 'Inactif';
  el.classList.toggle('cab-net-status--on', on);
}

// Le carré perd sa couleur de marque et redevient blanc quand le réseau est désactivé.
function _setNetLineState(net, on) {
  const line = document.getElementById('toggle-' + net)?.closest('.cab-net-line');
  if (line) line.classList.toggle('cab-net-line--off', !on);
}

async function toggleNetwork(net, btn) {
  _cabNetworks[net] = !_cabNetworks[net];
  localStorage.setItem('kbine_cab_nets', JSON.stringify(_cabNetworks));
  if (btn) btn.classList.toggle('active', _cabNetworks[net]);
  _setNetLineState(net, _cabNetworks[net]);
  _setNetStatusLabel(net, _cabNetworks[net]);
  loadCabOrders(_cabFilter);
  Toast.info(`Réseau ${net.charAt(0).toUpperCase() + net.slice(1)} ${_cabNetworks[net] ? 'activé' : 'désactivé'}`);

  // Persisté côté serveur (voir api/cabine_update_self.php) — c'est cette
  // valeur, jamais le cache local, que le moteur d'attribution des
  // commandes consulte pour décider de t'envoyer ou non une commande sur
  // ce réseau.
  const res = await DB.business.cabineUpdateSelf(currentUser.id, { reseaux_actifs: _cabNetworks });
  if (!res.ok) Toast.error(res.error || 'Échec de l\'enregistrement — réessayez.');
}

/* ── Accepter / Refuser une demande ────────────────────────────── */
/* Countdown extrait de holdRequest() pour être réutilisable par
   restoreCabState() (reprise après reload avec le temps restant
   recalculé depuis _cabResume.holds[txnId], pas repartie à 5:00). */
function _startHoldCountdown(txnId, remainingSeconds) {
  const btn = document.querySelector(`#req-${txnId} .cov-btn--hold`);
  if (!btn || remainingSeconds <= 0) return;
  btn.disabled = true;
  let s = remainingSeconds;
  const render = () => {
    const m = Math.floor(s / 60), sec = s % 60;
    btn.innerHTML = `<i class="fa-solid fa-clock"></i> ${m}:${sec.toString().padStart(2,'0')}`;
  };
  render();
  const iv = setInterval(() => {
    s--;
    if (s <= 0) {
      clearInterval(iv);
      // Reste désactivé : une seule utilisation par commande (voir
      // holdRequest()), le bouton ne redevient jamais cliquable pour
      // cette commande une fois les 5 minutes écoulées.
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-lock-open"></i> Déjà utilisé';
      delete _cabResume.holds[txnId];
      _saveCabResume();
      return;
    }
    render();
  }, 1000);
}

async function holdRequest(txnId) {
  const txn = DB.transactions.byId(txnId);
  if (!txn) return;
  // Une seule utilisation de "Conserver 5min" par commande — une fois
  // consommée, le bouton reste désactivé (voir renderCabOrders()), même
  // après la fin des 5 minutes, au lieu de redevenir cliquable à l'infini.
  if (txn.hold_used) return;

  // Prolonge aussi le délai avant réattribution automatique (DB.RETARD_MS,
  // 3 min) de 5 minutes supplémentaires — sans ça, la commande pouvait
  // être réattribuée à une autre cabine pendant que celle-ci la "gardait"
  // volontairement. Persisté côté serveur (voir api/orders_hold.php) :
  // c'est la date d'assignation EN BASE, jamais le cache local, que le
  // balayage des commandes en retard (api/orders_sweep.php) consulte.
  const res = await DB.business.holdOrder(txnId);
  if (!res.ok) { Toast.error(res.error || 'Échec de la réservation — réessayez.'); return; }
  const newAssignation = res.transaction.date_assignation;
  const countdownEl = document.querySelector(`#req-${txnId} .cov-countdown`);
  if (countdownEl) countdownEl.dataset.assigned = newAssignation;

  _cabResume.holds[txnId] = Date.now();
  _saveCabResume();
  _startHoldCountdown(txnId, 300);
  CabSound.notify();
  showToast('Commande réservée pour 5 minutes', 'success');
}

async function acceptRequest(txnId) {
  const card = document.getElementById('req-' + txnId);
  if (card) { card.style.opacity = '.5'; card.style.pointerEvents = 'none'; }

  const res = await DB.business.acceptRequest(txnId, currentUser.id);
  if (res.ok) {
    Toast.success('Transfert marqué comme terminé ! Commission créditée.');
    CabSound.notify();
    currentUser = Auth.refresh();
    loadCabHome();
  } else {
    Toast.error(res.error);
    if (card) { card.style.opacity = '1'; card.style.pointerEvents = ''; }
  }
}

/* ── Preuve de paiement (commandes facture) — obligatoire avant de
   pouvoir valider ce type de commande, visible ensuite côté client dans
   le suivi de commande (voir openOrderTracking() dans js/client.js).
   Même patron d'upload que la résolution de réclamation ci-dessous
   (handleReclaFileSelect/_reclaPendingScreenshots), classes CSS
   réutilisées telles quelles. ── */
const _facturePendingProofs = {};

function handleFactureProofSelect(txnId, input) {
  const file = input.files && input.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    _facturePendingProofs[txnId] = reader.result;
    const preview = document.getElementById('factp-preview-' + txnId);
    if (preview) {
      if (file.type.startsWith('image/')) { preview.src = reader.result; preview.style.display = 'block'; }
      else { preview.style.display = 'none'; }
    }
    const lbl = document.getElementById('factp-upload-lbl-' + txnId);
    if (lbl) lbl.innerHTML = '<i class="fa-solid fa-check"></i> Fichier sélectionné — changer';
  };
  reader.readAsDataURL(file);
}

async function submitFactureProofAndComplete(txnId) {
  const proof = _facturePendingProofs[txnId];
  if (!proof) { Toast.error("Veuillez téléverser une capture d'écran de preuve de paiement."); return; }

  const card = document.getElementById('req-' + txnId);
  if (card) { card.style.opacity = '.5'; card.style.pointerEvents = 'none'; }

  const res = await DB.business.acceptRequest(txnId, currentUser.id, proof);
  if (res.ok) {
    delete _facturePendingProofs[txnId];
    Toast.success('Commande terminée ! Preuve transmise au client. Commission créditée.');
    CabSound.notify();
    currentUser = Auth.refresh();
    loadCabHome();
  } else {
    Toast.error(res.error);
    if (card) { card.style.opacity = '1'; card.style.pointerEvents = ''; }
  }
}

/* ── Renvoi manuel d'une commande (motif obligatoire) ─────────────
   Même patron que la mise en pause (modal-cab-pause / onCabPauseReasonChange
   ci-dessus) : select à 4 motifs, justification texte requise uniquement
   pour "Autre". Réutilise DB.business.refuseRequest() (js/db.js), qui suit
   désormais la même logique de réattribution que le timeout (feature 6). */
let _cabRefuseTxnId = null;

function refuseRequest(txnId) {
  _cabRefuseTxnId = txnId;
  const form = document.getElementById('cab-refuse-form');
  if (form) form.reset();
  const otherWrap = document.getElementById('cab-refuse-other-wrap');
  if (otherWrap) otherWrap.style.display = 'none';
  _cabSyncReasonList('cab-refuse-motif', 'cab-refuse-motif-list');
  openModal('modal-cab-refuse');
}

function closeCabRefuseModal() {
  _cabRefuseTxnId = null;
  closeModal('modal-cab-refuse');
}

/* Assistant WhatsApp cabine — liste gérée par le super admin (onglet
   "Assistant clientèle cabine"), lue en direct depuis DB.settings à
   chaque clic (aucune donnée mise en cache côté cabine, donc toute
   modification admin est visible dès le prochain clic). */
async function openCabWhatsappPicker() {
  const contacts = (((await DB.settings.get()).assistant_cabine || {}).whatsapp || []).map(DB.normalizeContact);
  const list = document.getElementById('cab-wa-picker-list');
  if (!contacts.length) {
    Toast.error('Aucun assistant WhatsApp configuré pour le moment.');
    return;
  }
  list.innerHTML = contacts.map(c => `
    <div class="cwa-row" onclick="cabPickWhatsapp('${c.numero}')">
      <div class="cwa-avatar"><i class="fa-brands fa-whatsapp"></i><span class="cwa-dot"></span></div>
      <div class="cwa-txt">
        <div class="cwa-name">${c.nom || Fmt.phone(c.numero)}</div>
        <div class="cwa-sub">${c.nom ? Fmt.phone(c.numero) : 'Assistant WhatsApp'}</div>
      </div>
      <i class="fa-solid fa-chevron-right cwa-chev"></i>
    </div>`).join('');
  openModal('modal-cab-wa-picker');
}

function cabPickWhatsapp(numero) {
  const link = Fmt.whatsappLink(numero);
  if (link) window.open(link, '_blank');
  closeModal('modal-cab-wa-picker');
}

function onCabRefuseReasonChange() {
  const select    = document.getElementById('cab-refuse-motif');
  const otherWrap = document.getElementById('cab-refuse-other-wrap');
  const otherTxt  = document.getElementById('cab-refuse-other');
  const isOther   = select && select.value === 'autre';
  if (otherWrap) otherWrap.style.display = isOther ? 'block' : 'none';
  if (otherTxt)  otherTxt.required = isOther;
}

async function confirmCabRefuse(event) {
  event.preventDefault();
  if (!_cabRefuseTxnId) return;
  const select = document.getElementById('cab-refuse-motif');
  const motif  = select ? select.value : '';
  if (!motif) { Toast.error('Choisissez un motif.'); return; }

  let justification = '';
  if (motif === 'autre') {
    justification = (document.getElementById('cab-refuse-other')?.value || '').trim();
    if (!justification) { Toast.error('Merci de préciser le motif du renvoi.'); return; }
  }

  const res = await DB.business.refuseRequest(_cabRefuseTxnId, currentUser.id, motif, justification);
  closeModal('modal-cab-refuse');
  _cabRefuseTxnId = null;
  if (res.ok) {
    Toast.info(res.reassignedTo ? 'Commande renvoyée et réaffectée à une autre cabine.' : 'Commande renvoyée — remise en attente côté administration.');
    // Rafraîchit tout de suite si ce renvoi vient de déclencher une
    // suspension automatique (5 renvois en 2 min) — pas d'attente du
    // sondage 30s pour voir apparaître le bandeau (voir objectif 6).
    currentUser = Auth.refresh();
    loadCabBalanceCard();
    loadCabOrders(_cabFilter);
    loadCabRealtimeStats();
    updateNotifBadge();
  } else {
    Toast.error(res.error);
  }
}

/* ── Historique retraits ───────────────────────────────────────── */
/* Historique des retraits, classé par méthode de retrait (Orange
   Money, Moov Money, Djamo, Wave Business, Wave Normal, Compte
   bancaire) — un en-tête par réseau, nom seul, sans logo. */
/* Couleurs de marque déjà établies pour ces opérateurs ailleurs dans
   l'app (voir PAYMENT_METHODS dans js/client.js) — réutilisées ici pour
   la puce de groupe et l'icône de chaque retrait. */
const RETRAIT_METHODE_STYLE = {
  'Orange Money':   { color: '#FF6200', gradient: 'linear-gradient(150deg,#FF9A3C,#FF6200)', ico: 'fa-wallet' },
  'Moov Money':      { color: '#00A3E0', gradient: 'linear-gradient(150deg,#5ECBF5,#00A3E0)', ico: 'fa-wallet' },
  'Djamo':           { color: '#FF4E6A', gradient: 'linear-gradient(150deg,#FF8FA3,#FF4E6A)', ico: 'fa-wallet' },
  'Wave Business':   { color: '#1AABE6', gradient: 'linear-gradient(150deg,#5ECFF2,#1AABE6)', ico: 'fa-wallet' },
  'Wave Normal':     { color: '#1AABE6', gradient: 'linear-gradient(150deg,#5ECFF2,#1AABE6)', ico: 'fa-wallet' },
  'Compte bancaire': { color: '#64748B', gradient: 'linear-gradient(150deg,#94A3B8,#475569)', ico: 'fa-building-columns' },
};

async function loadCabRetraits() {
  const list = document.getElementById('cab-retraits-list');
  if (!list) return;
  await DB.retraits.refresh();

  const all       = DB.retraits.byCabine(currentUser.id);
  // Les sanctions (voir DB.business.refundTransaction, type: 'sanction')
  // sont des prélèvements imposés, pas des retraits demandés par la
  // cabine — exclues des statistiques "Retraits"/"Total retiré" et
  // affichées à part ci-dessous, jamais mêlées aux groupes par méthode.
  const retraits  = all.filter(r => r.type !== 'sanction');
  const sanctions = all.filter(r => r.type === 'sanction');

  const totalRetire = retraits.filter(r => r.statut === 'terminé').reduce((s, r) => s + r.montant, 0);
  const setStat = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setStat('cab-retraits-count', retraits.length);
  setStat('cab-retraits-total', Fmt.money(totalRetire));

  if (!all.length) {
    list.innerHTML = `<div class="cab-empty-state">
      <i class="fa-solid fa-clock-rotate-left" style="font-size:2rem;opacity:.3;margin-bottom:8px;display:block;"></i>
      <div>Aucun retrait enregistré</div>
    </div>`;
    return;
  }

  const groups = {};
  DB.retraits.methodes.forEach(m => { groups[m] = []; });
  retraits.forEach(r => {
    if (!groups[r.methode_retrait]) groups[r.methode_retrait] = [];
    groups[r.methode_retrait].push(r);
  });

  const sanctionsHtml = sanctions.length ? `<div class="rgroup">
      <div class="rgroup-head">
        <span class="rgroup-dot" style="background:#EF4444"></span>
        <span class="rgroup-name">Sanctions</span>
        <span class="rgroup-count">${sanctions.length}</span>
      </div>
      <div class="rgroup-list">${sanctions.map((r, i) => {
        const ref  = Fmt.ref(r.id);
        const dt   = new Date(r.date);
        const day  = dt.toLocaleDateString('fr-CI', { day:'2-digit', month:'short', year:'numeric' });
        const time = dt.toLocaleTimeString('fr-CI', { hour:'2-digit', minute:'2-digit' });
        return `<div class="rrow rrow--sanction" style="animation-delay:${(i * 0.04).toFixed(2)}s">
          <span class="rrow-ico rrow-ico--sanction"><i class="fa-solid fa-triangle-exclamation"></i></span>
          <div class="rrow-main">
            <div class="rrow-amount rrow-amount--sanction">-${Fmt.money(r.montant)}</div>
            <div class="rrow-meta"><span>${day}</span><span>${time}</span><span>#${ref}</span></div>
            ${r.motif ? `<div class="rrow-motif">${r.motif}</div>` : ''}
          </div>
          <span class="rrow-status rrow-status--sanction">
            <i class="fa-solid fa-triangle-exclamation"></i> Sanction
          </span>
        </div>`;
      }).join('')}</div>
    </div>` : '';

  const methodGroupsHtml = DB.retraits.methodes.map(methode => {
    const items = groups[methode];
    if (!items.length) return '';
    const style = RETRAIT_METHODE_STYLE[methode] || RETRAIT_METHODE_STYLE['Compte bancaire'];

    const rows = items.map((r, i) => {
      const ref     = Fmt.ref(r.id);
      const dt      = new Date(r.date);
      const day     = dt.toLocaleDateString('fr-CI', { day:'2-digit', month:'short', year:'numeric' });
      const time    = dt.toLocaleTimeString('fr-CI', { hour:'2-digit', minute:'2-digit' });
      const pending = r.statut === 'en_attente';

      return `<div class="rrow" style="animation-delay:${(i * 0.04).toFixed(2)}s">
        <span class="rrow-ico" style="background:${style.gradient}"><i class="fa-solid ${style.ico}"></i></span>
        <div class="rrow-main">
          <div class="rrow-amount">${Fmt.money(r.montant)}</div>
          <div class="rrow-meta"><span>${day}</span><span>${time}</span><span>#${ref}</span></div>
        </div>
        <span class="rrow-status ${pending ? 'rrow-status--pending' : 'rrow-status--done'}">
          <i class="fa-solid ${pending ? 'fa-hourglass-half' : 'fa-circle-check'}"></i> ${pending ? 'En attente' : 'Terminé'}
        </span>
      </div>`;
    }).join('');

    return `<div class="rgroup">
      <div class="rgroup-head">
        <span class="rgroup-dot" style="background:${style.color}"></span>
        <span class="rgroup-name">${methode}</span>
        <span class="rgroup-count">${items.length}</span>
      </div>
      <div class="rgroup-list">${rows}</div>
    </div>`;
  }).join('');

  list.innerHTML = sanctionsHtml + methodGroupsHtml;
}

/* ── Transférer à un cabiniste (feature 1) ──────────────────────────
   Recherche exacte par cabine_nom, avec confirmation visuelle du
   destinataire avant envoi. Voir DB.business.cabineTransfer. */
let _cabTransferRecipientId = null;

function handleCabTransferMontantChange() {
  const montant = parseFloat(document.getElementById('cab-transfer-montant').value) || 0;
  const totalEl = document.getElementById('cab-transfer-total');
  const submitBtn = document.getElementById('cab-transfer-submit-btn');
  const ready = montant > 0 && !!_cabTransferRecipientId;
  totalEl.textContent = montant > 0 ? Fmt.money(montant + DB.TRANSFERT_CABINE_FRAIS) : '—';
  totalEl.classList.toggle('ready', ready);
  submitBtn.disabled = !ready;
  submitBtn.classList.toggle('ready', ready);

  document.querySelectorAll('.tf-amount-chip').forEach(chip => {
    chip.classList.toggle('sel', Number(chip.dataset.amount) === montant);
  });

  _cabResume.transferDraft = _cabResume.transferDraft || { nom: '', montant: '' };
  _cabResume.transferDraft.montant = document.getElementById('cab-transfer-montant').value;
  _saveCabResume();
}

function pickCabTransferAmount(amount) {
  document.getElementById('cab-transfer-montant').value = amount;
  handleCabTransferMontantChange();
}

function handleCabTransferLookup(nomQuery) {
  const preview = document.getElementById('cab-transfer-preview');
  _cabTransferRecipientId = null;

  _cabResume.transferDraft = _cabResume.transferDraft || { nom: '', montant: '' };
  _cabResume.transferDraft.nom = nomQuery || '';
  _saveCabResume();

  const needle = (nomQuery || '').trim().toLowerCase();
  if (!needle) { preview.innerHTML = ''; handleCabTransferMontantChange(); return; }

  const matches = DB.users.byRole('cabine').filter(c =>
    c.statut === 'actif' && c.id !== currentUser.id && (c.cabine_nom || '').trim().toLowerCase() === needle
  );

  if (!matches.length) {
    preview.innerHTML = `<div class="tf-preview tf-preview--error">
      <span class="tf-preview-ico"><i class="fa-solid fa-circle-xmark"></i></span>
      <div><div class="tf-preview-name">Cabine introuvable</div><div class="tf-preview-sub">Vérifiez le nom ou son statut (inactive ?)</div></div>
    </div>`;
    handleCabTransferMontantChange();
    return;
  }

  if (matches.length > 1) {
    preview.innerHTML = `<div class="tf-preview-pick-hint">Plusieurs cabines portent ce nom, choisissez :</div>` +
      matches.map(c => `
        <label class="tf-preview-pick-row">
          <input type="radio" name="cab-transfer-pick" value="${c.id}" onchange="_cabTransferPick('${c.id}')">
          <span>${c.prenom} ${c.nom} — <strong>${c.cabine_nom}</strong> (${c.zone || 'N/A'})</span>
        </label>`).join('');
    handleCabTransferMontantChange();
    return;
  }

  _renderCabTransferMatch(matches[0]);
}

function _cabTransferPick(id) {
  const c = DB.users.byId(id);
  if (c) _renderCabTransferMatch(c, true);
}

function _renderCabTransferMatch(c, keepList = false) {
  const preview = document.getElementById('cab-transfer-preview');
  _cabTransferRecipientId = c.id;

  const confirmHtml = `<div class="tf-preview tf-preview--ok">
    <span class="tf-preview-ico"><i class="fa-solid fa-circle-check"></i></span>
    <div><div class="tf-preview-name">${c.prenom} ${c.nom}</div><div class="tf-preview-sub">${c.cabine_nom}</div></div>
  </div>`;

  if (!keepList) preview.innerHTML = confirmHtml;
  else preview.insertAdjacentHTML('beforeend', confirmHtml);

  handleCabTransferMontantChange();
}

async function handleCabTransferSubmit() {
  const montant = parseFloat(document.getElementById('cab-transfer-montant').value);
  if (!_cabTransferRecipientId || !montant || montant <= 0) { Toast.error('Renseignez un destinataire et un montant valides.'); return; }

  const res = await DB.business.cabineTransfer(currentUser.id, DB.users.byId(_cabTransferRecipientId).cabine_nom, montant);
  if (!res.ok) { Toast.error(res.error); return; }

  Toast.success(`${Fmt.money(montant)} envoyés à ${res.recipient.prenom} ${res.recipient.nom}.`);
  currentUser = Auth.refresh();
  document.getElementById('cab-transfer-nom').value = '';
  document.getElementById('cab-transfer-montant').value = '';
  document.getElementById('cab-transfer-preview').innerHTML = '';
  const totalEl = document.getElementById('cab-transfer-total');
  const submitBtn = document.getElementById('cab-transfer-submit-btn');
  totalEl.textContent = '—';
  totalEl.classList.remove('ready');
  submitBtn.disabled = true;
  submitBtn.classList.remove('ready');
  document.querySelectorAll('.tf-amount-chip').forEach(chip => chip.classList.remove('sel'));
  _cabTransferRecipientId = null;
  _cabResume.transferDraft = null;
  _saveCabResume();
  loadCabHome();
  loadCabTransferHistory();
}

async function loadCabTransferHistory() {
  const list = document.getElementById('cab-transfer-history-list');
  if (!list) return;
  await DB.transferts_cabine.refresh();
  const items = DB.transferts_cabine.byCabine(currentUser.id);
  if (!items.length) {
    list.innerHTML = `<div class="cab-empty-state"><i class="fa-solid fa-right-left" style="font-size:2rem;opacity:.3;margin-bottom:8px;display:block;"></i><div>Aucun transfert</div></div>`;
    return;
  }
  list.innerHTML = items.map(t => {
    const sent = t.from_cabine_id === currentUser.id;
    const other = DB.users.byId(sent ? t.to_cabine_id : t.from_cabine_id);
    const dt = new Date(t.date);
    const day = dt.toLocaleDateString('fr-CI', { day:'2-digit', month:'short', year:'numeric' });
    const time = dt.toLocaleTimeString('fr-CI', { hour:'2-digit', minute:'2-digit' });
    return `<div class="cab-retrait-row">
      <div class="cab-retrait-row-info">
        <span class="cab-retrait-row-amount">${sent ? '-' : '+'}${Fmt.money(t.montant)}</span>
        <span class="cab-retrait-row-meta">${sent ? 'Envoyé à' : 'Reçu de'} ${other ? (other.cabine_nom || other.prenom + ' ' + other.nom) : '?'} · ${day} · ${time}</span>
      </div>
    </div>`;
  }).join('');
}

/* ── Historique (transactions propres à la cabine, ex. un réabonnement) ──
   Sans client_id — distinct des commandes traitées pour des clients
   (voir loadCommissions() ci-dessous, qui exclut désormais ces mêmes
   transactions pour ne pas s'y mélanger). Même patron de carte que
   renderHistoryList() côté client (js/client.js), classes .hoc-*
   déjà réutilisables telles quelles (aucun style spécifique client). */
const CAB_HISTORY_TYPE_META = {
  reabonnement: { ico: 'fa-rotate', clr: '#F59E0B', lbl: 'Réabonnement' },
};

// Statut affiché par transaction : 'terminé' (toujours vrai avant
// l'introduction du circuit d'assignation pour la recharge UV, d'où le
// texte "Terminée" codé en dur d'origine) n'est plus systématique — une
// recharge UV auto-initiée peut rester 'en_attente' (assignée ou non).
const CAB_HISTORY_STATUT_META = {
  'terminé':   { pill: 'hoc-pill--ok',   ico: 'fa-circle-check',    lbl: 'Terminée' },
  'en_attente':{ pill: 'hoc-pill--pend', ico: 'fa-hourglass-half',  lbl: 'En attente' },
  'refusé':    { pill: 'hoc-pill--ko',   ico: 'fa-circle-xmark',    lbl: 'Refusée' },
  'remboursé': { pill: 'hoc-pill--rfd',  ico: 'fa-rotate-left',     lbl: 'Remboursée' },
};

// Filtre affiché au-dessus de l'historique (même segmented control que
// "Mes commandes", voir .cof-tabs/.cof-ctab dans cabine.html) : "Tout",
// "Transferts" (cabine-à-cabine, voir loadCabTransferHistory() ci-dessus)
// ou "Commandes" (transactions propres + commandes traitées pour des
// clients, déjà fusionnées ci-dessous).
let _cabHistFilter = 'all';

function filterCabHistory(filter, btn) {
  _cabHistFilter = filter;
  document.querySelectorAll('#cab-sec-historique .cof-ctab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  loadCabHistory();
}

function _cabHistDateLabel(dateStr) {
  const dt = new Date(dateStr);
  const day = dt.toLocaleDateString('fr-CI', { day: '2-digit', month: 'short' });
  const time = dt.toLocaleTimeString('fr-CI', { hour: '2-digit', minute: '2-digit' });
  return `${day} · ${time}`;
}

function _renderCabHistTxnCard(t) {
  const meta   = CAB_HISTORY_TYPE_META[t.type] || { ico: 'fa-circle-nodes', clr: '#7c3aed', lbl: t.type || 'Transaction' };
  const statut = CAB_HISTORY_STATUT_META[t.statut] || { pill: 'hoc-pill--pend', ico: 'fa-clock', lbl: t.statut };
  const d      = t.details || {};
  const ref    = Fmt.ref(t.id);
  return `
  <div class="hoc-card">
    <div class="hoc-card-top">
      <div class="hoc-id-row">
        <div class="hoc-ico" style="background:${meta.clr}1a;color:${meta.clr};"><i class="fa-solid ${meta.ico}"></i></div>
        <div>
          <div class="hoc-svc">${t.service || meta.lbl}</div>
          <div class="hoc-meta">Réf : ${ref}${d.moyen_paiement ? ' · ' + d.moyen_paiement : ''} · ${_cabHistDateLabel(t.date)}</div>
        </div>
      </div>
      <div class="hoc-amounts">
        <div class="hoc-montant">-${Fmt.money(t.montant)}</div>
        <span class="hoc-pill ${statut.pill}"><i class="fa-solid ${statut.ico}"></i> ${statut.lbl}</span>
      </div>
    </div>
  </div>`;
}

function _renderCabHistTransfertRow(t) {
  const sent  = t.from_cabine_id === currentUser.id;
  const other = DB.users.byId(sent ? t.to_cabine_id : t.from_cabine_id);
  return `<div class="cab-retrait-row">
    <div class="cab-retrait-row-info">
      <span class="cab-retrait-row-amount">${sent ? '-' : '+'}${Fmt.money(t.montant)}</span>
      <span class="cab-retrait-row-meta">${sent ? 'Envoyé à' : 'Reçu de'} ${other ? (other.cabine_nom || other.prenom + ' ' + other.nom) : '?'} · ${_cabHistDateLabel(t.date)}</span>
    </div>
  </div>`;
}

async function loadCabHistory() {
  const list = document.getElementById('cab-historique-list');
  if (!list) return;

  // Fusionne 3 sources : ses propres transactions internes (ex.
  // réabonnement, sans client_id) + ses propres demandes auto-initiées
  // (ex. recharge UV, désormais potentiellement assignées à une AUTRE
  // cabine — voir DB.business.cabineSelfRecharge — donc invisibles via
  // byCabine seul) + les transferts cabine-à-cabine (voir
  // loadCabTransferHistory() ci-dessus, même source de données).
  await DB.transferts_cabine.refresh();

  const selfTxns      = DB.transactions.byCabine(currentUser.id).filter(t => !t.client_id);
  const requestedTxns = DB.transactions.byClient(currentUser.id);
  const transferts    = DB.transferts_cabine.byCabine(currentUser.id);

  const items = [];
  if (_cabHistFilter !== 'transferts') {
    [...selfTxns, ...requestedTxns].forEach(t => items.push({ date: t.date, html: _renderCabHistTxnCard(t) }));
  }
  if (_cabHistFilter !== 'commandes') {
    transferts.forEach(t => items.push({ date: t.date, html: _renderCabHistTransfertRow(t) }));
  }
  items.sort((a, b) => new Date(b.date) - new Date(a.date));

  if (!items.length) {
    list.innerHTML = `<div class="cab-empty-state"><i class="fa-solid fa-clock-rotate-left" style="font-size:2rem;opacity:.3;margin-bottom:8px;display:block;"></i><div>Aucune transaction</div></div>`;
    return;
  }

  list.innerHTML = `<div class="hoc-list">${items.map(i => i.html).join('')}</div>`;
}

/* ── Commissions ───────────────────────────────────────────────── */
let _cabCommTxns = [];

function loadCommissions() {
  const user  = DB.users.byId(currentUser.id);
  // Exclut les transactions propres à la cabine (sans client_id, ex. un
  // réabonnement — voir loadCabHistory() ci-dessous) : "Mes commissions"
  // ne couvre que les commandes traitées pour des clients.
  const txns  = DB.transactions.byCabine(currentUser.id).filter(t => t.statut === 'terminé' && t.client_id);
  const totalComm = txns.reduce((s, t) => s + (t.commission || 0), 0);

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('comm-total',     Fmt.money(user.commissions_total || totalComm));
  set('comm-txn-count', user.transferts_total || txns.length);
  set('comm-rate',      DB.commissions.active().pourcentage + '%');

  _cabCommTxns = txns;
  const search = document.getElementById('cab-comm-search');
  if (search) search.value = '';
  renderCommList(txns);
}

function searchCabCommissions() {
  const q = document.getElementById('cab-comm-search').value.toLowerCase().trim();
  let txns = _cabCommTxns;
  if (q) txns = txns.filter(t =>
    (t.numero_beneficiaire || '').toLowerCase().includes(q) ||
    (t.id || '').toLowerCase().includes(q)
  );
  renderCommList(txns);
}

function renderCommList(txns) {
  const list = document.getElementById('comm-list');
  if (!list) return;
  const recent = txns.slice(0, 30);
  if (!recent.length) {
    list.innerHTML = `<div class="cab-empty-state cab-empty-state--light">Aucune commission</div>`;
    return;
  }

  // Heure seule (HH:MM), ou '—' si l'étape n'a pas de date connue
  // (anciennes données de démo créées avant le suivi assignation/validation).
  const hm = (d) => d ? new Date(d).toLocaleTimeString('fr-CI', { hour:'2-digit', minute:'2-digit' }) : '—';

  // .ccm-card a un fond sombre (dégradé charbon) : un simple liseré
  // gauche solide (voir Fmt.rowColors(), js/auth.js) porte le code
  // couleur de statut ici, pas la teinte de fond claire utilisée sur
  // les listes à fond blanc (illisible sur fond sombre).
  list.innerHTML = recent.map(t => `
    <div class="ccm-card" style="border-left:3px solid ${Fmt.rowColors(t).line};" onclick="openCabOrderDetail('${t.id}')">
      <div class="ccm-card-top">
        <div class="ccm-card-info">
          <span class="ccm-op">${Fmt.operator(t.operateur)}</span>
          <code class="ccm-id">${Fmt.ref(t.id)}</code>
        </div>
        <div class="ccm-amounts">
          <span class="ccm-montant">${Fmt.money(t.montant)}</span>
          <span class="ccm-comm">+${Fmt.money(t.commission || 0)}</span>
        </div>
      </div>
      <div class="ccm-timeline">
        <div class="ccm-tl-step">
          <span class="ccm-tl-dot ${t.date ? 'ccm-tl-dot--on' : ''}"></span>
          <span class="ccm-tl-time">${hm(t.date)}</span>
          <span class="ccm-tl-lbl">Créée</span>
        </div>
        <div class="ccm-tl-bar ${t.date_assignation ? 'ccm-tl-bar--on' : ''}"></div>
        <div class="ccm-tl-step">
          <span class="ccm-tl-dot ${t.date_assignation ? 'ccm-tl-dot--on' : ''}"></span>
          <span class="ccm-tl-time">${hm(t.date_assignation)}</span>
          <span class="ccm-tl-lbl">Assignée</span>
        </div>
        <div class="ccm-tl-bar ${t.date_fin ? 'ccm-tl-bar--on' : ''}"></div>
        <div class="ccm-tl-step">
          <span class="ccm-tl-dot ${t.date_fin ? 'ccm-tl-dot--on' : ''}"></span>
          <span class="ccm-tl-time">${hm(t.date_fin)}</span>
          <span class="ccm-tl-lbl">Validée</span>
        </div>
      </div>
    </div>`).join('');
}

/* Clic sur le numéro destinataire (carte de commande, liste principale) :
   lance directement la composition — avec le code USSD complet du forfait
   si la commande en a un (préfixe appliqué selon la préférence du
   cabiniste), sinon un simple appel vers le numéro. */
async function dialCabNumber(txnId) {
  const t = DB.transactions.byId(txnId);
  if (!t) return;
  const code = (await getOrderUssdCode(t)) || t.numero_beneficiaire || '';
  if (!code) return;
  window.location.href = 'tel:' + encodeURIComponent(code);
}

/* Code USSD affichable/composable d'une commande, quel que soit le type :
   - Forfait Orange : déjà calculé à la commande (voir _tfForfaitDetails()
     dans js/client.js) — un seul modèle par réseau, rien à choisir ici.
   - Transfert direct MTN/Moov : construit à la volée à partir du modèle
     courant (settings.ussd_templates, modifiable par le super admin dans
     Admin › Forfaits) — ainsi une commande déjà passée reflète toujours le
     modèle actuel plutôt qu'une valeur figée à la création.
   Dans les deux cas, le cabiniste peut désactiver le composeur auto pour
   un réseau donné (voir toggleUssdNetwork()/currentUser.ussd_enabled,
   section Préférences du profil) : le lien "tel:" disparaît alors, sans
   affecter les autres réseaux ni l'acceptation de commandes.
   Retourne null si la commande n'a pas de code USSD (ou si désactivé). */
async function getOrderUssdCode(t) {
  if (!t || !t.details) return null;
  const enabled = (currentUser && currentUser.ussd_enabled) || {};

  if (t.details.ussd_code) {
    if (t.operateur === 'Orange' && enabled.orange === false) return null;
    return t.details.ussd_code;
  }

  if (t.details.direct_ussd_network && t.details.direct_ussd_numero) {
    const templates = (await DB.settings.get()).ussd_templates || {};
    const numero = t.details.direct_ussd_numero;
    if (t.details.direct_ussd_network === 'MTN' && enabled.mtn !== false && templates.mtn) {
      return templates.mtn.replace('{numero_destinataire}', numero);
    }
    if (t.details.direct_ussd_network === 'Moov' && enabled.moov !== false && templates.moov_marchand) {
      return templates.moov_marchand.replace('{numero_destinataire}', numero);
    }
  }
  return null;
}

/* ── Détail d'une commande (recap + copie ID / numéro destinataire) ── */
function formatDurationMs(ms) {
  if (ms == null || ms < 0) return '—';
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return '< 1 min';
  if (totalMin < 60) return totalMin + ' min';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h + 'h' + (m ? ' ' + m + 'min' : '');
}

async function openCabOrderDetail(id) {
  const t = DB.transactions.byId(id);
  if (!t) return;
  const client = DB.users.byId(t.client_id);
  const refCode = Fmt.ref(t.id);
  const emetteur = Fmt.phone(client && client.telephone) || '—';
  const destinataire = Fmt.phone(t.numero_beneficiaire) || '—';
  const hm = (d) => d ? new Date(d).toLocaleTimeString('fr-CI', { hour: '2-digit', minute: '2-digit' }) : '—';
  const dureeValidation = t.date_fin ? formatDurationMs(new Date(t.date_fin) - new Date(t.date)) : null;
  const svcLbl = t.service || (t.type === 'recharge_uv' ? 'Recharge UV' : 'Transfert Direct');
  const ussdCode = await getOrderUssdCode(t);
  const ussdLbl = (t.details && t.details.forfait_nom) || `Recharge ${t.operateur}`;

  const sub = document.getElementById('cdet-head-sub');
  if (sub) sub.textContent = `${svcLbl} · ${t.operateur}`;

  const step = (on, icon, lbl, time, note) => `
    <div class="ordet-tl-row">
      <div class="ordet-tl-rail">
        <span class="ordet-tl-node ${on ? 'ordet-tl-node--on' : ''}"><i class="fa-solid ${icon}"></i></span>
        <span class="ordet-tl-line ${on ? 'ordet-tl-line--on' : ''}"></span>
      </div>
      <div class="ordet-tl-body">
        <div class="ordet-tl-toprow">
          <span class="ordet-tl-lbl ${on ? '' : 'ordet-tl-lbl--pending'}">${lbl}</span>
          <span class="ordet-tl-time">${time}</span>
        </div>
        ${note ? `<div class="ordet-tl-note">${note}</div>` : ''}
      </div>
    </div>`;

  document.getElementById('cdet-body').innerHTML = `
    <div class="ordet-strip">
      <div class="ordet-strip-id">
        <span class="ordet-strip-id-lbl">ID</span>
        <span class="ordet-strip-id-val">#${refCode}</span>
      </div>
      <button class="ordet-copy-btn" onclick="copyCabField('${t.id}', this)" title="Copier"><i class="fa-solid fa-copy"></i></button>
    </div>

    <div class="ordet-nums">
      <div class="ordet-num-line">
        <span class="ordet-num-ico"><i class="fa-solid fa-user"></i></span>
        <div class="ordet-num-text">
          <div class="ordet-num-lbl">Expéditeur</div>
          <div class="ordet-num-val">${emetteur}</div>
        </div>
      </div>
      <div class="ordet-num-line">
        <span class="ordet-num-ico"><i class="fa-solid fa-mobile-screen"></i></span>
        <div class="ordet-num-text">
          <div class="ordet-num-lbl">Destinataire</div>
          <div class="ordet-num-val">${destinataire}</div>
        </div>
        <button class="ordet-num-copy" onclick="copyCabField('${destinataire}', this)" title="Copier"><i class="fa-solid fa-copy"></i></button>
      </div>
    </div>

    ${ussdCode ? `
    <div class="ordet-ussd">
      <a class="ordet-ussd-link" href="tel:${encodeURIComponent(ussdCode)}">
        <span class="ordet-ussd-ico"><i class="fa-solid fa-phone-volume"></i></span>
        <div class="ordet-ussd-text">
          <div class="ordet-ussd-lbl">${ussdLbl}</div>
          <div class="ordet-ussd-val">${ussdCode}</div>
        </div>
        <i class="fa-solid fa-chevron-right ordet-ussd-arrow"></i>
      </a>
      ${t.details.ussd_verified === false ? '<div class="ordet-ussd-warn"><i class="fa-solid fa-triangle-exclamation"></i> Code à vérifier avant composition</div>' : ''}
    </div>` : ''}

    <div class="ordet-tl-wrap">
      <div class="ordet-tl-title">Suivi de la commande</div>
      ${step(!!t.date, 'fa-paper-plane', 'Créée', hm(t.date))}
      ${step(!!t.date_assignation, 'fa-user-check', 'Assignée', hm(t.date_assignation))}
      ${step(!!t.date_fin, 'fa-circle-check', 'Validée', hm(t.date_fin), dureeValidation ? `Terminée en <b>${dureeValidation}</b>` : null)}
    </div>
  `;
  openModal('modal-cab-order-detail');
  _cabResume.openOrderDetailId = id;
  _saveCabResume();
}

function closeCabOrderDetailModal() {
  _cabResume.openOrderDetailId = null;
  _saveCabResume();
  closeModal('modal-cab-order-detail');
}

function copyCabField(value, btn) {
  if (!value || value === '—') return;
  navigator.clipboard.writeText(value).then(() => {
    if (btn) {
      const icon = btn.querySelector('i');
      if (icon) { icon.className = 'fa-solid fa-check'; setTimeout(() => { icon.className = 'fa-solid fa-copy'; }, 2000); }
    }
    Toast.success('Copié !');
  }).catch(() => Toast.info(value));
}

/* ── Recharge UV ───────────────────────────────────────────────── */
// Réinitialise systématiquement la modale à l'étape formulaire (onglet
// "Je passe une commande") à chaque ouverture — sans ça, une deuxième
// recharge rouvrirait sur le récap/la confirmation de la précédente (la
// modale ne se ferme plus toute seule depuis que la commande passe par
// le circuit d'assignation, voir cabUvConfirmPayment ci-dessous).
function openCabUvModal() {
  stopCabUvPoll();
  _cabUvPending = null;
  _cabUvTxnId   = null;
  _cabUvNet     = null;
  document.getElementById('cab-uv-form').reset();
  document.querySelectorAll('#cab-uv-step-1 .svc-net-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('cab-uv-form').style.display = '';
  document.getElementById('cab-uv-step-1').style.display = '';
  document.getElementById('cab-uv-step-2').style.display = 'none';
  document.getElementById('cab-uv-panel-recap').style.display = 'none';
  document.getElementById('cab-uv-step-confirm').style.display = 'none';
  _cabUvSetStepDots(1);
  cabUvSwitchTab('commande');
  openModal('modal-cab-uv');
}

function cabUvSwitchTab(tab) {
  document.getElementById('cab-uv-tab-commande').style.display    = tab === 'commande'    ? '' : 'none';
  document.getElementById('cab-uv-tab-reclamation').style.display = tab === 'reclamation' ? '' : 'none';
  document.getElementById('cab-uv-tabbtn-commande').classList.toggle('active', tab === 'commande');
  document.getElementById('cab-uv-tabbtn-reclamation').classList.toggle('active', tab === 'reclamation');
  if (tab === 'reclamation') { cabUvSwitchReclaSubTab('nouvelle'); loadCabUvReclaTab(); }
}

/* ── Étape 1/2 : assistant pas-à-pas (réseau, puis numéro/montant) ──── */
let _cabUvNet = null;

function _cabUvSetStepDots(step) {
  for (let i = 1; i <= 4; i++) {
    const dot = document.getElementById(`cab-uv-dot-${i}`);
    if (dot) {
      dot.classList.remove('done', 'current');
      if (i < step)        { dot.classList.add('done'); dot.innerHTML = '<i class="fa-solid fa-check"></i>'; }
      else if (i === step) { dot.classList.add('current'); dot.textContent = i; }
      else                  { dot.textContent = i; }
    }
    if (i < 4) {
      const line = document.getElementById(`cab-uv-line-${i}`);
      if (line) line.classList.toggle('done', i < step);
    }
  }
}

async function cabUvSelectNetwork(net, el) {
  if (await isNetworkInMaintenance(net)) { warnMaintenance(`Le réseau ${net} est actuellement en maintenance.`); return; }
  document.querySelectorAll('#cab-uv-step-1 .svc-net-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  _cabUvNet = net;
  applyNetworkPrefix('cab-uv-number', net);
}

function cabUvGoStep2() {
  if (!_cabUvNet) { Toast.error('Choisissez un réseau.'); return; }
  document.getElementById('cab-uv-step-1').style.display = 'none';
  document.getElementById('cab-uv-step-2').style.display = '';
  _cabUvSetStepDots(2);
}

function cabUvGoBackToStep1() {
  document.getElementById('cab-uv-step-2').style.display = 'none';
  document.getElementById('cab-uv-step-1').style.display = '';
  _cabUvSetStepDots(1);
}

/* ── Étape 3 : récapitulatif avant tout débit ──────────────────────
   Le formulaire ne débite plus rien directement : il calcule un aperçu (montant + 200 FCFA de frais de
   service, voir DB.business.previewCabineSelfRecharge/js/db.js) et
   attend une confirmation explicite avant d'appeler cabineSelfRecharge. */
let _cabUvPending = null;

async function cabUvShowRecap() {
  const net     = _cabUvNet;
  const number  = document.getElementById('cab-uv-number').value.replace(/\D/g, '');
  const montant = parseInt(document.getElementById('cab-uv-amount').value) || 0;

  if (currentUser.statut === 'suspendu') { Toast.error('Votre compte est suspendu. Vous ne pouvez pas passer de commande de recharge UV.'); return; }
  if (!net)             { Toast.error('Choisissez un réseau.'); return; }
  if (!number)          { Toast.error('Saisissez le numéro de téléphone.'); return; }
  if (montant < 10000)  { Toast.error('Montant minimum : 10 000 FCFA.'); return; }
  if (await isServiceInMaintenance('recharge_uv')) { warnMaintenance('La recharge UV est actuellement en maintenance.'); return; }
  if (await isNetworkInMaintenance(net)) { warnMaintenance(`Le réseau ${net} est actuellement en maintenance.`); return; }

  const { frais, total, soldeApres } = DB.business.previewCabineSelfRecharge(currentUser.id, montant);
  _cabUvPending = { network: net, numero: number, montant };

  document.getElementById('cab-uv-recap-rows').innerHTML = `
    <div class="svc-recap-rows">
      <div class="svc-recap-row"><span>Moyen de paiement</span><strong>Solde du cabiniste</strong></div>
      <div class="svc-recap-row"><span>Réseau</span><strong>${net}</strong></div>
      <div class="svc-recap-row"><span>Numéro</span><strong>${Fmt.phone(number)}</strong></div>
      <div class="svc-recap-row"><span>Montant</span><strong>${Fmt.money(montant)}</strong></div>
      <div class="svc-recap-row"><span>Frais de service</span><strong>${Fmt.money(frais)}</strong></div>
      <div class="svc-recap-row svc-recap-row--total"><span>Total débité</span><strong>${Fmt.money(total)}</strong></div>
      <div class="svc-recap-row"><span>Solde restant après paiement</span><strong>${Fmt.money(soldeApres)}</strong></div>
    </div>`;
  document.getElementById('cab-uv-form').style.display = 'none';
  document.getElementById('cab-uv-panel-recap').style.display = 'block';
  _cabUvSetStepDots(3);
}

function cabUvBackToForm() {
  document.getElementById('cab-uv-panel-recap').style.display = 'none';
  document.getElementById('cab-uv-form').style.display = '';
  document.getElementById('cab-uv-step-1').style.display = 'none';
  document.getElementById('cab-uv-step-2').style.display = '';
  _cabUvSetStepDots(2);
}

/* ── Étape 2 : confirmation → débit réel + écran de suivi ──────────
   Reprend, au 1:1, le mécanisme déjà utilisé côté client pour le suivi
   de commande (RECLA_MIN_DELAY_MS/reclamationWindowState/formatMmSs,
   désormais globaux dans js/db.js) : le bouton "Réclamation" reste
   grisé/caché tant que la commande a moins de 5 minutes ET est encore
   en_attente ; il devient actif dès que l'une des deux conditions cesse
   (5 minutes écoulées, ou statut final atteint). Aucune expiration/
   annulation automatique de la commande. */
let _cabUvTxnId     = null;
let _cabUvPollTimer = null;

async function cabUvConfirmPayment() {
  if (!_cabUvPending) return;
  const res = await DB.business.cabineSelfRecharge(currentUser.id, _cabUvPending);
  if (!res.ok) { Toast.error(res.error); return; }
  currentUser = Auth.refresh();
  _cabUvPending = null;

  document.getElementById('cab-uv-panel-recap').style.display = 'none';
  document.getElementById('cab-uv-step-confirm').style.display = 'block';
  _cabUvTxnId = res.transaction.id;
  renderCabUvConfirmStatus();
  startCabUvPoll();
  loadCabHome();
  _cabUvSetStepDots(4);
}

function renderCabUvConfirmStatus() {
  const txn = DB.transactions.byId(_cabUvTxnId);
  if (!txn) return;
  document.getElementById('cab-uv-confirm-status').innerHTML = txn.cabine_id
    ? '<i class="fa-solid fa-circle-check"></i> Assignée à une cabine, en cours de traitement.'
    : '<i class="fa-solid fa-hourglass-half"></i> En attente qu\'une cabine se connecte.';
  document.getElementById('cab-uv-confirm-recap').innerHTML = `
    <div class="svc-recap-rows">
      <div class="svc-recap-row"><span>Moyen de paiement</span><strong>Solde du cabiniste</strong></div>
      <div class="svc-recap-row"><span>Réseau</span><strong>${txn.operateur}</strong></div>
      <div class="svc-recap-row"><span>Numéro</span><strong>${Fmt.phone(txn.numero_beneficiaire)}</strong></div>
      <div class="svc-recap-row"><span>Montant</span><strong>${Fmt.money(txn.montant)}</strong></div>
      <div class="svc-recap-row"><span>Frais de service</span><strong>${Fmt.money(txn.frais_service || 0)}</strong></div>
      <div class="svc-recap-row svc-recap-row--total"><span>Total débité</span><strong>${Fmt.money(txn.montant + (txn.frais_service || 0))}</strong></div>
      <div class="svc-recap-row"><span>Référence</span><strong>${Fmt.ref(txn.id)}</strong></div>
    </div>`;

  const win     = reclamationWindowState(txn);
  const already = DB.reclamations.byTransaction(txn.id);
  const canReclaim = !already && txn.statut !== 'terminé' && win.state !== 'expired';
  const countdownWrap = document.getElementById('cab-uv-countdown-wrap');
  const reclaBtn       = document.getElementById('cab-uv-recla-btn');

  if (win.state === 'early' && txn.statut === 'en_attente') {
    countdownWrap.style.display = 'flex';
    reclaBtn.style.display = 'none';
  } else {
    countdownWrap.style.display = 'none';
    reclaBtn.style.display = canReclaim ? 'flex' : 'none';
  }
}

function startCabUvPoll() {
  stopCabUvPoll();
  _cabUvPollTimer = setInterval(() => {
    const txn = DB.transactions.byId(_cabUvTxnId);
    if (!txn) return;
    const win = reclamationWindowState(txn);
    const numEl = document.getElementById('cab-uv-countdown-num');
    if (numEl) numEl.textContent = win.state === 'early' ? formatMmSs(win.remainingMs) : '0:00';
    if (win.state !== 'early') renderCabUvConfirmStatus();
  }, 1000);
}

function stopCabUvPoll() {
  if (_cabUvPollTimer) { clearInterval(_cabUvPollTimer); _cabUvPollTimer = null; }
}

// Raccourci depuis l'écran de suivi : ouvre directement le motif pour
// LA commande qui vient d'être payée (pas de sélection à faire).
function cabUvOpenSelfReclaFromConfirm() {
  if (!_cabUvTxnId) return;
  cabUvSwitchTab('reclamation');
  cabUvSwitchReclaSubTab('nouvelle');
  cabUvPickOrderForRecla(_cabUvTxnId);
}

/* ── Onglet "Réclamation" : dépôt sur une commande passée + historique ─
   getReclamableOrders/RECLA_REASONS sont désormais globaux (js/db.js),
   partagés avec le hub réclamation du client (js/client.js). */
let _cabUvReclaTxnId = null;

function cabUvSwitchReclaSubTab(tab) {
  document.getElementById('cab-uv-recla-subtab-nouvelle').style.display   = tab === 'nouvelle'   ? '' : 'none';
  document.getElementById('cab-uv-recla-subtab-historique').style.display = tab === 'historique' ? '' : 'none';
  document.getElementById('cab-uv-recla-tabbtn-nouvelle').classList.toggle('active', tab === 'nouvelle');
  document.getElementById('cab-uv-recla-tabbtn-historique').classList.toggle('active', tab === 'historique');
}

function loadCabUvReclaTab() {
  renderCabUvReclaNewList();
  renderCabUvReclaHistory();
}

function renderCabUvReclaNewList() {
  document.getElementById('cab-uv-recla-motif-picker').style.display = 'none';
  const eligible = getReclamableOrders(currentUser.id).filter(t => t.type === 'recharge_uv');
  const list = document.getElementById('cab-uv-recla-new-list');
  list.style.display = '';
  if (!eligible.length) {
    list.innerHTML = `<div class="recla-empty recla-empty--ok">
      <span class="recla-empty-ico"><i class="fa-solid fa-check"></i></span>
      <div class="recla-empty-title">Aucune commande éligible</div>
      <div class="recla-empty-sub">Vos commandes de recharge UV apparaîtront ici tant qu'elles sont éligibles à réclamation.</div>
    </div>`;
    return;
  }
  list.innerHTML = eligible.map(t => `
    <div class="recla-card" style="cursor:pointer;" onclick="cabUvPickOrderForRecla('${t.id}')">
      <div class="recla-ref-block">
        <div class="recla-ref-eyebrow">Référence</div>
        <div class="recla-ref-big">${Fmt.ref(t.id)}</div>
      </div>
      <div class="recla-tiles-row">
        <div class="recla-tile"><div class="recla-tile-lbl"><i class="fa-solid fa-mobile-screen"></i> Réseau</div><div class="recla-tile-val">${t.operateur}</div></div>
        <div class="recla-tile"><div class="recla-tile-lbl"><i class="fa-solid fa-coins"></i> Montant</div><div class="recla-tile-val">${t.montant.toLocaleString()} FCFA</div></div>
      </div>
    </div>`).join('');
}

function cabUvPickOrderForRecla(txnId) {
  _cabUvReclaTxnId = txnId;
  document.getElementById('cab-uv-recla-new-list').style.display = 'none';
  document.getElementById('cab-uv-recla-motif-picker').style.display = 'block';
}

function cabUvCancelReclaPick() {
  _cabUvReclaTxnId = null;
  renderCabUvReclaNewList();
}

async function cabUvSubmitRecla(motifKey) {
  const t = DB.transactions.byId(_cabUvReclaTxnId);
  if (!t) return;
  const motif = RECLA_REASONS[motifKey] || motifKey;
  // Notification à la cabine concernée envoyée côté serveur (voir
  // api/reclamations_create.php), plus de doublon local ici.
  const res = await DB.reclamations.create({ transaction_id: t.id, motif });
  if (!res.ok) { Toast.error(res.error); return; }
  Toast.success('Réclamation envoyée. La cabine concernée a été notifiée.');
  _cabUvReclaTxnId = null;
  cabUvSwitchReclaSubTab('historique');
  loadCabUvReclaTab();
  renderCabUvConfirmStatus(); // le bouton "Réclamation" du panneau de suivi doit se cacher si affiché
}

// Historique en lecture seule : c'est l'AUTRE cabine (celle qui traite
// la commande) qui téléverse la preuve et résout — voir resolveReclamation
// ci-dessous, inchangé, qui s'applique déjà aux réclamations créées ici.
function renderCabUvReclaHistory() {
  const mine = DB.reclamations.byClient(currentUser.id);
  const list = document.getElementById('cab-uv-recla-history-list');
  if (!mine.length) {
    list.innerHTML = `<div class="recla-empty recla-empty--none">
      <span class="recla-empty-ico"><i class="fa-solid fa-inbox"></i></span>
      <div class="recla-empty-title">Aucune réclamation déposée</div>
      <div class="recla-empty-sub">L'historique de vos réclamations sur vos propres commandes de recharge UV apparaîtra ici.</div>
    </div>`;
    return;
  }
  const STATUT_LBL = { en_attente: 'En attente', 'résolue': 'Validée', remboursement_demande: 'Remboursement demandé', 'remboursée': 'Remboursée' };
  list.innerHTML = mine
    .slice()
    .sort((a, b) => new Date(b.date_created) - new Date(a.date_created))
    .map(r => {
      const t = DB.transactions.byId(r.transaction_id);
      const dateStr = new Date(r.date_created).toLocaleString('fr-CI', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      return `
      <div class="recla-card">
        <div class="recla-top-row">
          <span class="recla-badge">${STATUT_LBL[r.statut] || r.statut}</span>
          <span class="recla-reltime">${dateStr}</span>
        </div>
        <div class="recla-ref-block">
          <div class="recla-ref-eyebrow">Commande</div>
          <div class="recla-ref-big">${Fmt.ref(r.transaction_id)}</div>
        </div>
        ${t ? `<div class="recla-tiles-row">
          <div class="recla-tile"><div class="recla-tile-lbl">Réseau</div><div class="recla-tile-val">${t.operateur}</div></div>
          <div class="recla-tile"><div class="recla-tile-lbl">Montant</div><div class="recla-tile-val">${t.montant.toLocaleString()} FCFA</div></div>
        </div>` : ''}
        ${r.screenshot ? `<div class="recla-tl-proof">
          <a href="${r.screenshot}" target="_blank"><img src="${r.screenshot}" class="recla-tl-proof-thumb" alt="Capture preuve"></a>
          <span class="recla-tl-proof-lbl">Preuve fournie</span>
        </div>` : ''}
      </div>`;
    }).join('');
}

/* ── Recharge portefeuille ─────────────────────────────────────── */
async function handleCabineRecharge(e) {
  e.preventDefault();
  const method  = document.querySelector('input[name="cab-recharge-method"]:checked')?.value;
  const montant = parseInt(document.getElementById('cab-recharge-amount').value) || 0;
  if (!method) { Toast.error('Choisissez un mode de paiement.'); return; }
  if (montant < 1000) { Toast.error('Montant minimum : 1 000 FCFA.'); return; }
  const res = await DB.business.recharge(currentUser.id, montant);
  if (res.ok) {
    closeModal('modal-cab-recharge');
    currentUser = Auth.refresh();
    Toast.success(`Portefeuille rechargé de ${Fmt.money(montant)} via ${method}.`);
    loadCabHome();
    document.getElementById('cab-recharge-form').reset();
  } else { Toast.error(res.error); }
}

/* ── Réclamations ──────────────────────────────────────────────── */
let _cabReclaFilter = 'en_attente';
let _cabReclaQuery = '';

function loadCabReclamations() {
  _renderCabReclamations();
  // Cache local affiché immédiatement ci-dessus ; resynchronise en tâche
  // de fond (voir DB.reclamations.refresh(), js/db.js) puis rafraîchit.
  DB.reclamations.refresh().then(_renderCabReclamations);
}

function _renderCabReclamations() {
  const reclas = DB.reclamations.byCabine(currentUser.id);
  const pendingCount = reclas.filter(r => r.statut === 'en_attente').length;
  const badge = document.getElementById('recla-tab-badge-attente');
  if (badge) {
    badge.textContent = pendingCount;
    badge.style.display = pendingCount > 0 ? '' : 'none';
  }
  renderCabReclaList(reclas, _cabReclaFilter, _cabReclaQuery);
}

function filterCabReclamations(filter, btn) {
  _cabReclaFilter = filter;
  document.querySelectorAll('#cab-sec-reclamations .cof-ctab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderCabReclaList(DB.reclamations.byCabine(currentUser.id), filter, _cabReclaQuery);
  _cabResume.reclaFilter = filter;
  _saveCabResume();
}

// Recherche par nom de client, référence de commande ou motif — filtre
// appliqué en plus de l'onglet actif (En cours/Terminées), voir
// renderCabReclaList() ci-dessous.
function searchCabReclamations(query) {
  _cabReclaQuery = query;
  renderCabReclaList(DB.reclamations.byCabine(currentUser.id), _cabReclaFilter, query);
}

function renderCabReclaList(reclas, filter, query = '') {
  const list = document.getElementById('recla-list');
  if (!list) return;
  let filtered = filter === 'en_attente'
    ? reclas.filter(r => r.statut === 'en_attente')
    : reclas.filter(r => r.statut !== 'en_attente');

  if (query.trim()) {
    const q = query.trim().toLowerCase();
    filtered = filtered.filter(r => {
      const txn = DB.transactions.byId(r.transaction_id);
      const client = txn ? DB.users.byId(txn.client_id) : null;
      const clientName = client ? `${client.prenom} ${client.nom}` : '';
      const ref = Fmt.ref(r.transaction_id).toLowerCase();
      return clientName.toLowerCase().includes(q) || ref.includes(q) || (r.motif || '').toLowerCase().includes(q);
    });
  }

  if (!filtered.length) {
    list.innerHTML = query.trim()
      ? `<div class="recla-empty recla-empty--none">
          <span class="recla-empty-ico"><i class="fa-solid fa-magnifying-glass"></i></span>
          <div class="recla-empty-title">Aucun résultat</div>
          <div class="recla-empty-sub">Aucune réclamation ne correspond à "${query.trim()}".</div>
        </div>`
      : filter === 'en_attente'
      ? `<div class="recla-empty recla-empty--ok">
          <span class="recla-empty-ico"><i class="fa-solid fa-check"></i></span>
          <div class="recla-empty-title">Aucune réclamation en cours</div>
          <div class="recla-empty-sub">Toutes les réclamations de vos clients ont été traitées.</div>
        </div>`
      : `<div class="recla-empty recla-empty--none">
          <span class="recla-empty-ico"><i class="fa-solid fa-inbox"></i></span>
          <div class="recla-empty-title">Aucune réclamation terminée</div>
          <div class="recla-empty-sub">L'historique de vos réclamations résolues apparaîtra ici.</div>
        </div>`;
    return;
  }
  const hm = (d) => d ? new Date(d).toLocaleTimeString('fr-CI', { hour: '2-digit', minute: '2-digit' }) : '—';

  list.innerHTML = filtered.map(r => {
    const txn    = DB.transactions.byId(r.transaction_id);
    const client = txn ? DB.users.byId(txn.client_id) : null;
    const isOpen = r.statut === 'en_attente';
    const dateStr = new Date(r.date_created).toLocaleString('fr-CI', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
    const clientName = client ? `${client.prenom} ${client.nom}` : 'Client inconnu';
    const clientInit = client ? Fmt.initials(client.nom, client.prenom) : '?';

    const canRequestRefund = isOpen && txn && txn.statut === 'terminé';

    const secondStep = isOpen ? `
      <div class="recla-tl-row">
        <div class="recla-tl-rail"><span class="recla-tl-node recla-tl-node--pending"><i class="fa-solid fa-hourglass-half"></i></span></div>
        <div class="recla-tl-body">
          <div class="recla-tl-toprow"><span class="recla-tl-lbl">En attente de votre réponse</span></div>
          <div class="recla-resolve-wrap" id="recla-wrap-${r.id}" style="margin-top:8px;">
            <input type="file" accept="image/*" id="recla-file-${r.id}" class="recla-file-input" onchange="handleReclaFileSelect('${r.id}', this)">
            <label for="recla-file-${r.id}" class="recla-upload-btn" id="recla-upload-lbl-${r.id}">
              <i class="fa-solid fa-camera"></i> Téléverser une capture d'écran
            </label>
            <img id="recla-preview-${r.id}" class="recla-upload-preview" style="display:none" alt="Aperçu de la capture">
            <button class="recla-resolve-btn" onclick="resolveReclamation('${r.id}')">
              <i class="fa-solid fa-paper-plane"></i> Soumettre la preuve
            </button>
          </div>
        </div>
      </div>` : r.statut === 'remboursement_demande' ? `
      <div class="recla-tl-row">
        <div class="recla-tl-rail"><span class="recla-tl-node recla-tl-node--refund"><i class="fa-solid fa-rotate-left"></i></span></div>
        <div class="recla-tl-body">
          <div class="recla-tl-toprow"><span class="recla-tl-lbl">Remboursement demandé par vous</span><span class="recla-tl-time">${hm(r.date_created)}</span></div>
          <div class="recla-tl-detail">En attente de validation par l'administration.</div>
        </div>
      </div>` : r.statut === 'remboursée' ? `
      <div class="recla-tl-row">
        <div class="recla-tl-rail"><span class="recla-tl-node recla-tl-node--refund"><i class="fa-solid fa-check"></i></span></div>
        <div class="recla-tl-body">
          <div class="recla-tl-toprow"><span class="recla-tl-lbl">Remboursement validé par l'administration</span><span class="recla-tl-time">${hm(r.date_resolved)}</span></div>
        </div>
      </div>` : `
      <div class="recla-tl-row">
        <div class="recla-tl-rail"><span class="recla-tl-node recla-tl-node--done"><i class="fa-solid fa-check"></i></span></div>
        <div class="recla-tl-body">
          <div class="recla-tl-toprow"><span class="recla-tl-lbl">Résolue par vous</span><span class="recla-tl-time">${hm(r.date_resolved)}</span></div>
          ${r.screenshot ? `<div class="recla-tl-proof">
            <a href="${r.screenshot}" target="_blank"><img src="${r.screenshot}" class="recla-tl-proof-thumb" alt="Capture preuve"></a>
            <span class="recla-tl-proof-lbl">Preuve fournie</span>
          </div>` : ''}
        </div>
      </div>`;

    const badgeLbl = isOpen ? 'Vérification requise'
      : r.statut === 'remboursement_demande' ? 'Remboursement demandé'
      : r.statut === 'remboursée' ? 'Remboursée'
      : 'Résolue';
    const badgeCls = isOpen ? 'recla-badge--open'
      : (r.statut === 'remboursement_demande' || r.statut === 'remboursée') ? 'recla-badge--refund'
      : 'recla-badge--done';

    const OP_CLR = { Orange: '#FF6200', MTN: '#B45309', Moov: '#0066CC' };
    const opClr  = txn ? (OP_CLR[txn.operateur] || '#6B7280') : '#6B7280';

    return `
    <div class="recla-card">
      <div class="recla-top-row">
        <div>
          <span class="recla-badge ${badgeCls}">${badgeLbl}</span>
          <div class="recla-reltime">${_relTimeFr(r.date_created)}</div>
        </div>
        <div class="recla-top-actions">
          ${canRequestRefund ? `<button class="recla-refund-btn" onclick="requestReclamationRefund('${r.id}')"><i class="fa-solid fa-rotate-left"></i> Rembourser</button>` : ''}
          ${txn ? `<span class="recla-op-badge" style="color:${opClr};border-color:${opClr}55;">${txn.operateur}</span>` : ''}
        </div>
      </div>

      <div class="recla-ref-block">
        <div class="recla-ref-eyebrow">Référence</div>
        <div class="recla-ref-big">${Fmt.ref(r.transaction_id)}</div>
      </div>

      ${txn ? `<div class="recla-tiles-row">
        <div class="recla-tile"><div class="recla-tile-lbl"><i class="fa-solid fa-mobile-screen"></i> Destinataire</div><div class="recla-tile-val">${Fmt.phone(txn.numero_beneficiaire)}</div></div>
        <div class="recla-tile"><div class="recla-tile-lbl"><i class="fa-solid fa-coins"></i> Montant</div><div class="recla-tile-val">${txn.montant.toLocaleString()} FCFA</div></div>
      </div>` : ''}

      <div class="recla-divider"></div>

      <div class="recla-tl-row">
        <div class="recla-tl-rail">
          <span class="recla-tl-node recla-tl-node--client">${clientInit}</span>
          <span class="recla-tl-line recla-tl-line--done"></span>
        </div>
        <div class="recla-tl-body">
          <div class="recla-tl-toprow"><span class="recla-tl-lbl">Signalée par ${clientName}</span><span class="recla-tl-time">${hm(r.date_created)}</span></div>
          <div class="recla-tl-detail">"${r.motif}"</div>
        </div>
      </div>

      ${secondStep}
    </div>`;
  }).join('');
}

// "il y a X minutes/heures/jours" — utilisé pour l'en-tête de la carte
// réclamation (voir renderCabReclaList() ci-dessus).
function _relTimeFr(dateStr) {
  const min = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
  if (min < 1)  return "à l'instant";
  if (min < 60) return `il y a ${min} minute${min > 1 ? 's' : ''}`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} heure${h > 1 ? 's' : ''}`;
  const j = Math.floor(h / 24);
  return `il y a ${j} jour${j > 1 ? 's' : ''}`;
}

/* ── Réclamations : upload de la capture d'écran (preuve) ─────────
   Lu en data URL via FileReader puis stocké en mémoire le temps que
   le partenaire clique sur "Soumettre" (voir resolveReclamation). */
const _reclaPendingScreenshots = {};

function handleReclaFileSelect(reclaId, input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { Toast.error('Veuillez choisir une image.'); return; }

  const reader = new FileReader();
  reader.onload = () => {
    _reclaPendingScreenshots[reclaId] = reader.result;
    const preview = document.getElementById('recla-preview-' + reclaId);
    if (preview) { preview.src = reader.result; preview.style.display = 'block'; }
    const lbl = document.getElementById('recla-upload-lbl-' + reclaId);
    if (lbl) lbl.innerHTML = '<i class="fa-solid fa-check"></i> Capture sélectionnée — changer';
  };
  reader.readAsDataURL(file);
}

async function resolveReclamation(reclaId) {
  const screenshot = _reclaPendingScreenshots[reclaId];
  if (!screenshot) { Toast.error("Veuillez téléverser une capture d'écran."); return; }
  // Statut/messages/notification client entièrement gérés côté serveur
  // (voir api/reclamations_resolve.php) — CAS de propriété inclus.
  const res = await DB.reclamations.resolve(reclaId, screenshot);
  if (!res.ok) { Toast.error(res.error); return; }
  delete _reclaPendingScreenshots[reclaId];
  Toast.success('Preuve soumise. Le client a été notifié.');
  loadCabReclamations();
  updateNotifBadge();
}

// Soumet une demande de remboursement à l'administration suite à une
// réclamation reconnue par la cabine — voir api/reclamations_request_refund.php
// (CAS de propriété + statut, 5 demandes/jour → suspension automatique,
// tout géré côté serveur). Visible uniquement dans l'onglet admin
// "Demandes de remboursement" tant qu'elle n'est pas traitée — ni chez le
// client, ni ailleurs côté cabine (voir renderCabReclaList ci-dessus).
async function requestReclamationRefund(reclaId) {
  if (!confirm('Transmettre une demande de remboursement à l\'administration pour cette commande ?')) return;

  const res = await DB.reclamations.requestRefund(reclaId);
  if (!res.ok) { Toast.error(res.error); return; }
  currentUser = Auth.refresh();
  loadCabBalanceCard();
  Toast.success('Demande de remboursement transmise à l\'administration.');
  loadCabReclamations();
  updateNotifBadge();
}

/* ── Notifications ─────────────────────────────────────────────── */
async function loadCabNotifications() {
  const list = document.getElementById('cab-notif-list');
  if (!list) return;
  await DB.notifications.refresh(currentUser.id);
  const notifs = DB.notifications.forUser(currentUser.id);
  if (!notifs.length) {
    list.innerHTML = `<div class="cab-empty-state">
      <i class="fa-solid fa-bell-slash" style="font-size:2rem;opacity:.3;margin-bottom:8px;display:block;"></i>
      <div>Aucune notification</div>
    </div>`;
    return;
  }
  const icons = { success:'fa-circle-check', info:'fa-circle-info', commission:'fa-coins', new_request:'fa-bell', transfer:'fa-right-left', warning:'fa-triangle-exclamation', reassigned:'fa-shuffle' };
  list.innerHTML = notifs.map(n => `
    <div class="notif-item ${n.lu ? '' : 'unread'}" onclick="markCabNotifRead('${n.id}', this)">
      <div class="notif-icon"><i class="fa-solid ${icons[n.type] || 'fa-bell'}"></i></div>
      <div class="notif-content">
        <div class="notif-msg">${n.message}</div>
        <div class="notif-time"><i class="fa-regular fa-clock"></i> ${Fmt.datetime(n.date)}</div>
      </div>
      ${!n.lu ? '<div class="notif-unread-dot"></div>' : ''}
    </div>`).join('');
  updateNotifBadge();
}

async function markCabNotifRead(id, el) {
  el.classList.remove('unread');
  el.querySelector('.notif-unread-dot')?.remove();
  updateNotifBadge();
  await DB.notifications.markRead(id);
}

async function markAllCabRead() {
  await DB.notifications.markAllRead(currentUser.id);
  loadCabNotifications();
  Toast.info('Toutes les notifications sont lues.');
}

/* ── Profil ────────────────────────────────────────────────────── */
function toggleCabPersonalInfo() {
  const section = document.getElementById('cab-pinfo-body');
  const icon    = document.getElementById('cab-pinfo-icon');
  const btn     = document.getElementById('cab-pinfo-btn');
  if (!section) return;
  const isOpen = section.style.display !== 'none';
  section.style.display = isOpen ? 'none' : 'block';
  icon?.classList.toggle('open', !isOpen);
  btn?.classList.toggle('open', !isOpen);
  if (!isOpen) section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function toggleCabPwdSection() {
  const section = document.getElementById('cab-pwd-body');
  const icon    = document.getElementById('cab-pwd-icon');
  const btn     = document.getElementById('cab-pwd-btn');
  if (!section) return;
  const isOpen = section.style.display !== 'none';
  section.style.display = isOpen ? 'none' : 'block';
  icon?.classList.toggle('open', !isOpen);
  btn?.classList.toggle('open', !isOpen);
  if (!isOpen) section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

const RETRAIT_NETWORK_PREFIX_KEY = { 'Orange Money': 'Orange', 'MTN MoMo': 'MTN', 'Moov Money': 'Moov' };
const RETRAIT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
let _cabRetraitSelected = null;

function toggleCabRetraitSection() {
  const section = document.getElementById('cab-retrait-body');
  const icon    = document.getElementById('cab-retrait-icon');
  const btn     = document.getElementById('cab-retrait-btn');
  if (!section) return;
  const isOpen = section.style.display !== 'none';
  section.style.display = isOpen ? 'none' : 'block';
  icon?.classList.toggle('open', !isOpen);
  btn?.classList.toggle('open', !isOpen);
  if (!isOpen) { renderCabRetraitState(); section.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
}

function renderCabRetraitState() {
  const user = DB.users.byId(currentUser.id);
  _cabRetraitSelected = user.paiement_vers || null;

  document.querySelectorAll('#cab-retrait-grid .prg-pay-card').forEach(c => {
    c.classList.toggle('prg-pay-card--sel', c.dataset.pay === user.paiement_vers);
  });
  const numeroInput = document.getElementById('cab-retrait-numero');
  if (numeroInput) numeroInput.value = Fmt.phone(user.numero_compte || '');

  const grid    = document.getElementById('cab-retrait-grid');
  const lockMsg = document.getElementById('cab-retrait-lock-msg');
  const lockTxt = document.getElementById('cab-retrait-lock-text');
  const saveBtn = document.getElementById('cab-retrait-save-btn');

  const lastMaj    = user.retrait_derniere_maj ? new Date(user.retrait_derniere_maj).getTime() : 0;
  const remainingMs = RETRAIT_COOLDOWN_MS - (Date.now() - lastMaj);
  const locked      = lastMaj > 0 && remainingMs > 0;

  grid?.classList.toggle('prg-pay-grid--locked', locked);
  if (numeroInput) numeroInput.disabled = locked;
  if (saveBtn) saveBtn.disabled = locked;

  if (lockMsg) {
    if (locked) {
      const nextAllowed = new Date(lastMaj + RETRAIT_COOLDOWN_MS);
      if (lockTxt) lockTxt.textContent = `Prochaine modification possible à partir du ${Fmt.datetime(nextAllowed)}.`;
      lockMsg.style.display = 'flex';
    } else {
      lockMsg.style.display = 'none';
    }
  }
}

function cabSelectRetraitReseau(card) {
  if (card.closest('#cab-retrait-grid')?.classList.contains('prg-pay-grid--locked')) return;
  document.querySelectorAll('#cab-retrait-grid .prg-pay-card').forEach(c => c.classList.remove('prg-pay-card--sel'));
  card.classList.add('prg-pay-card--sel');
  _cabRetraitSelected = card.dataset.pay;

  const prefixKey = RETRAIT_NETWORK_PREFIX_KEY[_cabRetraitSelected];
  if (prefixKey) applyNetworkPrefix('cab-retrait-numero', prefixKey);
}

async function confirmCabRetrait() {
  const user       = DB.users.byId(currentUser.id);
  const lastMaj     = user.retrait_derniere_maj ? new Date(user.retrait_derniere_maj).getTime() : 0;
  const remainingMs = RETRAIT_COOLDOWN_MS - (Date.now() - lastMaj);
  if (lastMaj > 0 && remainingMs > 0) {
    const nextAllowed = new Date(lastMaj + RETRAIT_COOLDOWN_MS);
    Toast.error(`Modification déjà effectuée récemment — réessayez à partir du ${Fmt.datetime(nextAllowed)}.`);
    renderCabRetraitState();
    return;
  }

  if (!_cabRetraitSelected) { Toast.error('Choisissez un réseau.'); return; }
  const numero = document.getElementById('cab-retrait-numero').value.trim();
  if (!numero) { Toast.error('Le numéro de réception est obligatoire.'); return; }

  const res = await DB.retraits.setInfo(_cabRetraitSelected, numero);
  if (!res.ok) { Toast.error(res.error); return; }
  await DB.users.refreshSelf();
  currentUser = Auth.refresh();

  Toast.success('Réseau et numéro de retrait mis à jour.');
  renderCabRetraitState();
}

let _cabReaboSelected = null;

function toggleCabReaboSection() {
  const section = document.getElementById('cab-reabo-body');
  const icon    = document.getElementById('cab-reabo-icon');
  const btn     = document.getElementById('cab-reabo-btn');
  if (!section) return;
  const isOpen = section.style.display !== 'none';
  section.style.display = isOpen ? 'none' : 'block';
  icon?.classList.toggle('open', !isOpen);
  btn?.classList.toggle('open', !isOpen);
  if (!isOpen) { renderCabReaboCards(); section.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
}

function renderCabReaboCards() {
  const user = DB.users.byId(currentUser.id);
  _cabReaboSelected = null;
  document.getElementById('cab-reabo-summary').style.display = 'none';

  ['Premium', 'VIP', 'VVIP'].forEach(formule => {
    const prix  = DB.SUBSCRIPTION_PRICES[formule];
    const quota = DB.SUBSCRIPTION_QUOTAS[formule];
    document.getElementById('cab-reabo-price-' + formule).innerHTML = `${prix.toLocaleString()} <span>FCFA</span>`;
    document.getElementById('cab-reabo-quota-' + formule).textContent = `Quota : ${quota.toLocaleString()} FCFA de commissions`;
    document.getElementById('cab-reabo-badge-' + formule).style.display = (user.abonnement === formule) ? '' : 'none';
    document.querySelector(`.cab-reabo-card[data-formule="${formule}"]`)?.classList.remove('selected');
  });

  // Tant que le quota actuel n'est pas atteint, changer de formule ou se
  // réabonner est bloqué — même règle côté serveur simulé, voir la garde
  // dans DB.business.resubscribeCabine() (js/db.js).
  const quotaAtteint = DB.business.cabineQuotaAtteint(currentUser.id);
  const grid = document.getElementById('cab-reabo-grid');
  const intro = document.getElementById('cab-reabo-intro');
  grid?.classList.toggle('prg-pay-grid--locked', !quotaAtteint);
  if (intro) {
    if (!quotaAtteint) {
      const quota = DB.SUBSCRIPTION_QUOTAS[user.abonnement] || DB.SUBSCRIPTION_QUOTAS.Premium;
      intro.innerHTML = `<i class="fa-solid fa-lock"></i> Vous devez atteindre votre quota actuel (${Fmt.money(user.commissions_total || 0)} / ${Fmt.money(quota)} de commissions) avant de pouvoir changer de formule ou vous réabonner.`;
    } else {
      intro.textContent = 'Choisissez une formule pour repartir sur un nouveau cycle de commission. Le paiement se fait exclusivement avec votre solde — un solde insuffisant est autorisé, le montant restant sera à rembourser.';
    }
  }
}

function cabSelectReaboFormule(formule) {
  // Garde défensive (la grille est déjà verrouillée visuellement via
  // .prg-pay-grid--locked dans renderCabReaboCards() tant que le quota
  // n'est pas atteint — pointer-events:none empêche déjà ce clic, ceci
  // protège un appel direct).
  if (!DB.business.cabineQuotaAtteint(currentUser.id)) return;
  _cabReaboSelected = formule;
  document.querySelectorAll('.cab-reabo-card').forEach(c => c.classList.toggle('selected', c.dataset.formule === formule));

  const user     = DB.users.byId(currentUser.id);
  const prix     = DB.SUBSCRIPTION_PRICES[formule];
  const solde    = user.solde || 0;
  const resteDu  = (solde - prix) < 0 ? Math.abs(solde - prix) : 0;

  document.getElementById('cab-reabo-sum-formule').textContent = formule;
  document.getElementById('cab-reabo-sum-prix').textContent    = Fmt.money(prix);
  document.getElementById('cab-reabo-sum-solde').textContent   = Fmt.money(solde);

  const warnEl = document.getElementById('cab-reabo-sum-warning');
  if (resteDu > 0) {
    warnEl.style.display = 'flex';
    document.getElementById('cab-reabo-sum-warning-text').textContent =
      `Solde insuffisant — après paiement, il restera ${Fmt.money(resteDu)} à rembourser (solde négatif).`;
  } else {
    warnEl.style.display = 'none';
  }

  document.getElementById('cab-reabo-summary').style.display = 'block';
}

async function confirmCabReabonnement() {
  if (!_cabReaboSelected) return;
  const formule = _cabReaboSelected;
  const prix = DB.SUBSCRIPTION_PRICES[formule];
  if (!confirm(`Confirmer le réabonnement ${formule} pour ${prix.toLocaleString()} FCFA, prélevés de votre solde ?`)) return;

  const res = await DB.business.resubscribeCabine(currentUser.id, formule);
  if (!res.ok) { Toast.error(res.error); return; }

  currentUser = Auth.refresh();
  loadCabBalanceCard();
  loadCabQuota();
  renderCabReaboCards();

  Toast[res.resteDu > 0 ? 'warning' : 'success'](res.resteDu > 0
    ? `Réabonnement ${formule} confirmé — il vous reste ${res.resteDu.toLocaleString()} FCFA à rembourser.`
    : `Réabonnement ${formule} confirmé avec succès.`);
}

function toggleUssdSection() {
  const section = document.getElementById('cab-ussd-body');
  const icon    = document.getElementById('cab-ussd-icon');
  const btn     = document.getElementById('cab-ussd-btn');
  if (!section) return;
  const isOpen = section.style.display !== 'none';
  section.style.display = isOpen ? 'none' : 'block';
  icon?.classList.toggle('open', !isOpen);
  btn?.classList.toggle('open', !isOpen);
  if (!isOpen) section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* Activation/désactivation du composeur USSD auto, par réseau — distincte
   de l'acceptation de commandes (_cabNetworks/toggleNetwork() ci-dessus) :
   un réseau désactivé ici continue de recevoir des commandes, mais
   getOrderUssdCode() (js/cabine.js) ne propose plus de lien "tel:" auto-
   composé pour lui, le cabiniste compose alors lui-même. Même patron de
   double-persistance (localStorage + compte) que toggleNetwork(). */
function _refreshUssdTogglesUI() {
  ['orange', 'mtn', 'moov'].forEach(net => {
    document.getElementById('ussd-toggle-' + net)?.classList.toggle('active', !!_cabUssdEnabled[net]);
  });
}

async function toggleUssdNetwork(net, btn) {
  _cabUssdEnabled[net] = !_cabUssdEnabled[net];
  localStorage.setItem('kbine_cab_ussd_enabled', JSON.stringify(_cabUssdEnabled));
  if (btn) btn.classList.toggle('active', _cabUssdEnabled[net]);
  const label = net === 'orange' ? 'Orange' : net === 'mtn' ? 'MTN' : 'Moov';
  Toast.info(`Code USSD ${label} ${_cabUssdEnabled[net] ? 'activé' : 'désactivé'}.`);

  // Persisté côté serveur (voir api/cabine_update_self.php) — sans ça, ce
  // réglage restait local à l'appareil et disparaissait sur un autre
  // appareil connecté au même compte.
  const res = await DB.business.cabineUpdateSelf(currentUser.id, { ussd_enabled: _cabUssdEnabled });
  if (!res.ok) { Toast.error(res.error || 'Échec de l\'enregistrement — réessayez.'); return; }
  currentUser = Auth.refresh();
}

function toggleCabDevicesSection() {
  const section = document.getElementById('cab-devices-body');
  const icon    = document.getElementById('cab-devices-icon');
  const btn     = document.getElementById('cab-devices-btn');
  if (!section) return;
  const isOpen = section.style.display !== 'none';
  section.style.display = isOpen ? 'none' : 'block';
  icon?.classList.toggle('open', !isOpen);
  btn?.classList.toggle('open', !isOpen);
  if (!isOpen) { loadCabDevices(); section.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
}

function _cabDeviceRelativeTime(iso) {
  const diffMin = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (diffMin < 1)   return 'à l\'instant';
  if (diffMin < 60)  return `il y a ${diffMin} min`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24)    return `il y a ${diffH} h`;
  return `il y a ${Math.round(diffH / 24)} j`;
}

// Remplace la lecture 100% locale (DB.partnerDevices.forUser()) par la
// vraie liste serveur (voir api/devices_list.php, Phase G) — sans ça,
// "Mes appareils connectés" ne montrait jamais que le navigateur courant,
// et "Déconnecter" ne faisait rien côté serveur (la session restait
// valide malgré le retrait visuel).
async function loadCabDevices() {
  const list = document.getElementById('cab-devices-list');
  if (!list) return;
  await DB.partnerDevices.refresh();
  const myDeviceId = Auth.getDeviceId();
  const devices = DB.partnerDevices.allFromServer().sort((a, b) => new Date(b.last_seen_at) - new Date(a.last_seen_at));
  list.innerHTML = devices.map(d => `
    <div class="cab-device-row">
      <div class="cab-device-ico"><i class="fa-solid fa-mobile-screen-button"></i></div>
      <div class="cab-device-info">
        <div class="cab-device-label">${d.label || 'Appareil'}${d.device_id === myDeviceId ? ' <span class="cab-device-here">Cet appareil</span>' : ''}</div>
        <div class="cab-device-sub">${d.remembered ? 'Mémorisé — ' : ''}Actif ${_cabDeviceRelativeTime(d.last_seen_at)}</div>
      </div>
      ${d.device_id === myDeviceId
        ? ''
        : `<button type="button" class="cab-device-disconnect" onclick="cabDisconnectDevice('${d.id}')" title="Déconnecter cet appareil"><i class="fa-solid fa-xmark"></i></button>`}
    </div>
  `).join('') || '<div class="cab-devices-empty">Aucun autre appareil connecté.</div>';
}

async function cabDisconnectDevice(deviceRecordId) {
  const res = await DB.partnerDevices.revoke(deviceRecordId);
  if (!res.ok) { Toast.error(res.error); return; }
  loadCabDevices();
  Toast.success('Appareil déconnecté.');
}

function loadProfile() {
  const user    = DB.users.byId(currentUser.id);
  const isAdmin = currentUser.role === 'admin';
  const set     = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v || '—'; };
  const setV    = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };

  // Carte profil (avatar + nom + statut)
  set('cab-prof-avatar',  Fmt.initials(user.nom, user.prenom));
  set('cab-prof-name',    user.prenom + ' ' + user.nom);
  set('cab-prof-member',  Fmt.date(user.date_creation));
  const statut = user.statut || 'inactif';
  set('cab-prof-status', statut.charAt(0).toUpperCase() + statut.slice(1));
  const statusDot = document.getElementById('cab-prof-status-dot');
  if (statusDot) statusDot.style.background = statut === 'actif' ? '#34D399' : '#F0554A';

  // Champs lecture seule
  set('cab-prof-prenom-view',  user.prenom);
  set('cab-prof-nom-view',     user.nom);
  set('cab-prof-cabnom-view',  user.cabine_nom);
  set('cab-prof-tel-view',     Fmt.phone(user.telephone));
  set('cab-prof-wa-view',      Fmt.phone(user.whatsapp));
  set('cab-prof-email-view',   user.email);
  set('cab-prof-zone-view',    user.zone);

  // Formulaire admin
  const adminEdit = document.getElementById('cab-prof-admin-edit');
  if (adminEdit) adminEdit.style.display = isAdmin ? 'block' : 'none';
  if (isAdmin) {
    setV('cab-prof-prenom',  user.prenom);
    setV('cab-prof-nom',     user.nom);
    setV('cab-prof-cabnom',  user.cabine_nom);
    setV('cab-prof-tel',     Fmt.phone(user.telephone));
    setV('cab-prof-wa',      Fmt.phone(user.whatsapp));
    setV('cab-prof-email',   user.email);
    setV('cab-prof-zone',    user.zone);
  }

  loadCabDevices();
}

async function handleCabineProfileUpdate(e) {
  e.preventDefault();
  const prenom    = document.getElementById('cab-prof-prenom')?.value.trim();
  const nom       = document.getElementById('cab-prof-nom')?.value.trim();
  const cabineNom = document.getElementById('cab-prof-cabnom')?.value.trim();
  const tel       = document.getElementById('cab-prof-tel')?.value.replace(/\D/g, '');
  const wa        = document.getElementById('cab-prof-wa')?.value.replace(/\D/g, '');
  const email     = document.getElementById('cab-prof-email')?.value.trim();
  const zone      = document.getElementById('cab-prof-zone')?.value.trim();
  if (!Auth.isValidGmail(email)) { Toast.error('Adresse Gmail invalide (ex : nom@gmail.com).'); return; }
  const existing = DB.users.byEmail(email);
  if (existing && existing.id !== currentUser.id) { Toast.error('Cet email est déjà utilisé par un autre compte.'); return; }
  // Persisté côté serveur (voir api/cabine_update_self.php) — un bug
  // séparé empêchait jusqu'ici cet enregistrement de s'exécuter, même
  // localement (condition de garde inversée, corrigée ici).
  const res = await DB.business.cabineUpdateSelf(currentUser.id, { prenom, nom, cabine_nom: cabineNom, telephone: tel, whatsapp: wa, email, zone });
  if (!res.ok) { Toast.error(res.error || 'Échec de la mise à jour du profil.'); return; }
  currentUser = Auth.refresh();
  renderTopbarUser();
  loadProfile();
  Toast.success('Profil mis à jour avec succès.');
}

async function handleCabinePwdChange(e) {
  e.preventDefault();
  const current = document.getElementById('cab-pwd-current').value;
  const newPwd  = document.getElementById('cab-pwd-new').value;
  const confirm = document.getElementById('cab-pwd-confirm').value;
  if (!Auth.isValidPin(newPwd)) { Toast.error('Le nouveau code doit contenir exactement 4 chiffres.'); return; }
  if (newPwd !== confirm) { Toast.error('Les mots de passe ne correspondent pas.'); return; }
  // Revérifié côté serveur (voir api/cabine_update_pin.php) : sans ça, le
  // code n'était changé que dans le cache local de l'appareil, obligeant
  // à retenir l'ANCIEN code sur tout autre appareil ou après effacement
  // des données du navigateur.
  const res = await DB.business.cabineUpdatePin(currentUser.id, current, newPwd);
  if (!res.ok) { Toast.error(res.error || 'Mot de passe actuel incorrect.'); return; }
  document.getElementById('cab-pwd-form').reset();
  Toast.success('Mot de passe modifié avec succès.');
}

/* ── Déconnexion avec choix (au lieu d'un Auth.logout() direct) ────────
   Voir Auth.hasClientBackup()/restoreClientBackup() dans auth.js : une
   session client mise de côté au moment de la connexion cabine permet de
   proposer un retour direct vers l'espace client. */
function openLogoutChoice() {
  const btn = document.getElementById('logout-return-client-btn');
  if (btn) btn.style.display = Auth.hasClientBackup() ? 'flex' : 'none';
  openModal('modal-logout-choice');
}

function logoutSwitchAccount() {
  if (currentUser) ResumeState.clearAllForUser(currentUser.id);
  sessionStorage.removeItem('cbp_session');
  sessionStorage.setItem('cbp_auto_login', 'cabine');
  window.location.href = 'client.html';
}

function logoutReturnToClient() {
  // Filet de sécurité : si la sauvegarde a disparu entre l'ouverture du
  // choix et le clic, on se déconnecte quand même plutôt que de laisser la
  // session cabine active rebondir vers cabine.html au chargement de client.html.
  if (currentUser) ResumeState.clearAllForUser(currentUser.id);
  if (!Auth.restoreClientBackup()) sessionStorage.removeItem('cbp_session');
  window.location.href = 'client.html';
}

window.addEventListener('DOMContentLoaded', boot);
