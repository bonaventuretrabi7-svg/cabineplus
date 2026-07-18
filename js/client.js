/* ================================================================
   KBINE PLUS | Espace Client — logique complète
   Accès libre (invité) · Inscription requise uniquement à la commande
   ================================================================ */

let currentUser  = null;
let pendingOrder = false;

// Identité client mémorisée sur cet appareil (jeton "rester connecté",
// voir DB.partnerDevices) — jamais utilisée pour ouvrir la session
// directement (contrairement à _tryRememberMeRestore() côté cabine, voir
// js/cabine.js) : sert seulement à afficher "Content de vous revoir,
// {prénom}" et à sauter la saisie du téléphone, voir _lookupRememberedClient()
// et le panneau ag-panel-unlock.
let _rememberedClient = null;
function _lookupRememberedClient() {
  const token = localStorage.getItem(Auth.REMEMBER_TOKEN_KEY);
  if (!token) return null;
  const rec = DB.partnerDevices.findByToken(Auth.getDeviceId(), token);
  if (!rec) { localStorage.removeItem(Auth.REMEMBER_TOKEN_KEY); return null; }
  const user = DB.users.byId(rec.user_id);
  return (user && user.role === 'client') ? user : null;
}

// "Ce n'est pas vous ?" (panneau ag-panel-unlock) : un autre client va
// utiliser cet appareil — on oublie l'identité mémorisée.
function forgetRememberedClient() {
  localStorage.removeItem(Auth.REMEMBER_TOKEN_KEY);
  _rememberedClient = null;
  switchAuthGateTab('login');
}

/* Reprise "rester connecté" SANS redemander le PIN — même patron que
   _tryRememberMeRestore() côté cabine (js/cabine.js), désormais étendu au
   client (demande explicite : éviter d'avoir à retaper son code à chaque
   ouverture). Le jeton (voir Auth._applyDeviceBookkeeping, js/auth.js) est
   toujours le jeton de session SERVEUR, revérifié par api/session_whoami.php
   avant d'ouvrir quoi que ce soit — jamais une session ouverte depuis des
   données purement locales. Retourne l'utilisateur restauré, ou null si
   rien n'a pu être repris (hors ligne, jeton invalide/expiré, compte
   bloqué/suspendu...) : le panneau de déverrouillage classique
   (ag-panel-unlock, PIN seul) prend alors le relais, voir boot(). */
async function _tryRememberMeClientRestore() {
  const token = localStorage.getItem(Auth.REMEMBER_TOKEN_KEY);
  if (!token) return null;
  const rec = DB.partnerDevices.findByToken(Auth.getDeviceId(), token);
  if (!rec) { localStorage.removeItem(Auth.REMEMBER_TOKEN_KEY); return null; }

  const res = await Auth.resumeSession(token);
  if (!res.ok) {
    // Hors ligne (networkError) : on retente au prochain démarrage, le
    // jeton reste valable — le panneau de déverrouillage (PIN) prend le
    // relais pour cette fois. Jeton réellement invalide/expiré ou compte
    // suspendu/bloqué : on l'oublie pour ne plus jamais réessayer avec un
    // jeton mort.
    if (!res.networkError) {
      DB.partnerDevices.remove(rec.id);
      localStorage.removeItem(Auth.REMEMBER_TOKEN_KEY);
    }
    return null;
  }
  if (res.user.role !== 'client') {
    // Jeton valide mais lié à un autre rôle (ex. appareil partagé) —
    // n'ouvre jamais l'espace client avec une session mal typée.
    sessionStorage.removeItem('cbp_session');
    DB.partnerDevices.remove(rec.id);
    localStorage.removeItem(Auth.REMEMBER_TOKEN_KEY);
    return null;
  }
  DB.partnerDevices.touch(rec.id, true, token);
  await DB.partnerDevices.syncSelf(rec.device_id, rec.label, true);
  return res.user;
}

/* ── Reprise d'état au rechargement (voir ResumeState dans auth.js) ──
   Un seul objet en mémoire, sauvegardé à chaque mutation et relu une
   fois au boot (restoreClientState()). */
let _clientResume = {
  section: null, transfer: null, orderInProgress: null,
  reclamationHub: null, partnerRegister: null, reclaFloat: null, lastOrderAt: null,
};
function _saveClientResume() { ResumeState.save('client', _clientResume); }

/* ── Anti-spam commandes : 1 min entre deux commandes, tous services
   confondus (transfert direct, facture, exchange, recharge UV, cadeau…).
   Persisté via _clientResume pour résister à un rechargement de page. */
const ORDER_COOLDOWN_MS = 60 * 1000;

function _orderCooldownRemainingMs() {
  if (!_clientResume.lastOrderAt) return 0;
  return Math.max(0, ORDER_COOLDOWN_MS - (Date.now() - _clientResume.lastOrderAt));
}

function _checkOrderCooldown() {
  const remaining = _orderCooldownRemainingMs();
  if (remaining > 0) {
    Toast.warning(`Merci de patienter encore ${formatMmSs(remaining)} avant de passer une nouvelle commande.`);
    return false;
  }
  return true;
}

function _markOrderSubmitted() {
  _clientResume.lastOrderAt = Date.now();
  _saveClientResume();
}

/* Appelé à chaque changement du formulaire de transfert (voir setStep(),
   tfUpdateRecipient(), tfOnPayPhone() plus bas) — capture tf + l'étape
   active du wizard (via la classe .active posée sur #step-op/.../#step-pay). */
function _saveTfState() {
  const curIdx = WZ_STEPS.findIndex(sid => document.getElementById(sid)?.classList.contains('active'));
  _clientResume.transfer = {
    operator: tf.operator, serviceType: tf.serviceType, directAmount: tf.directAmount,
    forfaitId: tf.forfait ? tf.forfait.id : null, forfaitCat: tf.forfaitCat,
    forfaitSubCat: tf.forfaitSubCat,
    recipient: tf.recipient, paymentMethod: tf.paymentMethod, payPhone: tf.payPhone,
    activeStep: curIdx >= 0 ? WZ_STEPS[curIdx] : WZ_STEPS[0],
  };
  _saveClientResume();
}

/* ── État du formulaire de transfert ───────────────────────────── */
const tf = {
  operator:      null,
  serviceType:   'direct',
  directAmount:  0,
  forfait:       null,
  forfaitCat:    'Internet',
  forfaitSubCat: null,
  forfaitSubRequired: false,
  recipient:     '',
  paymentMethod: null,
  payPhone:      '',

  get amount() {
    return this.serviceType === 'direct'
      ? this.directAmount
      : (this.forfait?.prix || 0);
  },
  get displayAmount() {
    if (!this.amount) return '—';
    return this.serviceType === 'direct'
      ? Fmt.money(this.amount)
      : `${this.forfait.detail} · ${Fmt.money(this.amount)}`;
  },
  get displayService() {
    return this.serviceType === 'direct' ? 'Transfert direct' : 'Forfait';
  },
  isValid() {
    if (!this.operator) return false;
    if (this.serviceType === 'direct' && this.directAmount < 500) return false;
    if (this.serviceType === 'forfait' && !this.forfait) return false;
    if (!/^0[0-9]{9}$/.test(this.recipient)) return false;
    if (!this.paymentMethod) return false;
    if (this.paymentMethod !== 'solde' && !/^0[0-9]{9}$/.test(this.payPhone)) return false;
    return true;
  },
  reset() {
    this.operator = null; this.serviceType = 'direct';
    this.directAmount = 0; this.forfait = null;
    this.forfaitCat = 'Internet'; this.forfaitSubCat = null; this.forfaitSubRequired = false; this.recipient = '';
    this.paymentMethod = null; this.payPhone = '';
    // Réinitialiser l'accordéon et le récap inline
    const wrap = document.getElementById('tf-pay-phone-wrap');
    if (wrap) { wrap.classList.remove('tf-pay-phone-wrap--open'); }
    const phoneEl = document.getElementById('tf-pay-phone');
    if (phoneEl) { phoneEl.value = ''; phoneEl.disabled = true; phoneEl.placeholder = ''; }
    const numWrap = document.getElementById('tf-pay-num-wrap');
    if (numWrap) numWrap.style.display = 'flex';
    const soldeWrap = document.getElementById('tf-pay-solde-wrap');
    if (soldeWrap) soldeWrap.style.display = 'none';
    const nextBtn = document.getElementById('tf-pay-next-btn');
    if (nextBtn) nextBtn.style.display = 'none';
    const sel = document.getElementById('tf-panel-select');
    const rec = document.getElementById('tf-panel-recap');
    if (sel) sel.style.display = 'flex';
    if (rec) rec.style.display = 'none';
  }
};

/* ── Forfaits par opérateur ────────────────────────────────────── */
/* Le catalogue (Orange Pass Mix/Pass International, MTN, Moov) vit
   désormais dans DB.forfaits (js/db.js) — gérable depuis l'onglet Super
   Admin "Forfaits" (ajout/suppression). tfRenderCats()/tfRenderForfaits()/
   tfSelectForfait() le relisent à chaque rendu, donc toute modification
   admin est visible côté Client sans redéploiement. */

/* ── Moyens de paiement ────────────────────────────────────────── */
const PAYMENT_METHODS = [
  {
    id:'solde', nom:'Solde disponible', l1:'Solde', l2:'disponible',
    color:'#22C55E', glow:'rgba(34,197,94,.35)',
    logo:`<svg viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="14" fill="#22C55E"/>
      <rect x="12" y="18" width="32" height="22" rx="4" stroke="#fff" stroke-width="3.5"/>
      <circle cx="36" cy="29" r="2.5" fill="#fff"/>
    </svg>`
  },
  {
    id:'wave', nom:'Wave', l1:'Wave', l2:'CI',
    color:'#1AABE6', glow:'rgba(26,171,230,.35)',
    logo:`<img src="img/logos/wave.png" alt="Wave" onerror="this.outerHTML='<span style=font-size:1.5rem>🌊</span>'">`
  },
  {
    id:'orange', nom:'Orange Money', l1:'Orange', l2:'Money',
    color:'#FF6200', glow:'rgba(255,98,0,.35)',
    logo:`<img src="img/logos/orange.png" alt="Orange" onerror="this.outerHTML='<span style=font-size:1.3rem>🟠</span>'">`
  },
  {
    id:'mtn', nom:'MTN MoMo', l1:'MTN', l2:'MoMo',
    color:'#FFCB05', glow:'rgba(255,203,5,.35)',
    logo:`<img src="img/logos/mtn.jpg" alt="MTN" onerror="this.outerHTML='<span style=font-size:1.3rem>🟡</span>'">`
  },
  {
    id:'moov', nom:'Moov Money', l1:'Moov', l2:'Money',
    color:'#00A3E0', glow:'rgba(0,163,224,.35)',
    logo:`<img src="img/logos/moov.jpg" alt="Moov" onerror="this.outerHTML='<span style=font-size:1.3rem>🔵</span>'">`
  },
  {
    id:'djamo', nom:'Djamo', l1:'Djamo', l2:'',
    color:'#FF4E6A', glow:'rgba(255,78,106,.35)',
    logo:`<img src="img/logos/djamo.png" alt="Djamo" onerror="this.outerHTML='<span style=font-size:1.3rem>💳</span>'">`
  },
];

/* ================================================================
   LOADING SCREEN
   ================================================================ */
function hideLoader() {
  const l = document.getElementById('page-loader');
  if (!l) return;
  l.classList.add('pl-hide');
  setTimeout(() => l.remove(), 500);
}

/* ================================================================
   ACTUALITÉS KBINE PLUS — voir renderActualites() plus bas
   ================================================================ */

let _revIdx = 0, _revTimer = null;
function initRevCarousel() {
  const slides = document.querySelectorAll('#rev-carousel .rev-slide');
  if (!slides.length) return;
  function revGoTo(idx) {
    _revIdx = (idx + slides.length) % slides.length;
    document.getElementById('rev-carousel').style.transform =
      `translateX(-${_revIdx * 100}%)`;
    document.querySelectorAll('.rev-dot2').forEach((d, i) =>
      d.classList.toggle('active', i === _revIdx));
  }
  document.querySelectorAll('.rev-dot2').forEach((d, i) =>
    d.addEventListener('click', () => { clearInterval(_revTimer); revGoTo(i); _revTimer = setInterval(() => revGoTo(_revIdx + 1), 4000); }));
  _revTimer = setInterval(() => revGoTo(_revIdx + 1), 4000);
}

function initClientCounterAnim() {
  const el = document.getElementById('asc-stat-clients');
  if (!el) return;
  const formatter = n => n.toLocaleString('fr-FR') + '+';
  const trigger = () => animateCountUp(el, 10000, formatter, 2200);

  const rect = el.getBoundingClientRect();
  const alreadyVisible = rect.top < window.innerHeight && rect.bottom > 0;
  if (alreadyVisible) { trigger(); return; }

  const observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) { trigger(); observer.disconnect(); }
  }, { threshold: 0.4 });
  observer.observe(el);
}

/* ── Reprise d'état au rechargement ──────────────────────────────
   Réutilise les vrais gestionnaires (tfSelectOp, tfSelectAmount…) plutôt
   que de reconstruire l'UI à la main, pour garantir un rendu identique à
   une sélection normale. Chaque étape revalide sa donnée contre l'état
   vivant (réseau en maintenance, forfait toujours au catalogue…) avant
   de rejouer l'action — sinon elle est simplement ignorée. */
async function restoreClientState() {
  const saved = ResumeState.load('client');
  tfInitView();
  if (!saved) return;

  // Ces deux-là ne sont pas rejoués/rouverts automatiquement (voir plan) —
  // juste remis en mémoire pour que la prochaine ouverture manuelle du
  // hub réclamation / formulaire partenaire retrouve où l'utilisateur
  // s'était arrêté avant le rechargement.
  _clientResume.reclamationHub  = saved.reclamationHub  || null;
  _clientResume.partnerRegister = saved.partnerRegister || null;

  if (saved.transfer) {
    const d = saved.transfer;

    if (d.operator && !(await isNetworkInMaintenance(d.operator))) {
      const opEl = document.querySelector(`.op-card[data-op="${d.operator}"]`);
      if (opEl) await tfSelectOp(d.operator, opEl);
    }

    if (tf.operator && d.serviceType === 'forfait') {
      tfSetService('forfait', true);
      if (d.forfaitCat) {
        const catEl = document.querySelector(`.fcat-btn[onclick*="tfSetCat('${d.forfaitCat}'"]`);
        if (catEl) tfSetCat(d.forfaitCat, catEl);
      }
      if (d.forfaitSubCat) {
        const subEl = document.querySelector(`.fsub-btn[onclick*="tfSetSubCat('${d.forfaitSubCat}'"]`);
        if (subEl) tfSetSubCat(d.forfaitSubCat, subEl);
      }
      if (d.forfaitId) {
        const cardEl = document.querySelector(`.forfait-card[onclick*="tfSelectForfait('${d.forfaitId}'"]`);
        if (cardEl) tfSelectForfait(d.forfaitId, cardEl);
      }
    } else if (tf.operator && d.directAmount) {
      const tileEl = document.querySelector(`.amount-tile[onclick*="tfSelectAmount(${d.directAmount},"]`);
      if (tileEl) {
        tfSelectAmount(d.directAmount, tileEl);
      } else {
        const custEl = document.getElementById('tf-amount-custom');
        if (custEl) { custEl.value = d.directAmount; tfCustomAmount(d.directAmount); }
      }
    }

    if (tf.amount && d.recipient) tfUpdateRecipient(d.recipient);

    if (/^0[0-9]{9}$/.test(tf.recipient) && d.paymentMethod) {
      const pmEl = document.getElementById('pm-' + d.paymentMethod);
      if (pmEl) tfSelectPayment(d.paymentMethod, pmEl);
      if (d.payPhone) tfOnPayPhone(d.payPhone);
    }

    // Replace le curseur du wizard exactement où l'utilisateur en était,
    // par-dessus les états complete/locked déjà dérivés ci-dessus — mais
    // seulement si cette étape est réellement atteignable avec les données
    // qui ont effectivement pu être restaurées : si une donnée (forfait,
    // destinataire…) n'a pas pu être retrouvée dans le DOM régénéré,
    // l'étape correspondante reste 'locked' et on ne force pas le saut,
    // sinon le client se retrouve sur une étape vide/incohérente (l'état
    // doit rester statique et fidèle à ce qui a vraiment été restauré).
    const activeStepEl = d.activeStep && document.getElementById(d.activeStep);
    if (activeStepEl && !activeStepEl.classList.contains('locked')) {
      setStep(d.activeStep, 'active');
    }
  }

  if (saved.orderInProgress && currentUser) {
    const { txnId, startedAt } = saved.orderInProgress;
    const txn = DB.transactions.byId(txnId);
    const remaining = 300 - Math.floor((Date.now() - startedAt) / 1000);
    if (txn && txn.statut === 'en_attente' && remaining > 0) {
      openOrderStatusModal(txn);
      // openOrderStatusModal() vient de relancer un countdown de 300s et
      // d'écraser startedAt à "maintenant" — on corrige les deux pour
      // refléter le temps réellement écoulé plutôt que de repartir à 5:00.
      startOrsCountdown(remaining);
      _clientResume.orderInProgress = { txnId, startedAt };
      _saveClientResume();
    } else {
      _clientResume.orderInProgress = null;
      _saveClientResume();
    }
  }

  if (saved.reclaFloat && saved.reclaFloat.txnId && currentUser) {
    _reclaFloatTxnId = saved.reclaFloat.txnId;
    renderReclaFloatWidget();
    _startReclaFloatTick();
    _initReclaFloatDrag();
  }

  if (saved.section && saved.section !== 'transfer') {
    showSection(saved.section);
  }
}

/* ── Bandeau impersonation admin ──────────────────────────────────
   Affiché uniquement quand l'admin a accédé à cet espace sans mot de passe
   (voir Auth.startImpersonation() dans js/auth.js). */
function _refreshImpersonationBanner() {
  const banner = document.getElementById('impersonation-banner');
  if (!banner) return;
  const active = Auth.isImpersonating();
  document.body.classList.toggle('impersonating', active);
  if (!active) { banner.style.display = 'none'; return; }
  const info = Auth.impersonationInfo();
  const nameEl = document.getElementById('impersonation-admin-name');
  if (nameEl) nameEl.textContent = info?.admin_name || 'un administrateur';
  banner.style.display = 'flex';
  // Hauteur réelle (le texte peut passer sur 2 lignes selon la longueur
  // du nom admin) — voir css/style.css, .client-page > #impersonation-banner.
  document.documentElement.style.setProperty('--imp-banner-h', banner.offsetHeight + 'px');
}

function returnFromImpersonation() {
  const admin = Auth.endImpersonation();
  if (!admin) return;
  window.location.href = 'admin.html';
}

/* ================================================================
   BOOT
   ================================================================ */
async function boot() {
  // Filet de sécurité : le loader disparaît toujours dans 3s max
  const loaderSafety = setTimeout(hideLoader, 3000);
  // Dans l'app Android empaquetée : démarre tout de suite la vérification
  // de mise à jour (voir js/update-notifier.js) EN PARALLÈLE du reste du
  // démarrage ci-dessous, avec son propre libellé sur l'écran de chargement
  // déjà présent (#page-loader) — seul le masquage du loader, dans le
  // `finally` plus bas, attend sa fin (bornée par loaderSafety ci-dessus,
  // donc jamais plus de 3s même hors ligne). Aucun effet sur le site web
  // (voir UpdateNotifier.isNative()) : le loader y garde son libellé
  // "Chargement…" par défaut.
  if (UpdateNotifier.isNative()) {
    const loaderLabel = document.querySelector('#page-loader .pl-label');
    if (loaderLabel) loaderLabel.textContent = 'Vérification de mise à jour…';
  }
  const updateCheck = UpdateNotifier.init();

  try {
    DB.init();
    // Capture le code de parrainage (?ref=<téléphone du parrain>, voir
    // renderParrainage() plus bas) s'il est présent dans l'URL — conservé
    // en localStorage (pas sessionStorage : un invité peut revenir
    // plusieurs jours plus tard avant de s'inscrire) jusqu'à l'inscription,
    // voir handleAuthGateRegister().
    const refParam = new URLSearchParams(window.location.search).get('ref');
    if (refParam && /^[0-9]{10}$/.test(refParam)) localStorage.setItem('cbp_referral_code', refParam);
    // Rattrape une file de synchronisation laissée en attente (voir
    // DB.syncQueue) si la connexion est déjà là au lancement, et
    // resynchronise automatiquement dès qu'elle revient — jamais bloquant,
    // l'app reste utilisable hors ligne quoi qu'il arrive ici.
    if (DB.Net.isOnline()) DB.drainSyncQueue();
    DB.Net.onChange(() => { if (DB.Net.isOnline()) DB.drainSyncQueue(); });
    // Catalogue forfaits + taux de commission (lecture publique, voir
    // api/forfaits_list.php/commissions_list.php) : rafraîchi en tâche de
    // fond dès le démarrage, invité ou non, pour que l'étape "Forfait" du
    // transfert (quelques clics plus tard) lise déjà des données à jour.
    DB.forfaits.refresh();
    DB.commissions.refresh();
    // Pas d'appel à Theme.init() ici : le mode sombre est retiré de
    // l'espace client (voir plus bas, nettoyage de l'ancien flag) — sinon
    // un ancien réglage "cbp_dark" partagé avec cabine/admin réactivait
    // silencieusement le thème sombre (fond bleu nuit) au chargement.

    let session = Auth.current();
    // Aucune session active sur cet onglet, mais un jeton "rester connecté"
    // existe peut-être pour cet appareil (voir _tryRememberMeClientRestore()
    // ci-dessus) — tenté AVANT le panneau de déverrouillage classique, pour
    // ne jamais redemander le PIN quand ce n'est pas nécessaire.
    if (!session) session = await _tryRememberMeClientRestore();
    if (session) {
      if (session.role === 'admin') {
        window.location.href = 'admin.html';  return;
      }
      if (session.role === 'cabine') {
        window.location.href = 'cabine.html'; return;
      }
      const fresh = Auth.refresh();
      currentUser = fresh || session;
    }

    _refreshImpersonationBanner();

    renderClientNav();
    renderSidebar();
    renderSoldeSection();
    initPinRows();
    tfRenderPaymentMethods();
    renderAndroidProfileButton();

    // QR "invité" (générique, avant connexion) — voir renderMyQrCode()
    // pour l'équivalent une fois connecté, généré en local de la même
    // façon (js/vendor-qrcode.js).
    const guestQrImg = document.getElementById('hbc-qr-guest-img');
    if (guestQrImg) guestQrImg.src = _buildQrDataUrl('KBINE-PLUS');

    renderFidelite();
    renderActualites();
    initRevCarousel();
    initClientCounterAnim();

    // Pull-to-refresh (glisser vers le bas pour actualiser) : chaque
    // section rappelle simplement sa propre fonction de chargement déjà
    // existante, aucune logique de données dupliquée ici — voir
    // js/pull-to-refresh.js.
    PullToRefresh.register('transfer',     loadRecentRecap);
    PullToRefresh.register('historique',   loadHistory);
    PullToRefresh.register('depenses',     loadDepenses);
    PullToRefresh.register('portefeuille', loadWallet);
    PullToRefresh.register('profit',       loadProfit);
    PullToRefresh.register('partenaires',  loadPartenaires);
    PullToRefresh.init();

    if (currentUser) {
      loadHistory();
      loadWallet();
      loadProfit();
      loadRecentRecap();
      renderLockedSections(false);
      startClientPresence();
      // Cache local affiché immédiatement ci-dessus ; resynchronise ses
      // propres commandes en tâche de fond (voir DB.transactions.refresh(),
      // js/db.js — le moteur de commandes, Phase 4, écrit désormais côté
      // serveur) et rafraîchit ces mêmes vues une fois reçu.
      DB.transactions.refresh().then(() => { loadHistory(); loadWallet(); loadRecentRecap(); });
      // Reprend aussi son propre profil (solde compris) dès l'ouverture —
      // une recharge faite par l'administration pendant que cet onglet
      // était fermé/en arrière-plan doit apparaître dès la réouverture,
      // sans attendre le premier cycle de sondage (voir startClientPresence()
      // ci-dessus pour la suite, toutes les 10s).
      DB.users.refreshSelf().then(() => {
        currentUser = Auth.refresh() || currentUser;
        refreshSoldeNumbers();
        loadWallet();
      });
      DB.notifications.refresh(currentUser.id).then(updateNotifBadge);
    } else {
      renderLockedSections(true);
      // Un client mémorisé sur cet appareil (jeton "rester connecté")
      // revient : on lui propose de déverrouiller (code seul) plutôt que
      // de tout ressaisir — voir openAuthModal() plus bas, qui choisit
      // automatiquement le bon panneau. Fermable (×) : rien n'empêche de
      // continuer en invité si ce n'est pas lui.
      _rememberedClient = _lookupRememberedClient();
      if (_rememberedClient) openAuthModal();
    }

    restoreClientState();

    // Message de bienvenue affiché une seule fois, au tout premier
    // chargement du site sur ce navigateur (localStorage, donc persiste
    // au-delà d'une simple session — contrairement à "Bon retour parmi
    // nous !" qui, lui, se déclenche à chaque reconnexion, voir afterLogin()).
    if (!localStorage.getItem('cbp_first_visit_done')) {
      localStorage.setItem('cbp_first_visit_done', 'true');
      // toast--welcome (voir css/style.css) : agrandi pour bien se
      // démarquer des toasts normaux, plus discrets — un seul affichage
      // dans toute la vie du client sur cet appareil, mérite d'être vu.
      Toast.success('Bienvenue sur KBINE PLUS !', 5000, 'toast--welcome');
    }

    // "Se connecter à un autre compte administrateur/partenaire" (choix à
    // la déconnexion, voir admin.js/cabine.js logoutSwitchAccount()) :
    // rouvre directement le bon formulaire de connexion au retour ici.
    const autoLogin = sessionStorage.getItem('cbp_auto_login');
    if (autoLogin) {
      sessionStorage.removeItem('cbp_auto_login');
      if (autoLogin === 'admin')  openAdminAuthModal();
      if (autoLogin === 'cabine') openPartnerLoginModal();
    }

    // Cet appareil vient d'être retiré de "Mes appareils connectés" (par
    // son propriétaire ou par l'admin — voir Auth.require() dans js/auth.js
    // et cabine.js boot()).
    if (sessionStorage.getItem('cbp_device_evicted')) {
      sessionStorage.removeItem('cbp_device_evicted');
      Toast.error('Vous avez été déconnecté(e) : cet appareil a été retiré de vos appareils connectés.');
    }

    // Synchronisation temps réel avec les autres onglets (partenaire,
    // administration) — même principe que DB.presence côté cabine.js
    // (window.addEventListener('storage', ...) sur 'cbp_presence') : une
    // commande remboursée ou traitée ailleurs se reflète ici sans
    // rechargement manuel, aucun backend nécessaire (même origine, même
    // localStorage partagé entre onglets).
    window.addEventListener('storage', (e) => {
      if (e.key !== 'cbp_transactions' || !currentUser) return;
      loadHistory();
      loadWallet();
      currentUser = Auth.refresh();
      refreshSoldeNumbers();
      if (_openDetailTxnId) openOrderDetail(_openDetailTxnId);
    });
  } catch (err) {
    console.error('[KBINE PLUS] Erreur au démarrage :', err);
  } finally {
    await updateCheck;
    clearTimeout(loaderSafety);
    setTimeout(hideLoader, 800);
  }
}

/* ── Téléchargement de l'application Android ───────────────────────────
   Proposé uniquement aux visiteurs sous Android (détection via
   navigator.userAgent) — voir BUILD_APK.md pour la compilation du .apk
   qui doit être déposé dans downloads/kbineplus.apk. */
function isAndroidDevice() {
  return /android/i.test(navigator.userAgent || '');
}

/* Bouton de téléchargement dans "Mon profil" (section cs-profit), juste
   au-dessus de la déconnexion — seul emplacement de ce bouton dans
   l'app, voir client.html #cs-profile-android-dl. */
function renderAndroidProfileButton() {
  const el = document.getElementById('cs-profile-android-dl');
  if (!el) return;
  el.style.display = isAndroidDevice() ? 'block' : 'none';
}

/* normalizeMaintenanceNetwork/isServiceInMaintenance/isNetworkInMaintenance/
   warnMaintenance sont désormais définies dans js/db.js (chargé par
   client.html ET cabine.html) — voir ce fichier. */

/* ── Présence en ligne (voir DB.presence, même mécanisme que cabine.js) ── */
function startClientPresence() {
  DB.presence.ping(currentUser.id);
  DB.presence.refresh();
  setInterval(async () => {
    DB.presence.ping(currentUser.id);
    DB.presence.refresh();
    // Reprend son propre profil (solde compris) — une recharge faite par
    // l'administration (ou tout autre changement fait ailleurs) doit
    // apparaître ici sans que le client ait besoin de se déconnecter/
    // reconnecter (voir DB.users.refreshSelf(), js/db.js).
    await DB.users.refreshSelf();
    currentUser = Auth.refresh() || currentUser;
    refreshSoldeNumbers();
    // Synchronise ses propres commandes (voir api/orders_list.php) — un
    // suivi de commande ouvert doit refléter une acceptation/un renvoi
    // fait côté cabine sans attendre un rechargement manuel.
    await DB.transactions.refresh();
    // Élargit la couverture du balayage de commandes en retard (features
    // 4/5) — les onglets client sont typiquement les plus nombreux ouverts.
    DB.business.sweepStaleOrders();
    DB.business.sweepAutoUnsuspensions();
    // Notifications réelles (voir api/notifications_list.php) — la cloche
    // reflète désormais ce qui se passe partout, pas seulement ce que cet
    // appareil a lui-même déclenché.
    await DB.notifications.refresh(currentUser.id);
    updateNotifBadge();
    // Re-rend la section ACTUELLEMENT affichée (voir _clientSectionLoader()
    // ci-dessus) — couvre automatiquement tous les onglets, pas seulement
    // Historique/Portefeuille comme avant.
    _clientSectionLoader(_clientResume.section || 'transfer')?.();
  }, DB.presence.HEARTBEAT_MS);
  window.addEventListener('beforeunload', () => DB.presence.leave(currentUser.id));
}

/* ================================================================
   SIDEBAR
   ================================================================ */
function openSidebar()  {}
function closeSidebar() {}

function renderSidebar() {
  const pill       = document.getElementById('cn-user-pill');
  const guestPill  = document.getElementById('cn-guest-pill');
  const hbcUser    = document.getElementById('hbc-user');
  const hbcGuest   = document.getElementById('hbc-guest');
  const userPanel  = document.getElementById('hbc-user-panel');
  const guestPanel = document.getElementById('hbc-guest-panel');

  if (currentUser) {
    if (pill)       pill.style.display       = 'flex';
    if (guestPill)  guestPill.style.display  = 'none';
    if (hbcUser)    hbcUser.style.display    = 'block';
    if (hbcGuest)   hbcGuest.style.display   = 'none';
    if (userPanel)  userPanel.style.display  = 'flex';
    if (guestPanel) guestPanel.style.display = 'none';
    const u = DB.users.byId(currentUser.id);
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    const isPhone = /^0[0-9]{9}$/.test(u.prenom);
    set('cn-avatar-top', isPhone ? u.telephone.slice(-2) : Fmt.initials(u.nom, u.prenom));
    _setBalanceValue(Fmt.money(u.solde));
    renderMyQrCode(u.telephone);
  } else {
    if (pill)       pill.style.display       = 'none';
    if (guestPill)  guestPill.style.display  = 'flex';
    if (hbcUser)    hbcUser.style.display    = 'none';
    if (hbcGuest)   hbcGuest.style.display   = 'block';
    if (userPanel)  userPanel.style.display  = 'none';
    if (guestPanel) guestPanel.style.display = 'flex';
  }
  _syncFixedHeaderSpacing();
}

/* ── La carte de solde (connecté) / cadenas (invité) est fixe (doit
   rester visible en permanence, même en défilant) : on réserve sa
   hauteur en haut de #cs-transfer pour que le contenu qui suit (le QR,
   qui chevauche le bas du bandeau via sa propre marge négative, et qui
   lui défile normalement avec la page — jamais fixe) ne passe pas
   dessous. #hbc-user et #hbc-guest ont chacun leur propre
   .pgc-hero-card (un seul visible à la fois, l'autre en display:none) :
   on prend celui qui est réellement affiché (offsetParent non nul),
   sinon .offsetHeight vaudrait 0 pour un élément caché et la réserve
   d'espace s'effondrerait. */
function _visibleHeroCard() {
  return [...document.querySelectorAll('.pgc-hero-card')].find(h => h.offsetParent !== null) || null;
}

function _syncFixedHeaderSpacing() {
  const section = document.getElementById('cs-transfer');
  const hero    = _visibleHeroCard();
  if (!section) return;
  // On mesure toujours la hauteur "déployée" du bandeau (même si l'utilisateur
  // est actuellement scrollé et le bandeau compact), sinon la réserve d'espace
  // rétrécirait et la carte QR sauterait au moindre resize pendant le scroll.
  const wasCompact = hero && hero.classList.contains('pgc-hero-card--compact');
  if (wasCompact) hero.classList.remove('pgc-hero-card--compact');
  section.style.paddingTop = (hero ? hero.offsetHeight : 0) + 'px';
  if (wasCompact) hero.classList.add('pgc-hero-card--compact');
}
window.addEventListener('resize', _syncFixedHeaderSpacing);

/* ── Bandeau (solde/cadenas) qui se compacte au défilement (contenu
   rétréci, toujours visible) puis se redéploie près du haut de page —
   appliqué aux deux bandeaux (connecté/invité, un seul visible à la
   fois) : inutile de détecter lequel est affiché, appliquer la classe
   à l'un ou l'autre n'a aucun effet tant qu'il reste caché. */
function _syncHeroCompact() {
  const isCompact = window.scrollY > 24;
  document.querySelectorAll('.pgc-hero-card').forEach(hero => {
    hero.classList.toggle('pgc-hero-card--compact', isCompact);
  });
}
window.addEventListener('scroll', _syncHeroCompact, { passive: true });

function refreshSidebarBalance() {
  if (!currentUser) return;
  const u = DB.users.byId(currentUser.id);
  _setBalanceValue(Fmt.money(u.solde));
}

/* ── Mon code QR (à présenter pour recevoir un transfert) ───────
   Généré 100% en local (js/vendor-qrcode.js) — ancienne version basée
   sur api.qrserver.com (service tiers appelé à chaque affichage) dont la
   lenteur/indisponibilité laissait parfois le QR bloqué (image vide)
   après un rechargement de page. 'H' = correction d'erreur haute (~30%)
   pour que le logo K+ incrusté au centre (voir .pgc-qr-logo-badge) ne
   nuise pas au scan — même niveau qu'avant. */
function _buildQrDataUrl(text) {
  const qr = qrcode(0, 'H');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(6, 0);
}

function renderMyQrCode(telephone) {
  const img = document.getElementById('hbc-qr-img');
  if (!img || !telephone) return;
  img.src = _buildQrDataUrl('KBINE:' + telephone);
}

/* ── Scanner un code QR (caméra + jsQR) ─────────────────────────
   Décode le flux vidéo en direct ; dès qu'un code "KBINE:0xxxxxxxxx"
   est détecté, on pré-remplit le destinataire et on ouvre le transfert. */
let _qrStream = null;
let _qrRAF    = null;

/* jsQR (~streaming decoder) n'est chargé qu'à l'ouverture réelle du
   scanner — sinon chaque visite paie son poids au chargement initial
   pour une fonctionnalité que la plupart des clients n'utilisent jamais.
   _qrScanLoop() vérifie déjà window.jsQR avant de l'appeler, donc rien
   à changer côté boucle de scan : elle attend juste que ça devienne vrai. */
function _loadJsQR() {
  if (window.jsQR || document.getElementById('jsqr-lib')) return;
  const s = document.createElement('script');
  s.id = 'jsqr-lib';
  s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
  document.head.appendChild(s);
}

function openQrScanner() {
  _loadJsQR();
  const statusEl = document.getElementById('qrs-status');
  openModal('modal-qr-scan');
  if (statusEl) statusEl.textContent = 'Placez le code KBINE de votre correspondant dans le cadre.';

  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    .then(stream => {
      _qrStream = stream;
      const video = document.getElementById('qrs-video');
      video.srcObject = stream;
      video.play();
      _qrScanLoop();
    })
    .catch(() => {
      if (statusEl) statusEl.textContent = '';
    });
}

function _qrScanLoop() {
  const video  = document.getElementById('qrs-video');
  const canvas = document.getElementById('qrs-canvas');
  if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
    _qrRAF = requestAnimationFrame(_qrScanLoop);
    return;
  }
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code  = window.jsQR ? jsQR(frame.data, frame.width, frame.height) : null;

  if (code) {
    const match = code.data.match(/^KBINE:(0[0-9]{9})$/);
    const statusEl = document.getElementById('qrs-status');
    if (match) {
      closeQrScanner();
      Toast.success('Code scanné — destinataire renseigné.');
      openClientTransferModal();
      setTimeout(() => {
        const phoneInput = document.getElementById('ct-phone');
        if (phoneInput) { phoneInput.value = match[1]; lookupTransferRecipient(); }
      }, 150);
      return;
    }
    if (statusEl) statusEl.textContent = 'Ce code n\'est pas un code KBINE valide.';
  }
  _qrRAF = requestAnimationFrame(_qrScanLoop);
}

function closeQrScanner() {
  closeModal('modal-qr-scan');
  if (_qrRAF) cancelAnimationFrame(_qrRAF);
  _qrRAF = null;
  if (_qrStream) { _qrStream.getTracks().forEach(t => t.stop()); _qrStream = null; }
  const video = document.getElementById('qrs-video');
  if (video) video.srcObject = null;
}

/* ── Navigation entre sections ─────────────────────────────────── */
// Table "section -> fonction(s) de rechargement", même patron que
// _adminViewLoader() (js/admin.js) — réutilisée à la fois par showSection()
// ci-dessous (au clic) et par le sondage périodique de startClientPresence()
// pour que la section ACTUELLEMENT affichée se remette à jour toute seule,
// sans avoir à câbler chaque onglet au cas par cas.
function _clientSectionLoader(name) {
  return ({
    transfer:     () => { loadRecentRecap(); renderActualites(); },
    historique:   loadHistory,
    depenses:     loadDepenses,
    portefeuille: loadWallet,
    profit:       loadProfit,
    partenaires:  loadPartenaires,
  })[name];
}

async function showSection(name) {
  const maintenanceKeys = { depenses: 'depenses', historique: 'historique' };
  if (maintenanceKeys[name] && await isServiceInMaintenance(maintenanceKeys[name])) {
    warnMaintenance('Cette section est actuellement en maintenance.');
    return;
  }
  const guestGateMsg = {
    historique:    'Connectez-vous pour voir votre historique de transferts.',
    depenses:      'Connectez-vous pour consulter vos dépenses du mois.',
    portefeuille:  'Connectez-vous pour gérer votre solde et recharger votre compte.',
    profit:        'Connectez-vous pour accéder à votre profil et vos coordonnées.',
  };
  if (guestGateMsg[name] && !Auth.current()) {
    openPrivateSpaceNotice(guestGateMsg[name]);
    return;
  }
  document.querySelectorAll('.bn-item').forEach(i =>
    i.classList.toggle('active', i.dataset.section === name));
  document.querySelectorAll('.cs-section').forEach(s =>
    s.classList.toggle('active', s.id === 'cs-' + name));
  const onHome = name === 'transfer';
  document.querySelectorAll('.home-only, .actu-section, .tf-order-intro, .tf-stepper-card, .tf-slider-wrap').forEach(el => {
    el.style.display = onHome ? '' : 'none';
  });
  document.body.classList.toggle('on-home', onHome);
  const activeEl = document.getElementById('cs-' + name);
  if (activeEl) activeEl.scrollTop = 0;
  _clientSectionLoader(name)?.();

  _clientResume.section = name;
  _saveClientResume();
}

/* ── Dépenses du mois ────────────────────────────────────────── */
function loadDepenses() {
  const locked  = document.getElementById('cs-depenses-locked');
  const content = document.getElementById('cs-depenses-content');
  const dBar    = document.querySelector('#cs-depenses .cs-sec-bar');
  if (!currentUser) {
    locked.style.display  = '';
    content.style.display = 'none';
    if (dBar) dBar.style.display = 'none';
    return;
  }
  locked.style.display  = 'none';
  content.style.display = '';
  if (dBar) dBar.style.display = '';

  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth();

  // Filtrer : transactions du mois en cours, statut terminé uniquement
  const all = DB.transactions.byClient(currentUser.id);
  const monthly = all.filter(t => {
    const d = new Date(t.date);
    return d.getFullYear() === year && d.getMonth() === month && t.statut === 'terminé';
  });

  const totalMonth = monthly.reduce((s, t) => s + (t.montant || 0), 0);

  // Récap mois
  const opBreak = {};
  monthly.forEach(t => { opBreak[t.operateur] = (opBreak[t.operateur] || 0) + t.montant; });

  const topOp  = Object.entries(opBreak).sort((a,b)=>b[1]-a[1])[0];
  const topOpName = topOp ? topOp[0] : '—';
  const topOpClr  = {Orange:'#FF6200',MTN:'#FFCC00',Moov:'#0066CC'}[topOpName] || '#7c3aed';

  document.getElementById('dp-recap').innerHTML = `
    <div class="sec-hero">
      <div class="sec-hero-icon"><i class="fa-solid fa-arrow-trend-down"></i></div>
      <div class="sec-hero-amount">${Fmt.money(totalMonth)}</div>
      <div class="sec-hero-label">Total dépensé en ${now.toLocaleDateString('fr-CI',{month:'long'})}</div>
      <div class="sec-hero-chips">
        <div class="sec-chip">
          <i class="fa-solid fa-receipt"></i>
          <span>${monthly.length} commande${monthly.length>1?'s':''}</span>
        </div>
        <div class="sec-chip">
          <i class="fa-solid fa-signal" style="color:${topOpClr}"></i>
          <span>${topOpName}</span>
        </div>
      </div>
    </div>
  `;

  // Grouper par semaine du mois
  const weeks = { 'Semaine 1': [], 'Semaine 2': [], 'Semaine 3': [], 'Semaine 4': [] };
  monthly.forEach(t => {
    const day = new Date(t.date).getDate();
    const wk  = day <= 7 ? 'Semaine 1' : day <= 14 ? 'Semaine 2' : day <= 21 ? 'Semaine 3' : 'Semaine 4';
    weeks[wk].push(t);
  });

  const weeksHtml = Object.entries(weeks).map(([label, items]) => {
    if (!items.length) return '';
    items.sort((a, b) => new Date(b.date) - new Date(a.date));
    const weekTotal = items.reduce((s, t) => s + (t.montant || 0), 0);
    const rows = items.map(t => {
      const opClr = {Orange:'#FF6200', MTN:'#FFCC00', Moov:'#0066CC'}[t.operateur] || '#7c3aed';
      const opTxt = t.operateur === 'MTN' ? '#1a1a1a' : '#fff';
      const dateStr = new Date(t.date).toLocaleDateString('fr-CI',{day:'2-digit',month:'short'});
      return `
      <div class="dp-row">
        <div class="dp-row-avatar" style="background:${opClr};color:${opTxt}">${(t.operateur||'?')[0]}</div>
        <div class="dp-row-info">
          <div class="dp-row-op">${t.operateur}</div>
          <div class="dp-row-num">${Fmt.phone(t.numero_beneficiaire)}</div>
        </div>
        <div class="dp-row-right">
          <div class="dp-row-amt">${Fmt.money(t.montant)}</div>
          <div class="dp-row-date">${dateStr}</div>
        </div>
      </div>`;
    }).join('');

    return `
    <div class="dp-week-block">
      <div class="dp-week-head">
        <span class="dp-week-label"><i class="fa-solid fa-calendar-week"></i> ${label}</span>
        <span class="dp-week-total">${Fmt.money(weekTotal)}</span>
      </div>
      <div class="dp-week-rows">${rows}</div>
    </div>`;
  }).join('');

  document.getElementById('dp-weeks').innerHTML = weeksHtml ||
    `<div class="hx-empty"><i class="fa-solid fa-inbox"></i><span>Aucune dépense ce mois</span></div>`;
}

/* Sections verrouillées pour les invités */

function renderLockedSections(locked) {
  ['historique', 'portefeuille', 'profit'].forEach(s => {
    const lockedEl  = document.getElementById('cs-' + s + '-locked');
    const contentEl = document.getElementById('cs-' + s + '-content');
    if (lockedEl)  lockedEl.style.display  = locked ? 'block' : 'none';
    if (contentEl) contentEl.style.display = locked ? 'none'  : 'block';
  });
}

/* ================================================================
   ÉTAT CONNECTÉ / INVITÉ
   ================================================================ */
function renderClientNav() {
  // La topnav est désormais fixe (logo + symbole profit uniquement).
  // Toutes les infos utilisateur sont dans la sidebar.
}

function renderSoldeSection() {
  renderSidebar();
}

function refreshSoldeNumbers() {
  if (!currentUser) return;
  const u = DB.users.byId(currentUser.id);
  refreshSidebarBalance();
}

function updateNotifBadge() {
  if (!currentUser) return;
  const count = DB.notifications.unread(currentUser.id);
  const sidebarBadge = document.getElementById('csb-notif-badge');
  if (sidebarBadge) { sidebarBadge.textContent = count; sidebarBadge.style.display = count ? 'inline-block' : 'none'; }
  const profileCount = document.getElementById('pc-notif-count');
  if (profileCount) profileCount.textContent = count ? `${count} nouvelle${count > 1 ? 's' : ''} notification${count > 1 ? 's' : ''}` : 'Aucune nouvelle notification';
}

/* Notifications (modal-client-notifications, voir index.html) — même
   patron que loadCabNotifications()/loadAdminNotifications(). */
async function loadClientNotifications() {
  const list = document.getElementById('pc-notif-list');
  if (!list || !currentUser) return;
  await DB.notifications.refresh(currentUser.id);
  const notifs = DB.notifications.forUser(currentUser.id);
  if (!notifs.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon"><i class="fa-solid fa-bell-slash"></i></div><div class="empty-title">Aucune notification</div></div>`;
    updateNotifBadge();
    return;
  }
  const icons = { success: 'fa-circle-check', info: 'fa-circle-info', new_request: 'fa-bell', transfer: 'fa-right-left', warning: 'fa-triangle-exclamation', reassigned: 'fa-shuffle' };
  list.innerHTML = notifs.map(n => `
    <div class="notif-item ${n.lu ? '' : 'unread'}" onclick="markClientNotifRead('${n.id}', this)">
      <div class="notif-icon"><i class="fa-solid ${icons[n.type] || 'fa-bell'}"></i></div>
      <div class="notif-content">
        <div class="notif-msg">${n.message}</div>
        <div class="notif-time"><i class="fa-regular fa-clock"></i> ${Fmt.datetime(n.date)}</div>
      </div>
      ${!n.lu ? '<div class="notif-unread-dot"></div>' : ''}
    </div>`).join('');
  updateNotifBadge();
}

async function markClientNotifRead(id, el) {
  el.classList.remove('unread');
  el.querySelector('.notif-unread-dot')?.remove();
  updateNotifBadge();
  await DB.notifications.markRead(id);
}

/* Après toute connexion réussie */
function afterLogin(user, instant) {
  currentUser = user;
  renderClientNav();
  renderSidebar();
  renderSoldeSection();
  renderLockedSections(false);
  tfInitView();
  loadHistory();
  loadWallet();
  loadProfit();
  renderFidelite();
  renderCadeauBtn();

  if (instant) {
    // Reconnexion (formulaire de connexion standard, hors inscription —
    // voir handleAuthGateRegister qui appelle afterLogin() sans "instant"
    // et affiche déjà son propre message de bienvenue via showLoginSuccess).
    Toast.success('Bon retour parmi nous !');
    closeAuthModal();
    return;
  }

  if (pendingOrder) {
    pendingOrder = false;
    showLoginSuccess(user, () => {
      closeAuthModal();
      setTimeout(() => {
        Toast.info('Connecté ! Votre commande est prête à être validée.');
        tfSubmitConfirm();
      }, 350);
    });
  } else {
    showLoginSuccess(user, () => closeAuthModal());
  }
}

function showLoginSuccess(user, callback) {
  const panels = ['ag-panel-login', 'ag-panel-register', 'ag-pending-order'];
  panels.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const panel = document.getElementById('ag-panel-success');
  const nameEl = document.getElementById('ag-success-name');
  if (nameEl) {
    const isPhone = /^0[0-9]{9}$/.test(user.prenom);
    nameEl.textContent = `Bienvenue, ${isPhone ? Fmt.phone(user.telephone) : user.prenom} !`;
  }
  if (panel) panel.style.display = 'block';
  setTimeout(() => {
    if (panel) panel.style.display = 'none';
    if (callback) callback();
  }, 1800);
}

/* ================================================================
   AUTH GATE
   ================================================================ */
function openAuthModal(tab) {
  // Priorité (sauf si un onglet précis est explicitement demandé, ex.
  // "register" depuis "Créer un compte") : déverrouillage PIN seul si un
  // client est mémorisé sur cet appareil, sinon le formulaire complet.
  if (!tab && _rememberedClient) {
    switchAuthGateTab('unlock');
  } else {
    switchAuthGateTab(tab || 'login');
  }
  document.getElementById('ag-pending-order').style.display = 'none';
  openModal('modal-auth-gate');
}

function closeAuthModalAnimated(callback) {
  const overlay = document.getElementById('modal-auth-gate');
  const modal   = overlay?.querySelector('.ag-modal');
  if (modal) {
    modal.style.transition = 'transform .22s cubic-bezier(.4,0,1,1), opacity .22s ease';
    modal.style.transform  = 'translateY(30px) scale(.96)';
    modal.style.opacity    = '0';
  }
  if (overlay) {
    overlay.style.transition = 'opacity .22s ease';
    overlay.style.opacity    = '0';
  }
  setTimeout(() => {
    closeAuthModal();
    if (modal) { modal.style.transform = ''; modal.style.opacity = ''; }
    if (overlay) { overlay.style.opacity = ''; }
    if (callback) callback();
  }, 220);
}

function closeAuthModal() {
  closeModal('modal-auth-gate');
  const modal  = document.querySelector('#modal-auth-gate .ag-modal');
  if (modal) modal.classList.remove('login-valid', 'login-error');
  const banner = document.getElementById('ag-live-success');
  if (banner) banner.style.display = 'none';
  const telLogin = document.getElementById('ag-login-tel');
  const telReg   = document.getElementById('ag-reg-tel');
  if (telLogin) telLogin.value = '';
  if (telReg)   telReg.value   = '';
  clearPinRow('pin-login-row');
  clearPinRow('pin-register-row');
  clearPinRow('pin-register-confirm-row');
}

function switchAuthGateTab(tab) {
  document.getElementById('ag-panel-unlock').style.display    = tab === 'unlock'    ? 'block' : 'none';
  document.getElementById('ag-panel-login').style.display    = tab === 'login'    ? 'block' : 'none';
  document.getElementById('ag-panel-register').style.display = tab === 'register' ? 'block' : 'none';
  if (tab === 'unlock') {
    clearPinRow('pin-unlock-row');
    const nameEl = document.getElementById('ag-unlock-name');
    if (nameEl && _rememberedClient) {
      const isPhone = /^0[0-9]{9}$/.test(_rememberedClient.prenom);
      nameEl.textContent = isPhone ? Fmt.phone(_rememberedClient.telephone) : _rememberedClient.prenom;
    }
    setTimeout(() => document.querySelector('#pin-unlock-row .pin-box')?.focus(), 280);
  }
  if (tab === 'login') {
    clearPinRow('pin-login-row');
  } else if (tab === 'register') {
    clearPinRow('pin-register-row');
    clearPinRow('pin-register-confirm-row');
  }
}

/* Lire les 4 cases PIN d'une rangée */
function getPinValue(rowId) {
  return [...document.querySelectorAll('#' + rowId + ' .pin-box, #' + rowId + ' .cab2-pin-dot, #' + rowId + ' .cab3-pin')]
    .map(b => b.value).join('');
}

/* Vider les cases d'une rangée */
function clearPinRow(rowId) {
  document.querySelectorAll('#' + rowId + ' .pin-box').forEach(b => {
    b.value = ''; b.classList.remove('pin-filled');
  });
}

/* formatPhoneInput() est désormais partagée dans js/auth.js (Fmt.phone),
   chargé avant ce fichier — voir aussi applyNetworkPrefix() pour le préfixe
   auto Orange/Moov/MTN. */

/* Champ téléphone du login — révèle le PIN quand numéro complet */
function onLoginPhoneInput(input) {
  formatPhoneInput(input);
  const digits = input.value.replace(/\D/g, '');
  const reveal  = document.getElementById('ag-pin-reveal');
  const submitBtn = document.getElementById('ag-login-submit-btn');
  if (!reveal) return;
  if (digits.length === 10) {
    if (!reveal.classList.contains('visible')) {
      reveal.classList.add('visible');
      clearPinRow('pin-login-row');
      setTimeout(() => {
        document.querySelector('#pin-login-row .pin-box')?.focus();
      }, 280);
    }
  } else {
    reveal.classList.remove('visible');
    if (submitBtn) submitBtn.style.display = 'none';
    clearPinRow('pin-login-row');
  }
}

/* Initialiser la navigation clavier entre les cases PIN */
function initPinRows() {
  document.querySelectorAll('.pin-row, .cab-pin-row, .cab2-pin-row, .cab3-pin-row').forEach(row => {
    const boxes = [...row.querySelectorAll('.pin-box')];
    const isLoginRow  = row.id === 'pin-login-row';
    const isUnlockRow = row.id === 'pin-unlock-row';
    boxes.forEach((box, idx) => {
      box.addEventListener('input', () => {
        const v = box.value.replace(/\D/g, '');
        box.value = v ? v[v.length - 1] : '';
        box.classList.toggle('pin-filled', !!box.value);
        if (box.value && idx < boxes.length - 1) {
          boxes[idx + 1].focus();
        } else if (box.value && idx === boxes.length - 1) {
          if (isLoginRow)  checkLoginLive();
          if (isUnlockRow) handleAuthGateUnlock();
        }
      });
      box.addEventListener('keydown', e => {
        if (e.key === 'Backspace' && !box.value && idx > 0) {
          boxes[idx - 1].value = '';
          boxes[idx - 1].classList.remove('pin-filled');
          boxes[idx - 1].focus();
        }
        if (e.key === 'ArrowLeft'  && idx > 0)                boxes[idx - 1].focus();
        if (e.key === 'ArrowRight' && idx < boxes.length - 1) boxes[idx + 1].focus();
      });
      box.addEventListener('paste', e => {
        e.preventDefault();
        const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 4);
        digits.split('').forEach((d, i) => {
          if (boxes[i]) { boxes[i].value = d; boxes[i].classList.add('pin-filled'); }
        });
        const next = boxes[Math.min(digits.length, boxes.length - 1)];
        if (next) next.focus();
        if (digits.length === 4) {
          if (isLoginRow)  checkLoginLive();
          if (isUnlockRow) handleAuthGateUnlock();
        }
      });
    });
  });
}

async function checkLoginLive() {
  const modal   = document.querySelector('#modal-auth-gate .ag-modal');
  const tel     = (document.getElementById('ag-login-tel')?.value || '').replace(/\s/g, '');
  const pin     = getPinValue('pin-login-row');
  const banner  = document.getElementById('ag-live-success');

  if (!modal || !/^[0-9]{10}$/.test(tel) || pin.length !== 4) return;

  modal.classList.remove('login-valid', 'login-error');
  if (banner) banner.style.display = 'none';

  // remember:true — le client est désormais toujours mémorisé sur cet
  // appareil dès sa connexion (voir _lookupRememberedClient()/le panneau
  // "ag-panel-unlock" : au prochain retour, plus besoin de ressaisir le
  // téléphone, juste le code).
  const res = await Auth.login(tel, pin, true, 'client');

  if (res.ok) {
    if (res.user.role === 'admin')  { window.location.href = 'admin.html';  return; }
    if (res.user.role === 'cabine') { window.location.href = 'cabine.html'; return; }
    closeAuthModalAnimated(() => afterLogin(res.user, true));
  } else {
    modal.classList.add('login-error');
    setTimeout(() => {
      modal.classList.remove('login-error');
      clearPinRow('pin-login-row');
      document.querySelector('#pin-login-row .pin-box')?.focus();
    }, 500);
    Toast.error(res.error || 'Numéro ou code incorrect.');
  }
}

async function handleAuthGateLogin(e) {
  e.preventDefault();
  const tel = document.getElementById('ag-login-tel').value.replace(/\s/g, '');
  const pin = getPinValue('pin-login-row');

  if (!/^[0-9]{10}$/.test(tel)) { Toast.error('Numéro invalide — 10 chiffres requis.'); return; }
  if (pin.length !== 4)         { Toast.error('Saisissez votre code à 4 chiffres.'); return; }

  const res = await Auth.login(tel, pin, true, 'client');
  if (res.ok) {
    if (res.user.role === 'admin')  { window.location.href = 'admin.html';  return; }
    if (res.user.role === 'cabine') { window.location.href = 'cabine.html'; return; }
    closeAuthModalAnimated(() => afterLogin(res.user, true));
  } else {
    Toast.error(res.error || 'Numéro ou code incorrect.');
    clearPinRow('pin-login-row');
    document.querySelector('#pin-login-row .pin-box')?.focus();
  }
}

// Déverrouillage (panneau ag-panel-unlock) : identifiant déjà connu
// (_rememberedClient, voir _lookupRememberedClient()) — uniquement le
// code à saisir, réutilise Auth.login() telle quelle pour bénéficier des
// mêmes règles (blocage 3 tentatives, statut de compte, etc.). Appelée à
// la fois par la soumission du formulaire (Entrée) et par le remplissage
// automatique de la 4e case (voir initPinRows()) — e est alors absent.
async function handleAuthGateUnlock(e) {
  if (e && e.preventDefault) e.preventDefault();
  if (!_rememberedClient) { switchAuthGateTab('login'); return; }
  const pin = getPinValue('pin-unlock-row');
  if (pin.length !== 4) return;

  const res = await Auth.login(_rememberedClient.telephone, pin, true, 'client');
  if (res.ok) {
    if (res.user.role === 'admin')  { window.location.href = 'admin.html';  return; }
    if (res.user.role === 'cabine') { window.location.href = 'cabine.html'; return; }
    closeAuthModalAnimated(() => afterLogin(res.user, true));
  } else {
    Toast.error(res.error || 'Code incorrect.');
    clearPinRow('pin-unlock-row');
    document.querySelector('#pin-unlock-row .pin-box')?.focus();
  }
}

async function handleAuthGateRegister(e) {
  e.preventDefault();
  const tel     = document.getElementById('ag-reg-tel').value.replace(/\s/g, '');
  const pin     = getPinValue('pin-register-row');
  const pinConf = getPinValue('pin-register-confirm-row');

  if (!/^[0-9]{10}$/.test(tel)) { Toast.error('Numéro invalide — 10 chiffres requis.'); return; }
  if (pin.length !== 4)          { Toast.error('Choisissez un code à 4 chiffres.'); return; }
  if (pinConf.length !== 4)      { Toast.error('Confirmez votre code à 4 chiffres.'); return; }
  if (pin !== pinConf) {
    Toast.error('Les codes ne correspondent pas. Réessayez.');
    clearPinRow('pin-register-confirm-row');
    document.querySelector('#pin-register-confirm-row .pin-box')?.focus();
    return;
  }
  if (DB.users.byPhoneAndRole(tel, 'client')) { Toast.error('Ce numéro est déjà utilisé par un autre compte de ce type.'); return; }

  // Création côté serveur quand c'est possible (voir api/create_account.php)
  // pour que ce compte soit utilisable sur N'IMPORTE QUEL appareil dès sa
  // création, pas seulement celui-ci — voir le diagnostic du bug de
  // connexion multi-appareil (DB.users vivait auparavant 100% en local, par
  // appareil). Repli local seul si hors ligne/projet non configuré :
  // Auth.login() resynchronisera ce compte avec le serveur dès sa prochaine
  // connexion en ligne depuis un autre appareil, si l'utilisateur en
  // configure un entretemps.
  if (ServerAPI.isConfigured && DB.Net.isOnline()) {
    const parrainTelephone = localStorage.getItem('cbp_referral_code') || null;
    const created = await ServerAPI.createAccount({ role: 'client', prenom: tel, telephone: tel, pin, parrainTelephone });
    if (!created.ok) { Toast.error(created.error || 'Échec de la création du compte.'); return; }
    DB.users.cacheFromServer(created.profile, pin);
    // Consommé une seule fois — un client qui recrée un autre compte plus
    // tard (rare, mais possible) ne doit pas re-déclencher le même
    // parrainage indéfiniment.
    localStorage.removeItem('cbp_referral_code');
  } else {
    DB.users.create({ prenom: tel, telephone: tel, mot_de_passe: pin, role: 'client' });
  }
  // remember:true — même règle que toute connexion client (voir
  // handleAuthGateLogin() plus haut) : un compte tout juste créé doit lui
  // aussi être mémorisé sur cet appareil, sinon le client devait ressaisir
  // numéro + code dès le lancement suivant alors qu'une connexion "normale"
  // ne le lui demande plus.
  const res = await Auth.login(tel, pin, true, 'client');
  if (res.ok) {
    afterLogin(res.user);
  } else {
    Toast.error('Compte créé. Connectez-vous pour continuer.');
    switchAuthGateTab('login');
  }
}

/* ================================================================
   FORMULAIRE DE TRANSFERT — 4 étapes guidées
   ================================================================ */

function tfInitView() {
  PaymentTimer.stop();
  tf.reset();
  setStep('step-op',      'active');
  setStep('step-service', 'locked');
  setStep('step-dest',    'locked');
  setStep('step-pay',     'locked');
  document.querySelectorAll('.op-card').forEach(c => c.classList.remove('active'));
  document.querySelectorAll('.amount-tile').forEach(t => t.classList.remove('selected'));
  document.querySelectorAll('.forfait-card').forEach(c => c.classList.remove('selected'));
  document.querySelectorAll('.pm-chip').forEach(c => c.classList.remove('selected'));
  const rcpEl  = document.getElementById('tf-recipient');
  if (rcpEl) { rcpEl.value = ''; rcpEl.classList.remove('rcp-valid'); }
  const custEl = document.getElementById('tf-amount-custom');
  if (custEl) custEl.value = '';
  document.getElementById('rcp-status').innerHTML = '';
  tfSetService('direct', true);
  refreshSoldeNumbers();
  document.getElementById('prev-op-label').textContent      = 'Sélectionnez un réseau';
  document.getElementById('prev-service-label').textContent = '—';
  document.getElementById('prev-dest-label').textContent    = 'Saisissez le numéro';
  document.getElementById('prev-pay-label').textContent     = 'Choisissez un mode';
  tfUpdateSummary();
  tfUpdateValidateBtn();
  _tfSyncSlideHeight();
}

function setStep(id, state) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('active', 'complete', 'locked');
  el.classList.add(state);
  syncWizardBar();
  _saveTfState();
}

/* ── Wizard : synchronisation barre de progression ──────────── */
const WZ_STEPS = ['step-op','step-service','step-dest','step-pay'];

function syncWizardBar() {
  WZ_STEPS.forEach((sid, i) => {
    const s  = document.getElementById(sid);
    const w  = document.getElementById('wz-ind-' + (i + 1));
    const ln = document.getElementById('wz-line-' + (i + 1));
    if (!s || !w) return;
    const isActive   = s.classList.contains('active');
    const isComplete = s.classList.contains('complete');
    w.classList.toggle('wz-active',   isActive);
    w.classList.toggle('wz-complete', isComplete);
    if (ln) ln.classList.toggle('wz-done', isComplete);
  });

  const curIdx = WZ_STEPS.findIndex(sid =>
    document.getElementById(sid)?.classList.contains('active'));

  const nextBtn = document.getElementById('tf-wz-next-btn');
  const valWrap = document.getElementById('tf-validate-wrap');

  if (nextBtn) nextBtn.style.display = curIdx < WZ_STEPS.length - 1 ? 'flex' : 'none';
  if (valWrap) valWrap.style.display = 'none';

  const track = document.getElementById('tf-slider-track');
  if (track && curIdx >= 0) {
    track.style.transform = `translateX(${-curIdx * 25}%)`;
    _tfSyncSlideHeight();
  }
}

/* ── Wizard : navigation ────────────────────────────────────── */
function wzBack() {
  const curIdx = WZ_STEPS.findIndex(sid =>
    document.getElementById(sid)?.classList.contains('active'));
  if (curIdx > 0) {
    // L'étape qu'on quitte doit repasser à 'complete' (comme wzNext() le
    // fait déjà en avançant) — sinon elle garde sa classe 'active' et
    // deux bulles du stepper s'allument en même temps (bug corrigé ici).
    setStep(WZ_STEPS[curIdx], 'complete');
    setStep(WZ_STEPS[curIdx - 1], 'active');
  }
}

function wzNext() {
  const curIdx = WZ_STEPS.findIndex(sid =>
    document.getElementById(sid)?.classList.contains('active'));
  if (curIdx === 0 && !tf.operator)  { Toast.error('Choisissez un opérateur.'); return; }
  if (curIdx === 1 && !tf.amount)    { Toast.error('Sélectionnez un montant ou un forfait.'); return; }
  if (curIdx === 2 && !/^0[0-9]{9}$/.test(tf.recipient)) {
    Toast.error('Numéro destinataire invalide (10 chiffres).'); return;
  }
  if (curIdx < WZ_STEPS.length - 1) {
    setStep(WZ_STEPS[curIdx], 'complete');
    setStep(WZ_STEPS[curIdx + 1], 'active');
  }
}

function wzClickStep(stepId) {
  const el = document.getElementById(stepId);
  if (!el || !el.classList.contains('complete')) return;
  // Même correctif que wzBack() : démote l'étape quittée à 'complete'
  // avant d'activer la cible, pour ne jamais avoir 2 bulles actives.
  const curIdx    = WZ_STEPS.findIndex(sid =>
    document.getElementById(sid)?.classList.contains('active'));
  const targetIdx = WZ_STEPS.indexOf(stepId);
  if (curIdx >= 0 && curIdx !== targetIdx) setStep(WZ_STEPS[curIdx], 'complete');
  setStep(stepId, 'active');
}

/* ── Étape 1 : Opérateur ───────────────────────────────────────── */
/* Couleur de marque appliquée aux boutons actifs des étapes suivantes
   (toggle Transfert direct/Forfait, onglets de catégorie) — posée en
   variable CSS sur .tf-layout, lue par les surcharges .tf-slide dans
   css/style.css (--op-clr/--op-clr-text). */
const OP_THEME = {
  Orange: { clr: '#FF6200', text: '#fff' },
  MTN:    { clr: '#FFCC00', text: '#3d2e00' },
  Moov:   { clr: '#1D7AE0', text: '#fff' },
};
async function tfSelectOp(op, el) {
  if (await isNetworkInMaintenance(op)) { warnMaintenance(`Le réseau ${op} est actuellement en maintenance.`); return; }
  tf.operator     = op;
  tf.forfait      = null;
  tf.directAmount = 0;
  document.querySelectorAll('.op-card').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  const layout = document.querySelector('.tf-layout');
  if (layout) {
    const theme = OP_THEME[op] || OP_THEME.Orange;
    layout.style.setProperty('--op-clr', theme.clr);
    layout.style.setProperty('--op-clr-text', theme.text);
  }
  applyNetworkPrefix('tf-recipient', op);
  const emojis = { Orange:'🟠', MTN:'🟡', Moov:'🔵' };
  document.getElementById('prev-op-label').textContent = emojis[op] + ' ' + op;
  const opLogos = { Orange: 'orange.png', MTN: 'mtn.jpg', Moov: 'moov.jpg' };
  const flagEl = document.getElementById('rcp-flag');
  if (flagEl) {
    flagEl.innerHTML = `<img src="img/logos/${opLogos[op]}" alt="${op}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.parentElement.textContent='${emojis[op]}'">`;
  }
  setStep('step-op',      'complete');
  setStep('step-service', 'active');
  document.querySelectorAll('.amount-tile').forEach(t => t.classList.remove('selected'));
  document.querySelectorAll('.forfait-card').forEach(c => c.classList.remove('selected'));
  const custEl = document.getElementById('tf-amount-custom');
  if (custEl) custEl.value = '';
  document.getElementById('prev-service-label').textContent = '—';
  if (!tf.amount) { setStep('step-dest', 'locked'); setStep('step-pay', 'locked'); }
  tfRenderCats();
  tfUpdateSummary();
  tfUpdateValidateBtn();
}

/* Les catégories de forfaits varient selon l'opérateur (Orange a 10 vrais
   groupes Pass Mix/Pass International, MTN/Moov gardent Internet/Appels/
   Mixtes) — les onglets sont donc générés dynamiquement plutôt que codés
   en dur dans le HTML (voir #forfait-cats-list dans client.html). */
const FORFAIT_CAT_ICONS = { Internet: 'fa-wifi', Appels: 'fa-circle-dot', Mixtes: 'fa-layer-group' };
function tfRenderCats() {
  const container = document.getElementById('forfait-cats-list');
  if (!container) return;
  const cats = DB.forfaits.categoriesByOperator(tf.operator).filter(c => c !== 'Mixtes');
  const all  = DB.forfaits.all().filter(f => f.operateur === tf.operator);
  // Aucune catégorie pré-sélectionnée : le client doit taper explicitement
  // sur une catégorie (ex: "Appels") avant de voir ses sous-groupes
  // (Pass Mix 1-3/5-7/30 jours...) et ses forfaits.
  tf.forfaitCat    = null;
  tf.forfaitSubCat = null;
  container.innerHTML = cats.map(cat => `
    <button class="fcat-btn" onclick="tfSetCat('${cat}',this)">
      <span class="fcat-btn-title"><i class="fa-solid ${FORFAIT_CAT_ICONS[cat] || 'fa-earth-africa'}"></i> ${cat}</span>
      <span class="fcat-btn-count">${all.filter(f => f.categorie === cat).length} forfaits</span>
    </button>`).join('');
  const subContainer = document.getElementById('forfait-subcats-list');
  if (subContainer) { subContainer.style.display = 'none'; subContainer.innerHTML = ''; }
  tfRenderForfaits();
}

/* ── Étape 2a : Type de service ────────────────────────────────── */
function tfSetService(type, silent = false) {
  tf.serviceType  = type;
  tf.forfait      = null;
  tf.directAmount = 0;
  document.getElementById('svc-direct').classList.toggle('active',  type === 'direct');
  document.getElementById('svc-forfait').classList.toggle('active', type === 'forfait');
  document.getElementById('panel-direct').style.display  = type === 'direct'  ? 'block' : 'none';
  document.getElementById('panel-forfait').style.display = type === 'forfait' ? 'block' : 'none';
  document.querySelectorAll('.amount-tile').forEach(t => t.classList.remove('selected'));
  document.querySelectorAll('.forfait-card').forEach(c => c.classList.remove('selected'));
  const custEl = document.getElementById('tf-amount-custom');
  if (custEl) custEl.value = '';
  document.getElementById('prev-service-label').textContent = '—';
  if (!silent) {
    setStep('step-dest', 'locked'); setStep('step-pay', 'locked');
    tf.recipient = ''; tf.paymentMethod = null;
    const rcpEl = document.getElementById('tf-recipient');
    if (rcpEl) { rcpEl.value = ''; rcpEl.classList.remove('rcp-valid'); }
    document.querySelectorAll('.pm-chip').forEach(c => c.classList.remove('selected'));
    document.getElementById('rcp-status').innerHTML = '';
  }
  tfUpdateSummary(); tfUpdateValidateBtn();
  _tfSyncSlideHeight();
}

/* ── Étape 2b : Montant direct ─────────────────────────────────── */
function tfSelectAmount(amount, el) {
  tf.directAmount = amount;
  document.querySelectorAll('.amount-tile').forEach(t => t.classList.remove('selected'));
  el.classList.add('selected');
  const custEl = document.getElementById('tf-amount-custom');
  if (custEl) custEl.value = '';
  document.getElementById('prev-service-label').textContent = Fmt.money(amount) + ' · direct';
  tfAfterAmountSet();
}

function tfCustomAmount(val) {
  const amount = parseInt(val) || 0;
  tf.directAmount = amount;
  document.querySelectorAll('.amount-tile').forEach(t => t.classList.remove('selected'));
  if (amount >= 500) {
    document.getElementById('prev-service-label').textContent = Fmt.money(amount) + ' · direct';
    tfAfterAmountSet();
  } else {
    setStep('step-dest', 'locked'); setStep('step-pay', 'locked');
    tfUpdateSummary(); tfUpdateValidateBtn();
  }
}

function tfAfterAmountSet() {
  setStep('step-service', 'complete');
  const rcpOk = /^0[0-9]{9}$/.test(tf.recipient);
  setStep('step-dest', rcpOk ? 'complete' : 'active');
  setStep('step-pay',  (rcpOk && tf.paymentMethod) ? 'complete' : (rcpOk ? 'active' : 'locked'));
  tfUpdateSummary(); tfUpdateValidateBtn();
}

/* ── Étape 2c : Forfaits ───────────────────────────────────────── */
function tfSetCat(cat, el) {
  tf.forfaitCat = cat;
  tf.forfait    = null;
  document.querySelectorAll('.fcat-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  tfRenderSubCats();
}

/* Sous-sections d'une catégorie (ex. Pass Mix 1-3j/5-7j/30j + International
   au sein d'"Appels" côté Orange) — rangée de boutons secondaire, affichée
   uniquement quand au moins un forfait de la catégorie a une sousCategorie.
   Un clic filtre la grille sur cette seule sous-section (tfRenderForfaits()). */
function tfRenderSubCats() {
  const container = document.getElementById('forfait-subcats-list');
  if (!container) return;
  const items = DB.forfaits.all().filter(f => f.operateur === tf.operator && f.categorie === tf.forfaitCat);
  const subs = [];
  items.forEach(f => { if (f.sousCategorie && !subs.includes(f.sousCategorie)) subs.push(f.sousCategorie); });

  if (!subs.length) {
    tf.forfaitSubCat = null;
    tf.forfaitSubRequired = false;
    container.style.display = 'none';
    container.innerHTML = '';
    tfRenderForfaits();
    return;
  }

  // Aucun sous-groupe pré-sélectionné : le client doit taper explicitement
  // sur l'un d'eux (ex: "Pass Mix 1-3 jours") avant de voir ses offres.
  tf.forfaitSubCat = null;
  tf.forfaitSubRequired = true;
  container.style.display = 'grid';
  // Rejoue l'animation d'entrée même en passant d'une catégorie à une
  // autre qui a elle aussi des sous-groupes (display reste "grid" dans
  // ce cas, donc pas de changement d'état à observer sans ce forçage).
  container.classList.remove('fsub-reveal');
  void container.offsetWidth;
  container.classList.add('fsub-reveal');
  container.innerHTML = subs.map(s => {
    const count = items.filter(f => f.sousCategorie === s).length;
    return `
    <button type="button" class="fsub-btn" onclick="tfSetSubCat('${s}',this)">
      <span class="fsub-btn-title">${s}</span>
      <span class="fsub-btn-count">${count} forfaits</span>
    </button>`;
  }).join('');
  tfRenderForfaits();
}

function tfSetSubCat(sub, el) {
  tf.forfaitSubCat = sub;
  tf.forfait = null;
  document.querySelectorAll('.fsub-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  tfRenderForfaits();
}

function tfRenderForfaits() {
  const container = document.getElementById('forfait-list');
  if (!container) return;
  if (!tf.operator) {
    container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--gray-400);font-size:.85rem;">Sélectionnez d\'abord un opérateur.</div>';
    _tfSyncSlideHeight();
    return;
  }
  if (!tf.forfaitCat) {
    container.innerHTML = '';
    _tfSyncSlideHeight();
    return;
  }
  if (tf.forfaitSubRequired && !tf.forfaitSubCat) {
    container.innerHTML = '';
    _tfSyncSlideHeight();
    return;
  }
  const list = DB.forfaits.all().filter(f =>
    f.operateur === tf.operator && f.categorie === tf.forfaitCat &&
    (!tf.forfaitSubRequired || f.sousCategorie === tf.forfaitSubCat));
  if (!list.length) {
    container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--gray-400);">Aucun forfait disponible.</div>';
    _tfSyncSlideHeight();
    return;
  }
  const opClass = { Orange: 'op-orange', MTN: 'op-mtn', Moov: 'op-moov' }[tf.operator] || 'op-orange';
  const opLogo  = { Orange: 'orange.png', MTN: 'mtn.jpg', Moov: 'moov.jpg' }[tf.operator];
  const opEmoji = { Orange: '🟠', MTN: '🟡', Moov: '🔵' }[tf.operator] || '📱';
  // Dans "International", chaque destination (Pass Burkina Faso, Mali...)
  // a plusieurs paliers de prix — plutôt que répéter "Pass Burkina Faso"
  // sur chaque carte, on affiche une seule annonce par destination et le
  // titre de la carte se réduit au prix. Les entrées d'une même
  // destination se suivent déjà dans DB.forfaits (voir js/db.js), donc un
  // simple changement d'étiquette suffit à repérer un nouveau groupe.
  const isIntl = tf.forfaitSubCat === 'International';
  let lastGroup = null;
  container.innerHTML = list.map(f => {
    const sel = tf.forfait?.id === f.id;
    let groupHtml = '';
    let title = f.nom;
    if (isIntl) {
      const group = f.nom.replace(/\s+[\d\s]+F$/, '');
      if (group !== lastGroup) {
        groupHtml = `<div class="forfait-group-hd"><span class="forfait-group-badge ${opClass}">${group}</span></div>`;
        lastGroup = group;
      }
      title = Fmt.money(f.prix);
    }
    return `${groupHtml}
    <div class="forfait-card ${opClass} ${sel ? 'selected' : ''}" onclick="tfSelectForfait('${f.id}',this)">
      <div class="fc-check"><i class="fa-solid fa-check"></i></div>
      <div class="fc-top">
        <div class="fc-icon ${opClass}"><img class="fc-icon-img" src="img/logos/${opLogo}" alt="${tf.operator}" onerror="this.outerHTML='<span>${opEmoji}</span>'"></div>
        <div class="fc-title">${title}</div>
      </div>
      <div class="fc-sep"></div>
      <div class="fc-adv-section ${opClass}"><div class="fc-adv-lbl">Les avantages du pass</div></div>
      <div class="fc-adv-val">${f.detail}</div>
      <div class="fc-val-lbl">Validité</div>
      <div class="fc-val-val">${f.duree}</div>
    </div>`;
  }).join('');
  _tfSyncSlideHeight();
}

/* Recalcule la hauteur de .tf-slider-wrap sur le contenu réel de la slide
   actuellement affichée — sans ça, la hauteur reste figée à sa valeur au
   moment du dernier setStep() (voir syncWizardBar()) et un rendu qui
   grandit ensuite (ex : bascule Direct/Forfait, changement de
   catégorie/sous-catégorie, récap de paiement) se retrouve rogné par
   l'overflow:hidden du conteneur.
   Se base sur le transform déjà posé sur #tf-slider-track (et non sur
   quel step a la classe 'active') : au dernier step, tfShowRecap() passe
   'step-pay' en 'complete' pour afficher le récap dans la même slide,
   auquel cas plus aucun step n'est 'active' alors que cette slide reste
   bien la slide visible à resynchroniser. */
function _tfSyncSlideHeight() {
  requestAnimationFrame(() => {
    const track = document.getElementById('tf-slider-track');
    const wrap  = document.querySelector('.tf-slider-wrap');
    if (!track || !wrap) return;
    const m = /translateX\((-?[\d.]+)%\)/.exec(track.style.transform || '');
    const curIdx = m ? Math.round(-parseFloat(m[1]) / 25) : 0;
    const slide = document.querySelectorAll('.tf-slide')[curIdx];
    if (slide) wrap.style.height = slide.scrollHeight + 'px';
  });
}

function tfSelectForfait(id, el) {
  tf.forfait = DB.forfaits.all().find(f => f.id === id) || null;
  document.querySelectorAll('.forfait-card').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  document.getElementById('prev-service-label').textContent =
    tf.forfait ? tf.forfait.detail + ' · ' + Fmt.money(tf.forfait.prix) : '—';
  tfAfterAmountSet();
}

/* ── Étape 3 : Destinataire ────────────────────────────────────── */
function tfUpdateRecipient(val) {
  const clean = val.replace(/\D/g, '').slice(0, 10);
  const rcpInput = document.getElementById('tf-recipient');
  if (rcpInput) rcpInput.value = Fmt.phone(clean);
  tf.recipient = clean;
  const statusEl = document.getElementById('rcp-status');

  // Le numéro du destinataire n'est plus vérifié par rapport aux comptes
  // existants — seul le format est contrôlé (10 chiffres commençant par
  // 0). Voir l'avertissement affiché en permanence sous ce champ
  // (client.html) : en cas d'erreur de saisie, aucun remboursement n'est
  // possible, c'est au client de vérifier.
  if (!clean) {
    statusEl.innerHTML = '';
    if (rcpInput) rcpInput.classList.remove('rcp-valid');
    document.getElementById('prev-dest-label').textContent = 'Saisissez le numéro';
    setStep('step-dest', tf.amount ? 'active' : 'locked');
    setStep('step-pay', 'locked');
  } else if (/^0[0-9]{9}$/.test(clean)) {
    statusEl.innerHTML = '<span class="rcp-msg ok"><i class="fa-solid fa-circle-check"></i> Numéro valide</span>';
    if (rcpInput) rcpInput.classList.add('rcp-valid');
    document.getElementById('prev-dest-label').textContent = clean;
    setStep('step-dest', 'complete');
    setStep('step-pay',  tf.paymentMethod ? 'complete' : 'active');
    tfRenderPaymentMethods();
  } else {
    statusEl.innerHTML = '';
    if (rcpInput) rcpInput.classList.remove('rcp-valid');
    document.getElementById('prev-dest-label').textContent = clean + '…';
    setStep('step-dest', 'active');
    setStep('step-pay', 'locked');
  }
  tfUpdateSummary(); tfUpdateValidateBtn();
}

async function tfPasteRecipient() {
  if (!navigator.clipboard?.readText) { Toast.error('Collage non disponible sur cet appareil.'); return; }
  try {
    const text = await navigator.clipboard.readText();
    if (!text.replace(/\D/g, '')) { Toast.error('Presse-papiers vide ou invalide.'); return; }
    tfUpdateRecipient(text);
  } catch {
    Toast.error('Impossible de lire le presse-papiers.');
  }
}

/* ── Étape 4 : Paiement ────────────────────────────────────────── */
function tfRenderPaymentMethods() {
  const container = document.getElementById('payment-grid');
  if (!container || container.childElementCount > 0) return;
  container.innerHTML = PAYMENT_METHODS.map(pm => `
    <div class="pm-row" id="pm-${pm.id}" onclick="tfSelectPayment('${pm.id}',this)"
         style="--pm-clr:${pm.color};--pm-glow:${pm.glow}">
      <div class="pm-row-check"><i class="fa-solid fa-check"></i></div>
      <div class="pm-row-logo">${pm.logo}</div>
      <div class="pm-row-name">${pm.l1}</div>
    </div>`).join('');
}

function tfSelectPayment(id, el) {
  tf.paymentMethod = id;
  tf.payPhone = '';
  const pm = PAYMENT_METHODS.find(p => p.id === id);
  document.querySelectorAll('.pm-row').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  document.getElementById('prev-pay-label').textContent = pm ? pm.nom : id;
  setStep('step-pay', 'active');

  // Couleur dynamique sur la carte
  const card = document.querySelector('.tf-pay-card');
  if (card && pm) {
    card.style.setProperty('--pm-clr', pm.color);
    card.style.setProperty('--pm-glow', pm.glow);
  }

  // Champ téléphone (masqué pour "Solde disponible" — pas de numéro requis,
  // voir tf.isValid()/tfShowRecap()/tfConfirmFromRecap() pour le court-circuit).
  const numWrap   = document.getElementById('tf-pay-num-wrap');
  const soldeWrap = document.getElementById('tf-pay-solde-wrap');
  const nextBtn   = document.getElementById('tf-pay-next-btn');

  if (id === 'solde') {
    tf.payPhone = '';
    if (numWrap)   numWrap.style.display   = 'none';
    if (soldeWrap) soldeWrap.style.display = 'flex';
    const destEl = document.getElementById('tf-pay-solde-dest');
    if (destEl) destEl.textContent = tf.recipient ? Fmt.phone(tf.recipient) : '—';
    if (nextBtn) nextBtn.style.display = 'flex';
  } else {
    if (numWrap)   numWrap.style.display   = 'flex';
    if (soldeWrap) soldeWrap.style.display = 'none';
    const methodLabel = document.getElementById('tf-pay-phone-method');
    if (methodLabel) methodLabel.textContent = pm ? 'Numéro ' + pm.nom : '';
    const phoneEl = document.getElementById('tf-pay-phone');
    if (phoneEl) {
      phoneEl.disabled = false;
      phoneEl.value = '';
      // Préfixe auto si le moyen de paiement choisi correspond à un réseau
      // mobile money (Orange/MTN/Moov) — voir NETWORK_PREFIX dans js/auth.js.
      const payNetwork = { orange: 'Orange', mtn: 'MTN', moov: 'Moov' }[id];
      if (payNetwork) applyNetworkPrefix('tf-pay-phone', payNetwork);
      setTimeout(() => phoneEl.focus(), 60);
    }
    if (nextBtn) nextBtn.style.display = 'none';
  }

  syncWizardBar();
  tfUpdateSummary(); tfUpdateValidateBtn();
}

function tfOnPayPhone(val) {
  const clean = val.replace(/\D/g, '').slice(0, 10);
  const payInput = document.getElementById('tf-pay-phone');
  if (payInput) payInput.value = Fmt.phone(clean);
  tf.payPhone = clean;
  const valid = /^0[0-9]{9}$/.test(tf.payPhone);
  const nextBtn = document.getElementById('tf-pay-next-btn');
  if (nextBtn) nextBtn.style.display = valid ? 'flex' : 'none';
  if (!valid) setStep('step-pay', 'active');
  else _saveTfState();
  _tfSyncSlideHeight();
  tfUpdateSummary(); tfUpdateValidateBtn();
}

/* Délai de 30s pour valider le paiement une fois le récap affiché — passé
   ce délai, la commande est annulée et le client doit reprendre le
   processus depuis le début (pas de reprise à mi-parcours). Scopé au
   wizard Transfert direct : c'est le seul flux qui correspond au sens de
   "commande" utilisé ailleurs dans l'app (les services avancés débitent
   directement, sans passer par une file d'attente cabine). */
const PaymentTimer = {
  _iv: null,
  start(seconds, displayId, onExpire) {
    this.stop();
    let s = seconds;
    const el = document.getElementById(displayId);
    const render = () => { if (el) el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    render();
    this._iv = setInterval(() => {
      s--;
      if (s <= 0) { this.stop(); onExpire(); return; }
      render();
    }, 1000);
  },
  stop() { if (this._iv) { clearInterval(this._iv); this._iv = null; } },
};

function tfPaymentTimeout() {
  PaymentTimer.stop();
  pendingOrder = false;
  closeModal('modal-auth-gate');
  tfInitView();
  Toast.error('Délai de 30s dépassé — veuillez recommencer votre commande.');
}

function tfShowRecap() {
  if (tf.paymentMethod !== 'solde' && !/^0[0-9]{9}$/.test(tf.payPhone)) return;
  if (!Auth.current()) { openPrivateSpaceNotice('Connectez-vous pour effectuer un transfert.'); return; }
  tfBuildInlineRecap();
  document.getElementById('tf-panel-select').style.display = 'none';
  document.getElementById('tf-panel-recap').style.display  = 'flex';
  setStep('step-pay', 'complete');
  syncWizardBar();
  PaymentTimer.start(30, 'tf-recap-countdown', tfPaymentTimeout);
  _tfSyncSlideHeight();
}

function tfHideRecap() {
  PaymentTimer.stop();
  document.getElementById('tf-panel-recap').style.display  = 'none';
  document.getElementById('tf-panel-select').style.display = 'flex';
  setStep('step-pay', 'active');
  syncWizardBar();
  setTimeout(() => document.getElementById('tf-pay-phone')?.focus(), 60);
}

function tfBuildInlineRecap() {
  const pm = PAYMENT_METHODS.find(p => p.id === tf.paymentMethod);
  const emojis = { Orange:'🟠', MTN:'🟡', Moov:'🔵' };
  const rows = [
    ['Réseau',       (emojis[tf.operator] || '') + ' ' + tf.operator, false],
    ['Service',      tf.displayService, false],
    ['Destinataire', Fmt.phone(tf.recipient), false],
    ['Paiement',     (pm ? pm.nom : '—'), false],
    ...(tf.paymentMethod === 'solde' ? [] : [['N° paiement', Fmt.phone(tf.payPhone), false]]),
    ['Montant',      tf.displayAmount, false],
    ['Frais',        '15 FCFA', false],
    ['Total débité', Fmt.money(tf.amount + 15), true],
  ];
  const el = document.getElementById('tf-recap-rows');
  if (el) el.innerHTML = rows.map(([lbl, val, total]) =>
    `<div class="tf-recap-row${total ? ' tf-recap-row--total' : ''}">
      <span>${lbl}</span><strong>${val}</strong>
    </div>`
  ).join('');
}

async function tfConfirmFromRecap() {
  if (!tf.isValid()) return;
  if (!currentUser) {
    pendingOrder = true;
    const emojis = { Orange:'🟠', MTN:'🟡', Moov:'🔵' };
    document.getElementById('ag-order-detail').textContent =
      `${emojis[tf.operator]} ${tf.operator} · ${tf.displayAmount} → ${tf.recipient}`;
    document.getElementById('ag-pending-order').style.display = 'flex';
    switchAuthGateTab(_rememberedClient ? 'unlock' : 'login');
    openModal('modal-auth-gate');
    return;
  }
  const user = DB.users.byId(currentUser.id);
  if (user.solde < tf.amount + 15) {
    Toast.error(`Solde insuffisant. Disponible : ${Fmt.money(user.solde)}.`);
    openModal('modal-recharge');
    return;
  }
  const res = await DB.business.createTransfer({
    client_id:           currentUser.id,
    operateur:           tf.operator,
    numero_beneficiaire: tf.recipient,
    montant:             tf.amount,
    service:             tf.displayService,
    moyen_paiement:      tf.paymentMethod,
    numero_paiement:     tf.payPhone,
    details:             _tfForfaitDetails(),
  });
  if (res.ok) {
    PaymentTimer.stop();
    closeModal('modal-client-transfer');
    openOrderStatusModal(res.txn);
    tfInitView();
    _clientResume.transfer = null;
    _saveClientResume();
    loadHistory();
    loadWallet();
  } else {
    Toast.error(res.error);
  }
}

/* ── Résumé & checklist ────────────────────────────────────────── */
function tfUpdateSummary() {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  const pm = PAYMENT_METHODS.find(p => p.id === tf.paymentMethod);
  set('sum-op',      tf.operator ? tf.operator : '-');
  set('sum-svc',     tf.operator ? tf.displayService : '-');
  set('sum-montant', tf.amount   ? tf.displayAmount  : '-');
  set('sum-dest',    tf.recipient || '-');
  set('sum-pay',     pm ? pm.nom : '-');
  set('sum-total',   tf.amount   ? Fmt.money(tf.amount + 15) : '-');
  vcCheck('vc-op',   !!tf.operator);
  vcCheck('vc-svc',  tf.amount >= 500);
  vcCheck('vc-dest', /^0[0-9]{9}$/.test(tf.recipient));
  vcCheck('vc-pay',  !!tf.paymentMethod);
}
function vcCheck(id, ok) {
  const el = document.getElementById(id);
  if (!el) return;
  const text = el.textContent.replace(/^[^\s]+\s/, '');
  el.classList.toggle('done', ok);
  el.innerHTML = (ok ? '<i class="fa-solid fa-circle-check"></i> ' : '<i class="fa-regular fa-circle"></i> ') + text;
}

function tfUpdateValidateBtn() {
  const btn  = document.getElementById('btn-validate');
  const icon = document.getElementById('btn-lock-icon');
  if (!btn) return;
  const valid = tf.isValid();
  btn.disabled = !valid;
  if (icon) icon.className = valid ? 'fa-solid fa-paper-plane' : 'fa-solid fa-lock';
}

/* Injecte le numéro du destinataire dans le modèle USSD du forfait choisi.
   Le préfixe #161 n'est jamais modifié ici — la préférence #161/#154 du
   cabiniste s'applique à l'affichage, une fois la commande assignée (voir
   applyUssdPrefix() dans js/cabine.js), uniformément pour tous les codes
   Orange (Pass Mix comme Pass International partagent le même préfixe). */
function buildUssdCode(template, recipient) {
  return template.replace('{numero_destinataire}', recipient);
}

/* Détails USSD rattachés à la commande, selon le type de service :
   - Forfait Orange : le code final est calculé ici (numéro injecté), le
     préfixe #161/#154 restant appliqué à l'affichage (voir buildUssdCode()).
   - Transfert direct MTN/Moov : seuls le réseau et le numéro sont stockés
     ({numero_destinataire} n'est pas encore résolu) — le code exact dépend
     du modèle USSD courant et, pour Moov, de la préférence du cabiniste
     assigné (ni l'un ni l'autre connus à la commande) ; construit à
     l'affichage par getOrderUssdCode() dans js/cabine.js. Orange en
     "Transfert direct" n'a pas de code USSD (non demandé). */
function _tfForfaitDetails() {
  if (tf.serviceType === 'forfait' && tf.forfait && tf.forfait.ussdTemplate) {
    return {
      forfait_id  : tf.forfait.id,
      forfait_nom : tf.forfait.nom,
      ussd_code   : buildUssdCode(tf.forfait.ussdTemplate, tf.recipient),
      ussd_verified: tf.forfait.verified !== false,
    };
  }
  if (tf.serviceType === 'direct' && (tf.operator === 'MTN' || tf.operator === 'Moov')) {
    return { direct_ussd_network: tf.operator, direct_ussd_numero: tf.recipient };
  }
  return null;
}

/* ── Soumission ────────────────────────────────────────────────── */
function tfSubmit() {
  if (!tf.isValid()) return;

  if (!currentUser) {
    pendingOrder = true;
    const emojis = { Orange:'🟠', MTN:'🟡', Moov:'🔵' };
    document.getElementById('ag-order-detail').textContent =
      `${emojis[tf.operator]} ${tf.operator} · ${tf.displayAmount} → ${tf.recipient}`;
    document.getElementById('ag-pending-order').style.display = 'flex';
    switchAuthGateTab(_rememberedClient ? 'unlock' : 'login');
    openModal('modal-auth-gate');
    return;
  }

  tfSubmitConfirm();
}

function tfSubmitConfirm() {
  if (!tf.isValid() || !currentUser) return;
  if (!_checkOrderCooldown()) return;

  const user = DB.users.byId(currentUser.id);
  if (user.solde < tf.amount) {
    Toast.error(`Solde insuffisant. Disponible : ${Fmt.money(user.solde)}.`);
    openModal('modal-recharge');
    return;
  }

  const emojis = { Orange:'🟠', MTN:'🟡', Moov:'🔵' };
  const pm = PAYMENT_METHODS.find(p => p.id === tf.paymentMethod);
  document.getElementById('confirm-operator').textContent   = (emojis[tf.operator]||'') + ' ' + tf.operator;
  document.getElementById('confirm-montant').textContent    = tf.displayAmount;
  document.getElementById('confirm-numero').textContent     = tf.recipient;
  document.getElementById('confirm-commission').textContent = Fmt.money(DB.commissions.calc(tf.amount));
  document.getElementById('confirm-total').textContent      = Fmt.money(tf.amount + 15);
  document.getElementById('confirm-svc-row').innerHTML =
    `<span class="label">Service</span><span class="value">${tf.displayService}</span>`;
  document.getElementById('confirm-pay-row').innerHTML =
    `<span class="label">Paiement</span><span class="value">${pm ? pm.nom : '—'}</span>`;
  const fraisRow = document.getElementById('confirm-frais-row');
  if (fraisRow) fraisRow.innerHTML = `<span class="label">Frais de service</span><span class="value" style="color:rgba(255,255,255,.5)">15 FCFA</span>`;

  openModal('modal-confirm-transfer');

  document.getElementById('btn-confirm-send').onclick = async () => {
    const res = await DB.business.createTransfer({
      client_id:           currentUser.id,
      operateur:           tf.operator,
      numero_beneficiaire: tf.recipient,
      montant:             tf.amount,
      service:             tf.displayService,
      moyen_paiement:      tf.paymentMethod,
      numero_paiement:     tf.payPhone || '',
      details:             _tfForfaitDetails(),
    });
    closeModal('modal-confirm-transfer');
    if (res.ok) {
      _markOrderSubmitted();
      currentUser = Auth.refresh();
      // openOrderStatusModal() lit tf.displayService/tf.paymentMethod pour
      // son récap : doit s'exécuter avant tfInitView() (qui les efface),
      // pas après (voir aussi tfConfirmFromRecap() plus haut, même ordre).
      openOrderStatusModal(res.txn);
      tfInitView();
      _clientResume.transfer = null;
      _saveClientResume();
      refreshSoldeNumbers();
      loadHistory();
      loadWallet();
    } else {
      Toast.error(res.error);
    }
  };
}

/* ── Modal statut commande + polling temps réel ───────────────── */
let _orsTimer  = null;
let _orsTxnId  = null;
let _orsPoll   = null;

function stopOrsPoll() {
  if (_orsPoll) { clearInterval(_orsPoll); _orsPoll = null; }
}

function startOrsPoll() {
  stopOrsPoll();
  _orsPoll = setInterval(() => {
    if (!_orsTxnId) { stopOrsPoll(); return; }
    const t = DB.transactions.byId(_orsTxnId);
    if (!t) { stopOrsPoll(); return; }

    if (t.statut === 'terminé') {
      stopOrsPoll();
      clearInterval(_orsTimer);
      // Mettre à jour le modal
      const el = document.getElementById('ors-icon');
      if (el) { el.className = 'ors-header-icon ors-header-icon--ok'; el.innerHTML = '<i class="fa-solid fa-check"></i>'; }
      const ti = document.getElementById('ors-title');
      if (ti) ti.textContent = 'Commande validée';
      const su = document.getElementById('ors-sub');
      if (su) su.textContent = 'Votre commande a été validée avec succès — à bientôt pour une autre commande !';
      const cw = document.getElementById('ors-countdown-wrap');
      if (cw) cw.style.display = 'none';
      // Rafraîchir historique et solde
      loadHistory();
      loadWallet();
      currentUser = Auth.refresh();
      refreshSoldeNumbers();
      Toast.success('Votre commande a été validée avec succès — à bientôt pour une autre commande !');
      _clientResume.orderInProgress = null;
      _saveClientResume();
    } else if (t.statut === 'refusé') {
      stopOrsPoll();
      clearInterval(_orsTimer);
      const el = document.getElementById('ors-icon');
      if (el) { el.className = 'ors-header-icon ors-header-icon--ko'; el.innerHTML = '<i class="fa-solid fa-xmark"></i>'; }
      const ti = document.getElementById('ors-title');
      if (ti) ti.textContent = 'Commande non validée';
      const su = document.getElementById('ors-sub');
      if (su) su.textContent = 'Aucune cabine disponible — vous avez été remboursé';
      const cw = document.getElementById('ors-countdown-wrap');
      if (cw) cw.style.display = 'none';
      loadHistory();
      loadWallet();
      currentUser = Auth.refresh();
      refreshSoldeNumbers();
      Toast.error('Commande non validée. Votre solde a été remboursé.');
      _clientResume.orderInProgress = null;
      _saveClientResume();
    }
  }, 3000);
}

function openOrderStatusModal(txn) {
  _orsTxnId = txn.id;
  const pm  = PAYMENT_METHODS.find(p => p.id === tf.paymentMethod);
  const opColor = {Orange:'#FF6200',MTN:'#FFCC00',Moov:'#0066CC'}[txn.operateur] || '#7c3aed';

  document.getElementById('ors-recap').innerHTML = `
    <div class="ors-recap-rows">
      <div class="ors-recap-row">
        <span>Réseau</span>
        <strong style="color:${opColor}">${txn.operateur}</strong>
      </div>
      <div class="ors-recap-row">
        <span>Bénéficiaire</span>
        <strong>${Fmt.phone(txn.numero_beneficiaire)}</strong>
      </div>
      <div class="ors-recap-row">
        <span>Service</span>
        <strong>${tf.displayService || 'Transfert direct'}</strong>
      </div>
      <div class="ors-recap-row">
        <span>Paiement</span>
        <strong>${pm ? pm.nom : '—'}</strong>
      </div>
      <div class="ors-recap-row">
        <span>Frais de service</span>
        <strong style="color:rgba(255,255,255,.45)">${Fmt.money(txn.frais_service || 15)}</strong>
      </div>
      <div class="ors-recap-row ors-recap-row--total">
        <span>Total débité</span>
        <strong>${Fmt.money(txn.montant + (txn.frais_service || 15))}</strong>
      </div>
      <div class="ors-recap-row">
        <span>Référence</span>
        <strong>${Fmt.ref(txn.id)}</strong>
      </div>
    </div>
  `;

  document.getElementById('ors-countdown-wrap').style.display = '';
  document.getElementById('ors-icon').className = 'ors-header-icon';
  document.getElementById('ors-icon').innerHTML = '<i class="fa-solid fa-clock"></i>';
  document.getElementById('ors-title').textContent = 'Commande envoyée';
  document.getElementById('ors-sub').textContent = 'Patienter pendant le traitement';

  openModal('modal-order-status');
  startOrsCountdown(300);
  startOrsPoll();
  _clientResume.orderInProgress = { txnId: txn.id, startedAt: Date.now() };
  _saveClientResume();
}

function startOrsCountdown(seconds) {
  clearInterval(_orsTimer);
  const total = seconds;
  const fill  = document.getElementById('ors-track-fill');
  const icon  = document.getElementById('ors-track-icon');

  function tick(s) {
    const mins = String(Math.floor(s / 60)).padStart(1,'0');
    const secs = String(s % 60).padStart(2,'0');
    const numEl = document.getElementById('ors-countdown-num');
    if (numEl) numEl.textContent = mins + ':' + secs;
    const pct = Math.min(100, Math.max(0, ((total - s) / total) * 100));
    if (fill) fill.style.width = pct + '%';
    if (icon) icon.style.left  = pct + '%';
    if (s <= 0) {
      clearInterval(_orsTimer);
      document.getElementById('ors-countdown-wrap').style.display = 'none';
    }
  }

  tick(seconds);
  _orsTimer = setInterval(() => { seconds--; tick(seconds); }, 1000);
}

/* ── Widget flottant : minuteur de réclamation ────────────────────
   Affiché quand le client ferme le suivi d'une commande (bouton "Fermer"
   de #modal-order-status) : compte à rebours tant que la fenêtre de
   réclamation n'est pas ouverte (RECLA_MIN_DELAY_MS/reclamationWindowState,
   déjà utilisés ailleurs), puis message fermable une fois qu'elle l'est.
   Persisté via _clientResume pour survivre à un rechargement de page,
   même patron que orderInProgress ci-dessus. */
let _reclaFloatTxnId = null;
let _reclaFloatTimer = null;

function _reclaFloatContent(t) {
  if (!t || DB.reclamations.byTransaction(t.id)) return '';
  const win = reclamationWindowState(t);
  if (win.state === 'early') {
    return `<div class="recla-float-inner recla-float-inner--wait">
      <i class="fa-solid fa-hourglass-half"></i>
      <span>Réclamation possible dans <strong>${formatMmSs(win.remainingMs)}</strong></span>
      <button class="recla-float-close" onclick="dismissReclaFloatWidget()"><i class="fa-solid fa-xmark"></i></button>
    </div>`;
  }
  if (win.state === 'eligible') {
    return `<div class="recla-float-inner recla-float-inner--ready">
      <i class="fa-solid fa-circle-check"></i>
      <span>Vous pouvez désormais faire une réclamation sur cette commande.</span>
      <button class="recla-float-close" onclick="dismissReclaFloatWidget()"><i class="fa-solid fa-xmark"></i></button>
    </div>`;
  }
  return '';
}

function renderReclaFloatWidget() {
  const el = document.getElementById('recla-float-widget');
  if (!el) return;
  const t = _reclaFloatTxnId ? DB.transactions.byId(_reclaFloatTxnId) : null;
  const html = _reclaFloatContent(t);
  if (!html) {
    _reclaFloatTxnId = null;
    _clientResume.reclaFloat = null;
    _saveClientResume();
    el.style.display = 'none';
    el.innerHTML = '';
    if (_reclaFloatTimer) { clearInterval(_reclaFloatTimer); _reclaFloatTimer = null; }
    return;
  }
  el.style.display = 'block';
  el.innerHTML = html;
}

function showReclaFloatWidget(txnId) {
  if (!txnId) return;
  _reclaFloatTxnId = txnId;
  _clientResume.reclaFloat = { txnId };
  _saveClientResume();
  renderReclaFloatWidget();
  _startReclaFloatTick();
  _initReclaFloatDrag();
}

function dismissReclaFloatWidget() {
  _reclaFloatTxnId = null;
  _clientResume.reclaFloat = null;
  _saveClientResume();
  const el = document.getElementById('recla-float-widget');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  if (_reclaFloatTimer) { clearInterval(_reclaFloatTimer); _reclaFloatTimer = null; }
}

function _startReclaFloatTick() {
  if (_reclaFloatTimer) return;
  _reclaFloatTimer = setInterval(renderReclaFloatWidget, 1000);
}

// Le client peut déplacer librement le widget (souris ou tactile) — utile
// s'il masque un bouton précis de l'écran en dessous. Position libre
// pendant la session, pas besoin de persister au-delà.
function _initReclaFloatDrag() {
  const el = document.getElementById('recla-float-widget');
  if (!el || el.dataset.draggable) return;
  el.dataset.draggable = '1';

  let dragging = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;

  function down(x, y, target) {
    if (target.closest && target.closest('.recla-float-close')) return;
    const rect = el.getBoundingClientRect();
    origLeft = rect.left; origTop = rect.top;
    startX = x; startY = y;
    dragging = true;
    el.classList.add('dragging');
  }
  function move(x, y) {
    if (!dragging) return;
    el.style.left   = (origLeft + (x - startX)) + 'px';
    el.style.top    = (origTop  + (y - startY)) + 'px';
    el.style.bottom = 'auto';
    el.style.transform = 'none';
  }
  function up() {
    dragging = false;
    el.classList.remove('dragging');
  }

  el.addEventListener('mousedown', e => down(e.clientX, e.clientY, e.target));
  document.addEventListener('mousemove', e => move(e.clientX, e.clientY));
  document.addEventListener('mouseup', up);

  el.addEventListener('touchstart', e => { const t = e.touches[0]; down(t.clientX, t.clientY, e.target); }, { passive: true });
  document.addEventListener('touchmove', e => { if (!dragging) return; const t = e.touches[0]; move(t.clientX, t.clientY); }, { passive: true });
  document.addEventListener('touchend', up);
}

/* ── Suivi de commande (services facture) ─────────────────────────
   Frise dérivée directement des champs déjà présents sur la transaction
   (date/date_assignation/preuve_paiement/date_fin) — aucun fil de
   messages séparé à persister. Le compte à rebours de 5 min réutilise
   RECLA_MIN_DELAY_MS/reclamationWindowState() déjà définis pour le hub
   de réclamation ci-dessous ; passé ce délai, le bouton "Faire une
   réclamation" bascule directement dans ce hub existant. ── */
let _otkTimer  = null;
let _otkPoll   = null;
let _otkTxnId  = null;

function stopOtkPoll() {
  if (_otkPoll)  { clearInterval(_otkPoll);  _otkPoll  = null; }
  if (_otkTimer) { clearInterval(_otkTimer); _otkTimer = null; }
}

function openOrderTracking(txnId, sourceModalId) {
  const txn = DB.transactions.byId(txnId);
  if (!txn) return;
  closeModal(sourceModalId || 'modal-facture');
  showSection('historique');
  _otkTxnId = txnId;
  renderOrderTracking(txn);
  openModal('modal-order-tracking');
  startOtkPoll();
}

function renderOrderTracking(txn) {
  const sub = document.getElementById('otk-sub');
  if (sub) {
    sub.textContent = txn.statut === 'terminé' ? 'Commande terminée'
      : txn.statut === 'refusé'  ? 'Commande non validée — remboursée'
      : 'Évolution en temps réel';
  }

  document.getElementById('otk-recap').innerHTML = `
    <div class="ors-recap-rows">
      <div class="ors-recap-row"><span>Service</span><strong>${txn.service || '—'}</strong></div>
      <div class="ors-recap-row"><span>Référence</span><strong>${Fmt.ref(txn.id)}</strong></div>
      <div class="ors-recap-row ors-recap-row--total"><span>Total débité</span><strong>${Fmt.money(txn.montant + (txn.frais_service || 0))}</strong></div>
    </div>`;

  const hm = (d) => d ? new Date(d).toLocaleTimeString('fr-CI', { hour: '2-digit', minute: '2-digit' }) : '';
  const steps = [];
  steps.push({ on: true, label: 'Commande envoyée', time: hm(txn.date) });
  steps.push({ on: !!txn.date_assignation, label: 'Assignée à un cabiniste', time: hm(txn.date_assignation) });
  steps.push({
    on: !!txn.preuve_paiement, label: 'Preuve de paiement reçue', time: '',
    image: txn.preuve_paiement || null,
  });
  if (txn.statut === 'refusé') {
    steps.push({ on: true, label: 'Commande non validée — remboursée', time: hm(txn.date_fin) });
  } else {
    steps.push({ on: txn.statut === 'terminé', label: 'Commande terminée', time: hm(txn.date_fin) });
  }

  document.getElementById('otk-timeline').innerHTML = steps.map((s, i) => `
    <div class="otk-tl-row">
      <div class="otk-tl-rail">
        <span class="otk-tl-node ${s.on ? 'otk-tl-node--on' : ''}"><i class="fa-solid ${s.on ? 'fa-check' : 'fa-circle'}"></i></span>
        ${i < steps.length - 1 ? `<span class="otk-tl-line ${s.on ? 'otk-tl-line--on' : ''}"></span>` : ''}
      </div>
      <div class="otk-tl-body">
        <div class="otk-tl-toprow">
          <span class="otk-tl-lbl ${s.on ? '' : 'otk-tl-lbl--pending'}">${s.label}</span>
          ${s.time ? `<span class="otk-tl-time">${s.time}</span>` : ''}
        </div>
        ${s.image ? `<img src="${s.image}" class="otk-tl-proof" alt="Preuve de paiement">` : ''}
      </div>
    </div>`).join('');

  const already = DB.reclamations.byTransaction(txn.id);
  const win = reclamationWindowState(txn);
  const countdownWrap = document.getElementById('otk-countdown-wrap');
  const reclaBtn       = document.getElementById('otk-recla-btn');
  const canReclaim = !already && txn.statut !== 'terminé' && win.state !== 'expired';

  if (win.state === 'early' && txn.statut === 'en_attente') {
    if (countdownWrap) countdownWrap.style.display = 'flex';
    if (reclaBtn) reclaBtn.style.display = 'none';
  } else {
    if (countdownWrap) countdownWrap.style.display = 'none';
    if (reclaBtn) reclaBtn.style.display = canReclaim ? 'flex' : 'none';
  }
}

function startOtkPoll() {
  stopOtkPoll();
  _otkTimer = setInterval(() => {
    const txn = DB.transactions.byId(_otkTxnId);
    if (!txn) return;
    const numEl = document.getElementById('otk-countdown-num');
    if (numEl) {
      const win = reclamationWindowState(txn);
      numEl.textContent = win.state === 'early' ? formatMmSs(win.remainingMs) : '0:00';
    }
    if (reclamationWindowState(txn).state !== 'early') renderOrderTracking(txn);
  }, 1000);
  _otkPoll = setInterval(() => {
    const txn = DB.transactions.byId(_otkTxnId);
    if (!txn) { stopOtkPoll(); return; }
    renderOrderTracking(txn);
    if (txn.statut === 'terminé' || txn.statut === 'refusé') stopOtkPoll();
  }, 3000);
}

// Au-delà de 3 tentatives consécutives sur une même commande tant que la
// preuve de paiement n'est pas fournie, redirige vers l'assistance
// WhatsApp plutôt que de laisser le client rouvrir indéfiniment le hub de
// réclamation. Compteur en mémoire (comme le reste de l'état du hub de
// réclamation, _rclHubTab etc.) — pas de persistance nécessaire.
const _otkReclaAttempts = {};

async function otkTriggerReclamation() {
  const txnId = _otkTxnId;
  const txn = DB.transactions.byId(txnId);

  if (txn && !txn.preuve_paiement) {
    _otkReclaAttempts[txnId] = (_otkReclaAttempts[txnId] || 0) + 1;
    if (_otkReclaAttempts[txnId] >= 3) {
      stopOtkPoll();
      closeModal('modal-order-tracking');
      const link = await assistanceWhatsappLink('Bonjour, je n\'arrive pas à obtenir le reçu de ma commande facture après plusieurs tentatives.');
      if (!link) { Toast.error('Aucun numéro d\'assistance WhatsApp n\'est configuré pour le moment.'); return; }
      Toast.warning('Redirection vers l\'assistance WhatsApp après plusieurs tentatives…');
      window.open(link, '_blank');
      return;
    }
  }

  stopOtkPoll();
  closeModal('modal-order-tracking');
  openReclamationHub();
  if (txn) rclHubSelectOrder(txn.id);
}

function toggleWhySection() {
  const section = document.getElementById('ph5-sector2');
  const icon    = document.getElementById('ph5-why-icon');
  const btn     = document.getElementById('ph5-why-btn');
  if (!section) return;
  const isOpen = section.style.display !== 'none';
  section.style.display = isOpen ? 'none' : 'block';
  icon?.classList.toggle('open', !isOpen);
  btn?.classList.toggle('open', !isOpen);
  if (!isOpen) section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Rôle attendu du compte à réinitialiser (le formulaire est partagé par
// les 3 modales de connexion, voir client.html) — détermine le compte
// visé en cas de numéro partagé entre plusieurs rôles (feature 5,
// unicité par rôle). Le code de réinitialisation est un PIN à 4 chiffres
// pour les 3 espaces (client, cabine, admin) — voir submitResetRequest().
let _resetModalRole = 'client';

function openResetModal(context) {
  _resetModalRole = context || 'client';
  // Cabine/admin : compte identifié par l'adresse Gmail (même identifiant
  // que la connexion) ; client : inchangé, identifié par téléphone.
  const isEmailRole = _resetModalRole === 'cabine' || _resetModalRole === 'admin';
  document.getElementById('rst-tel-field').style.display   = isEmailRole ? 'none' : 'block';
  document.getElementById('rst-email-field').style.display = isEmailRole ? 'block' : 'none';
  document.getElementById('rst-tel').value = '';
  document.getElementById('rst-email').value = '';
  clearPinRow('pin-reset-new-row');
  clearPinRow('pin-reset-confirm-row');

  document.getElementById('rst-sent').style.display = 'none';
  document.getElementById('rst-form').style.display = 'block';
  openModal('modal-reset-pwd');
  setTimeout(() => document.getElementById(isEmailRole ? 'rst-email' : 'rst-tel')?.focus(), 100);
}

async function submitResetRequest() {
  const isEmailRole = _resetModalRole === 'cabine' || _resetModalRole === 'admin';
  let identifiant;
  if (isEmailRole) {
    identifiant = (document.getElementById('rst-email').value || '').trim();
    if (!Auth.isValidGmail(identifiant)) { Toast.error('Adresse Gmail invalide (ex : nom@gmail.com).'); return; }
  } else {
    identifiant = document.getElementById('rst-tel').value.replace(/\s/g, '');
    if (!/^[0-9]{10}$/.test(identifiant)) { Toast.error('Numéro WhatsApp invalide — 10 chiffres requis.'); return; }
  }

  // Code obligatoirement un PIN de 4 chiffres, chiffres uniquement — le
  // test regex protège aussi contre un caractère non numérique qui
  // aurait pu passer outre l'attribut HTML pattern (ex. collage), en
  // plus de la simple vérification de longueur.
  const pin     = getPinValue('pin-reset-new-row');
  const pinConf = getPinValue('pin-reset-confirm-row');
  if (!Auth.isValidPin(pin))     { Toast.error('Le nouveau code doit contenir exactement 4 chiffres.'); return; }
  if (!Auth.isValidPin(pinConf)) { Toast.error('Confirmez votre nouveau code à 4 chiffres.'); return; }
  if (pin !== pinConf)          { Toast.error('Les codes ne correspondent pas.'); return; }

  // La recherche du compte, l'exclusion du super admin et le contrôle
  // "une seule demande en attente à la fois" sont désormais entièrement
  // revérifiés côté serveur (api/reset_requests_create.php), jamais
  // depuis le cache local (potentiellement incomplet sur cet appareil).
  submitResetRequestBtnLoading(true);
  const res = await DB.resetRequests.create(_resetModalRole, identifiant, pin);
  submitResetRequestBtnLoading(false);
  if (!res.ok) { Toast.error(res.error); return; }

  document.getElementById('rst-form').style.display = 'none';
  document.getElementById('rst-sent').style.display = 'flex';
}

// Filet de sécurité minimal : évite un double envoi si le bouton est
// cliqué plusieurs fois pendant l'appel réseau (aucun spinner dédié
// n'existait dans la version 100% locale, ce bouton pouvait déjà être
// recliqué à volonté puisque rien n'attendait un serveur).
function submitResetRequestBtnLoading(loading) {
  const btn = document.querySelector('#rst-form button[onclick="submitResetRequest()"]');
  if (btn) btn.disabled = loading;
}

function openPartnerAuthModal() {
  openAuthModal('login');
}

/* ── Rappel "Espace privé" (Facture, Recharge UV, Exchange, Cadeau) :
   au lieu de renvoyer directement au formulaire de connexion, on
   affiche d'abord ce popup explicatif. */
function openPrivateSpaceNotice(message) {
  const msgEl = document.getElementById('priv-space-msg');
  if (msgEl) msgEl.textContent = message || 'Connectez-vous pour accéder à cette fonctionnalité.';
  openModal('modal-private-space');
}

/* Onglet "Partenaires" de la barre du bas : page de recrutement/
   candidature, accessible sans connexion (les futurs partenaires ne
   sont pas encore clients). */
function goPartenairesSection() {
  showSection('partenaires');
}

/* ── Inscription partenaire multi-étapes ───────────────────────── */
let prgStep = 1;
const PRG_TOTAL = 3;
const PRG_LABELS = [
  'Étape 1 sur 3 — Informations personnelles',
  'Étape 2 sur 3 — Documents d\'identité',
  'Étape 3 sur 3 — Profil & Abonnement'
];

function openPartnerRegister() {
  // Reprend l'étape et les champs texte (hors fichiers/abonnement/paiement/
  // PIN, non restaurables ou volontairement exclus — voir _savePrgState())
  // si un brouillon existe depuis un précédent chargement de page.
  const draft = _clientResume.partnerRegister;
  prgStep = (draft && draft.step) || 1;
  ['prg-prenom','prg-nom','prg-email','prg-tel','prg-wa','prg-exp','prg-numero-compte'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = (draft && draft.fields[id]) || '';
  });
  ['prg-puce-orange','prg-puce-mtn','prg-puce-moov'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = (draft && draft.fields[id]) || '0';
  });
  document.querySelectorAll('.prg-abo2').forEach(c => c.classList.remove('prg-abo2--sel'));
  document.querySelectorAll('.prg-pay-card').forEach(c => c.classList.remove('prg-pay-card--sel'));
  ['prg-pin-row','prg-pin-confirm-row'].forEach(rowId => {
    document.querySelectorAll(`#${rowId} .adm-pin-box`).forEach(b => { b.value = ''; b.classList.remove('adm-pin-filled'); });
  });
  prgInitPinRow('prg-pin-row');
  prgInitPinRow('prg-pin-confirm-row');
  const motiv = document.getElementById('prg-motivation');
  if (motiv) motiv.value = '';
  ['prg-fn-recto','prg-fn-verso','prg-fn-photo','prg-fn-qr'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = 'Aucun fichier sélectionné';
  });
  ['prg-file-recto','prg-file-verso','prg-file-photo','prg-file-qr'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  ['prg-up-recto','prg-up-verso','prg-up-photo','prg-up-qr'].forEach(id => {
    document.getElementById(id)?.classList.remove('prg-upload--done');
  });
  const qrWrap = document.getElementById('prg-qr-wrap');
  if (qrWrap) qrWrap.style.display = 'none';
  const wa = document.getElementById('prg-wa-same');
  if (wa) wa.checked = false;
  document.getElementById('prg-confirm').style.display = 'none';
  document.getElementById('prg-footer').style.display = 'flex';
  prgShowStep(prgStep);
  openModal('modal-partner-register');
}

function _savePrgState() {
  const fieldIds = ['prg-prenom','prg-nom','prg-email','prg-tel','prg-wa','prg-exp','prg-numero-compte','prg-puce-orange','prg-puce-mtn','prg-puce-moov'];
  const fields = {};
  fieldIds.forEach(id => { const el = document.getElementById(id); if (el) fields[id] = el.value; });
  _clientResume.partnerRegister = { step: prgStep, fields };
  _saveClientResume();
}

function prgShowStep(n) {
  for (let i = 1; i <= PRG_TOTAL; i++) {
    document.getElementById(`prg-step-${i}`).style.display = i === n ? 'block' : 'none';
    const dot = document.getElementById(`prg-dot-${i}`);
    if (dot) {
      dot.classList.toggle('prg-stp--active', i === n);
      dot.classList.toggle('prg-stp--done', i < n);
    }
    const line = document.getElementById(`prg-line-${i}`);
    if (line) line.classList.toggle('prg-stp-line--done', i < n);
  }
  document.getElementById('prg-prev-btn').style.display = n === 1 ? 'none' : 'flex';
  const next = document.getElementById('prg-next-btn');
  next.innerHTML = n === PRG_TOTAL
    ? '<i class="fa-solid fa-paper-plane"></i> Soumettre la demande'
    : 'Continuer <i class="fa-solid fa-arrow-right"></i>';
  _savePrgState();
}

function prgNext() {
  if (!prgValidate(prgStep)) return;
  if (prgStep < PRG_TOTAL) {
    prgStep++;
    prgShowStep(prgStep);
  } else {
    prgSubmit();
  }
}

function prgPrev() {
  if (prgStep > 1) { prgStep--; prgShowStep(prgStep); }
}

function prgValidate(step) {
  if (step === 1) {
    const prenom = document.getElementById('prg-prenom').value.trim();
    const nom    = document.getElementById('prg-nom').value.trim();
    const email  = document.getElementById('prg-email').value.trim();
    const tel    = document.getElementById('prg-tel').value.replace(/\s/g,'');
    const wa     = document.getElementById('prg-wa').value.replace(/\s/g,'');
    const cabineNom = document.getElementById('prg-cabine-nom')?.value.trim() || '';
    if (!cabineNom) { Toast.error('Veuillez donner un nom à votre cabine.'); return false; }
    if (!prenom || !nom) { Toast.error('Veuillez saisir votre prénom et nom.'); return false; }
    if (!/^[^\s@]+@gmail\.com$/i.test(email)) { Toast.error('Adresse Gmail invalide (ex : nom@gmail.com).'); return false; }
    if (!/^[0-9]{10}$/.test(tel)) { Toast.error('Numéro de téléphone invalide — 10 chiffres requis.'); return false; }
    if (!/^[0-9]{10}$/.test(wa))  { Toast.error('Numéro WhatsApp invalide — 10 chiffres requis.'); return false; }
    const pin1 = [...document.querySelectorAll('#prg-pin-row .adm-pin-box')].map(b => b.value).join('');
    const pin2 = [...document.querySelectorAll('#prg-pin-confirm-row .adm-pin-box')].map(b => b.value).join('');
    if (pin1.length !== 4) { Toast.error('Veuillez définir un code PIN à 4 chiffres.'); return false; }
    if (pin1 !== pin2)     { Toast.error('Les codes PIN ne correspondent pas.'); return false; }
  }
  if (step === 2) {
    if (!document.getElementById('prg-file-recto').files[0]) { Toast.error('Veuillez importer la pièce d\'identité (recto).'); return false; }
    if (!document.getElementById('prg-file-verso').files[0]) { Toast.error('Veuillez importer la pièce d\'identité (verso).'); return false; }
    if (!document.getElementById('prg-file-photo').files[0]) { Toast.error('Veuillez importer votre photo d\'identité.'); return false; }
  }
  if (step === 3) {
    const motivation = document.getElementById('prg-motivation').value.trim();
    if (!motivation || motivation.length < 20) { Toast.error('Veuillez expliquer votre motivation (20 caractères minimum).'); return false; }
    if (!document.querySelector('.prg-abo2--sel')) { Toast.error('Veuillez sélectionner un type d\'abonnement.'); return false; }
    if (!document.getElementById('prg-exp').value) { Toast.error('Veuillez indiquer vos années d\'expérience.'); return false; }
    const total = ['prg-puce-orange','prg-puce-mtn','prg-puce-moov']
      .reduce((s, id) => s + (parseInt(document.getElementById(id).value) || 0), 0);
    if (total === 0) { Toast.error('Veuillez indiquer au moins une puce téléphonique.'); return false; }
    if (!document.querySelector('#prg-pay-abo .prg-pay-card--sel'))  { Toast.error('Veuillez choisir un moyen de paiement pour l\'abonnement.'); return false; }
    if (!document.querySelector('#prg-pay-vers .prg-pay-card--sel')) { Toast.error('Veuillez choisir un moyen de réception des versements.'); return false; }
    const versSel = document.querySelector('#prg-pay-vers .prg-pay-card--sel');
    if (!document.getElementById('prg-numero-compte').value.trim()) { Toast.error('Veuillez indiquer le numero de compte de reception.'); return false; }
    if (versSel && (versSel.dataset.pay === 'Wave Business' || versSel.dataset.pay === 'Wave Normal') && !document.getElementById('prg-file-qr').files[0]) {
      Toast.error('Veuillez importer le code QR de reception Wave.'); return false;
    }
  }
  return true;
}

function prgReadFileAsDataUrl(file) {
  return new Promise((resolve) => {
    if (!file) { resolve(''); return; }
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}

function prgSubmit() {
  const btn = document.getElementById('prg-next-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Envoi…';

  const photoFile = document.getElementById('prg-file-photo').files[0];
  const qrFile    = document.getElementById('prg-file-qr')?.files[0];

  Promise.all([prgReadFileAsDataUrl(photoFile), prgReadFileAsDataUrl(qrFile)]).then(async ([photoDataUrl, qrDataUrl]) => {
    const res = await DB.partnerApplications.create({
      prenom     : document.getElementById('prg-prenom').value.trim(),
      nom        : document.getElementById('prg-nom').value.trim(),
      email      : document.getElementById('prg-email').value.trim().toLowerCase(),
      telephone  : document.getElementById('prg-tel').value.replace(/\s/g,''),
      whatsapp   : document.getElementById('prg-wa').value.replace(/\s/g,''),
      cabine_nom : document.getElementById('prg-cabine-nom')?.value.trim() || '',
      // Photo d'identité et code QR — images réelles (data URL), utilisées
      // notamment pour l'affichage dans l'espace cabine une fois le compte créé.
      photo       : photoDataUrl,
      code_qr     : qrDataUrl,
      pin         : [...document.querySelectorAll('#prg-pin-row .adm-pin-box')].map(b => b.value).join(''),
      motivation  : document.getElementById('prg-motivation').value.trim(),
      abonnement  : document.querySelector('.prg-abo2--sel')?.dataset.abo || '',
      paiement_abo   : document.querySelector('#prg-pay-abo .prg-pay-card--sel')?.dataset.pay || '',
      paiement_vers  : document.querySelector('#prg-pay-vers .prg-pay-card--sel')?.dataset.pay || '',
      numero_compte  : document.getElementById('prg-numero-compte').value.trim(),
      experience  : document.getElementById('prg-exp').value,
      puces: {
        orange: parseInt(document.getElementById('prg-puce-orange').value) || 0,
        mtn   : parseInt(document.getElementById('prg-puce-mtn').value)    || 0,
        moov  : parseInt(document.getElementById('prg-puce-moov').value)   || 0,
      }
    });

    btn.disabled = false;
    if (!res.ok) {
      btn.innerHTML = 'Envoyer ma candidature';
      Toast.error(res.error);
      return;
    }
    for (let i = 1; i <= PRG_TOTAL; i++) document.getElementById(`prg-step-${i}`).style.display = 'none';
    document.getElementById('prg-footer').style.display = 'none';
    document.getElementById('prg-confirm').style.display = 'block';
    _clientResume.partnerRegister = null;
    _saveClientResume();
  });
}

function prgWaSame(cb) {
  const wa = document.getElementById('prg-wa');
  if (cb.checked) wa.value = document.getElementById('prg-tel').value; // already formatted
  else wa.value = '';
}

function prgFileChange(input, zoneId, fnId) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { Toast.warning('Fichier trop volumineux (max 2 Mo).'); input.value = ''; return; }
  document.getElementById(fnId).textContent = file.name;
  document.getElementById(zoneId).classList.add('prg-upload--done');
}

function prgSelectAbo(card) {
  document.querySelectorAll('.prg-abo2').forEach(c => c.classList.remove('prg-abo2--sel'));
  card.classList.add('prg-abo2--sel');
}

function openPartnerLoginModal() {
  // Reset tout
  document.getElementById('prt-tel').value = '';
  document.getElementById('prt-denied').style.display = 'none';
  document.querySelectorAll('#prt-pin-row .pln-pin-box').forEach(b => { b.value = ''; });
  // Revenir à l'étape 1 sans animation
  const s1 = document.getElementById('prt-slide-1');
  const s2 = document.getElementById('prt-slide-2');
  s1.classList.remove('pln-slide--hidden','pln-slide--exit','pln-slide--enter');
  s2.style.display = 'none'; s2.classList.remove('pln-slide--enter','pln-slide--exit');
  document.getElementById('prt-back-btn').style.display = 'none';
  document.getElementById('prt-dot-1').classList.add('pln-step--active');
  document.getElementById('prt-dot-1').classList.remove('pln-step--done');
  document.getElementById('prt-dot-2').classList.remove('pln-step--active');
  openModal('modal-partner-login');
  // Init PIN nav
  const boxes = document.querySelectorAll('#prt-pin-row .pln-pin-box');
  boxes.forEach((box, idx) => {
    box.oninput = () => {
      box.value = box.value.replace(/\D/g, '').slice(0, 1);
      if (box.value && idx < boxes.length - 1) {
        boxes[idx + 1].focus();
      } else if (box.value && idx === boxes.length - 1) {
        // Dernière case remplie → connexion automatique
        setTimeout(submitPartnerLogin, 120);
      }
    };
    box.onkeydown = e => {
      if (e.key === 'Backspace' && !box.value && idx > 0) boxes[idx - 1].focus();
    };
  });
  setTimeout(() => document.getElementById('prt-tel')?.focus(), 120);
}

function prtGoStep(step) {
  const s1 = document.getElementById('prt-slide-1');
  const s2 = document.getElementById('prt-slide-2');
  const backBtn = document.getElementById('prt-back-btn');
  const dot1 = document.getElementById('prt-dot-1');
  const dot2 = document.getElementById('prt-dot-2');

  if (step === 2) {
    // Valider l'adresse Gmail
    const email = (document.getElementById('prt-tel').value || '').trim();
    if (!Auth.isValidGmail(email)) { Toast.error('Adresse Gmail invalide (ex : nom@gmail.com).'); return; }
    const user = DB.users.byEmail(email);
    if (!user) { Toast.error('Aucun compte partenaire trouvé pour cette adresse.'); return; }

    // Remplir la carte utilisateur
    const initials = ((user.prenom || '')[0] || '') + ((user.nom || '')[0] || '') || email.slice(0, 2);
    document.getElementById('prt-user-ava').textContent  = initials.toUpperCase();
    document.getElementById('prt-user-name').textContent = `${user.prenom || ''} ${user.nom || ''}`.trim() || 'Partenaire';
    document.getElementById('prt-user-tel').textContent  = Fmt.phone(user.telephone);
    document.getElementById('prt-denied').style.display  = 'none';

    // Transition slide 1 → 2
    s1.classList.add('pln-slide--exit');
    setTimeout(() => {
      s1.classList.add('pln-slide--hidden'); s1.classList.remove('pln-slide--exit');
      s2.style.display = 'block'; s2.classList.remove('pln-slide--enter');
      requestAnimationFrame(() => { requestAnimationFrame(() => { s2.classList.add('pln-slide--enter'); }); });
    }, 260);

    dot1.classList.remove('pln-step--active'); dot1.classList.add('pln-step--done');
    dot2.classList.add('pln-step--active');
    backBtn.style.display = 'flex';
    setTimeout(() => document.querySelector('#prt-pin-row .pln-pin-box')?.focus(), 420);

  } else {
    // Retour étape 1
    s2.classList.remove('pln-slide--enter'); s2.classList.add('pln-slide--exit');
    setTimeout(() => {
      s2.style.display = 'none'; s2.classList.remove('pln-slide--exit');
      s1.classList.remove('pln-slide--hidden','pln-slide--exit');
      requestAnimationFrame(() => { requestAnimationFrame(() => { s1.classList.add('pln-slide--enter'); }); });
    }, 260);

    dot2.classList.remove('pln-step--active');
    dot1.classList.remove('pln-step--done'); dot1.classList.add('pln-step--active');
    backBtn.style.display = 'none';
    setTimeout(() => document.getElementById('prt-tel')?.focus(), 420);
  }
}

function prgInitPinRow(rowId) {
  const boxes = document.querySelectorAll(`#${rowId} .adm-pin-box`);
  boxes.forEach((box, idx) => {
    box.oninput = () => {
      box.value = box.value.replace(/\D/g,'').slice(0,1);
      box.classList.toggle('adm-pin-filled', !!box.value);
      if (box.value && idx < boxes.length - 1) boxes[idx + 1].focus();
    };
    box.onkeydown = e => { if (e.key === 'Backspace' && !box.value && idx > 0) boxes[idx - 1].focus(); };
  });
}

function prgSelectPay(groupId, card) {
  document.querySelectorAll(`#${groupId} .prg-pay-card`).forEach(c => c.classList.remove('prg-pay-card--sel'));
  card.classList.add('prg-pay-card--sel');

  // Réception des versements en Wave (Business/Normal) : preuve du code QR requise.
  if (groupId === 'prg-pay-vers') {
    const isWave = card.dataset.pay === 'Wave Business' || card.dataset.pay === 'Wave Normal';
    const qrWrap = document.getElementById('prg-qr-wrap');
    if (qrWrap) qrWrap.style.display = isWave ? 'block' : 'none';
  }
}

async function submitPartnerLogin() {
  const email    = (document.getElementById('prt-tel')?.value || '').trim();
  const pin      = [...document.querySelectorAll('#prt-pin-row .pln-pin-box')].map(b => b.value).join('');
  const remember = !!document.getElementById('prt-remember')?.checked;
  const denied   = document.getElementById('prt-denied');
  denied.style.display = 'none';

  if (!Auth.isValidGmail(email)) { Toast.error('Adresse Gmail invalide (ex : nom@gmail.com).'); return; }
  if (!Auth.isValidPin(pin))     { Toast.error('Saisissez votre code PIN à 4 chiffres.'); return; }

  const res = await Auth.login(email, pin, remember, 'cabine');

  if (!res.ok) { Toast.error(res.error); return; }

  if (res.user.role !== 'cabine') {
    sessionStorage.removeItem('cbp_session');
    denied.style.display = 'flex';
    document.querySelectorAll('#prt-pin-row .pln-pin-box').forEach(b => { b.value = ''; });
    return;
  }

  if (res.rememberToken) localStorage.setItem(Auth.REMEMBER_TOKEN_KEY, res.rememberToken);

  window.location.href = 'cabine.html';
}

function openAdminAuthModal() {
  document.getElementById('adm-tel').value = '';
  document.getElementById('adm-denied').style.display = 'none';
  document.querySelectorAll('#adm-pin-row .adx-pin-box').forEach(b => { b.value = ''; });
  // Reset étape 1
  const s1 = document.getElementById('adx-slide-1');
  const s2 = document.getElementById('adx-slide-2');
  s1.classList.remove('adx-slide--hidden','adx-slide--exit','adx-slide--enter');
  s2.style.display = 'none'; s2.classList.remove('adx-slide--enter','adx-slide--exit');
  document.getElementById('adx-dot-1').className = 'adx-step adx-step--active';
  document.getElementById('adx-dot-2').className = 'adx-step';
  openModal('modal-admin-auth');
  // Init PIN nav
  const boxes = document.querySelectorAll('#adm-pin-row .adx-pin-box');
  boxes.forEach((box, idx) => {
    box.oninput = () => {
      box.value = box.value.replace(/\D/g, '').slice(0, 1);
      if (box.value && idx < boxes.length - 1) boxes[idx + 1].focus();
      else if (box.value && idx === boxes.length - 1) setTimeout(submitAdminLogin, 120);
    };
    box.onkeydown = e => { if (e.key === 'Backspace' && !box.value && idx > 0) boxes[idx - 1].focus(); };
  });
  setTimeout(() => document.getElementById('adm-tel')?.focus(), 120);
}

function admGoStep(step) {
  const s1 = document.getElementById('adx-slide-1');
  const s2 = document.getElementById('adx-slide-2');
  const dot1 = document.getElementById('adx-dot-1');
  const dot2 = document.getElementById('adx-dot-2');
  if (step === 2) {
    const email = (document.getElementById('adm-tel').value || '').trim();
    if (!Auth.isValidGmail(email)) { Toast.error('Adresse Gmail invalide (ex : nom@gmail.com).'); return; }
    const user = DB.users.byEmail(email);
    if (!user) { Toast.error('Aucun compte administrateur trouvé pour cette adresse.'); return; }
    const initials = ((user.prenom || '')[0] || '') + ((user.nom || '')[0] || '') || 'A';
    document.getElementById('adx-user-ava').textContent  = initials.toUpperCase();
    document.getElementById('adx-user-name').textContent = `${user.prenom || ''} ${user.nom || ''}`.trim() || 'Administrateur';
    document.getElementById('adm-denied').style.display  = 'none';
    s1.classList.add('adx-slide--exit');
    setTimeout(() => {
      s1.classList.add('adx-slide--hidden'); s1.classList.remove('adx-slide--exit');
      s2.style.display = 'block';
      requestAnimationFrame(() => requestAnimationFrame(() => s2.classList.add('adx-slide--enter')));
    }, 260);
    dot1.className = 'adx-step adx-step--done';
    dot2.className = 'adx-step adx-step--active';
    setTimeout(() => document.querySelector('#adm-pin-row .adx-pin-box')?.focus(), 420);
  }
}

async function submitAdminLogin() {
  const email  = (document.getElementById('adm-tel')?.value || '').trim();
  const pin    = [...document.querySelectorAll('#adm-pin-row .adx-pin-box')].map(b => b.value).join('');
  const denied = document.getElementById('adm-denied');
  denied.style.display = 'none';

  if (!Auth.isValidGmail(email)) { Toast.error('Adresse Gmail invalide (ex : nom@gmail.com).'); return; }
  if (!Auth.isValidPin(pin))     { Toast.error('Saisissez votre code PIN à 4 chiffres.'); return; }

  const res = await Auth.login(email, pin, false, 'admin');

  if (!res.ok) { Toast.error(res.error); return; }

  if (res.user.role !== 'admin') {
    sessionStorage.removeItem('cbp_session');
    denied.style.display = 'flex';
    document.querySelectorAll('#adm-pin-row .adx-pin-box').forEach(b => { b.value = ''; });
    return;
  }

  window.location.href = 'admin.html';
}

function toggleAboSection() {
  const section = document.getElementById('ph5-abo');
  const icon    = document.getElementById('ph5-abo-icon');
  const btn     = document.getElementById('ph5-abo-btn');
  if (!section) return;
  const isOpen = section.style.display !== 'none';
  section.style.display = isOpen ? 'none' : 'block';
  icon?.classList.toggle('open', !isOpen);
  btn?.classList.toggle('open', !isOpen);
  if (!isOpen) section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function toggleContactSection() {
  const section = document.getElementById('ph5-contact');
  const icon    = document.getElementById('ph5-contact-icon');
  const btn     = document.getElementById('ph5-contact-btn');
  if (!section) return;
  const isOpen = section.style.display !== 'none';
  section.style.display = isOpen ? 'none' : 'block';
  icon?.classList.toggle('open', !isOpen);
  btn?.classList.toggle('open', !isOpen);
  if (!isOpen) section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function toggleAproposSection() {
  const section = document.getElementById('ph5-apropos');
  const icon    = document.getElementById('ph5-apropos-icon');
  const btn     = document.getElementById('ph5-apropos-btn');
  if (!section) return;
  const isOpen = section.style.display !== 'none';
  section.style.display = isOpen ? 'none' : 'block';
  icon?.classList.toggle('open', !isOpen);
  btn?.classList.toggle('open', !isOpen);
  if (!isOpen) section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ── Fenêtre de réclamation ───────────────────────────────────────
   Entre 5 minutes et 24h après la commande — aucune limite de nombre
   de réclamations par client (le client peut en faire autant qu'il le
   souhaite). RECLA_MIN_DELAY_MS/RECLA_MAX_DELAY_MS/reclamationWindowState/
   formatMmSs sont désormais définis dans js/db.js (fonctions globales
   partagées avec js/cabine.js, voir onglet Réclamation de la Recharge UV). */

async function assistanceWhatsappLink(motif) {
  const settings = await DB.settings.get();
  const list = (settings.assistance && settings.assistance.whatsapp) || [];
  const raw = list.find(n => n && n.trim());
  if (!raw) return null;
  return Fmt.whatsappLink(raw, motif || 'Bonjour, j\'ai besoin d\'assistance concernant une commande KBINE PLUS.');
}

/* ── Bouton "Aide" (bottom-nav) — liste indépendante gérée par le super
   admin (onglet "Assistant clientèle client"), avec programmation
   horaire optionnelle : si un créneau est actif pour le jour/heure
   actuels, redirection directe sans liste (avec rotation ~1min, voir
   pickClientWhatsappTarget ci-dessous) ; sinon, sélection manuelle
   (même patron que openCabWhatsappPicker() côté cabine). Sans lien avec
   settings.assistance (secours réclamation ci-dessus), volontairement
   séparé. */
async function activeScheduledAssistant() {
  const schedule = ((await DB.settings.get()).assistant_client || {}).schedule || [];
  const now = new Date();
  const day = now.getDay(); // 0=dimanche..6=samedi, aligné sur Date.getDay()
  const hm  = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  return schedule.find(s => (s.jours || []).includes(day) && hm >= s.debut && hm <= s.fin) || null;
}

async function pickClientWhatsappTarget(slot) {
  const pool  = (((await DB.settings.get()).assistant_client || {}).whatsapp || []).map(c => DB.normalizeContact(c).numero);
  const state = JSON.parse(localStorage.getItem('cbp_wa_rotation_client') || 'null');
  const now   = Date.now();

  let numero = slot.numero;
  if (state && state.slotId === slot.id && (now - state.ts) < 60000) {
    // Reclic rapproché (< 1min) : on garde le même assistant, pas encore
    // "sans réponse".
    numero = state.numero;
  } else if (state && state.slotId === slot.id && pool.length > 1) {
    // ≥1min depuis le dernier clic sur ce même créneau : on bascule vers
    // l'assistant suivant dans la liste, à des fins de disponibilité.
    const idx = pool.indexOf(state.numero);
    numero = pool[(idx + 1) % pool.length];
  }

  localStorage.setItem('cbp_wa_rotation_client', JSON.stringify({ slotId: slot.id, ts: now, numero }));
  return numero;
}

async function handleClientWhatsappClick() {
  const slot = await activeScheduledAssistant();
  if (slot) {
    const numero = await pickClientWhatsappTarget(slot);
    const link = Fmt.whatsappLink(numero);
    if (link) window.open(link, '_blank');
    return;
  }
  openClientWhatsappPicker();
}

async function openClientWhatsappPicker() {
  const contacts = (((await DB.settings.get()).assistant_client || {}).whatsapp || []).map(DB.normalizeContact);
  const list = document.getElementById('client-wa-picker-list');
  if (!contacts.length) {
    Toast.error('Aucun assistant WhatsApp configuré pour le moment.');
    return;
  }
  list.innerHTML = contacts.map(c => `
    <div class="wa-pick-item" onclick="clientPickWhatsapp('${c.numero}')">
      <div class="wa-pick-ico"><i class="fa-brands fa-whatsapp"></i></div>
      <div class="wa-pick-info">
        <div class="wa-pick-name">${c.nom || Fmt.phone(c.numero)}</div>
      </div>
      <span class="wa-pick-btn">Discuter</span>
    </div>`).join('');
  openModal('modal-client-wa-picker');
}

function clientPickWhatsapp(numero) {
  const link = Fmt.whatsappLink(numero);
  if (link) window.open(link, '_blank');
  closeModal('modal-client-wa-picker');
}

/* ── Hub réclamation — interface de chat unique ──────────────────
   Un seul point d'entrée (bouton "Réclamation" dans Historique) :
   - Onglet "Nouvelle" : thread de chat, commande éligible puis motif.
   - Onglets "En attente" / "Terminées" : suivi des réclamations.
   RECLA_REASONS/getReclamableOrders sont désormais définis dans
   js/db.js (fonctions globales partagées avec js/cabine.js). */

let _rclHubTab          = 'nouvelle'; // 'nouvelle' | 'attente' | 'terminees'
// Onglet "Nouvelle" : petite machine à états — 'menu' (accueil + 2 motifs
// numérotés) | 'pick_order' (motif déjà choisi, reste à identifier la commande).
let _rclHubStep          = 'menu';
let _rclHubPendingReason = null; // motif choisi au menu, en attente du choix de commande
// Commande préselectionnée hors menu (voir otkTriggerReclamation, suivi de
// commande) : on saute directement à "quel est le motif ?" pour cette
// commande précise, sans repasser par le menu.
let _rclHubSelectedTxn  = null;
let _rclHubSubmitted    = false;
let _rclHubOpenThreadId = null; // id d'une réclamation dont le fil est ouvert (vue détail)

function openReclamationHub() {
  if (!currentUser) return;
  const saved = _clientResume.reclamationHub;
  _rclHubTab = saved ? saved.tab : 'nouvelle';
  _rclHubSelectedTxn   = null;
  _rclHubStep          = 'menu';
  _rclHubPendingReason = null;
  _rclHubSubmitted     = false;
  renderReclamationHub();
  openModal('modal-reclamation-hub');
  // Cache local affiché immédiatement ci-dessus ; resynchronise en tâche
  // de fond (voir DB.reclamations.refresh(), js/db.js) puis rafraîchit —
  // une réponse de la cabine doit apparaître sans rechargement manuel.
  DB.reclamations.refresh().then(renderReclamationHub);
}

function _saveRclHubState() {
  _clientResume.reclamationHub = { tab: _rclHubTab };
  _saveClientResume();
}

function rclHubSwitchTab(tab) {
  _rclHubTab = tab;
  if (tab === 'nouvelle') {
    _rclHubSelectedTxn = null; _rclHubSubmitted = false;
    _rclHubStep = 'menu'; _rclHubPendingReason = null;
  }
  renderReclamationHub();
  _saveRclHubState();
}

// Entrée "raccourci" : commande déjà connue (voir otkTriggerReclamation) —
// on saute le menu, il ne reste qu'à demander le motif pour cette commande.
function rclHubSelectOrder(id) {
  const t = DB.transactions.byId(id);
  if (!t) return;
  _rclHubSelectedTxn = t;
  renderReclamationHub();
  _saveRclHubState();
}

function rclHubSelectReason(key) {
  const t = _rclHubSelectedTxn;
  if (!t || !currentUser) return;
  _rclHubFinalize(t, key);
}

// Entrée "menu" (options 1/2) : le motif est déjà choisi, il ne reste qu'à
// identifier la commande — voir rclHubMenuChoice ci-dessous.
function rclHubPickOrderForReason(id) {
  const t = DB.transactions.byId(id);
  if (!t || !_rclHubPendingReason) return;
  _rclHubFinalize(t, _rclHubPendingReason);
}

async function _rclHubFinalize(t, key) {
  if (DB.reclamations.byTransaction(t.id)) {
    Toast.warning('Une réclamation existe déjà pour cette commande.');
    _rclHubSelectedTxn = null; _rclHubStep = 'menu'; _rclHubPendingReason = null;
    renderReclamationHub();
    return;
  }
  if (reclamationWindowState(t).state !== 'eligible') {
    Toast.error('Cette commande n\'est plus éligible à une réclamation.');
    _rclHubSelectedTxn = null; _rclHubStep = 'menu'; _rclHubPendingReason = null;
    renderReclamationHub();
    return;
  }
  const motif = RECLA_REASONS[key] || key;
  // Notification à la cabine envoyée côté serveur (voir
  // api/reclamations_create.php), plus de doublon local ici.
  const res = await DB.reclamations.create({ transaction_id: t.id, motif });
  if (!res.ok) { Toast.error(res.error); return; }
  _rclHubSubmitted = true;
  renderReclamationHub();
  Toast.success('Réclamation envoyée. La cabine sera notifiée.');
  loadHistory();
}

function rclHubMenuChoice(key) {
  _rclHubPendingReason = key;
  _rclHubStep = 'pick_order';
  renderReclamationHub();
}

function rclHubBack() {
  _rclHubStep = 'menu';
  _rclHubPendingReason = null;
  renderReclamationHub();
}

function renderReclamationHub() {
  if (!currentUser) return;
  const all       = DB.reclamations.byClient(currentUser.id);
  const pending   = all.filter(r => r.statut === 'en_attente');
  const completed = all.filter(r => r.statut !== 'en_attente');

  const tabs = document.getElementById('rclhub-tabs');
  if (tabs) {
    tabs.style.display = _rclHubOpenThreadId ? 'none' : '';
    tabs.innerHTML = `
      <div class="rh-tab ${_rclHubTab === 'nouvelle'  ? 'active' : ''}" onclick="rclHubSwitchTab('nouvelle')">Nouvelle</div>
      <div class="rh-tab ${_rclHubTab === 'attente'   ? 'active' : ''}" onclick="rclHubSwitchTab('attente')">En attente${pending.length ? ` <span class="rh-tab-badge">${pending.length}</span>` : ''}</div>
      <div class="rh-tab ${_rclHubTab === 'terminees' ? 'active' : ''}" onclick="rclHubSwitchTab('terminees')">Terminées${completed.length ? ` <span class="rh-tab-badge">${completed.length}</span>` : ''}</div>
    `;
  }

  const body = document.getElementById('rclhub-body');
  if (!body) return;
  if (_rclHubOpenThreadId) {
    const r = DB.reclamations.all().find(x => x.id === _rclHubOpenThreadId);
    body.innerHTML = r ? renderRclHubThread(r) : '';
  } else if (_rclHubTab === 'attente')        body.innerHTML = renderRclHubList(pending, true);
  else if (_rclHubTab === 'terminees') body.innerHTML = renderRclHubList(completed, false);
  else                                 body.innerHTML = renderRclHubChat();
}

function renderRclHubChat() {
  const botRow = (html) => `
    <div class="rh-msg-row">
      <div class="rh-msg-avatar"><i class="fa-solid fa-comment-dots"></i></div>
      <div class="rh-msg-bubble">${html}</div>
    </div>`;
  const backBtn = () => `<button class="rh-thread-back" onclick="rclHubBack()"><i class="fa-solid fa-arrow-left"></i> Retour</button>`;

  if (_rclHubSubmitted) {
    return `
      <div class="rh-msg-row">
        <div class="rh-msg-avatar"><i class="fa-solid fa-comment-dots"></i></div>
        <div class="rh-confirm-bubble"><i class="fa-solid fa-circle-check"></i> Merci, nous sommes désolés pour le désagrément rencontré. Une vérification est en cours auprès de la cabine, merci de patienter environ 2 minutes.</div>
      </div>`;
  }

  // Commande préselectionnée hors menu (voir otkTriggerReclamation) : le
  // motif reste à demander pour cette commande précise.
  if (_rclHubSelectedTxn) {
    const t = _rclHubSelectedTxn;
    return botRow('Bonjour 👋 Nous sommes désolés pour le désagrément rencontré.')
      + `<div class="rh-msg-row user"><div class="rh-msg-bubble">Commande ${Fmt.ref(t.id)} — ${t.service || 'Transfert direct'} · ${Fmt.money(t.montant)}</div></div>`
      + botRow('Quel est le problème rencontré avec cette commande ?')
      + `<div class="rh-msg-group">
          <button class="rh-reason-btn" onclick="rclHubSelectReason('non_recue')"><i class="fa-solid fa-circle-exclamation"></i> ${RECLA_REASONS.non_recue}</button>
          <button class="rh-reason-btn" onclick="rclHubSelectReason('non_conforme')"><i class="fa-solid fa-triangle-exclamation"></i> ${RECLA_REASONS.non_conforme}</button>
        </div>`;
  }

  if (_rclHubStep === 'pick_order') {
    const eligible = getReclamableOrders(currentUser.id);
    const listHtml = eligible.length
      ? eligible.map(t => `
          <button class="rh-order-pick" onclick="rclHubPickOrderForReason('${t.id}')">
            <span class="rh-order-pick-ico"><i class="fa-solid fa-receipt"></i></span>
            <span class="rh-order-pick-main">
              <span class="rh-order-pick-svc">${t.service || 'Transfert direct'}${t.operateur ? ' · ' + t.operateur : ''}</span>
              <span class="rh-order-pick-meta">${Fmt.ref(t.id)} · ${Fmt.datetime(t.date)}</span>
            </span>
            <span class="rh-order-pick-amt">${Fmt.money(t.montant)}</span>
          </button>`).join('')
      : `<div class="hx-empty" style="margin-left:32px"><div class="hx-empty-icon">🗂️</div><div class="hx-empty-title">Aucune commande éligible</div><div class="hx-empty-sub">Une réclamation peut être lancée entre 5 min et 24h après la commande.</div></div>`;
    return backBtn() + botRow('Sur quelle commande souhaitez-vous faire une réclamation ?') + `<div class="rh-msg-group">${listHtml}</div>`;
  }

  // 'menu' (défaut)
  return botRow('Bonjour 👋 Nous sommes désolés pour le désagrément rencontré. Comment pouvons-nous vous aider ?')
    + `<div class="rh-msg-group">
        <button class="rh-reason-btn" onclick="rclHubMenuChoice('non_recue')"><i class="fa-solid fa-circle-exclamation"></i> 1. Je n'ai pas reçu ma commande</button>
        <button class="rh-reason-btn" onclick="rclHubMenuChoice('non_conforme')"><i class="fa-solid fa-triangle-exclamation"></i> 2. J'ai reçu, mais pas ce que j'ai demandé</button>
      </div>`;
}

function renderRclHubList(items, isPending) {
  if (!items.length) {
    return `<div class="hx-empty"><div class="hx-empty-icon">🗂️</div><div class="hx-empty-title">Aucune réclamation</div><div class="hx-empty-sub">${isPending ? 'Vos réclamations en cours apparaîtront ici.' : 'Vos réclamations résolues apparaîtront ici.'}</div></div>`;
  }
  return items
    .slice()
    .sort((a, b) => new Date(b.date_created) - new Date(a.date_created))
    .map(r => {
      const t = DB.transactions.byId(r.transaction_id);
      const ref = Fmt.ref(t ? t.id : r.transaction_id);
      const date = new Date(r.date_created).toLocaleString('fr-CI', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      const isRefundFlow = r.statut === 'remboursement_demande' || r.statut === 'remboursée';
      const pillCls = isPending ? 'pend' : isRefundFlow ? 'refund' : 'done';
      const pillIco = isPending ? 'fa-clock' : isRefundFlow ? 'fa-rotate-left' : 'fa-circle-check';
      const pillLbl = isPending ? 'En attente' : r.statut === 'remboursement_demande' ? 'Remboursement en cours' : r.statut === 'remboursée' ? 'Remboursée' : 'Résolue';
      return `
        <div class="rh-card" onclick="rclHubOpenThread('${r.id}')">
          <div class="rh-card-top">
            <span class="rh-card-ref">${ref}</span>
            <span class="rh-pill rh-pill--${pillCls}"><i class="fa-solid ${pillIco}"></i> ${pillLbl}</span>
          </div>
          <div class="rh-card-motif">"${r.motif}"</div>
          <div class="rh-card-date">Envoyée le ${date}</div>
          ${r.statut === 'résolue' && r.screenshot ? `<img src="${r.screenshot}" class="rh-proof-img" onclick="event.stopPropagation();window.open('${r.screenshot}','_blank')" alt="Capture preuve">` : ''}
        </div>`;
    }).join('');
}

/* ── Fil de discussion d'une réclamation ─────────────────────────
   Ouvert en cliquant une carte "En attente"/"Terminées". Affiche
   l'historique des messages (déclaration initiale, preuves envoyées par
   la cabine, relances du client) et propose les 2 réponses rapides tant
   que la réclamation n'est ni clôturée ni bloquée (voir
   rclHubQuickReply ci-dessous pour la limite de 2 relances après une
   première preuve). */
function rclHubOpenThread(id) {
  _rclHubOpenThreadId = id;
  renderReclamationHub();
}

function rclHubCloseThread() {
  _rclHubOpenThreadId = null;
  renderReclamationHub();
}

function renderRclHubThread(r) {
  const msgs = r.messages || [];
  const bubbles = msgs.map(m => {
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

  // 'résolue' est ambigu : posé aussi bien quand la cabine vient de
  // fournir une preuve (le client peut encore relancer) que quand le
  // client a confirmé réception (voir confirmed_by_client, posé
  // uniquement par rclHubQuickReply('recu') ci-dessous) — seul ce
  // dernier cas clôture réellement le fil.
  const closed  = r.statut === 'remboursement_demande' || r.statut === 'remboursée' || !!r.confirmed_by_client;
  const blocked = !closed && !!r.screenshot && (r.relances_apres_preuve || 0) >= 3;

  let footer = '';
  if (blocked) {
    footer = `
      <div class="rh-msg-row">
        <div class="rh-msg-avatar"><i class="fa-solid fa-comment-dots"></i></div>
        <div class="rh-msg-bubble">Vous avez atteint la limite de réclamations pour cette commande. Merci de cliquer sur l'icône WhatsApp pour exposer votre préoccupation directement à un assistant clientèle.</div>
      </div>
      <div class="rh-msg-group"><button class="rh-reason-btn rh-reason-btn--wa" onclick="handleClientWhatsappClick()"><i class="fa-brands fa-whatsapp"></i> Contacter l'assistance WhatsApp</button></div>`;
  } else if (!closed) {
    footer = `
      <div class="rh-msg-group">
        <button class="rh-reason-btn" onclick="rclHubQuickReply('${r.id}','non_recue')"><i class="fa-solid fa-circle-exclamation"></i> Je n'ai toujours pas reçu ma commande</button>
        <button class="rh-reason-btn" onclick="rclHubQuickReply('${r.id}','recu')"><i class="fa-solid fa-circle-check"></i> J'ai reçu ma commande, merci !</button>
      </div>`;
  }

  return `<button class="rh-thread-back" onclick="rclHubCloseThread()"><i class="fa-solid fa-arrow-left"></i> Retour</button>${bubbles}${footer}`;
}

// Statut/messages/notifications/plafond de relances entièrement gérés
// côté serveur désormais (voir api/reclamations_confirm_received.php et
// api/reclamations_relance.php) — la vérification défensive locale
// (r.confirmed_by_client, statut déjà clos) reste utile pour éviter un
// appel réseau inutile, mais le serveur la refait de toute façon (CAS).
async function rclHubQuickReply(reclaId, kind) {
  const r = DB.reclamations.all().find(x => x.id === reclaId);
  if (!r) return;
  if (r.confirmed_by_client || r.statut === 'remboursement_demande' || r.statut === 'remboursée') return;

  if (kind === 'recu') {
    const res = await DB.reclamations.confirmReceived(reclaId);
    if (!res.ok) { Toast.error(res.error); return; }
    Toast.success('Merci ! La cabine a été notifiée.');
    renderReclamationHub();
    return;
  }

  // kind === 'non_recue'
  if (r.screenshot && (r.relances_apres_preuve || 0) >= 3) {
    // 4e tentative : le client a droit à 3 relances par commande après
    // preuve — redirection directe vers l'assistance WhatsApp plutôt que
    // de le laisser relancer indéfiniment (vérifié aussi côté serveur).
    renderReclamationHub();
    const link = await assistanceWhatsappLink('Bonjour, j\'ai besoin d\'aide concernant une réclamation en cours.');
    if (!link) { Toast.error('Aucun numéro d\'assistance WhatsApp n\'est configuré pour le moment.'); return; }
    Toast.warning('Vous avez atteint la limite de relances — redirection vers l\'assistance WhatsApp…');
    window.open(link, '_blank');
    return;
  }
  const res = await DB.reclamations.relance(reclaId);
  if (!res.ok) { Toast.error(res.error); return; }
  Toast.warning('La cabine a été notifiée à nouveau.');
  renderReclamationHub();
}

/* ── Répertoire du téléphone ────────────────────────────────────── */
// Un plugin Capacitor natif ne se charge pas via <script src> : une fois
// installé, Capacitor l'expose lui-même au runtime sur
// window.Capacitor.Plugins.<Nom>. undefined dans un navigateur desktop
// classique ou sous Node (tests).
function _contactsPlugin() {
  return (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins)
    ? window.Capacitor.Plugins.Contacts
    : undefined;
}

async function openContactsPicker() {
  if (!currentUser) {
    Toast.info('Connectez-vous pour accéder à votre répertoire.');
    return;
  }

  const plugin = _contactsPlugin();
  if (plugin) {
    try {
      const { contact } = await plugin.pickContact({ projection: { name: true, phones: true } });
      const numero = contact?.phones?.find(p => p.number)?.number;
      if (!numero) { Toast.error('Ce contact ne possède aucun numéro de téléphone.'); return; }
      tfPickContact(numero);
    } catch (e) {
      // Sélection annulée ou permission refusée — rien à afficher.
    }
    return;
  }

  // Application ouverte dans un navigateur (site web, hors app Android) :
  // aucun pont Capacitor — repli sur l'API standard Contact Picker si le
  // navigateur la propose (Chrome Android récent).
  if (typeof navigator !== 'undefined' && navigator.contacts && navigator.contacts.select) {
    try {
      const [contact] = await navigator.contacts.select(['tel'], { multiple: false });
      const numero = contact?.tel?.[0];
      if (!numero) { Toast.error('Ce contact ne possède aucun numéro de téléphone.'); return; }
      tfPickContact(numero);
    } catch (e) {
      // Sélection annulée.
    }
    return;
  }

  Toast.info("L'accès au répertoire du téléphone n'est disponible que dans l'application KBINE PLUS.");
}

function tfPickContact(numero) {
  document.getElementById('tf-recipient').value = numero;
  tfUpdateRecipient(numero);
  Toast.info(`Numéro ${Fmt.phone(numero)} sélectionné.`);
}

/* ================================================================
   RÉCAPITULATIF COMMANDES (dashboard)
   ================================================================ */
function loadRecentRecap() {
  if (!currentUser) return;
  const section = document.getElementById('rcp-section');
  const list    = document.getElementById('rcp-list');
  if (!section || !list) return;

  const OP_COLOR = { Orange:'#FF6200', MTN:'#FFCC00', Moov:'#0066CC' };
  const OP_LOGO  = { Orange:'orange.png', MTN:'mtn.jpg', Moov:'moov.jpg' };
  const OP_EMOJI = { Orange:'🟠', MTN:'🟡', Moov:'🔵' };

  const txns = DB.transactions.byClient(currentUser.id)
    .sort((a,b) => new Date(b.date) - new Date(a.date))
    .slice(0, 3);

  if (!txns.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';

  list.innerHTML = txns.map(t => {
    const opClr   = OP_COLOR[t.operateur] || '#7c3aed';
    const opLogo  = OP_LOGO[t.operateur];
    const opEmoji = OP_EMOJI[t.operateur] || '📱';
    const isOk  = t.statut === 'terminé';
    const isPend = t.statut === 'en_attente';
    const stIco = isOk ? 'fa-circle-check' : isPend ? 'fa-clock' : 'fa-circle-xmark';
    const stLbl = isOk ? 'Terminée' : isPend ? 'En attente' : 'Refusée';
    const stClr = isOk ? '#22c55e' : isPend ? '#f59e0b' : '#ef4444';
    const ref   = t.id.slice(0,8);
    const dt    = new Date(t.date);
    const dateStr = dt.toLocaleDateString('fr-CI',{day:'2-digit',month:'short'}) + ' · ' + dt.toLocaleTimeString('fr-CI',{hour:'2-digit',minute:'2-digit'});
    return `
    <div class="rcp-item" onclick="showSection('historique')">
      <div class="rcp-op-ico ${t.operateur === 'Orange' ? 'rcp-op-ico--orange' : ''}" style="background:${opClr}18;border:1.5px solid ${opClr}30;">${opLogo ? `<img src="img/logos/${opLogo}" alt="${t.operateur}" onerror="this.outerHTML='<span>${opEmoji}</span>'">` : `<span>${opEmoji}</span>`}</div>
      <div class="rcp-info">
        <div class="rcp-ref">#${ref} <span class="rcp-benef">→ ${Fmt.phone(t.numero_beneficiaire)}</span></div>
        <div class="rcp-date">${dateStr}</div>
      </div>
      <div class="rcp-right">
        <div class="rcp-amount">${Fmt.money(t.montant)}</div>
        <div class="rcp-status" style="color:${stClr};"><i class="fa-solid ${stIco}"></i> ${stLbl}</div>
      </div>
    </div>`;
  }).join('');
}

/* ================================================================
   HISTORIQUE
   ================================================================ */
function loadHistory() {
  const hLocked  = document.getElementById('cs-historique-locked');
  const hContent = document.getElementById('cs-historique-content');
  const hBar     = document.querySelector('#cs-historique .cs-sec-bar');
  if (!currentUser) {
    if (hLocked)  hLocked.style.display  = '';
    if (hContent) hContent.style.display = 'none';
    if (hBar)     hBar.style.display     = 'none';
    return;
  }
  if (hLocked)  hLocked.style.display  = 'none';
  if (hContent) hContent.style.display = '';
  if (hBar)     hBar.style.display     = '';
  const search = document.getElementById('history-search');
  if (search) search.value = '';
  renderHistoryList(DB.transactions.byClient(currentUser.id));
  renderCadeauBtn();
}

function resetHistory() {
  if (!currentUser) return;
  if (!confirm('Vider tout l\'historique ? Cette action est irréversible.')) return;
  const all = DB.transactions.all().filter(t => t.client_id !== currentUser.id);
  DB.transactions.save(all);
  loadHistory();
  loadWallet();
  Toast.success('Historique vidé.');
}

function searchHistory() {
  if (!currentUser) return;
  const q = document.getElementById('history-search').value.toLowerCase().trim();
  let txns = DB.transactions.byClient(currentUser.id);
  if (q) txns = txns.filter(t =>
    (t.numero_beneficiaire || '').toLowerCase().includes(q) ||
    (t.id || '').toLowerCase().includes(q)
  );
  renderHistoryList(txns);
}

function renderHistoryList(txns) {
  const list = document.getElementById('history-list');
  if (!list) { return; }

  const sorted = txns ? [...txns].sort((a,b) => new Date(b.date) - new Date(a.date)) : [];
  updateReclamationBadge();
  updateReceiptButtonVisibility();

  if (!sorted.length) {
    list.innerHTML = `
      <div class="hx-empty">
        <div class="hx-empty-icon">📋</div>
        <div class="hx-empty-title">Aucune commande</div>
        <div class="hx-empty-sub">Vos transferts apparaîtront ici</div>
      </div>`;
    return;
  }

  const TYPE_META = {
    recharge      : { ico:'fa-bolt',             clr:'#f59e0b', lbl:'Recharge' },
    transfert     : { ico:'fa-paper-plane',      clr:'#6366f1', lbl:'Transfert' },
    transfert_client: { ico:'fa-paper-plane',    clr:'#6366f1', lbl:'Transfert client' },
    facture       : { ico:'fa-file-invoice-dollar', clr:'#f59e0b', lbl:'Facture' },
    recharge_uv   : { ico:'fa-bolt-lightning',   clr:'#06b6d4', lbl:'Recharge UV' },
    exchange      : { ico:'fa-arrows-rotate',    clr:'#8b5cf6', lbl:'Exchange' },
    cadeau        : { ico:'fa-gift',             clr:'#ec4899', lbl:'Cadeau' },
    reabonnement  : { ico:'fa-rotate',           clr:'#F59E0B', lbl:'Réabonnement' },
  };

  // Heure seule (HH:MM), ou '—' si l'étape n'a pas de date connue —
  // même convention que la frise de "Mes commissions" côté cabine.
  const hm = (d) => d ? new Date(d).toLocaleTimeString('fr-CI', { hour:'2-digit', minute:'2-digit' }) : '—';

  const cards = sorted.map(t => {
    const meta   = TYPE_META[t.type] || { ico:'fa-circle-nodes', clr:'#7c3aed', lbl: t.type || 'Service' };
    const isOk   = t.statut === 'terminé';
    const isPend = t.statut === 'en_attente';
    const isRfd  = t.statut === 'remboursé';
    const ref    = Fmt.ref(t.id);
    const d      = t.details || {};

    let desc = t.service || meta.lbl;
    let secondLine = '';
    if (t.type === 'exchange') {
      secondLine = `${d.debit_network || ''}/${d.debit_numero ? Fmt.phone(d.debit_numero) : '—'} → ${d.recep_network || ''}/${d.recep_numero ? Fmt.phone(d.recep_numero) : '—'}`;
    } else if (t.type === 'cadeau') {
      secondLine = `Pour ${d.network || t.operateur} ${Fmt.phone(d.numero || t.numero_beneficiaire) || '—'}`;
    } else if (t.type === 'facture') {
      secondLine = `Réf : ${d.ref || t.numero_beneficiaire || '—'}${d.offer ? ' · ' + d.offer : ''}`;
    } else if (t.numero_beneficiaire) {
      secondLine = `→ ${t.operateur ? t.operateur + ' ' : ''}${Fmt.phone(t.numero_beneficiaire)}`;
    }

    // Statut simplifié côté client : uniquement "En cours" / "Validée" /
    // "Remboursée" / "Non validée" — les notions internes de retard ou de
    // réattribution (voir Fmt.isLate/Fmt.rowColors, réservées à l'admin et
    // à la cabine) ne sont jamais montrées au client.
    const rc = STATUS_COLORS[t.statut] || STATUS_COLORS.en_attente;
    const pillIco = isOk ? 'fa-circle-check' : isPend ? 'fa-clock' : isRfd ? 'fa-rotate-left' : 'fa-circle-xmark';
    const pillLbl = isOk ? 'Validée' : isPend ? 'En cours' : isRfd ? 'Remboursée' : 'Non validée';

    const step2On   = !!t.date_assignation;
    const step3Time = isOk ? (t.date_fin || t.date_assignation || t.date) : (isRfd ? (t.date_remboursement || t.date) : null);
    const step3Lbl  = isOk ? 'Reçue' : isPend ? 'En cours' : isRfd ? 'Remboursée' : 'Refusée';
    const step3Dot  = isOk ? 'hoc-tl-dot--ok' : isPend ? 'hoc-tl-dot--active' : isRfd ? 'hoc-tl-dot--rfd' : 'hoc-tl-dot--ko';
    const step3Bar  = isOk ? 'hoc-tl-bar--ok' : isPend ? 'hoc-tl-bar--active' : isRfd ? 'hoc-tl-bar--rfd' : 'hoc-tl-bar--ko';
    const step3LblCls = isPend ? 'hoc-tl-lbl--active' : '';

    return `
    <div class="hoc-card" id="hoc-card-${t.id}" style="border-left:3px solid ${rc.line};background:${rc.bg};" onclick="openOrderDetail('${t.id}')">
      <div class="hoc-card-top">
        <div class="hoc-id-row">
          <div class="hoc-ico" style="background:${meta.clr}1a;color:${meta.clr};"><i class="fa-solid ${meta.ico}"></i></div>
          <div>
            <div class="hoc-svc">${desc}</div>
            ${secondLine ? `<div class="hoc-meta">${secondLine}</div>` : `<div class="hoc-ref">#${ref}</div>`}
          </div>
        </div>
        <div class="hoc-amounts">
          <div class="hoc-montant">${Fmt.money(t.montant)}</div>
          <span class="hoc-pill" style="background:${rc.bg};color:${rc.text};"><i class="fa-solid ${pillIco}"></i> ${pillLbl}</span>
        </div>
      </div>
      <div class="hoc-timeline">
        <div class="hoc-tl-step">
          <span class="hoc-tl-dot hoc-tl-dot--ok"></span>
          <span class="hoc-tl-time">${hm(t.date)}</span>
          <span class="hoc-tl-lbl">Envoyée</span>
        </div>
        <div class="hoc-tl-bar ${step2On ? 'hoc-tl-bar--ok' : ''}"></div>
        <div class="hoc-tl-step">
          <span class="hoc-tl-dot ${step2On ? 'hoc-tl-dot--ok' : ''}"></span>
          <span class="hoc-tl-time ${step2On ? '' : 'hoc-tl-time--muted'}">${hm(t.date_assignation)}</span>
          <span class="hoc-tl-lbl">Assignée</span>
        </div>
        <div class="hoc-tl-bar ${step3Bar}"></div>
        <div class="hoc-tl-step">
          <span class="hoc-tl-dot ${step3Dot}"></span>
          <span class="hoc-tl-time ${step3Time ? '' : 'hoc-tl-time--muted'}">${hm(step3Time)}</span>
          <span class="hoc-tl-lbl ${step3LblCls}">${step3Lbl}</span>
        </div>
      </div>
      ${isPend ? `<div class="hoc-recla-hint-slot" id="hoc-recla-${t.id}">${_hocReclaHintInner(t)}</div>` : ''}
    </div>`;
  }).join('');

  list.innerHTML = `<div class="hoc-list">${cards}</div>`;
  _startHocReclaTick();
}

// ── Indice de réclamation sur les cartes Historique ─────────────────
// Pour chaque commande en attente : un petit compte à rebours tant que la
// fenêtre de réclamation n'est pas ouverte (voir RECLA_MIN_DELAY_MS /
// reclamationWindowState, réutilisés tels quels), puis un bandeau
// discret — fermable par le client — dès qu'elle le devient. N'apparaît
// plus une fois la commande déjà réclamée.
const _hocDismissedRecla = new Set();

function _hocReclaHintInner(t) {
  if (t.statut !== 'en_attente' || DB.reclamations.byTransaction(t.id)) return '';
  const win = reclamationWindowState(t);
  if (win.state === 'early') {
    return `<div class="hoc-recla-hint hoc-recla-hint--wait">
      <i class="fa-solid fa-hourglass-half"></i> Réclamation possible dans <strong>${formatMmSs(win.remainingMs)}</strong>
    </div>`;
  }
  if (win.state === 'eligible' && !_hocDismissedRecla.has(t.id)) {
    return `<div class="hoc-recla-hint hoc-recla-hint--ready">
      <span><i class="fa-solid fa-circle-check"></i> Vous pouvez faire une <strong>réclamation</strong> maintenant si vous le souhaitez.</span>
      <button class="hoc-recla-hint-close" onclick="event.stopPropagation(); hocDismissReclaHint('${t.id}')"><i class="fa-solid fa-xmark"></i></button>
    </div>`;
  }
  return '';
}

function hocDismissReclaHint(txnId) {
  _hocDismissedRecla.add(txnId);
  const slot = document.getElementById('hoc-recla-' + txnId);
  if (slot) slot.innerHTML = '';
}

let _hocReclaTickTimer = null;
function _startHocReclaTick() {
  if (_hocReclaTickTimer) return;
  _hocReclaTickTimer = setInterval(() => {
    document.querySelectorAll('.hoc-recla-hint-slot').forEach(slot => {
      const txnId = slot.id.replace('hoc-recla-', '');
      const t = DB.transactions.byId(txnId);
      if (!t) { slot.innerHTML = ''; return; }
      slot.innerHTML = _hocReclaHintInner(t);
    });
  }, 1000);
}

function updateReclamationBadge() {
  const badge = document.getElementById('rclhub-badge');
  const sub   = document.getElementById('rclhub-sub');
  if (!badge && !sub) return;
  const count = currentUser ? DB.reclamations.byClient(currentUser.id).filter(r => r.statut === 'en_attente').length : 0;
  if (badge) {
    badge.textContent = count;
    badge.style.display = count > 0 ? '' : 'none';
  }
  if (sub) {
    sub.textContent = count > 0
      ? count + ' en attente de traitement'
      : 'Signaler un problème sur une commande';
  }
}

/* ── Reçu de commande (services facture) ──────────────────────────
   Bouton visible uniquement si le client a au moins une commande
   type === 'facture' — ouvre la modale de suivi déjà existante
   (openOrderTracking, voir plus haut) sur la commande la plus
   pertinente : celle en attente le plus récemment, sinon la plus
   récente tout statut confondu (pour revoir un reçu déjà livré). */
function _mostRelevantFactureOrder() {
  if (!currentUser) return null;
  const factures = DB.transactions.byClient(currentUser.id)
    .filter(t => t.type === 'facture')
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  if (!factures.length) return null;
  return factures.find(t => t.statut === 'en_attente') || factures[0];
}

function updateReceiptButtonVisibility() {
  const wrap = document.getElementById('receipt-btn-wrap');
  const sub  = document.getElementById('receipt-btn-sub');
  if (!wrap) return;
  const txn = _mostRelevantFactureOrder();
  if (!txn) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  if (sub) sub.textContent = txn.preuve_paiement ? 'Reçu disponible' : 'En cours de traitement';
}

function openReceiptSection() {
  if (!currentUser) return;
  const factures = DB.transactions.byClient(currentUser.id)
    .filter(t => t.type === 'facture')
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  if (!factures.length) return;
  renderReceiptsList(factures);
  openModal('modal-receipts-list');
}

function _rclDayLabel(dateStr) {
  const d = new Date(dateStr);
  const dayStr = d.toLocaleDateString('fr-CI', { day: '2-digit', month: 'short' });
  return d.toDateString() === new Date().toDateString() ? `Aujourd'hui, ${dayStr}` : dayStr;
}

function renderReceiptsList(factures) {
  const list = document.getElementById('rcl-list');
  if (!list) return;
  let lastDay = null;
  list.innerHTML = factures.map(t => {
    const hasProof = !!t.preuve_paiement;
    const thumb = hasProof
      ? `<div class="rcl-thumb rcl-thumb--ok"><i class="fa-solid fa-check"></i></div>`
      : `<div class="rcl-thumb rcl-thumb--pending"><i class="fa-solid fa-hourglass-half"></i></div>`;
    const dayKey = new Date(t.date).toDateString();
    const dayHtml = dayKey !== lastDay ? `<div class="rcl-day-label">${_rclDayLabel(t.date)}</div>` : '';
    lastDay = dayKey;
    return `
      ${dayHtml}
      <div class="rcl-row" onclick="openReceiptDetail('${t.id}')">
        ${thumb}
        <div class="rcl-row-main">
          <div class="rcl-row-ref">${Fmt.ref(t.id)}</div>
          <div class="rcl-row-date">${Fmt.datetime(t.date)}</div>
        </div>
        <div class="rcl-row-status ${hasProof ? 'rcl-row-status--ok' : 'rcl-row-status--pending'}">
          ${hasProof ? '<i class="fa-solid fa-circle-check"></i> Disponible' : '<i class="fa-solid fa-clock"></i> En attente'}
        </div>
        <i class="fa-solid fa-chevron-right rcl-row-chev"></i>
      </div>`;
  }).join('');
}

// Clic sur une ligne de la liste des reçus : affiche automatiquement la
// capture soumise par la cabine, ou un message d'attente clair si la
// preuve n'a pas encore été fournie — vue dédiée, plus directe que la
// modale de suivi complète (pas de frise/countdown/réclamation ici).
function openReceiptDetail(txnId) {
  const t = DB.transactions.byId(txnId);
  if (!t) return;
  const refEl  = document.getElementById('rcv-ref');
  const dateEl = document.getElementById('rcv-date');
  if (refEl)  refEl.textContent  = Fmt.ref(t.id);
  if (dateEl) dateEl.textContent = Fmt.datetime(t.date);

  const body = document.getElementById('rcv-body');
  if (body) {
    body.innerHTML = t.preuve_paiement
      ? `<img src="${t.preuve_paiement}" alt="Preuve de paiement" style="display:block;width:100%;border-radius:14px;border:1px solid rgba(255,255,255,.1);">`
      : `<div class="hx-empty"><div class="hx-empty-icon">⏳</div><div class="hx-empty-title">En cours de traitement</div><div class="hx-empty-sub">Le cabiniste n'a pas encore soumis la preuve de paiement pour cette commande.</div></div>`;
  }
  openModal('modal-receipt-detail');
}

let _openDetailTxnId = null;

function openOrderDetail(id) {
  const txns = DB.transactions.byClient(currentUser.id);
  const t = txns.find(x => x.id === id);
  if (!t) return;
  _openDetailTxnId = id;
  const isOk      = t.statut === 'terminé';
  const isPending = t.statut === 'en_attente';
  const isRfd     = t.statut === 'remboursé';
  const statusLbl = isOk ? 'Validée' : isPending ? 'En cours' : isRfd ? 'Remboursée' : 'Non validée';
  const statusIco = isOk ? 'fa-circle-check' : isPending ? 'fa-clock' : isRfd ? 'fa-rotate-left' : 'fa-circle-xmark';
  const statusKey = isOk ? 'ok' : isPending ? 'pend' : isRfd ? 'rfd' : 'fail';
  const d = t.details || {};
  const pm = PAYMENT_METHODS ? PAYMENT_METHODS.find(p => p.id === t.moyen_paiement) : null;

  // Récapitulatif de commande.
  const refCode      = Fmt.ref(t.id);
  const reseau        = t.operateur || d.network || d.debit_network || d.recep_network || '—';
  const emetteur       = Fmt.phone(currentUser.telephone) || '—';
  const destinataire  = Fmt.phone(t.numero_beneficiaire || d.numero || d.debit_numero) || '—';
  const moyenPaiement = pm ? pm.nom : '—';
  const numeroPaiement = t.numero_paiement ? Fmt.phone(t.numero_paiement) : '—';
  const heureCreation  = t.date ? new Date(t.date).toLocaleTimeString('fr-CI', { hour: '2-digit', minute: '2-digit' }) : '—';
  const validationTs   = isOk ? (t.date_fin || t.date_assignation || t.date) : (isRfd ? (t.date_remboursement || t.date) : null);
  const heureValidation = validationTs
    ? new Date(validationTs).toLocaleTimeString('fr-CI', { hour: '2-digit', minute: '2-digit' })
    : (isPending ? 'En attente' : (isRfd ? 'Remboursée' : 'Non validée'));

  document.getElementById('hx-detail-body').innerHTML = `
    <div class="hxtk-head">
      <div class="hxtk-head-row">
        <div class="hxtk-title">Détail de la commande</div>
        <button class="hxtk-close" onclick="closeOrderDetail()"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="hxtk-status">
        <div class="hxtk-status-ring hxtk-status-ring--${statusKey}"><i class="fa-solid ${statusIco}"></i></div>
        <div>
          <div class="hxtk-status-lbl">${statusLbl}</div>
          <div class="hxtk-status-sub">${Fmt.datetime(t.date)}</div>
        </div>
      </div>
      <span class="hxtk-notch-l"></span>
      <span class="hxtk-notch-r"></span>
    </div>
    <div class="hxtk-perf"></div>

    <div class="hxtk-body">
      <div class="hx-detail-rows">
        <div class="hx-detail-row"><span><i class="fa-solid fa-hashtag"></i> ID</span><strong>#${refCode}</strong></div>
        <div class="hx-detail-row"><span><i class="fa-solid fa-signal"></i> Réseau</span><strong>${reseau}</strong></div>
        <div class="hx-detail-row"><span><i class="fa-solid fa-paper-plane"></i> Créée à</span><strong>${heureCreation}</strong></div>
        <div class="hx-detail-row"><span><i class="fa-solid fa-circle-check"></i> Validée à</span><strong>${heureValidation}</strong></div>
        <div class="hx-detail-row"><span><i class="fa-solid fa-user"></i> Émetteur</span><strong>${emetteur}</strong></div>
        <div class="hx-detail-row"><span><i class="fa-solid fa-mobile-screen"></i> Destinataire</span><strong>${destinataire}</strong></div>
        <div class="hx-detail-row"><span><i class="fa-solid fa-wallet"></i> Moyen de paiement</span><strong>${moyenPaiement}</strong></div>
        <div class="hx-detail-row"><span><i class="fa-solid fa-phone"></i> N° paiement</span><strong>${numeroPaiement}</strong></div>
        <div class="hx-detail-row"><span><i class="fa-solid fa-coins"></i> Montant</span><strong>${Fmt.money(t.montant)}</strong></div>
      </div>

      <div class="hxtk-actions">
        <button class="hx-dl-btn" onclick="downloadReceipt('${t.id}')"><i class="fa-solid fa-download"></i> Télécharger</button>
        ${(t.type === 'facture' || t.type === 'recharge_uv' || t.type === 'exchange') && isPending ? `<button class="hx-dl-btn" onclick="closeOrderDetail(); openOrderTracking('${t.id}')"><i class="fa-solid fa-location-dot"></i> Suivre ma commande</button>` : ''}
      </div>
    </div>
  `;
  document.getElementById('hx-detail-overlay').classList.add('open');
}

function closeOrderDetail(e) {
  if (e && e.target !== document.getElementById('hx-detail-overlay')) return;
  document.getElementById('hx-detail-overlay').classList.remove('open');
  _openDetailTxnId = null;
}

/* ================================================================
   PORTEFEUILLE
   ================================================================ */
// Section "Portefeuille" (cs-portefeuille) — voir renderLockedSections()
// pour le bandeau "Espace privé" affiché en invité (déjà câblé), ici on ne
// peuple que #cs-portefeuille-content. Réutilise .sec-hero/.sec-chip
// (mêmes classes que le récap "Dépenses", voir loadDepenses() ci-dessus)
// plutôt que d'introduire un nouveau style.
function loadWallet() {
  if (!currentUser) return;
  const content = document.getElementById('cs-portefeuille-content');
  if (!content) return;
  const user = DB.users.byId(currentUser.id);
  const txns = DB.transactions.byClient(currentUser.id);
  const terminees = txns.filter(t => t.statut === 'terminé');
  const vol = terminees.reduce((s, t) => s + (t.montant || 0), 0);

  content.innerHTML = `
    <div class="sec-hero">
      <div class="sec-hero-icon"><i class="fa-solid fa-wallet"></i></div>
      <div class="sec-hero-amount">${Fmt.money(user.solde)}</div>
      <div class="sec-hero-label">Solde disponible</div>
      <div class="sec-hero-chips">
        <div class="sec-chip">
          <i class="fa-solid fa-receipt"></i>
          <span>${terminees.length} transaction${terminees.length > 1 ? 's' : ''} terminée${terminees.length > 1 ? 's' : ''}</span>
        </div>
        <div class="sec-chip">
          <i class="fa-solid fa-chart-line"></i>
          <span>${Fmt.money(vol)} au total</span>
        </div>
      </div>
    </div>
    <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:16px;" onclick="openRechargeModalGated()">
      <i class="fa-solid fa-arrow-up-from-bracket"></i> Recharger mon compte
    </button>
  `;
}

// Étape 1 de la recharge : champ de saisie libre + chips additifs.
function _rchSetAmount(val) {
  val = Math.max(0, val);
  const input = document.getElementById('recharge-amount');
  if (input) input.value = val || '';
}

function rchAddAmount(delta) {
  const cur = parseInt(document.getElementById('recharge-amount')?.value) || 0;
  _rchSetAmount(cur + delta);
}

// Grise/désactive les cartes réseau dont l'accès a été coupé spécifiquement
// pour la Recharge portefeuille (maintenance.networksByService.recharge,
// indépendant des autres services — voir isNetworkInMaintenanceForService,
// js/db.js).
async function _applyRechargeNetworkGating() {
  const cards = document.querySelectorAll('.rch-mth');
  for (const card of cards) {
    const blocked = await isNetworkInMaintenanceForService('recharge', card.dataset.method);
    card.style.opacity = blocked ? '.35' : '';
    card.style.pointerEvents = blocked ? 'none' : '';
  }
}

async function selectRchMethod(el) {
  const method = el.dataset.method;
  if (await isNetworkInMaintenanceForService('recharge', method)) { warnMaintenance(`${method} est actuellement indisponible pour la recharge.`); return; }
  document.querySelectorAll('.rch-mth').forEach(m => m.classList.remove('rch-mth--active'));
  el.classList.add('rch-mth--active');
  const color  = el.dataset.color || 'var(--primary)';
  document.getElementById('rch-method-hidden').value = method;
  // Champ numéro
  const wrap  = document.getElementById('rch-phone-wrap');
  const label = document.getElementById('rch-phone-label');
  label.textContent = 'Votre numéro ' + method;
  wrap.classList.add('rch-phone-wrap--open');
  wrap.style.setProperty('--rch-clr', color);
  document.getElementById('rch-phone').focus();
}

async function openRechargeModalGated() {
  if (await isServiceInMaintenance('recharger')) { warnMaintenance('La recharge de portefeuille est actuellement en maintenance.'); return; }
  document.getElementById('rch-step-2').style.display = 'none';
  const step1 = document.getElementById('rch-step-1');
  step1.style.display = 'block';
  step1.classList.remove('rch-step--enter'); void step1.offsetWidth; step1.classList.add('rch-step--enter');
  _rchSetAmount(0);
  await _applyRechargeNetworkGating();
  openModal('modal-recharge');
}

function rchGoStep2() {
  const montant = parseInt(document.getElementById('recharge-amount').value) || 0;
  if (montant < 1000) { Toast.error('Montant minimum : 1 000 FCFA.'); return; }
  document.getElementById('rch-step-1').style.display = 'none';
  const step2 = document.getElementById('rch-step-2');
  step2.style.display = 'block';
  step2.classList.remove('rch-step--enter'); void step2.offsetWidth; step2.classList.add('rch-step--enter');
}

function rchGoStep1() {
  document.getElementById('rch-step-2').style.display = 'none';
  const step1 = document.getElementById('rch-step-1');
  step1.style.display = 'block';
  step1.classList.remove('rch-step--enter'); void step1.offsetWidth; step1.classList.add('rch-step--enter');
}

async function handleRecharge(e) {
  e.preventDefault();
  if (!currentUser) { Toast.error('Connectez-vous pour recharger votre portefeuille.'); return; }
  const method  = document.getElementById('rch-method-hidden')?.value ||
                  document.querySelector('input[name="recharge-method"]:checked')?.value;
  const montant = parseInt(document.getElementById('recharge-amount').value) || 0;
  if (!method)        { Toast.error('Choisissez un mode de paiement.'); return; }
  if (montant < 1000) { Toast.error('Montant minimum : 1 000 FCFA.'); return; }
  const res = await DB.business.recharge(currentUser.id, montant, method);
  if (res.ok) {
    closeModal('modal-recharge');
    currentUser = Auth.refresh();
    Toast.success(`Portefeuille rechargé de ${Fmt.money(montant)} via ${method}.`);
    renderSoldeSection();
    refreshSoldeNumbers();
    refreshSidebarBalance();
    loadWallet();
    document.getElementById('recharge-form').reset();
    _rchSetAmount(0);
  } else {
    Toast.error(res.error);
  }
}

/* ================================================================
   PROFIL — coordonnées du client
   ================================================================ */
function uploadProfilePhoto(input) {
  if (!input.files || !input.files[0] || !currentUser) return;
  const reader = new FileReader();
  reader.onload = e => {
    const b64 = e.target.result;
    localStorage.setItem('cbp_photo_' + currentUser.id, b64);
    applyProfilePhoto(b64);
    Toast.success('Photo mise à jour.');
  };
  reader.readAsDataURL(input.files[0]);
}

function applyProfilePhoto(b64) {
  const el = document.getElementById('pc-avatar');
  if (!el) return;
  if (b64) {
    el.style.backgroundImage = `url(${b64})`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
    el.textContent = '';
  } else {
    el.style.backgroundImage = '';
    el.style.backgroundSize = '';
  }
}

function loadProfit() {
  const pLocked  = document.getElementById('cs-profit-locked');
  const pContent = document.getElementById('cs-profit-content');
  const pBar     = document.querySelector('#cs-profit .cs-sec-bar');
  if (!currentUser) {
    if (pLocked)  pLocked.style.display  = '';
    if (pContent) pContent.style.display = 'none';
    if (pBar)     pBar.style.display     = 'none';
    return;
  }
  if (pLocked)  pLocked.style.display  = 'none';
  if (pContent) pContent.style.display = '';
  if (pBar)     pBar.style.display     = '';
  const u   = DB.users.byId(currentUser.id);
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

  const isPhone  = /^0[0-9]{9}$/.test(u.prenom);
  const fullName = isPhone ? Fmt.phone(u.telephone) : (u.prenom + (u.nom ? ' ' + u.nom : '')).trim();

  // Avatar
  const savedPhoto = localStorage.getItem('cbp_photo_' + currentUser.id);
  if (savedPhoto) {
    applyProfilePhoto(savedPhoto);
  } else {
    const avatarEl = document.getElementById('pc-avatar');
    if (avatarEl) {
      avatarEl.style.backgroundImage = '';
      avatarEl.textContent = isPhone ? u.telephone.slice(-2) : Fmt.initials(u.nom, u.prenom);
    }
  }

  set('pc-name',  fullName || Fmt.phone(u.telephone));
  set('pc-tel',   '+225 ' + Fmt.phone(u.telephone));
  set('pc-solde', Fmt.money(u.solde));
  // Hero stats
  set('pc-solde-hero', Fmt.money(u.solde));
  set('pc-tel-hero', Fmt.phone(u.telephone));
  const txnCount = DB.transactions.byClient(currentUser.id).length;
  set('pc-txn-count', txnCount);


  // Date membre
  if (u.date_creation) {
    const d = new Date(u.date_creation);
    set('pc-date', d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' }));
  }

  // Parrainage
  renderParrainage(u);
  loadFavoris();
}

function renderParrainage(u) {
  const linkEl = document.getElementById('parrain-link');
  if (linkEl) linkEl.textContent = 'kbineplus.com/?ref=' + u.telephone;

  const countEl = document.getElementById('parrain-count');
  const totalEl = document.getElementById('parrain-total');
  if (countEl) countEl.textContent = DB.referrals.count();
  if (totalEl) totalEl.textContent = Fmt.money(DB.referrals.total());
  // Chiffres à jour dès l'ouverture (cache-first, comme DB.settings.get())
  // — voir api/referrals_summary.php.
  DB.referrals.refresh().then(() => {
    if (countEl) countEl.textContent = DB.referrals.count();
    if (totalEl) totalEl.textContent = Fmt.money(DB.referrals.total());
  });
}

// Section Partenaires (cs-partenaires) : pas de rendu de liste complexe
// comme les autres sections, juste le bloc parrainage — voir
// goPartenairesSection() et PullToRefresh.register() dans boot().
function loadPartenaires() {
  if (!currentUser) return;
  const u = DB.users.byId(currentUser.id);
  if (u) renderParrainage(u);
}

/* ── Mes favoris (numéros de destinataires) ────────────────────────
   Gérés depuis le profil, proposés en sélection rapide à l'étape
   "Numéro du destinataire" du Transfert direct — voir
   openContactsPicker() plus bas, qui les affiche au-dessus de la
   section "Récents" déjà existante. */
function loadFavoris() {
  if (!currentUser) return;
  if (!document.getElementById('favoris-list')) return;

  _renderFavorisList();

  // Rafraîchit depuis le serveur en tâche de fond (voir DB.favoris.refresh,
  // js/db.js) — un nouvel appareil retrouve ainsi ses favoris sans jamais
  // bloquer l'affichage sur le réseau (cache local affiché immédiatement
  // ci-dessus).
  DB.favoris.refresh(currentUser.id).then(_renderFavorisList);
}

function _renderFavorisList() {
  const list = document.getElementById('favoris-list');
  if (!list || !currentUser) return;

  const favoris = DB.favoris.forUser(currentUser.id);
  if (!favoris.length) {
    list.innerHTML = `<div style="font-size:.75rem;color:var(--gray-400);padding:8px 4px;">Aucun favori enregistré.</div>`;
    return;
  }

  list.innerHTML = favoris.map(f => `
    <div class="contact-item" style="cursor:default;">
      <div class="contact-avatar">${(f.nom || f.numero).slice(0, 2).toUpperCase()}</div>
      <div style="flex:1;min-width:0;">
        <div class="contact-name">${f.nom || Fmt.phone(f.numero)}</div>
        ${f.nom ? `<div class="contact-num">${Fmt.phone(f.numero)}</div>` : ''}
      </div>
      <button type="button" onclick="removeFavori('${f.id}')" title="Supprimer" style="background:none;border:none;color:#EF4444;cursor:pointer;padding:8px;flex-shrink:0;">
        <i class="fa-solid fa-trash"></i>
      </button>
    </div>`).join('');
}

async function addFavori() {
  if (!currentUser) return;
  const nom    = document.getElementById('fav-new-nom').value.trim();
  const numero = document.getElementById('fav-new-numero').value.replace(/\s/g, '');
  if (!/^0[0-9]{9}$/.test(numero)) { Toast.error('Numéro invalide — 10 chiffres commençant par 0.'); return; }

  await DB.favoris.create({ client_id: currentUser.id, nom, numero });
  document.getElementById('fav-new-nom').value = '';
  document.getElementById('fav-new-numero').value = '';
  Toast.success('Favori ajouté.');
  loadFavoris();
}

async function removeFavori(id) {
  if (!confirm('Supprimer ce favori ?')) return;
  await DB.favoris.remove(id);
  Toast.info('Favori supprimé.');
  loadFavoris();
}

function copyReferralLink() {
  const link = document.getElementById('parrain-link')?.textContent;
  if (!link || link === '—') return;
  const icon = document.getElementById('parrain-copy-icon');
  navigator.clipboard.writeText(link).then(() => {
    if (icon) { icon.className = 'fa-solid fa-check'; setTimeout(() => { icon.className = 'fa-solid fa-copy'; }, 2200); }
    Toast.success('Lien de parrainage copié !');
  }).catch(() => Toast.info('Votre lien : ' + link));
}

/* ================================================================
   FIDÉLITÉ
   ================================================================ */
function renderFidelite() {
  const total = 100;
  let count = 0;

  if (currentUser) {
    const txns = DB.transactions.byClient(currentUser.id);
    count = txns.filter(t => t.statut === 'terminé').length;
  }

  const pct   = Math.min((count / total) * 100, 100);
  const bar   = document.getElementById('fid-bar');
  const label = document.getElementById('fid-count');
  const hint  = document.getElementById('fid-hint');

  if (bar)   bar.style.width = pct + '%';
  if (label) label.textContent = count;

  if (!currentUser) {
    if (hint) hint.innerHTML = '<i class="fa-solid fa-lock"></i> Connectez-vous pour voir votre progression';
    return;
  }

  const remaining = total - count;
  if (hint) {
    hint.innerHTML = remaining > 0
      ? `<i class="fa-solid fa-fire"></i> Plus que ${remaining} commande${remaining > 1 ? 's' : ''} pour votre 🎂 !`
      : '🎉 Félicitations ! Votre gâteau surprise vous attend !';
  }

  [25, 50, 75, 100].forEach(ms => {
    const el = document.getElementById('fid-ms-' + ms);
    if (el) el.classList.toggle('reached', count >= ms);
  });

  const cake = document.getElementById('fid-cake-icon');
  if (cake && count >= total) {
    cake.style.filter = 'drop-shadow(0 0 8px rgba(245,158,11,.9))';
  }
}

/* ================================================================
   ESPACE PARTENAIRES — Auth Cabiniste
   ================================================================ */
function cabSwitchTab(tab) {
  document.getElementById('cab-panel-login').style.display    = tab === 'login'    ? 'block' : 'none';
  document.getElementById('cab-panel-register').style.display = tab === 'register' ? 'block' : 'none';
  document.getElementById('cab-tab-login').classList.toggle('active',    tab === 'login');
  document.getElementById('cab-tab-register').classList.toggle('active', tab === 'register');
  const banner = document.getElementById('cs4-banner-txt');
  if (banner) banner.textContent = tab === 'login'
    ? 'Saisissez votre numéro puis votre code PIN pour accéder à votre espace cabiniste.'
    : 'Renseignez vos informations pour créer votre compte cabiniste et rejoindre le réseau.';
  const pinWrap = document.getElementById('cs4-pin-wrap');
  if (pinWrap) { pinWrap.classList.remove('visible'); clearPinRow('cab-pin-login'); }
  if (tab === 'login') { const t = document.getElementById('cab-login-tel'); if (t) { t.value = ''; } }
}

/* Révèle le PIN cabine dès que le numéro est complet */
function onCabTelInput(input) {
  formatPhoneInput(input);
  const digits  = input.value.replace(/\D/g, '');
  const pinWrap = document.getElementById('cs4-pin-wrap');
  if (!pinWrap) return;
  if (digits.length === 10) {
    if (!pinWrap.classList.contains('visible')) {
      pinWrap.classList.add('visible');
      clearPinRow('cab-pin-login');
      setTimeout(() => document.querySelector('#cab-pin-login .cab3-pin')?.focus(), 260);
    }
  } else {
    pinWrap.classList.remove('visible');
    clearPinRow('cab-pin-login');
  }
}

async function handleCabineLogin(e) {
  e.preventDefault();
  const tel = (document.getElementById('cab-login-tel').value || '').replace(/\s/g, '');
  const pin = getPinValue('cab-pin-login');
  if (!/^[0-9]{10}$/.test(tel)) { Toast.error('Numéro invalide — 10 chiffres requis.'); return; }
  if (pin.length !== 4)          { Toast.error('Saisissez votre code PIN à 4 chiffres.'); return; }
  const res = await Auth.login(tel, pin, false, 'cabine');
  if (res.ok && res.user.role === 'cabine') {
    closeAuthModalAnimated(() => { window.location.href = 'cabine.html'; });
  } else if (res.ok) {
    Toast.error('Ce compte n\'est pas un compte cabiniste.');
    Auth.logout();
  } else {
    Toast.error(res.error || 'Numéro ou code incorrect.');
    clearPinRow('cab-pin-login');
  }
}

function handleCabineRegister(e) {
  e.preventDefault();
  const prenom = document.getElementById('cab-reg-prenom').value.trim();
  const nom    = document.getElementById('cab-reg-nom').value.trim();
  const tel    = (document.getElementById('cab-reg-tel').value || '').replace(/\s/g, '');
  const pin    = getPinValue('cab-pin-reg');
  if (!prenom || !nom)           { Toast.error('Prénom et nom requis.'); return; }
  if (!/^[0-9]{10}$/.test(tel)) { Toast.error('Numéro invalide — 10 chiffres requis.'); return; }
  if (pin.length !== 4)          { Toast.error('Choisissez un code PIN à 4 chiffres.'); return; }
  if (DB.users.byPhoneAndRole(tel, 'cabine')) { Toast.error('Ce numéro est déjà utilisé par un autre compte de ce type.'); return; }
  const user = DB.users.create({ prenom, nom, telephone: tel, pin, role: 'cabine', solde: 0, statut: 'actif' });
  Toast.success(`Compte cabiniste créé ! Bienvenue, ${prenom}.`);
  cabSwitchTab('login');
  clearPinRow('cab-pin-reg');
}

/* ================================================================
   PROFIL
   ================================================================ */
function loadProfile() {
  if (!currentUser) return;
  const u = DB.users.byId(currentUser.id);
  document.getElementById('prof-avatar').textContent       = Fmt.initials(u.nom, u.prenom);
  document.getElementById('prof-name').textContent         = u.prenom + ' ' + u.nom;
  document.getElementById('prof-prenom').value             = u.prenom;
  document.getElementById('prof-nom').value                = u.nom;
  document.getElementById('prof-tel').value                = u.telephone;
  document.getElementById('prof-email').value              = u.email;
  document.getElementById('prof-member-since').textContent = Fmt.date(u.date_creation);
  const txns = DB.transactions.byClient(u.id);
  document.getElementById('prof-txn-count').textContent    = txns.length;
  document.getElementById('prof-solde').textContent        = Fmt.money(u.solde);
}

function handleProfileUpdate(e) {
  e.preventDefault();
  DB.users.update(currentUser.id, {
    prenom: document.getElementById('prof-prenom').value.trim(),
    nom:    document.getElementById('prof-nom').value.trim(),
    email:  document.getElementById('prof-email').value.trim(),
  });
  currentUser = Auth.refresh();
  renderClientNav();
  loadProfile();
  Toast.success('Profil mis à jour avec succès.');
}

function handlePasswordChange(e) {
  e.preventDefault();
  const current = document.getElementById('pwd-current').value;
  const newPwd  = document.getElementById('pwd-new').value;
  const confirm = document.getElementById('pwd-confirm').value;
  const user    = DB.users.byId(currentUser.id);
  if (!DB.users.checkPwd(user, current)) { Toast.error('Mot de passe actuel incorrect.'); return; }
  if (newPwd.length < 6)                  { Toast.error('Minimum 6 caractères requis.'); return; }
  if (newPwd !== confirm)                 { Toast.error('Les mots de passe ne correspondent pas.'); return; }
  DB.users.update(currentUser.id, { mot_de_passe: newPwd });
  document.getElementById('pwd-form').reset();
  Toast.success('Mot de passe modifié avec succès.');
}

/* ================================================================
   REÇU PDF
   ================================================================ */
function downloadReceipt(txnId) {
  const t = DB.transactions.byId(txnId);
  if (!t) return;
  const d = t.details || {};
  const client = DB.users.byId(t.client_id);
  const isOk      = t.statut === 'terminé';
  const isPending = t.statut === 'en_attente';
  const statutLbl   = isOk ? 'Validée' : isPending ? 'En cours' : 'Non validée';
  const statutColor = isOk ? '#009A44' : isPending ? '#f59e0b' : '#ef4444';
  const pm = PAYMENT_METHODS ? PAYMENT_METHODS.find(p => p.id === t.moyen_paiement) : null;

  const reseau         = t.operateur || d.network || d.debit_network || d.recep_network || '—';
  const emetteur        = Fmt.phone(client && client.telephone) || '—';
  const destinataire   = Fmt.phone(t.numero_beneficiaire || d.numero || d.debit_numero) || '—';
  const moyenPaiement  = pm ? pm.nom : '—';
  const numeroPaiement = t.numero_paiement ? Fmt.phone(t.numero_paiement) : '—';
  const heureCreation   = t.date ? new Date(t.date).toLocaleTimeString('fr-CI', { hour: '2-digit', minute: '2-digit' }) : '—';
  const validationTs    = isOk ? (t.date_fin || t.date_assignation || t.date) : null;
  const heureValidation = validationTs
    ? new Date(validationTs).toLocaleTimeString('fr-CI', { hour: '2-digit', minute: '2-digit' })
    : (isPending ? 'En attente' : 'Non validée');

  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>Reçu KBINE PLUS</title>
<style>
  body{font-family:'Segoe UI',sans-serif;max-width:400px;margin:40px auto;padding:20px;color:#333}
  .sub{text-align:center;color:#888;font-size:.8rem;margin-bottom:20px}
  hr{border:none;border-top:2px dashed #ddd;margin:16px 0}
  .row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f5f5f5;font-size:.87rem}
  .label{color:#888}.value{font-weight:700}
  .footer{text-align:center;color:#bbb;font-size:.72rem;margin-top:20px}
</style></head><body>
<img src="img/logo.png" alt="KBINE PLUS" style="width:80px;height:80px;object-fit:contain;display:block;margin:0 auto 4px;">
<div class="sub">Reçu de transaction · Côte d'Ivoire 🇨🇮</div>
<hr>
<div class="row"><span class="label">ID</span><span class="value">${Fmt.ref(t.id)}</span></div>
<div class="row"><span class="label">Réseau</span><span class="value">${reseau}</span></div>
<div class="row"><span class="label">Créée à</span><span class="value">${heureCreation}</span></div>
<div class="row"><span class="label">Validée à</span><span class="value">${heureValidation}</span></div>
<div class="row"><span class="label">Émetteur</span><span class="value">${emetteur}</span></div>
<div class="row"><span class="label">Destinataire</span><span class="value">${destinataire}</span></div>
<div class="row"><span class="label">Moyen de paiement</span><span class="value">${moyenPaiement}</span></div>
<div class="row"><span class="label">N° paiement</span><span class="value">${numeroPaiement}</span></div>
<div class="row"><span class="label">Montant</span><span class="value">${t.montant.toLocaleString('fr-CI')} FCFA</span></div>
<div class="row"><span class="label">Statut</span><span class="value" style="color:${statutColor}">${statutLbl}</span></div>
<div class="row"><span class="label">Date</span><span class="value">${new Date(t.date).toLocaleString('fr-CI')}</span></div>
<div class="footer">Merci d'utiliser KBINE PLUS · Service de transfert d'unités téléphoniques<br>© ${new Date().getFullYear()} KBINE PLUS Côte d'Ivoire</div>
<div style="text-align:center;margin-top:20px">
  <button onclick="window.print()" style="padding:10px 24px;background:#FF6200;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:700">
    🖨️ Imprimer / Sauvegarder PDF
  </button>
</div>
</body></html>`);
  win.document.close();
}

window.addEventListener('DOMContentLoaded', boot);

/* ── Barre du bas : masquée pendant le défilement, réapparaît à l'arrêt ── */
let _bnScrollHideTimer = null;
function _bnHandleScroll() {
  const nav = document.querySelector('.bottom-nav');
  if (!nav) return;
  nav.classList.add('bottom-nav--scroll-hidden');
  clearTimeout(_bnScrollHideTimer);
  _bnScrollHideTimer = setTimeout(() => {
    nav.classList.remove('bottom-nav--scroll-hidden');
  }, 500);
}
window.addEventListener('scroll', _bnHandleScroll, { passive: true });

/* ── Masquer / afficher le solde ───────────────────────────────
   Style "points nets" (pas de flou) : le texte réel (stocké dans
   data-value) est remplacé par des points qui reprennent le même
   gabarit ("46 470 F" → "•• ••• F"), avec un petit fondu/zoom
   au basculement (voir .pgc-balance-swap). */
function _maskMoney(text) { return text.replace(/\d/g, '•'); }

function _setBalanceValue(formatted) {
  const el = document.getElementById('hbc-amount');
  if (!el) return;
  el.dataset.value = formatted;
  el.textContent = localStorage.getItem('kbine_bal_hidden') === 'true'
    ? _maskMoney(formatted) : formatted;
}

function toggleBalanceVisibility() {
  const el = document.getElementById('hbc-amount');
  const icon = document.getElementById('pgc-eye-icon');
  if (!el) return;
  const hidden = localStorage.getItem('kbine_bal_hidden') !== 'true';
  localStorage.setItem('kbine_bal_hidden', hidden);
  if (icon) icon.className = hidden ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
  el.classList.remove('pgc-balance-swap');
  void el.offsetWidth; // relance l'animation même si elle vient de tourner
  el.classList.add('pgc-balance-swap');
  setTimeout(() => {
    el.textContent = hidden ? _maskMoney(el.dataset.value || '') : (el.dataset.value || '');
  }, 160);
  el.addEventListener('animationend', () => el.classList.remove('pgc-balance-swap'), { once: true });
}

function initBalanceVisibility() {
  const icon = document.getElementById('pgc-eye-icon');
  if (localStorage.getItem('kbine_bal_hidden') === 'true' && icon) {
    icon.className = 'fa-solid fa-eye-slash';
  }
}
document.addEventListener('DOMContentLoaded', initBalanceVisibility);

/* Mode sombre retiré de l'espace client : on s'assure qu'aucun ancien
   réglage enregistré (localStorage) ne réactive silencieusement le
   thème sombre au chargement. */
document.body.classList.remove('dark');
localStorage.removeItem('kbine_dark');

// Annonces KBINE PLUS gérées par l'admin (voir loadActualitesAdmin(),
// js/admin.js) — remplace l'ancien bandeau Football/Politique codé en dur
// (aucun rapport avec l'app, jamais réellement "temps réel" : rendre ça
// réel nécessiterait un abonnement à une API d'actualités externe, hors
// scope). Lu via DB.settings.get() (déjà synchronisé, cache-first —
// aucun nouvel endpoint nécessaire).
async function renderActualites() {
  const list = document.getElementById('actu-kbine-list');
  const section = document.getElementById('actu-section');
  if (!list) return;
  const items = ((await DB.settings.get()).actualites || []).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  if (!items.length) {
    if (section) section.style.display = 'none';
    list.innerHTML = '';
    return;
  }
  if (section) section.style.display = '';
  const [featured, ...rest] = items;
  list.innerHTML = `
    <div class="actu-featured">
      <div class="actu-featured-top">
        <div class="actu-cat actu-cat--kbine">KBINE PLUS</div>
        <div class="actu-meta"><i class="fa-solid fa-clock"></i> ${Fmt.datetime(featured.date)}</div>
      </div>
      <div class="actu-featured-title">${featured.titre}</div>
      ${featured.message ? `<div style="font-size:.68rem;color:rgba(255,255,255,.6);margin-top:4px;">${featured.message}</div>` : ''}
    </div>
    <div class="actu-mini-list">
      ${rest.map(a => `
        <div class="actu-mini-item">
          <span class="actu-mini-dot actu-mini-dot--kbine"></span>
          <span class="actu-mini-title">${a.titre}</span>
          <span class="actu-mini-time">${Fmt.datetime(a.date)}</span>
        </div>`).join('')}
    </div>
  `;
}


/* ================================================================
   TRANSFERT CLIENT À CLIENT
   ================================================================ */
let _ctData = {};

function _ctSetStep(step) {
  const text = document.getElementById('ct-step-text');
  if (text) text.textContent = `Étape ${step}/2`;
  const seg1 = document.getElementById('ct-step-seg-1');
  const seg2 = document.getElementById('ct-step-seg-2');
  if (seg1) seg1.classList.toggle('done', step >= 1);
  if (seg2) seg2.classList.toggle('done', step >= 2);
}

async function openClientTransferModal() {
  if (await isServiceInMaintenance('transferer')) { warnMaintenance('Le transfert entre clients est actuellement en maintenance.'); return; }
  if (!Auth.current()) { openPrivateSpaceNotice('Connectez-vous pour transférer de l\'argent à un autre client.'); return; }
  _ctData = {};
  document.getElementById('ct-phone').value   = '';
  document.getElementById('ct-amount').value  = '';
  document.getElementById('ct-recipient-preview').style.display = 'none';
  document.getElementById('ct-error').style.display = 'none';
  document.getElementById('client-transfer-form').style.display = 'block';
  document.getElementById('ct-step-recap').style.display = 'none';
  _ctSetStep(1);
  const hint = document.getElementById('ct-solde-hint');
  if (hint) {
    const u = DB.users.byId(Auth.current().id);
    hint.textContent = 'Solde disponible : ' + Fmt.money(u ? u.solde : 0);
  }
  openModal('modal-client-transfer');
}

function ctGoBackToForm() {
  document.getElementById('client-transfer-form').style.display = 'block';
  document.getElementById('ct-step-recap').style.display = 'none';
  _ctSetStep(1);
}

function lookupTransferRecipient() {
  const phone   = (document.getElementById('ct-phone')?.value || '').replace(/\s/g,'');
  const preview = document.getElementById('ct-recipient-preview');
  const error   = document.getElementById('ct-error');
  if (!preview || !error) return;
  preview.style.display = 'none';
  error.style.display   = 'none';
  if (!/^[0-9]{10}$/.test(phone)) return;

  const me = Auth.current();
  if (me && phone === me.telephone) {
    error.textContent = 'Vous ne pouvez pas vous transférer de l\'argent à vous-même.';
    error.style.display = 'block';
    return;
  }

  const recipient = DB.users.byPhone(phone);
  if (!recipient || recipient.role !== 'client' || recipient.statut === 'suspendu') {
    error.textContent = 'Aucun compte client actif trouvé pour ce numéro.';
    error.style.display = 'block';
    return;
  }

  const nameEl   = document.getElementById('ct-recipient-name');
  const avatarEl = document.getElementById('ct-rcp-avatar');
  const fullName = (recipient.prenom + ' ' + recipient.nom).trim();
  if (nameEl)   nameEl.textContent   = fullName;
  if (avatarEl) avatarEl.textContent = (recipient.prenom[0] || '?').toUpperCase();
  preview.style.display = 'flex';
}

function handleClientTransfer(e) {
  e.preventDefault();
  const me = Auth.current();
  if (!me) { openPartnerAuthModal(); return; }

  const phone  = (document.getElementById('ct-phone')?.value  || '').replace(/\s/g,'');
  const amount = parseInt(document.getElementById('ct-amount')?.value || '0', 10);
  const error  = document.getElementById('ct-error');

  error.style.display = 'none';

  const showError = (msg) => { error.textContent = msg; error.style.display = 'block'; };

  if (!/^[0-9]{10}$/.test(phone))    return showError('Numéro de compte invalide.');
  if (!amount || amount < 100)        return showError('Montant minimum : 100 FCFA.');
  if (phone === me.telephone)         return showError('Impossible de vous transférer à vous-même.');

  const sender    = DB.users.byId(me.id);
  const recipient = DB.users.byPhone(phone);

  if (!recipient || recipient.role !== 'client' || recipient.statut === 'suspendu')
    return showError('Destinataire introuvable ou compte inactif.');
  if ((sender.solde || 0) < amount)
    return showError('Solde insuffisant — disponible : ' + Fmt.money(sender.solde || 0));

  _ctData = { phone, amount, recipientId: recipient.id, destName: (recipient.prenom + ' ' + recipient.nom).trim() };

  const rows = [
    { label: 'Destinataire', value: _ctData.destName },
    { label: 'Numéro',       value: Fmt.phone(phone) },
  ];
  document.getElementById('ct-recap-content').innerHTML = _svcRecapHTML(rows, amount, 0);
  document.getElementById('client-transfer-form').style.display = 'none';
  document.getElementById('ct-step-recap').style.display = 'block';
  _ctSetStep(2);
}

function ctConfirmTransfer() {
  const me = Auth.current();
  if (!me || !_ctData.recipientId) return;

  const sender    = DB.users.byId(me.id);
  const recipient = DB.users.byId(_ctData.recipientId);
  if (!recipient) { Toast.error('Destinataire introuvable.'); return; }
  if ((sender.solde || 0) < _ctData.amount) {
    Toast.error('Solde insuffisant — disponible : ' + Fmt.money(sender.solde || 0));
    ctGoBackToForm();
    return;
  }

  DB.users.updateSolde(me.id, -_ctData.amount);
  DB.users.updateSolde(recipient.id, _ctData.amount);

  DB.transactions.create({
    client_id: me.id,
    type: 'transfert_client',
    sens: 'envoi',
    montant: _ctData.amount,
    destinataire_nom: _ctData.destName,
    destinataire_tel: recipient.telephone,
    statut: 'terminé',
  });

  currentUser = Auth.refresh();
  closeModal('modal-client-transfer');
  renderSoldeSection();
  refreshSidebarBalance();
  loadWallet();
  loadProfit();
  Toast.success(Fmt.money(_ctData.amount) + ' transféré avec succès à ' + _ctData.destName + ' !');
}

/* ══════════════════════════════════════════════════════════════
   SERVICES AVANCÉS – helpers communs
══════════════════════════════════════════════════════════════ */
const FRAIS_SERVICE_AVANCE = 200;

function _svcCheckSolde(montant) {
  const me = Auth.current();
  if (!me) return false;
  const user = DB.users.byId(me.id);
  const total = montant + FRAIS_SERVICE_AVANCE;
  if ((user.solde || 0) < total) {
    Toast.error('Solde insuffisant — disponible : ' + Fmt.money(user.solde || 0) + ' (total requis : ' + Fmt.money(total) + ')');
    return false;
  }
  return true;
}

async function _svcDebitAndRecord(data) {
  const me = Auth.current();
  if (!me) return null;
  if (data.type === 'recharge_uv' && data.montant < 10000) {
    Toast.error('Montant minimum : 10 000 FCFA.');
    return null;
  }
  if (data.type === 'facture') {
    const fm = (await DB.settings.get()).maintenance?.factureServices?.[data.details?.service];
    if (fm?.blocked) { Toast.error(fm.message || 'Service momentanément indisponible.'); return null; }
  }
  if (data.type === 'exchange') {
    const nets = (await DB.settings.get()).maintenance?.networksByService?.exchange || {};
    const debit = normalizeMaintenanceNetwork(data.details?.debit_network);
    const recep = normalizeMaintenanceNetwork(data.details?.recep_network);
    if ((debit && nets[debit]) || (recep && nets[recep])) {
      Toast.error('Un des réseaux choisis est temporairement indisponible.');
      return null;
    }
  }
  const total = data.montant + FRAIS_SERVICE_AVANCE;
  DB.users.updateSolde(me.id, -total);
  const cabineId = me.cabine_id || null;
  const txn = DB.transactions.create({
    client_id      : me.id,
    cabine_id      : cabineId,
    type           : data.type,
    service        : data.service || '',
    operateur      : data.operateur || '',
    numero_beneficiaire: data.numero || '',
    montant        : data.montant,
    frais_service  : FRAIS_SERVICE_AVANCE,
    details        : data.details || {},
    statut         : 'en_attente',
    date           : new Date().toISOString(),
    notes          : data.notes || '',
  });
  currentUser = Auth.refresh();
  _markOrderSubmitted();
  renderSoldeSection();
  refreshSidebarBalance();
  loadWallet();
  return txn;
}

// Récapitulatif générique, réutilisé par toutes les commandes payées avec
// le solde disponible (objectif "récap obligatoire" + "moyen de paiement
// choisi" toujours visible). `frais` optionnel : 0 pour un service gratuit
// (ex. transfert client→client), sinon le frais de service avancé standard.
function _svcRecapHTML(rows, montant, frais = FRAIS_SERVICE_AVANCE) {
  rows = [{ label: 'Moyen de paiement', value: 'Solde disponible' }, ...rows];
  const total = montant + frais;
  let html = '<div class="svc-recap-rows">';
  rows.forEach(r => {
    html += `<div class="svc-recap-row"><span>${r.label}</span><strong>${r.value}</strong></div>`;
  });
  html += `<div class="svc-recap-row"><span>Montant</span><strong>${Fmt.money(montant)}</strong></div>`;
  if (frais > 0) html += `<div class="svc-recap-row"><span>Frais de service</span><strong>${Fmt.money(frais)}</strong></div>`;
  html += `<div class="svc-recap-row svc-recap-row--total"><span>${frais > 0 ? 'Total prélevé' : 'Total débité'}</span><strong>${Fmt.money(total)}</strong></div>`;
  html += '</div>';
  return html;
}

/* ══════════════════════════════════════════════════════════════
   MODAL FACTURE
══════════════════════════════════════════════════════════════ */
let _factService = '';
let _factData    = {};
let _factPickedService = '';

function _factAnimateStep(el) {
  if (!el) return;
  el.classList.remove('rch-step--enter'); void el.offsetWidth; el.classList.add('rch-step--enter');
}

function _factScrollTop() {
  const modal = document.querySelector('#modal-facture .svc-modal');
  if (modal) modal.scrollTo({ top: 0, behavior: 'smooth' });
}

function _factSetStep(step) {
  for (let i = 1; i <= 4; i++) {
    const dot = document.getElementById(`fact-dot-${i}`);
    if (dot) {
      dot.classList.remove('done', 'current');
      if (i < step)       { dot.classList.add('done'); dot.innerHTML = '<i class="fa-solid fa-check"></i>'; }
      else if (i === step) { dot.classList.add('current'); dot.textContent = i; }
      else                  { dot.textContent = i; }
    }
    if (i < 4) {
      const line = document.getElementById(`fact-line-${i}`);
      if (line) line.classList.toggle('done', i < step);
    }
  }
}

// Grise/désactive les cartes de service dont l'accès a été coupé (voir
// maintenance.factureServices, js/db.js) — un service désactivé n'est plus
// sélectionnable, un clic affiche son message personnalisé (voir
// factPickService ci-dessous).
async function _applyFactureServiceGating() {
  const cards = document.querySelectorAll('.fact-svc-card');
  for (const card of cards) {
    const blocked = !!(await DB.settings.get()).maintenance?.factureServices?.[card.dataset.service]?.blocked;
    card.style.opacity = blocked ? '.35' : '';
    card.style.pointerEvents = blocked ? 'none' : '';
  }
}

async function openFactureModal() {
  if (await isServiceInMaintenance('facture')) { warnMaintenance('Le paiement de factures est actuellement en maintenance.'); return; }
  if (!Auth.current()) { openPrivateSpaceNotice('Connectez-vous pour accéder à vos factures.'); return; }
  _factService = '';
  _factData    = {};
  _factPickedService = '';
  document.querySelectorAll('.fact-svc-card').forEach(c => c.classList.remove('active'));
  const continueBtn = document.getElementById('fact-select-continue-btn');
  if (continueBtn) continueBtn.style.display = 'none';
  const step1 = document.getElementById('fact-step-select');
  step1.style.display = 'block';
  document.getElementById('fact-step-form').style.display   = 'none';
  document.getElementById('fact-step-recap').style.display  = 'none';
  document.getElementById('fact-step-confirm').style.display = 'none';
  _factAnimateStep(step1);
  _factSetStep(1);
  await _applyFactureServiceGating();
  openModal('modal-facture');
}

async function factPickService(service, el) {
  const fm = (await DB.settings.get()).maintenance?.factureServices?.[service];
  if (fm?.blocked) { Toast.error(fm.message || 'Service momentanément indisponible.'); return; }
  document.querySelectorAll('.fact-svc-card').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  _factPickedService = service;
  const continueBtn = document.getElementById('fact-select-continue-btn');
  if (continueBtn) continueBtn.style.display = 'flex';
}

function factConfirmService() {
  if (!_factPickedService) { Toast.error('Veuillez choisir un service.'); return; }
  selectFactureService(_factPickedService);
}

function selectFactureService(service) {
  _factService = service;
  _factData    = {};
  document.getElementById('fact-step-select').style.display = 'none';
  const step2 = document.getElementById('fact-step-form');
  step2.style.display = 'block';
  document.getElementById('fact-step-recap').style.display  = 'none';
  document.getElementById('fact-form-content').innerHTML    = _factBuildForm(service);
  _factAnimateStep(step2);
  _factSetStep(2);
  _factScrollTop();
}

function _factBuildForm(service) {
  const netRow = `
    <div class="svc-net-row">
      <div class="svc-net-btn fact-net" style="--net-clr:#FF6200" onclick="factSelectNetwork('Orange Money',this)">
        <div class="svc-net-btn-check"><i class="fa-solid fa-check"></i></div>
        <span class="fact-logo-crop"><img src="img/logos/orange.png" alt="Orange" style="transform:scale(1.35);" onerror="this.parentElement.outerHTML='<span style=font-size:1.3rem>🟠</span>'"></span>
        <span>Orange Money</span>
      </div>
      <div class="svc-net-btn fact-net" style="--net-clr:#FFCC00" onclick="factSelectNetwork('MTN MoMo',this)">
        <div class="svc-net-btn-check"><i class="fa-solid fa-check"></i></div>
        <span class="fact-logo-crop"><img src="img/logos/mtn.jpg" alt="MTN" style="transform:scale(1.15);" onerror="this.parentElement.outerHTML='<span style=font-size:1.3rem>🟡</span>'"></span>
        <span>MTN MoMo</span>
      </div>
      <div class="svc-net-btn fact-net" style="--net-clr:#1DC7FF" onclick="factSelectNetwork('Wave',this)">
        <div class="svc-net-btn-check"><i class="fa-solid fa-check"></i></div>
        <span class="fact-logo-crop"><img src="img/logos/wave.png" alt="Wave" style="transform:scale(1.15);" onerror="this.parentElement.outerHTML='<span style=font-size:1.5rem>🌊</span>'"></span>
        <span>Wave</span>
      </div>
      <div class="svc-net-btn fact-net" style="--net-clr:#FF4E6A" onclick="factSelectNetwork('Djamo',this)">
        <div class="svc-net-btn-check"><i class="fa-solid fa-check"></i></div>
        <span class="fact-logo-crop"><img src="img/logos/djamo.png" alt="Djamo" style="transform:scale(1.3);" onerror="this.parentElement.outerHTML='<span style=font-size:1.3rem>💳</span>'"></span>
        <span>Djamo</span>
      </div>
      <div class="svc-net-btn fact-net" style="--net-clr:#22C55E" onclick="factSelectNetwork('Solde disponible',this)">
        <div class="svc-net-btn-check"><i class="fa-solid fa-check"></i></div>
        <i class="fa-solid fa-wallet" style="font-size:1.4rem;color:#22C55E;"></i>
        <span>Solde disponible</span>
      </div>
    </div>
    <div class="svc-field" id="fact-pay-number-field" style="display:none;">
      <label class="svc-label"><i class="fa-solid fa-phone"></i> Numéro du moyen de paiement</label>
      <input type="tel" id="fact-pay-number" class="svc-input" placeholder="Ex : 07 00 00 00 00" maxlength="10" oninput="_factData.payNumber = this.value">
    </div>`;

  const netCard = `
    <div class="svc-step-head">
      <div class="svc-step-head-ico"><i class="fa-solid fa-tower-broadcast"></i></div>
      <div class="svc-step-head-title">Réseau de paiement</div>
    </div>
    ${netRow}`;

  if (service === 'cie_prepaye' || service === 'cie_facture' || service === 'sodeci') {
    const label = service === 'cie_prepaye' ? 'Prépayé CIE' : (service === 'cie_facture' ? 'Facture CIE' : 'SODECI');
    const refLabel = service === 'cie_prepaye' ? 'Numéro compteur' : 'Référence facture';
    return `
      <div class="svc-step-head">
        <div class="svc-step-head-ico"><i class="fa-solid fa-file-invoice"></i></div>
        <div class="svc-step-head-title">${label}</div>
      </div>
      <div class="svc-field">
        <label class="svc-label"><i class="fa-solid fa-hashtag"></i> ${refLabel}</label>
        <input type="text" id="fact-ref" class="svc-input" placeholder="Ex : 01234567">
      </div>
      <div class="svc-field">
        <label class="svc-label"><i class="fa-solid fa-coins"></i> Montant (F)</label>
        <input type="number" id="fact-amount" class="svc-input" placeholder="Montant" min="100">
      </div>
      ${netCard}
      <button class="svc-continue-btn" onclick="factShowRecap()">Voir récapitulatif <i class="fa-solid fa-arrow-right"></i></button>`;
  }

  if (service === 'canal_plus') {
    return `
      <div class="svc-step-head">
        <div class="svc-step-head-ico"><i class="fa-solid fa-tv"></i></div>
        <div class="svc-step-head-title">CANAL+</div>
      </div>
      <div class="svc-field">
        <label class="svc-label"><i class="fa-solid fa-id-card"></i> Numéro abonné</label>
        <input type="text" id="fact-ref" class="svc-input" placeholder="Numéro abonné CANAL+">
      </div>
      <div class="svc-field">
        <label class="svc-label"><i class="fa-solid fa-list-check"></i> Formule</label>
        <div class="svc-offers-grid">
          <div class="svc-offer-card" onclick="factSelectOffer('Access',5000,this)"><div>Access</div><div style="font-weight:700;color:#fbbf24;">5 000 FCFA</div></div>
          <div class="svc-offer-card" onclick="factSelectOffer('Évasion',10000,this)"><div>Évasion</div><div style="font-weight:700;color:#fbbf24;">10 000 FCFA</div></div>
          <div class="svc-offer-card" onclick="factSelectOffer('Access+',15000,this)"><div>Access+</div><div style="font-weight:700;color:#fbbf24;">15 000 FCFA</div></div>
          <div class="svc-offer-card" onclick="factSelectOffer('Tout Canal',25000,this)"><div>Tout Canal</div><div style="font-weight:700;color:#fbbf24;">25 000 FCFA</div></div>
        </div>
      </div>
      ${netCard}
      <button class="svc-continue-btn" onclick="factShowRecap()">Voir récapitulatif <i class="fa-solid fa-arrow-right"></i></button>`;
  }

  if (service === 'canalbox') {
    return `
      <div class="svc-step-head">
        <div class="svc-step-head-ico"><i class="fa-solid fa-wifi"></i></div>
        <div class="svc-step-head-title">CANALBOX</div>
      </div>
      <div class="svc-field">
        <label class="svc-label"><i class="fa-solid fa-id-card"></i> Numéro abonné</label>
        <input type="text" id="fact-ref" class="svc-input" placeholder="Numéro abonné CANALBOX">
      </div>
      <div class="svc-field">
        <label class="svc-label"><i class="fa-solid fa-list-check"></i> Offre</label>
        <div class="svc-offers-grid">
          <div class="svc-offer-card" onclick="factSelectOffer('Start',15000,this)"><div>Start</div><div style="font-weight:700;color:#fbbf24;">15 000 FCFA/mois</div></div>
          <div class="svc-offer-card" onclick="factSelectOffer('Premium',30000,this)"><div>Premium</div><div style="font-weight:700;color:#fbbf24;">30 000 FCFA/mois</div></div>
        </div>
      </div>
      <div class="svc-field">
        <label class="svc-label"><i class="fa-solid fa-calendar"></i> Durée</label>
        <div class="svc-dur-row">
          <div class="svc-dur-btn" onclick="factSelectDuration(1,this)">1 mois</div>
          <div class="svc-dur-btn" onclick="factSelectDuration(3,this)">3 mois</div>
          <div class="svc-dur-btn" onclick="factSelectDuration(6,this)">6 mois</div>
          <div class="svc-dur-btn" onclick="factSelectDuration(12,this)">12 mois</div>
        </div>
      </div>
      <div id="fact-canalbox-total" style="text-align:center;font-weight:700;color:#fbbf24;font-size:.9rem;margin:8px 0 4px;display:none;"></div>
      ${netCard}
      <button class="svc-continue-btn" onclick="factShowRecap()">Voir récapitulatif <i class="fa-solid fa-arrow-right"></i></button>`;
  }

  if (service === 'sotra') {
    return `
      <div class="svc-step-head">
        <div class="svc-step-head-ico"><i class="fa-solid fa-bus"></i></div>
        <div class="svc-step-head-title">SOTRA</div>
      </div>
      <div class="svc-field">
        <label class="svc-label"><i class="fa-solid fa-credit-card"></i> Numéro de carte SOTRA</label>
        <input type="text" id="fact-ref" class="svc-input" placeholder="Numéro de carte">
      </div>
      <div class="svc-field">
        <label class="svc-label"><i class="fa-solid fa-coins"></i> Montant (F)</label>
        <input type="number" id="fact-amount" class="svc-input" placeholder="Montant" min="500">
      </div>
      ${netCard}
      <button class="svc-continue-btn" onclick="factShowRecap()">Voir récapitulatif <i class="fa-solid fa-arrow-right"></i></button>`;
  }

  return '';
}

async function factSelectNetwork(net, el) {
  if (net !== 'Solde disponible' && await isNetworkInMaintenance(net)) { warnMaintenance(`Le réseau ${net} est actuellement en maintenance.`); return; }
  document.querySelectorAll('.fact-net').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  _factData.network = net;
  _factData.payNumber = '';
  const field = document.getElementById('fact-pay-number-field');
  const input = document.getElementById('fact-pay-number');
  if (input) input.value = '';
  if (field) field.style.display = (net === 'Solde disponible') ? 'none' : '';
}

function factSelectOffer(name, price, el) {
  document.querySelectorAll('.svc-offer-card').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  _factData.offer      = name;
  _factData.offerPrice = price;
  if (_factService === 'canalbox') _updateCanalboxTotal();
}

function factSelectDuration(months, el) {
  document.querySelectorAll('.svc-dur-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  _factData.duration = months;
  if (_factService === 'canalbox') _updateCanalboxTotal();
}

function _updateCanalboxTotal() {
  const totalEl = document.getElementById('fact-canalbox-total');
  if (!totalEl) return;
  if (_factData.offerPrice && _factData.duration) {
    const t = _factData.offerPrice * _factData.duration;
    _factData.montant = t;
    totalEl.textContent = 'Total : ' + Fmt.money(t);
    totalEl.style.display = 'block';
  }
}

function factGoBack() {
  const step1 = document.getElementById('fact-step-select');
  step1.style.display = 'block';
  document.getElementById('fact-step-form').style.display   = 'none';
  document.getElementById('fact-step-recap').style.display  = 'none';
  _factAnimateStep(step1);
  _factSetStep(1);
  _factScrollTop();
}

function factPaymentTimeout() {
  PaymentTimer.stop();
  openFactureModal();
  Toast.error('Délai de paiement expiré (30 secondes). Veuillez recommencer l\'opération.');
}

function factGoBackToForm() {
  PaymentTimer.stop();
  const step2 = document.getElementById('fact-step-form');
  step2.style.display = 'block';
  document.getElementById('fact-step-recap').style.display  = 'none';
  _factAnimateStep(step2);
  _factSetStep(2);
  _factScrollTop();
}

function factShowRecap() {
  const ref = document.getElementById('fact-ref')?.value.trim() || '';
  if (!ref) { Toast.error('Veuillez saisir la référence.'); return; }
  if (!_factData.network) { Toast.error('Veuillez choisir un réseau de paiement.'); return; }

  let montant = 0;
  const rows  = [];

  const svcLabels = {
    cie_prepaye: 'Prépayé CIE', cie_facture: 'Facture CIE',
    sodeci: 'SODECI', canal_plus: 'CANAL+', canalbox: 'CANALBOX', sotra: 'SOTRA'
  };
  rows.push({ label: 'Service', value: svcLabels[_factService] || _factService });
  rows.push({ label: 'Référence', value: ref });
  rows.push({ label: 'Réseau paiement', value: _factData.network });

  if (_factService === 'canal_plus') {
    if (!_factData.offer) { Toast.error('Veuillez choisir une formule CANAL+.'); return; }
    montant = _factData.offerPrice;
    rows.push({ label: 'Formule', value: _factData.offer });
  } else if (_factService === 'canalbox') {
    if (!_factData.offer)    { Toast.error('Veuillez choisir une offre CANALBOX.'); return; }
    if (!_factData.duration) { Toast.error('Veuillez choisir une durée.'); return; }
    montant = _factData.offerPrice * _factData.duration;
    rows.push({ label: 'Offre', value: _factData.offer });
    rows.push({ label: 'Durée', value: _factData.duration + ' mois' });
  } else {
    montant = parseInt(document.getElementById('fact-amount')?.value) || 0;
    if (montant < 100) { Toast.error('Montant minimum : 100 FCFA.'); return; }
  }

  if (!_svcCheckSolde(montant)) return;

  _factData.ref    = ref;
  _factData.montant = montant;

  document.getElementById('fact-recap-content').innerHTML = _svcRecapHTML(rows, montant);
  document.getElementById('fact-step-form').style.display  = 'none';
  const step3 = document.getElementById('fact-step-recap');
  step3.style.display = 'block';
  _factAnimateStep(step3);
  _factSetStep(3);
  _factScrollTop();
  PaymentTimer.start(30, 'fact-recap-countdown', factPaymentTimeout);
}

let _factConfirmTxnId = null;

async function factSubmit() {
  if (!_checkOrderCooldown()) return;
  if (!_svcCheckSolde(_factData.montant)) return;
  if (!_factData.network) { Toast.error('Veuillez choisir un moyen de paiement.'); return; }
  if (_factData.network !== 'Solde disponible' && !/^0[0-9]{9}$/.test(_factData.payNumber || '')) {
    Toast.error('Veuillez saisir un numéro valide pour ce moyen de paiement.');
    return;
  }
  const svcLabels = {
    cie_prepaye: 'Prépayé CIE', cie_facture: 'Facture CIE',
    sodeci: 'SODECI', canal_plus: 'CANAL+', canalbox: 'CANALBOX', sotra: 'SOTRA'
  };
  const txn = await _svcDebitAndRecord({
    type    : 'facture',
    service : svcLabels[_factService] || _factService,
    operateur: _factData.network,
    numero  : _factData.ref,
    montant : _factData.montant,
    details : {
      service   : _factService,
      ref       : _factData.ref,
      network   : _factData.network,
      offer     : _factData.offer   || null,
      duration  : _factData.duration || null,
      payNumber : _factData.network === 'Solde disponible' ? null : _factData.payNumber,
    },
    notes: `Paiement ${svcLabels[_factService]} — réf. ${_factData.ref}`,
  });
  loadHistory();
  if (!txn) { closeModal('modal-facture'); return; }
  PaymentTimer.stop();

  _factConfirmTxnId = txn.id;
  document.getElementById('fact-confirm-recap').innerHTML =
    `<div class="svc-recap-rows"><div class="svc-recap-row"><span>Service</span><strong>${svcLabels[_factService] || _factService}</strong></div><div class="svc-recap-row"><span>Référence</span><strong>${_factData.ref}</strong></div><div class="svc-recap-row svc-recap-row--total"><span>Total débité</span><strong>${Fmt.money(_factData.montant + FRAIS_SERVICE_AVANCE)}</strong></div></div>`;
  document.getElementById('fact-step-recap').style.display   = 'none';
  const step4 = document.getElementById('fact-step-confirm');
  step4.style.display = 'block';
  _factAnimateStep(step4);
  _factSetStep(4);
  _factScrollTop();
}

/* ══════════════════════════════════════════════════════════════
   MODAL RECHARGE UV
══════════════════════════════════════════════════════════════ */
let _uvData = {};
let _uvConfirmTxnId = null;

// Ramène le haut de la modale en vue à chaque changement d'étape, pour que
// la nouvelle étape reste visible sans que le client ait à défiler manuellement.
function _uvScrollTop() {
  const modal = document.querySelector('#modal-uv .svc-modal');
  if (modal) modal.scrollTo({ top: 0, behavior: 'smooth' });
}

function _uvSetStep(step) {
  for (let i = 1; i <= 6; i++) {
    const dot = document.getElementById(`uv-dot-${i}`);
    if (dot) {
      dot.classList.remove('done', 'current');
      if (i < step)       { dot.classList.add('done'); dot.innerHTML = '<i class="fa-solid fa-check"></i>'; }
      else if (i === step) { dot.classList.add('current'); dot.textContent = i; }
      else                  { dot.textContent = i; }
    }
    if (i < 6) {
      const line = document.getElementById(`uv-line-${i}`);
      if (line) line.classList.toggle('done', i < step);
    }
  }
}

async function openUVModal() {
  if (await isServiceInMaintenance('recharge_uv')) { warnMaintenance('La recharge UV est actuellement en maintenance.'); return; }
  if (!Auth.current()) { openPrivateSpaceNotice('Connectez-vous pour recharger vos unités virtuelles.'); return; }
  _uvData = {};
  document.querySelectorAll('.uv-op-card, .uv-pay-card').forEach(b => b.classList.remove('active'));
  document.getElementById('uv-step-1').style.display      = 'block';
  document.getElementById('uv-step-2').style.display      = 'none';
  document.getElementById('uv-step-3').style.display      = 'none';
  document.getElementById('uv-step-4').style.display      = 'none';
  document.getElementById('uv-step-recap').style.display   = 'none';
  document.getElementById('uv-step-confirm').style.display = 'none';
  _uvSetStep(1);
  const n = document.getElementById('uv-numero');
  const m = document.getElementById('uv-montant');
  const p = document.getElementById('uv-pay-number');
  if (n) n.value = '';
  if (m) m.value = '';
  if (p) p.value = '';
  openModal('modal-uv');
}

async function uvSelectNetwork(net, el) {
  if (await isNetworkInMaintenance(net)) { warnMaintenance(`Le réseau ${net} est actuellement en maintenance.`); return; }
  document.querySelectorAll('.uv-op-card').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  _uvData.network = net;
  applyNetworkPrefix('uv-numero', net);
}

function uvGoStep2() {
  if (!_uvData.network) { Toast.error('Veuillez choisir un réseau.'); return; }
  document.getElementById('uv-step-1').style.display = 'none';
  document.getElementById('uv-step-2').style.display = 'block';
  _uvSetStep(2);
  _uvScrollTop();
}

function uvGoBack() {
  document.getElementById('uv-step-1').style.display = 'block';
  document.getElementById('uv-step-2').style.display = 'none';
  _uvSetStep(1);
  _uvScrollTop();
}

function uvGoStep3() {
  const num = document.getElementById('uv-numero').value.replace(/\s/g,'');
  const mnt = parseInt(document.getElementById('uv-montant').value) || 0;
  if (!/^[0-9]{10}$/.test(num)) { Toast.error('Numéro invalide — 10 chiffres requis.'); return; }
  if (mnt < 10000) { Toast.error('Montant minimum : 10 000 FCFA.'); return; }
  _uvData.numero  = num;
  _uvData.montant = mnt;
  document.getElementById('uv-step-2').style.display = 'none';
  document.getElementById('uv-step-3').style.display = 'block';
  _uvSetStep(3);
  _uvScrollTop();
}

function uvGoBackToStep2() {
  document.getElementById('uv-step-3').style.display = 'none';
  document.getElementById('uv-step-2').style.display = 'block';
  _uvSetStep(2);
  _uvScrollTop();
}

async function uvSelectPayNetwork(net, el) {
  if (net !== 'Solde disponible' && await isNetworkInMaintenance(net)) { warnMaintenance(`Le réseau ${net} est actuellement en maintenance.`); return; }
  document.querySelectorAll('.uv-pay-card').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  _uvData.payNetwork = net;
  _uvData.payNumber  = '';
  const field = document.getElementById('uv-pay-number-field');
  const note  = document.getElementById('uv-pay-solde-note');
  const input = document.getElementById('uv-pay-number');
  if (input) input.value = '';
  const isSolde = net === 'Solde disponible';
  if (field) field.style.display = isSolde ? 'none' : '';
  if (note)  note.style.display  = isSolde ? '' : 'none';
}

function uvGoStep4() {
  if (!_uvData.payNetwork) { Toast.error('Veuillez choisir un réseau de paiement.'); return; }
  document.getElementById('uv-step-3').style.display = 'none';
  document.getElementById('uv-step-4').style.display = 'block';
  _uvSetStep(4);
  _uvScrollTop();
}

function uvGoBackToStep3() {
  document.getElementById('uv-step-4').style.display = 'none';
  document.getElementById('uv-step-3').style.display = 'block';
  _uvSetStep(3);
  _uvScrollTop();
}

function uvShowRecap() {
  if (_uvData.payNetwork !== 'Solde disponible') {
    const payNum = document.getElementById('uv-pay-number')?.value.trim() || '';
    if (!/^0[0-9]{9}$/.test(payNum)) { Toast.error('Veuillez saisir un numéro valide pour ce moyen de paiement.'); return; }
    _uvData.payNumber = payNum;
  }
  if (!_svcCheckSolde(_uvData.montant)) return;
  const rows = [
    { label: 'Réseau à recharger', value: _uvData.network },
    { label: 'Numéro à recharger', value: Fmt.phone(_uvData.numero) },
    { label: 'Réseau de paiement', value: _uvData.payNetwork },
  ];
  document.getElementById('uv-recap-content').innerHTML   = _svcRecapHTML(rows, _uvData.montant);
  document.getElementById('uv-step-4').style.display      = 'none';
  document.getElementById('uv-step-recap').style.display  = 'block';
  _uvSetStep(5);
  _uvScrollTop();
  PaymentTimer.start(30, 'uv-recap-countdown', uvPaymentTimeout);
}

function uvPaymentTimeout() {
  PaymentTimer.stop();
  openUVModal();
  Toast.error('Délai de paiement expiré (30 secondes). Veuillez recommencer l\'opération.');
}

function uvGoBackToForm() {
  PaymentTimer.stop();
  document.getElementById('uv-step-recap').style.display = 'none';
  document.getElementById('uv-step-4').style.display     = 'block';
  _uvSetStep(4);
  _uvScrollTop();
}

async function uvSubmit() {
  if (!_checkOrderCooldown()) return;
  if (!_svcCheckSolde(_uvData.montant)) return;
  const txn = await _svcDebitAndRecord({
    type    : 'recharge_uv',
    service : 'Recharge UV',
    operateur: _uvData.network,
    numero  : _uvData.numero,
    montant : _uvData.montant,
    details : {
      network    : _uvData.network,
      numero     : _uvData.numero,
      payNetwork : _uvData.payNetwork,
      payNumber  : _uvData.payNetwork === 'Solde disponible' ? null : _uvData.payNumber,
    },
    notes: `Recharge UV ${_uvData.network} → ${_uvData.numero}`,
  });
  loadHistory();
  if (!txn) { closeModal('modal-uv'); return; }
  PaymentTimer.stop();

  _uvConfirmTxnId = txn.id;
  document.getElementById('uv-confirm-recap').innerHTML =
    `<div class="svc-recap-rows"><div class="svc-recap-row"><span>Réseau</span><strong>${_uvData.network}</strong></div><div class="svc-recap-row"><span>Numéro</span><strong>${Fmt.phone(_uvData.numero)}</strong></div><div class="svc-recap-row svc-recap-row--total"><span>Total débité</span><strong>${Fmt.money(_uvData.montant + FRAIS_SERVICE_AVANCE)}</strong></div></div>`;
  document.getElementById('uv-step-recap').style.display   = 'none';
  document.getElementById('uv-step-confirm').style.display = 'block';
  _uvSetStep(6);
  _uvScrollTop();
}

/* ══════════════════════════════════════════════════════════════
   MODAL EXCHANGE
══════════════════════════════════════════════════════════════ */
let _exchData = {};
let _exchConfirmTxnId = null;

// Ramène le haut de la modale en vue à chaque changement d'étape.
function _exchScrollTop() {
  const modal = document.querySelector('#modal-exchange .svc-modal');
  if (modal) modal.scrollTo({ top: 0, behavior: 'smooth' });
}

function _exchSetStep(step) {
  for (let i = 1; i <= 5; i++) {
    const dot = document.getElementById(`exch-dot-${i}`);
    if (dot) {
      dot.classList.remove('done', 'current');
      if (i < step)       { dot.classList.add('done'); dot.innerHTML = '<i class="fa-solid fa-check"></i>'; }
      else if (i === step) { dot.classList.add('current'); dot.textContent = i; }
      else                  { dot.textContent = i; }
    }
    if (i < 5) {
      const line = document.getElementById(`exch-line-${i}`);
      if (line) line.classList.toggle('done', i < step);
    }
  }
}

// Grise/désactive les cartes réseau dont l'accès a été coupé spécifiquement
// pour Exchange (maintenance.networksByService.exchange, indépendant des
// autres services — voir isNetworkInMaintenanceForService, js/db.js).
async function _applyExchangeNetworkGating() {
  const cards = document.querySelectorAll('.exch-debit-net, .exch-recep-net');
  for (const card of cards) {
    const blocked = await isNetworkInMaintenanceForService('exchange', card.dataset.net);
    card.style.opacity = blocked ? '.35' : '';
    card.style.pointerEvents = blocked ? 'none' : '';
  }
}

async function openExchangeModal() {
  if (await isServiceInMaintenance('exchange')) { warnMaintenance('L\'exchange est actuellement en maintenance.'); return; }
  if (!Auth.current()) { openPrivateSpaceNotice('Connectez-vous pour effectuer un exchange.'); return; }
  _exchData = {};
  document.querySelectorAll('.exch-debit-net, .exch-recep-net').forEach(b => b.classList.remove('active'));
  await _applyExchangeNetworkGating();
  const ni = document.getElementById('exch-debit-num');
  const nr = document.getElementById('exch-recep-num');
  const mn = document.getElementById('exch-montant');
  if (ni) ni.value = '';
  if (nr) nr.value = '';
  if (mn) mn.value = '';
  document.getElementById('exch-step-1').style.display      = 'block';
  document.getElementById('exch-step-2').style.display      = 'none';
  document.getElementById('exch-step-3').style.display      = 'none';
  document.getElementById('exch-step-recap').style.display   = 'none';
  document.getElementById('exch-step-confirm').style.display = 'none';
  _exchSetStep(1);
  openModal('modal-exchange');
}

async function exchSelectDebitNet(net, el) {
  if (await isNetworkInMaintenanceForService('exchange', net)) { warnMaintenance(`Le réseau ${net} est actuellement indisponible pour l'Exchange.`); return; }
  document.querySelectorAll('.exch-debit-net').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  _exchData.debitNet = net;
  applyNetworkPrefix('exch-debit-num', net);
}

async function exchSelectRecepNet(net, el) {
  if (await isNetworkInMaintenanceForService('exchange', net)) { warnMaintenance(`Le réseau ${net} est actuellement indisponible pour l'Exchange.`); return; }
  document.querySelectorAll('.exch-recep-net').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  _exchData.recepNet = net;
  applyNetworkPrefix('exch-recep-num', net);
}

function exchGoStep2() {
  const recepNum = document.getElementById('exch-recep-num').value.replace(/\s/g,'');
  if (!_exchData.recepNet) { Toast.error('Veuillez choisir le réseau de réception.'); return; }
  if (!/^[0-9]{10}$/.test(recepNum)) { Toast.error('Numéro de réception invalide.'); return; }
  _exchData.recepNum = recepNum;
  document.getElementById('exch-step-1').style.display = 'none';
  document.getElementById('exch-step-2').style.display = 'block';
  _exchSetStep(2);
  _exchScrollTop();
}

function exchGoBackToStep1() {
  document.getElementById('exch-step-2').style.display = 'none';
  document.getElementById('exch-step-1').style.display = 'block';
  _exchSetStep(1);
  _exchScrollTop();
}

function exchGoStep3() {
  const debitNum = document.getElementById('exch-debit-num').value.replace(/\s/g,'');
  if (!_exchData.debitNet) { Toast.error('Veuillez choisir le réseau de débit.'); return; }
  if (!/^[0-9]{10}$/.test(debitNum)) { Toast.error('Numéro de débit invalide.'); return; }
  _exchData.debitNum = debitNum;
  document.getElementById('exch-step-2').style.display = 'none';
  document.getElementById('exch-step-3').style.display = 'block';
  _exchSetStep(3);
  _exchScrollTop();
}

function exchGoBackToStep2() {
  document.getElementById('exch-step-3').style.display = 'none';
  document.getElementById('exch-step-2').style.display = 'block';
  _exchSetStep(2);
  _exchScrollTop();
}

function exchShowRecap() {
  const mnt = parseInt(document.getElementById('exch-montant').value) || 0;
  if (mnt < 500) { Toast.error('Montant minimum : 500 FCFA.'); return; }
  if (!_svcCheckSolde(mnt)) return;
  _exchData.montant = mnt;
  const rows = [
    { label: 'Réseau débit',     value: _exchData.debitNet },
    { label: 'Numéro débit',     value: Fmt.phone(_exchData.debitNum) },
    { label: 'Réseau réception', value: _exchData.recepNet },
    { label: 'Numéro réception', value: Fmt.phone(_exchData.recepNum) },
  ];
  document.getElementById('exch-recap-content').innerHTML  = _svcRecapHTML(rows, mnt);
  document.getElementById('exch-step-3').style.display     = 'none';
  document.getElementById('exch-step-recap').style.display = 'block';
  _exchSetStep(4);
  _exchScrollTop();
  PaymentTimer.start(30, 'exch-recap-countdown', exchPaymentTimeout);
}

function exchPaymentTimeout() {
  PaymentTimer.stop();
  openExchangeModal();
  Toast.error('Délai de paiement expiré (30 secondes). Veuillez recommencer l\'opération.');
}

function exchGoBackToStep3() {
  PaymentTimer.stop();
  document.getElementById('exch-step-recap').style.display = 'none';
  document.getElementById('exch-step-3').style.display     = 'block';
  _exchSetStep(3);
  _exchScrollTop();
}

async function exchSubmit() {
  if (!_checkOrderCooldown()) return;
  if (!_svcCheckSolde(_exchData.montant)) return;
  const txn = await _svcDebitAndRecord({
    type    : 'exchange',
    service : 'Exchange',
    operateur: _exchData.recepNet,
    numero  : _exchData.recepNum,
    montant : _exchData.montant,
    details : {
      debit_network : _exchData.debitNet,
      debit_numero  : _exchData.debitNum,
      recep_network : _exchData.recepNet,
      recep_numero  : _exchData.recepNum,
    },
    notes: `Exchange ${_exchData.debitNet}/${_exchData.debitNum} → ${_exchData.recepNet}/${_exchData.recepNum}`,
  });
  loadHistory();
  if (!txn) { closeModal('modal-exchange'); return; }
  PaymentTimer.stop();

  _exchConfirmTxnId = txn.id;
  document.getElementById('exch-confirm-recap').innerHTML =
    `<div class="svc-recap-rows"><div class="svc-recap-row"><span>Réception</span><strong>${_exchData.recepNet} — ${Fmt.phone(_exchData.recepNum)}</strong></div><div class="svc-recap-row svc-recap-row--total"><span>Total débité</span><strong>${Fmt.money(_exchData.montant + FRAIS_SERVICE_AVANCE)}</strong></div></div>`;
  document.getElementById('exch-step-recap').style.display   = 'none';
  document.getElementById('exch-step-confirm').style.display = 'block';
  _exchSetStep(5);
  _exchScrollTop();
}

/* ══════════════════════════════════════════════════════════════
   CADEAU RÉCOMPENSE — débloqué après 100 commandes terminées
══════════════════════════════════════════════════════════════ */
const CADEAU_GOAL    = 100;
const CADEAU_MONTANT = 500; // F crédités sur le solde

function _cadeauStats() {
  const me = Auth.current();
  if (!me) return { done: 0, claimed: 0, canClaim: false, progress: 0 };
  const txns    = DB.transactions.byClient(me.id);
  const done    = txns.filter(t => t.statut === 'terminé').length;
  const claimed = txns.filter(t => t.type === 'cadeau_reward').length;
  const eligible = Math.floor(done / CADEAU_GOAL);
  return {
    done,
    claimed,
    canClaim : eligible > claimed,
    progress : done % CADEAU_GOAL,
    eligible,
  };
}

function renderCadeauBtn() {
  const btns = document.querySelectorAll('.pgc-circ-btn--gift');
  const lbls = document.querySelectorAll('.pgc-gift-lbl');
  const me   = Auth.current();
  if (!me) { lbls.forEach(l => l.textContent = 'Cadeau'); return; }

  const { done, canClaim, progress } = _cadeauStats();

  btns.forEach(btn => {
    btn.classList.remove('pgc-circ-btn--gift-ready');
    if (canClaim) {
      btn.classList.add('pgc-circ-btn--gift-ready');
    }
  });
  lbls.forEach(l => {
    if (canClaim) {
      l.textContent = 'Débloqué !';
    } else {
      l.textContent = done < CADEAU_GOAL ? `${done}/${CADEAU_GOAL}` : `${progress}/${CADEAU_GOAL}`;
    }
  });
}

function openCadeauModal() {
  if (!Auth.current()) { openPrivateSpaceNotice('Connectez-vous pour accéder à vos cadeaux.'); return; }
  const { done, canClaim, claimed, progress } = _cadeauStats();
  const pct  = Math.min(100, Math.round((done % CADEAU_GOAL) / CADEAU_GOAL * 100));
  const circ = 2 * Math.PI * 54; // circumference for r=54
  const dash = circ * (1 - pct / 100);
  const body = document.getElementById('cadeau-modal-body');

  if (canClaim) {
    // ── Vue récompense débloquée ──
    body.innerHTML = `
      <div class="cadeau-unlock-wrap">
        <div class="cadeau-confetti">
          <i class="fa-solid fa-star" style="color:#fbbf24;font-size:1.1rem;"></i>
          <i class="fa-solid fa-star" style="color:#f9a8d4;font-size:.7rem;"></i>
          <i class="fa-solid fa-star" style="color:#a78bfa;font-size:.9rem;"></i>
          <i class="fa-solid fa-star" style="color:#fbbf24;font-size:.6rem;"></i>
          <i class="fa-solid fa-star" style="color:#67e8f9;font-size:.8rem;"></i>
        </div>
        <div class="cadeau-unlock-icon">🎁</div>
        <div class="cadeau-unlock-title">Félicitations !</div>
        <div class="cadeau-unlock-sub">Vous avez réalisé <strong>${done} commandes</strong>.<br>Votre récompense est prête à être réclamée.</div>
        <div class="cadeau-reward-card">
          <i class="fa-solid fa-coins" style="color:#fbbf24;font-size:1.4rem;"></i>
          <div>
            <div class="cadeau-reward-amount">+ ${Fmt.money(CADEAU_MONTANT)}</div>
            <div class="cadeau-reward-label">crédités sur votre solde</div>
          </div>
        </div>
        <button class="cadeau-claim-btn" onclick="cadeauClaim()">
          <i class="fa-solid fa-gift"></i> Réclamer mon cadeau
        </button>
      </div>`;
  } else {
    // ── Vue progression ──
    const reste = CADEAU_GOAL - (done % CADEAU_GOAL || (done > 0 && done % CADEAU_GOAL === 0 ? CADEAU_GOAL : done % CADEAU_GOAL));
    const displayProgress = done % CADEAU_GOAL === 0 && done > 0 ? 0 : done % CADEAU_GOAL;
    const displayReste    = CADEAU_GOAL - displayProgress;
    body.innerHTML = `
      <div class="cadeau-prog-wrap">
        <div class="cadeau-prog-ring-wrap">
          <svg width="130" height="130" viewBox="0 0 130 130">
            <circle cx="65" cy="65" r="54" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="9"/>
            <circle cx="65" cy="65" r="54" fill="none"
              stroke="url(#gift-grad)" stroke-width="9"
              stroke-linecap="round"
              stroke-dasharray="${circ}"
              stroke-dashoffset="${circ * (1 - Math.min(displayProgress, CADEAU_GOAL) / CADEAU_GOAL)}"
              transform="rotate(-90 65 65)"
              style="transition:stroke-dashoffset .6s ease;"/>
            <defs>
              <linearGradient id="gift-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#ec4899"/>
                <stop offset="100%" stop-color="#f59e0b"/>
              </linearGradient>
            </defs>
          </svg>
          <div class="cadeau-prog-center">
            <div class="cadeau-prog-num">${displayProgress}</div>
            <div class="cadeau-prog-denom">/${CADEAU_GOAL}</div>
            <div class="cadeau-prog-ico">🎁</div>
          </div>
        </div>
        <div class="cadeau-prog-title">Votre cadeau arrive !</div>
        <div class="cadeau-prog-sub">
          Réalisez <strong>${displayReste} commande${displayReste > 1 ? 's' : ''}</strong> de plus pour débloquer votre récompense de <strong>${Fmt.money(CADEAU_MONTANT)}</strong>.
        </div>
        <div class="cadeau-prog-bar-wrap">
          <div class="cadeau-prog-bar" style="width:${Math.round(displayProgress / CADEAU_GOAL * 100)}%"></div>
        </div>
        <div class="cadeau-prog-legend">
          <span>${displayProgress} réalisées</span>
          <span>${displayReste} restantes</span>
        </div>
        ${claimed > 0 ? `<div class="cadeau-prog-cycle">Récompense n°${claimed + 1} en cours · ${claimed} déjà réclamée${claimed > 1 ? 's' : ''}</div>` : ''}
      </div>`;
  }

  openModal('modal-cadeau');
}

function cadeauClaim() {
  const { canClaim } = _cadeauStats();
  if (!canClaim) return;
  const me = Auth.current();
  if (!me) return;

  DB.users.updateSolde(me.id, CADEAU_MONTANT);
  DB.transactions.create({
    client_id   : me.id,
    cabine_id   : me.cabine_id || null,
    type        : 'cadeau_reward',
    service     : 'Récompense 100 commandes',
    operateur   : '',
    montant     : CADEAU_MONTANT,
    frais_service: 0,
    statut      : 'terminé',
    date        : new Date().toISOString(),
    notes       : `Cadeau KBINE PLUS — récompense pour ${(_cadeauStats().claimed + 1) * CADEAU_GOAL} commandes réalisées`,
  });

  currentUser = Auth.refresh();
  closeModal('modal-cadeau');
  renderSoldeSection();
  refreshSidebarBalance();
  renderCadeauBtn();
  loadHistory();
  Toast.success('🎁 Cadeau reçu ! ' + Fmt.money(CADEAU_MONTANT) + ' ont été crédités sur votre solde.');
}


