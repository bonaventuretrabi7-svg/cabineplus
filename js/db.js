/* ================================================================
   KBINE PLUS | Base de données (localStorage)
   ================================================================ */

const DB = (() => {
  const PREFIX = 'cbp_';
  const DB_VERSION = '7';
  const KEY = {
    users:            PREFIX + 'users',
    transactions:     PREFIX + 'transactions',
    notifications:    PREFIX + 'notifications',
    commissions:      PREFIX + 'commissions',
    settings:         PREFIX + 'settings',
    reclamations:     PREFIX + 'reclamations',
    retraits:         PREFIX + 'retraits',
    retards:          PREFIX + 'retards',
    transferts_cabine: PREFIX + 'transferts_cabine',
    initialized:      PREFIX + 'initialized',
    version:          PREFIX + 'version',
    presence:         PREFIX + 'presence',
    partnerDevices:   PREFIX + 'partner_devices',
    refundRequests:   PREFIX + 'refund_requests',
    accessLogs:       PREFIX + 'access_logs',
    cabineRefusals:   PREFIX + 'cabine_refusals',
    resubscriptions:  PREFIX + 'resubscriptions',
    favoris:          PREFIX + 'favoris',
    permissionLogs:   PREFIX + 'permission_logs',
    maintenanceLogs:  PREFIX + 'maintenance_logs',
    forfaits:         PREFIX + 'forfaits',
    suspensionLogs:   PREFIX + 'suspension_logs',
    syncQueue:        PREFIX + 'sync_queue',
    resetRequests:    PREFIX + 'reset_requests',
    partnerApplications: PREFIX + 'partner_applications',
    partnerDevicesServer: PREFIX + 'partner_devices_server',
    referrals: PREFIX + 'referrals',
    commandesProgrammees: PREFIX + 'commandes_programmees',
  };

  /* Les 6 méthodes de retrait disponibles pour verser sa commission
     au cabiniste (indépendantes du moyen_paiement utilisé par le
     client dans ses propres transferts). */
  const METHODES_RETRAIT = ['Orange Money', 'Moov Money', 'Djamo', 'Wave Business', 'Wave Normal', 'Compte bancaire'];

  /* Seuil de retard d'une commande (3 min) — réattribution auto (feature 4)
     et comptage des retards menant à une suspension (feature 5). Remplace
     les anciennes constantes locales dupliquées (5 min) d'admin.js/cabine.js. */
  const RETARD_MS = 3 * 60 * 1000;

  /* Frais de service prélevé à l'expéditeur d'un transfert cabine-à-cabine. */
  const TRANSFERT_CABINE_FRAIS = 150;

  /* Frais de service prélevé sur une recharge UV en libre-service côté
     cabine (voir cabineSelfRecharge/previewCabineSelfRecharge ci-dessous). */
  const FRAIS_SERVICE_UV_CABINE = 200;

  /* Pénalité fixe appliquée au partenaire quand l'administration rembourse
     une commande qu'il avait marquée "Terminée" (voir refundTransaction). */
  const PENALITE_REMBOURSEMENT_TERMINE = 60;

  /* â”€â”€ Simple hash (demo only — use bcrypt server-side in prod) â”€â”€ */
  function hashPwd(pwd) {
    let h = 0;
    for (let i = 0; i < pwd.length; i++) {
      h = Math.imul(31, h) + pwd.charCodeAt(i) | 0;
    }
    return h.toString(16) + '_' + btoa(pwd).replace(/=/g, '');
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // Les colonnes JSON de `profiles` (permissions, puces, docs...) reviennent
  // du serveur sous forme de CHAÎNE JSON brute (PDO ne décode jamais une
  // colonne JSON MySQL automatiquement, voir api/) — jamais parsées jusqu'ici
  // dans fromProfileRow() ci-dessous, alors qu'aucune de ces colonnes n'avait
  // en pratique de vraie valeur écrite par le serveur avant ce correctif
  // (voir admin_update_profile.php/admin_create_account.php, nouveaux).
  // Défensif plutôt qu'un JSON.parse() direct : reste compatible avec une
  // valeur déjà parsée (ex. relue depuis le cache local) ou absente.
  function parseJsonField(v) {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch (e) { return v; }
  }

  function now() { return new Date().toISOString(); }

  /* ── Connectivité (hors-ligne d'abord — LocalStorage reste la source de
     vérité, le serveur (api/, PHP+MySQL) n'est jamais qu'une synchronisation
     optionnelle en tâche de fond, voir DB.settings et DB.syncQueue
     ci-dessous). Pas de
     plugin Capacitor natif : navigator.onLine + les événements standards
     online/offline fonctionnent déjà dans la WebView. */
  /* Dans l'app Android empaquetée (Capacitor), navigator.onLine ment parfois
     (signale "hors ligne" alors que la connexion est bien là) — un cas connu
     de cette WebView. Comme isOnline() gate TOUT rafraîchissement périodique
     (refreshSelf, transactions.refresh, notifications.refresh...), un faux
     "hors ligne" bloquait silencieusement toute mise à jour (ex. solde
     rechargé par l'admin jamais reflété) jusqu'à la prochaine déconnexion/
     reconnexion — Auth.login() ne dépend jamais de isOnline(), lui. On
     ignore donc ce signal dans l'app et on tente toujours l'appel réseau
     réel ; ServerAPI._call() a son propre délai d'expiration, un vrai échec
     (réellement hors ligne) reste intercepté normalement par chaque
     appelant. Sur le site web classique, navigator.onLine reste fiable :
     comportement inchangé. */
  const Net = {
    isOnline: () => {
      if (typeof navigator === 'undefined') return true;
      if (typeof window !== 'undefined' && window.Capacitor) return true;
      return navigator.onLine;
    },
    onChange(cb) {
      if (typeof window === 'undefined') return;
      window.addEventListener('online', cb);
      window.addEventListener('offline', cb);
    },
  };

  /* ── Seed data ──────────────────────────────────────────────────── */
  function seed() {
    // Seul le compte super-admin est pré-créé (application en production —
    // aucun compte de démonstration) : c'est le seul moyen de démarrer, les
    // comptes cabine/client se créent ensuite normalement depuis l'app
    // (auto-inscription) ou depuis le panneau admin.
    const users = [
      {
        id: 'u_admin', nom: 'TRA BI', prenom: 'BONAVENTURE VANIE HOLLAND',
        telephone: '0789794720', email: 'bonaventuretrab7@gmail.com',
        mot_de_passe: hashPwd('1973'),
        role: 'admin', solde: 0, statut: 'actif', admin_level: 'super',
        date_creation: '2024-01-01T00:00:00Z', zone: 'Abidjan'
      }
    ];

    const transactions = [];
    const notifications = [];

    const commissions = [
      { id: uid(), label: 'Commission standard', pourcentage: 5, montant_min: 0, montant_max: 99999, actif: true, date: '2024-01-01T00:00:00Z' },
    ];

    const retraits = [];

    const settings = {
      platformName: 'KBINE PLUS',
      currency: 'F',
      commissionRate: 5,
      minTransfer: 500,
      maxTransfer: 100000,
      rechargeMin: 1000,
      maintenance: {
        global:   { enabled: false, message: '' },
        services: { recharger: false, depenses: false, transferer: false, historique: false, facture: false, recharge_uv: false, exchange: false },
        networks: { Orange: false, MTN: false, Moov: false },
        // Réseaux indépendants par service (Exchange/Recharge) — distincts de
        // `networks` ci-dessus, qui reste partagé par Transfert direct/Facture
        // (réseau de paiement)/Recharge UV, volontairement inchangés (voir
        // isNetworkInMaintenanceForService ci-dessous).
        networksByService: {
          exchange: { Orange: false, MTN: false, Moov: false },
          recharge: { Orange: false, MTN: false, Moov: false, Wave: false },
        },
        // Un message personnalisé par service du bouton Facture, affiché au
        // client à la place du service quand `blocked` est vrai (voir
        // openFactureModal/factPickService, js/client.js).
        factureServices: {
          cie_prepaye: { blocked: false, message: '' },
          cie_facture: { blocked: false, message: '' },
          sodeci:      { blocked: false, message: '' },
          canal_plus:  { blocked: false, message: '' },
          canalbox:    { blocked: false, message: '' },
          sotra:       { blocked: false, message: '' },
        },
      },
      assistance: { whatsapp: [], email: '', facebook: '', snapchat: '' },
      assistant_cabine: { whatsapp: [] },
      assistant_client: { whatsapp: [], schedule: [] },
      // Modèles USSD "transfert direct" (crédit simple, hors forfaits Orange
      // qui ont leur propre ussdTemplate par forfait — voir DB.forfaits) :
      // {numero_destinataire} est injecté à la commande (voir tfSubmitConfirm
      // dans js/client.js), construit à l'affichage côté Cabine (voir
      // getOrderUssdCode() dans js/cabine.js) pour rester éditable a
      // posteriori par le super admin sans affecter les commandes déjà
      // stockées. Un seul modèle par réseau.
      ussd_templates: {
        mtn: '*133*6*2*{numero_destinataire}#',
        moov_marchand: '*155*6*2*{numero_destinataire}#',
      },
      // Programmations des administrateurs simples (feature "Gestion des
      // Administrateurs") — { id, admin_id, jours:[0-6], debut, fin,
      // mode:'auto'|'manuel', date_creation }. Un admin simple sans aucune
      // entrée ici ne peut pas se connecter (voir Auth.login()).
      admin_schedules: [],
      // Annonces KBINE PLUS gérées par l'admin (promotions, maintenance,
      // nouveautés) — { id, titre, message, date } — voir renderActualites()
      // (js/client.js) et loadActualitesAdmin() (js/admin.js).
      actualites: [],
    };

    localStorage.setItem(KEY.users,         JSON.stringify(users));
    localStorage.setItem(KEY.transactions,   JSON.stringify(transactions));
    localStorage.setItem(KEY.notifications,  JSON.stringify(notifications));
    localStorage.setItem(KEY.commissions,    JSON.stringify(commissions));
    localStorage.setItem(KEY.settings,       JSON.stringify(settings));
    localStorage.setItem(KEY.retraits,       JSON.stringify(retraits));
    localStorage.setItem(KEY.retards,        JSON.stringify([]));
    localStorage.setItem(KEY.transferts_cabine, JSON.stringify([]));
    localStorage.setItem(KEY.initialized,    'true');
  }

  function init() {
    try {
      const storedVersion = localStorage.getItem(KEY.version);
      if (!localStorage.getItem(KEY.initialized) || storedVersion !== DB_VERSION) {
        localStorage.clear();
        seed();
        localStorage.setItem(KEY.version, DB_VERSION);
      }
      migrateAdminIdentity();
      migrateCabineSeedEmails();
      migrateForfaitsSeed();
      migrateForfaitCategories();
      migrateForfaitSubcategories();
      migrateUssdTemplatesSeed();
      migrateSingleUssdPerNetwork();
    } catch(e) {
      console.error('[DB] init failed, resetting:', e);
      try { localStorage.clear(); seed(); localStorage.setItem(KEY.version, DB_VERSION); } catch(_) {}
    }
  }

  /* Met à jour en place les coordonnées du compte admin déjà seedé chez les
     utilisateurs existants (sans tout réinitialiser, contrairement à un bump
     de DB_VERSION) : ne touche que si l'ancien téléphone par défaut est
     encore présent, donc idempotent — ne s'applique qu'une seule fois. */
  function migrateAdminIdentity() {
    const list = get(KEY.users);
    const idx  = list.findIndex(u => u.id === 'u_admin');
    if (idx === -1) return;
    let changed = false;

    if (list[idx].telephone === '0101010101') {
      list[idx] = {
        ...list[idx],
        nom: 'TRA BI', prenom: 'BONAVENTURE VANIE HOLLAND',
        telephone: '0789794720', email: 'bonaventuretrab7@gmail.com',
        mot_de_passe: hashPwd('1973'),
      };
      changed = true;
    }

    // Le compte u_admin est l'unique super admin — s'assure qu'il porte
    // toujours ce statut même sur une base déjà initialisée avant l'ajout
    // du système de permissions (indépendant du bloc ci-dessus, qui ne
    // se déclenche qu'une fois sur l'ancien numéro par défaut).
    if (list[idx].admin_level !== 'super') {
      list[idx] = { ...list[idx], admin_level: 'super' };
      changed = true;
    }

    // Le super admin ne doit jamais rester verrouillé après 3 tentatives
    // de code incorrectes (voir Auth.login()) : c'est le SEUL compte admin
    // possible (aucune auto-inscription admin) — un blocage resterait
    // définitif sans ce déverrouillage automatique à chaque chargement.
    if (list[idx].statut === 'bloqué' || list[idx].tentatives_echouees) {
      list[idx] = { ...list[idx], statut: 'actif', tentatives_echouees: 0 };
      changed = true;
    }

    if (changed) set(KEY.users, list);
  }

  /* Réécrit les 3 comptes cabine seedés dont l'email est encore l'ancien
     format @cabineplus.ci (avant l'exigence Gmail pour cabine/admin) — même
     patron chirurgical/idempotent que migrateAdminIdentity() : ne touche
     que ces 3 adresses connues, jamais un compte cabine créé/édité
     manuellement avec une autre adresse. */
  function migrateCabineSeedEmails() {
    const OLD_TO_NEW = {
      'cabine1@cabineplus.ci': 'cabine1@gmail.com',
      'cabine2@cabineplus.ci': 'cabine2@gmail.com',
      'cabine3@cabineplus.ci': 'cabine3@gmail.com',
    };
    const list = get(KEY.users);
    let changed = false;
    list.forEach(u => {
      if (u.role === 'cabine' && OLD_TO_NEW[u.email]) { u.email = OLD_TO_NEW[u.email]; changed = true; }
    });
    if (changed) set(KEY.users, list);
  }

  /* Amorce settings.ussd_templates (MTN + Moov) une seule fois sur une base
     déjà seedée avant leur ajout — chirurgical comme les migrations
     ci-dessus, ne touche à rien d'autre dans settings. */
  function migrateUssdTemplatesSeed() {
    let s;
    try { s = JSON.parse(localStorage.getItem(KEY.settings) || '{}'); } catch(e) { return; }
    if (!s || Array.isArray(s) || s.ussd_templates) return;
    s.ussd_templates = {
      mtn: '*133*6*2*{numero_destinataire}#',
      moov_marchand: '*155*6*2*{numero_destinataire}#',
    };
    set(KEY.settings, s);
  }

  /* Retire le 2ᵉ code Moov (Puce UV) et les préférences #161/#154 et
     Marchand/UV des comptes cabiniste : chaque réseau n'a plus qu'un seul
     modèle de code USSD, ces champs devenus inutiles restaient sinon en
     mémoire sur les installations déjà migrées ci-dessus. */
  function migrateSingleUssdPerNetwork() {
    let s;
    try { s = JSON.parse(localStorage.getItem(KEY.settings) || '{}'); } catch(e) { s = null; }
    if (s && !Array.isArray(s) && s.ussd_templates && 'moov_uv' in s.ussd_templates) {
      delete s.ussd_templates.moov_uv;
      set(KEY.settings, s);
    }
  }

  /* Sous-section d'un forfait Orange "Appels", déduite de son id (stable
     depuis le catalogue d'origine) — regroupe visuellement les Pass Mix
     1-3j / 5-7j / 30j entre eux et les 7 destinations Pass International
     ensemble sous "International", sans dépendre de l'état de migration
     de la catégorie elle-même (voir migrateForfaitSubcategories()). */
  function _forfaitSubcategoryForId(id) {
    if (/^omx([1-4])$/.test(id))     return 'Pass Mix 1-3 jours';
    if (/^omx([5-8])$/.test(id))     return 'Pass Mix 5-7 jours';
    if (/^omx(9|1[0-2])$/.test(id))  return 'Pass Mix 30 jours';
    if (/^(obf|oml|osn|ogn|oni|ong|oae)/.test(id)) return 'International';
    return null;
  }

  /* Amorce la collection "forfaits" (catalogue Orange/MTN/Moov, gérable
     ensuite via l'onglet Super Admin "Forfaits") une seule fois, sans
     toucher au reste des données déjà en place — même patron chirurgical
     que migrateAdminIdentity() ci-dessus, plutôt qu'un bump de DB_VERSION
     qui purgerait tout le localStorage existant. */
  function migrateForfaitsSeed() {
    if (localStorage.getItem(KEY.forfaits)) return;

    const nested = {
      // Tous les Pass Mix et Pass International Orange sont regroupés dans
      // une seule section "Appels" (ce sont tous, au fond, des forfaits de
      // minutes) — "Internet" est laissée prête à accueillir de futurs
      // forfaits data Orange, ajoutés via l'onglet Super Admin "Forfaits"
      // (une catégorie n'apparaît qu'une fois qu'elle contient un forfait).
      Orange: {
        Appels: [
          { id:'omx1', nom:'Pass mix 200 F',      detail:'17 min tous réseaux',        duree:'1 jour',  prix:200, ussdTemplate:'#161*{numero_destinataire}*2*1*1#' },
          { id:'omx2', nom:'Pass mix 300 F',      detail:'30 min tous réseaux + 100 Mo', duree:'2 jours', prix:300, ussdTemplate:'#161*{numero_destinataire}*2*1*2#' },
          { id:'omx3', nom:'Pass mix 400 F',      detail:'50 min tous réseaux + 100 Mo', duree:'2 jours', prix:400, ussdTemplate:'#161*{numero_destinataire}*2*1*3#' },
          { id:'omx4', nom:'Pass mix Veedz 600 F', detail:'50 min + 100 Mo + Veedz',    duree:'3 jours', prix:600, ussdTemplate:'#161*{numero_destinataire}*2*1*3#', verified:false },
          { id:'omx5', nom:'Pass mix 500 F',   detail:'55 min + 300 SMS + illimité numéro préféré',                 duree:'5 jours', prix:500,  ussdTemplate:'#161*{numero_destinataire}*2*2*1#' },
          { id:'omx6', nom:'Pass Mix 700 F',   detail:'60 min + 1,5 Go',                                             duree:'5 jours', prix:700,  ussdTemplate:'#161*{numero_destinataire}*2*2*2#' },
          { id:'omx7', nom:'Pass Mix 1 000 F', detail:'100 min + 1 Go + illimité numéro préféré + 150 Mo Spotify',   duree:'7 jours', prix:1000, ussdTemplate:'#161*{numero_destinataire}*2*2*3#' },
          { id:'omx8', nom:'Pass Mix 1 500 F', detail:'200 min + 1500 Mo + illimité numéro préféré + 150 Mo Spotify', duree:'7 jours', prix:1500, ussdTemplate:'#161*{numero_destinataire}*2*2*4#' },
          { id:'omx9',  nom:'Pass Mix 3 000 F',  detail:'250 min + 2,5 Go + 500 SMS + illimité numéro préféré + 500 Mo Spotify', duree:'30 jours', prix:3000,  ussdTemplate:'#161*{numero_destinataire}*2*3*1#' },
          { id:'omx10', nom:'Pass Mix 5 000 F',  detail:'400 min + 5 Go + illimité numéro préféré + 500 Mo Spotify',              duree:'30 jours', prix:5000,  ussdTemplate:'#161*{numero_destinataire}*2*3*2#' },
          { id:'omx11', nom:'Pass Mix 10 000 F', detail:'500 min + 10 Go + illimité numéro préféré + 500 Mo Spotify',             duree:'30 jours', prix:10000, ussdTemplate:'#161*{numero_destinataire}*2*3*3#' },
          { id:'omx12', nom:'Pass Mix 20 000 F', detail:'1200 min + 20 Go + illimité numéro préféré + 500 Mo Spotify',            duree:'30 jours', prix:20000, ussdTemplate:'#161*{numero_destinataire}*2*3*4#' },
          { id:'obf1', nom:'Pass Burkina Faso 300 F',   detail:'4 min vers Orange Burkina/Onatel/Telecel + 4 min locales',   duree:'1 jour',  prix:300,  ussdTemplate:'#161*{numero_destinataire}*5*1*1#' },
          { id:'obf2', nom:'Pass Burkina Faso 500 F',   detail:'20 min vers Orange Burkina/Onatel/Telecel + 15 min locales', duree:'3 jours', prix:500,  ussdTemplate:'#161*{numero_destinataire}*5*1*2#' },
          { id:'obf3', nom:'Pass Burkina Faso 1 000 F', detail:'35 min vers Orange Burkina/Onatel/Telecel + 35 min locales', duree:'7 jours', prix:1000, ussdTemplate:'#161*{numero_destinataire}*5*1*3#' },
          { id:'obf4', nom:'Pass Burkina Faso 2 500 F', detail:'100 min vers Orange Burkina/Onatel/Telecel + 50 min locales', duree:'7 jours', prix:2500, ussdTemplate:'#161*{numero_destinataire}*5*1*4#' },
          { id:'oml1', nom:'Pass Mali 300 F',   detail:'4 min vers Orange Mali/Onatel/Telecel + 4 min locales',   duree:'1 jour',  prix:300,  ussdTemplate:'#161*{numero_destinataire}*5*2*1#' },
          { id:'oml2', nom:'Pass Mali 500 F',   detail:'20 min vers Orange Mali/Onatel/Telecel + 15 min locales', duree:'3 jours', prix:500,  ussdTemplate:'#161*{numero_destinataire}*5*2*2#' },
          { id:'oml3', nom:'Pass Mali 1 000 F', detail:'35 min vers Orange Mali/Onatel/Telecel + 35 min locales', duree:'7 jours', prix:1000, ussdTemplate:'#161*{numero_destinataire}*5*2*3#' },
          { id:'oml4', nom:'Pass Mali 2 500 F', detail:'100 min vers Orange Mali/Onatel/Telecel + 50 min locales', duree:'7 jours', prix:2500, ussdTemplate:'#161*{numero_destinataire}*5*2*4#' },
          { id:'osn1', nom:'Pass Sénégal 300 F',   detail:'4 min vers Orange Sénégal/Onatel/Telecel + 4 min locales',   duree:'1 jour',  prix:300,  ussdTemplate:'#161*{numero_destinataire}*5*3*1#' },
          { id:'osn2', nom:'Pass Sénégal 500 F',   detail:'20 min vers Orange Sénégal/Onatel/Telecel + 15 min locales', duree:'3 jours', prix:500,  ussdTemplate:'#161*{numero_destinataire}*5*3*2#' },
          { id:'osn3', nom:'Pass Sénégal 1 000 F', detail:'35 min vers Orange Sénégal/Onatel/Telecel + 35 min locales', duree:'7 jours', prix:1000, ussdTemplate:'#161*{numero_destinataire}*5*3*3#' },
          { id:'osn4', nom:'Pass Sénégal 2 500 F', detail:'100 min vers Orange Sénégal/Onatel/Telecel + 50 min locales', duree:'7 jours', prix:2500, ussdTemplate:'#161*{numero_destinataire}*5*3*4#' },
          { id:'ogn1', nom:'Pass Guinée Conakry 500 F',   detail:'6 min vers Orange Guinée Conakry + 3 min locales', duree:'3 jours', prix:500,  ussdTemplate:'#161*{numero_destinataire}*5*4*1#' },
          { id:'ogn2', nom:'Pass Guinée Conakry 1 000 F', detail:'7 min vers Orange Guinée Conakry + 7 min locales', duree:'7 jours', prix:1000, ussdTemplate:'#161*{numero_destinataire}*5*4*2#' },
          { id:'oni1', nom:'Pass Niger 500 F',   detail:'10 min vers numéros mobiles + 5 min locales',  duree:'3 jours', prix:500,  ussdTemplate:'#161*{numero_destinataire}*5*5*1#' },
          { id:'oni2', nom:'Pass Niger 1 000 F', detail:'12 min vers numéros mobiles + 12 min locales', duree:'3 jours', prix:1000, ussdTemplate:'#161*{numero_destinataire}*5*5*2#' },
          { id:'ong1', nom:'Pass Nigéria 500 F',   detail:'3 min vers numéros mobiles + 3 min locales',   duree:'1 jour',   prix:500,  ussdTemplate:'#161*{numero_destinataire}*5*6*1#' },
          { id:'ong2', nom:'Pass Nigéria 1 000 F', detail:'11 min vers numéros mobiles + 11 min locales', duree:'7 jours',  prix:1000, ussdTemplate:'#161*{numero_destinataire}*5*6*2#' },
          { id:'ong3', nom:'Pass Nigéria 3 000 F', detail:'35 min vers numéros mobiles + 35 min locales', duree:'30 jours', prix:3000, ussdTemplate:'#161*{numero_destinataire}*5*6*3#' },
          { id:'oae1', nom:'Pass Amérique/Asie/Europe 500 F',   detail:'20 min vers USA, Inde, Canada, Orange France, Roumanie, Brésil, Colombie, Mexique, Singapour + 10 min locales',  duree:'1 mois', prix:500,  ussdTemplate:'#161*{numero_destinataire}*5*7*1#' },
          { id:'oae2', nom:'Pass Amérique/Asie/Europe 1 000 F', detail:'50 min vers les mêmes destinations + 20 min locales',  duree:'1 mois', prix:1000, ussdTemplate:'#161*{numero_destinataire}*5*7*2#' },
          { id:'oae3', nom:'Pass Amérique/Asie/Europe 2 000 F', detail:'110 min vers les mêmes destinations + 30 min locales', duree:'1 mois', prix:2000, ussdTemplate:'#161*{numero_destinataire}*5*7*2#', verified:false },
        ],
      },
      MTN: {
        Internet: [
          { id:'mi1', nom:'Pépite Jour',   detail:'50 Mo',  prix:200,  duree:'24h' },
          { id:'mi2', nom:'Pépite 200 Mo', detail:'200 Mo', prix:500,  duree:'3 jours' },
          { id:'mi3', nom:'Pépite 1 Go',   detail:'1 Go',   prix:1000, duree:'7 jours' },
          { id:'mi4', nom:'Pépite 3 Go',   detail:'3 Go',   prix:2000, duree:'30 jours' },
          { id:'mi5', nom:'Pépite 10 Go',  detail:'10 Go',  prix:5000, duree:'30 jours' },
        ],
        Appels: [
          { id:'ma1', nom:'XtraTime 30min', detail:'30 min',  prix:300,  duree:'24h' },
          { id:'ma2', nom:'XtraTime 1h',    detail:'60 min',  prix:500,  duree:'3 jours' },
          { id:'ma3', nom:'XtraTime 2h',    detail:'120 min', prix:1000, duree:'7 jours' },
        ],
        Mixtes: [
          { id:'mm1', nom:'XtraCombo Lite',    detail:'200 Mo + 30 min', prix:700,  duree:'3 jours' },
          { id:'mm2', nom:'XtraCombo Pro',     detail:'1 Go + 1h',       prix:1500, duree:'7 jours' },
          { id:'mm3', nom:'XtraCombo Premium', detail:'5 Go + 2h',       prix:3500, duree:'30 jours' },
        ],
      },
      Moov: {
        Internet: [
          { id:'mvi1', nom:'Net Jour',   detail:'50 Mo',  prix:200,  duree:'24h' },
          { id:'mvi2', nom:'Net 200 Mo', detail:'200 Mo', prix:500,  duree:'3 jours' },
          { id:'mvi3', nom:'Net 1 Go',   detail:'1 Go',   prix:1000, duree:'7 jours' },
          { id:'mvi4', nom:'Net 5 Go',   detail:'5 Go',   prix:2500, duree:'30 jours' },
        ],
        Appels: [
          { id:'mva1', nom:'Talk 30min', detail:'30 min',  prix:250, duree:'24h' },
          { id:'mva2', nom:'Talk 1h',    detail:'60 min',  prix:450, duree:'3 jours' },
          { id:'mva3', nom:'Talk 2h',    detail:'120 min', prix:900, duree:'7 jours' },
        ],
        Mixtes: [
          { id:'mvm1', nom:'Flex Starter', detail:'200 Mo + 30 min', prix:600,  duree:'3 jours' },
          { id:'mvm2', nom:'Flex Pro',     detail:'1 Go + 1h',       prix:1400, duree:'7 jours' },
          { id:'mvm3', nom:'Flex Premium', detail:'5 Go + 3h',       prix:3500, duree:'30 jours' },
        ],
      },
    };

    const flat = [];
    Object.entries(nested).forEach(([operateur, cats]) => {
      Object.entries(cats).forEach(([categorie, list]) => {
        list.forEach(f => flat.push({
          ...f, operateur, categorie,
          ussdTemplate: f.ussdTemplate || null,
          verified: f.verified !== false,
          sousCategorie: _forfaitSubcategoryForId(f.id),
        }));
      });
    });
    set(KEY.forfaits, flat);
  }

  /* Regroupe les anciennes catégories Orange (les 3 paliers "Pass Mix" +
     les 7 destinations "Pass International") dans une seule section
     "Appels", pour les bases déjà seedées avant ce changement — migration
     chirurgicale et idempotente, même patron que migrateAdminIdentity(). */
  function migrateForfaitCategories() {
    const OLD_ORANGE_CATS = [
      'Pass Mix 1-3j', 'Pass Mix 5-7j', 'Pass Mix 30j',
      'Burkina Faso', 'Mali', 'Sénégal', 'Guinée Conakry', 'Niger', 'Nigéria', 'Amérique/Asie/Europe',
    ];
    const list = get(KEY.forfaits);
    if (!list.length) return;
    let changed = false;
    list.forEach(f => {
      if (f.operateur === 'Orange' && OLD_ORANGE_CATS.includes(f.categorie)) {
        f.categorie = 'Appels';
        changed = true;
      }
    });
    if (changed) set(KEY.forfaits, list);
  }

  /* Sous-sections au sein de la catégorie Orange "Appels" — Pass Mix
     1-3j/5-7j/30j regroupés entre eux, les 7 destinations Pass
     International regroupées ensemble sous "International". Backfill
     idempotent basé sur l'id (voir _forfaitSubcategoryForId()), donc
     indépendant de l'ordre d'exécution avec migrateForfaitCategories(). */
  function migrateForfaitSubcategories() {
    const list = get(KEY.forfaits);
    if (!list.length) return;
    let changed = false;
    list.forEach(f => {
      if (f.operateur !== 'Orange' || f.sousCategorie) return;
      const sous = _forfaitSubcategoryForId(f.id);
      if (sous) { f.sousCategorie = sous; changed = true; }
    });
    if (changed) set(KEY.forfaits, list);
  }

  /* ── CRUD helpers ─────────────────────────────────────────────── */
  function get(key) {
    try { return JSON.parse(localStorage.getItem(key) || '[]'); }
    catch(e) { console.warn('[DB] corrupted key:', key); return []; }
  }
  function set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); }
    catch(e) { console.warn('[DB] write failed:', key, e); }
  }

  /* â”€â”€ Users â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  const users = {
    all: ()           => get(KEY.users),
    save: (list)      => set(KEY.users, list),
    byId: (id)        => get(KEY.users).find(u => u.id === id),
    byEmail: (email)  => get(KEY.users).find(u => u.email === email.toLowerCase().trim()),
    byPhone: (phone)  => get(KEY.users).find(u => u.telephone === phone.trim()),
    // Unicité par rôle (feature 5) : un même numéro peut être associé à au
    // plus 1 compte client + 1 cabine + 1 admin — jamais 2 fois pour le
    // même rôle. Utilisé à la création/édition à la place de byPhone()
    // (qui reste utilisé tel quel pour la connexion/réinitialisation sans
    // indice de rôle, voir Auth.login()).
    byPhoneAndRole: (phone, role) => get(KEY.users).find(u => u.telephone === phone.trim() && u.role === role),
    byRole: (role)    => get(KEY.users).filter(u => u.role === role),

    create(data) {
      const list  = get(KEY.users);
      const canAutoEmail = data.role !== 'admin' && data.role !== 'cabine';
      const email = data.email ? data.email.toLowerCase().trim()
                                : (canAutoEmail ? (data.telephone || '') + '@kbineplus.app' : '');
      // Filet de sécurité (pas le rempart principal — voir les validations
      // dans js/admin.js/js/cabine.js/js/client.js) : signale tout compte
      // cabine/admin créé sans email Gmail valide, sans bloquer la création
      // (un blocage dur ici casserait l'app si un appelant est oublié).
      if ((data.role === 'admin' || data.role === 'cabine') && !/^[^\s@]+@gmail\.com$/i.test(email)) {
        console.warn('[DB] users.create: email Gmail invalide/manquant pour un compte', data.role, email);
      }
      const user  = { id: 'u_' + uid(), date_creation: now(), statut: 'actif',
        nom: '', ...data, email, mot_de_passe: hashPwd(data.mot_de_passe) };
      list.push(user);
      set(KEY.users, list);
      return user;
    },

    update(id, updates) {
      const list = get(KEY.users);
      const idx  = list.findIndex(u => u.id === id);
      if (idx === -1) return null;
      if (updates.mot_de_passe) updates.mot_de_passe = hashPwd(updates.mot_de_passe);
      list[idx] = { ...list[idx], ...updates };
      set(KEY.users, list);
      return list[idx];
    },

    delete(id) {
      const list = get(KEY.users).filter(u => u.id !== id);
      set(KEY.users, list);
    },

    updateSolde(id, delta) {
      const list = get(KEY.users);
      const idx  = list.findIndex(u => u.id === id);
      if (idx === -1) return null;
      list[idx].solde = (list[idx].solde || 0) + delta;
      set(KEY.users, list);
      return list[idx].solde;
    },

    checkPwd(user, pwd) {
      return user.mot_de_passe === hashPwd(pwd);
    },

    // Convertit une ligne `profiles` (table MySQL, snake_case, mot de passe
    // en bcrypt — voir api/) vers le format local. `plainPin` : le code EN
    // CLAIR qui vient d'être validé côté serveur (uniquement après une
    // connexion RÉUSSIE, voir Auth.login() dans js/auth.js) ; jamais
    // conservé tel quel, seulement son hash LOCAL (hashPwd(), le même que
    // tous les autres comptes) pour que les connexions suivantes sur CET
    // appareil fonctionnent hors ligne sans dépendre du bcrypt serveur
    // (format incompatible avec checkPwd() ci-dessus). Omis (voir
    // mergeProfileList() ci-dessous, synchronisation en lecture seule côté
    // admin) : mot_de_passe n'est alors pas inclus dans le résultat —
    // l'admin ne connaît pas le PIN des autres comptes, écraser un hash
    // local existant casserait la connexion hors-ligne de son propriétaire.
    fromProfileRow(row, plainPin) {
      const out = {
        id: row.id, nom: row.nom || '', prenom: row.prenom || '',
        telephone: row.telephone || '', email: row.email || '',
        role: row.role, solde: row.solde || 0, statut: row.statut,
        admin_level: row.admin_level || undefined,
        permissions: parseJsonField(row.permissions) || undefined,
        zone: row.zone || undefined, cabine_nom: row.cabine_nom || undefined,
        commissions_total: row.commissions_total || 0,
        transferts_total: row.transferts_total || 0,
        commandes_renvoyees: row.commandes_renvoyees || 0,
        remboursements_recus: row.remboursements_recus || 0,
        limite_commandes: row.limite_commandes ?? undefined,
        tentatives_echouees: row.tentatives_echouees || 0,
        suspendu_auto: row.suspendu_auto || false,
        suspendu_by: row.suspendu_by || null,
        suspendu_motif: row.suspendu_motif || null,
        suspendu_jusqu: row.suspendu_jusqu || null,
        abonnement: row.abonnement || undefined,
        abonnement_debut: row.abonnement_debut || undefined,
        date_creation: row.date_creation,
        paiement_vers: row.paiement_vers || undefined,
        numero_compte: row.numero_compte || undefined,
        retrait_derniere_maj: row.retrait_derniere_maj || undefined,
        whatsapp: row.whatsapp || undefined,
        photo: row.photo || undefined,
        code_qr: row.code_qr || undefined,
        motivation: row.motivation || undefined,
        experience: row.experience || undefined,
        puces: parseJsonField(row.puces) || undefined,
        paiement_abo: row.paiement_abo || undefined,
        poste: row.poste || undefined,
        pays: row.pays || undefined,
        ville: row.ville || undefined,
        quartier: row.quartier || undefined,
        date_naissance: row.date_naissance || undefined,
        docs: parseJsonField(row.docs) || undefined,
        en_pause: row.en_pause || false,
        pause_raison: row.pause_raison || null,
        pause_note: row.pause_note || null,
        pause_debut: row.pause_debut || null,
        reseaux_actifs: parseJsonField(row.reseaux_actifs) || undefined,
        services_actifs: parseJsonField(row.services_actifs) || undefined,
        ussd_enabled: parseJsonField(row.ussd_enabled) || undefined,
        carte_couleur: row.carte_couleur || undefined,
        theme_sombre: row.theme_sombre === null || row.theme_sombre === undefined ? undefined : !!row.theme_sombre,
        notif_son_actif: row.notif_son_actif === null || row.notif_son_actif === undefined ? undefined : !!row.notif_son_actif,
        notif_son_preset_commande: row.notif_son_preset_commande || undefined,
        notif_son_preset_reclamation: row.notif_son_preset_reclamation || undefined,
        motif_zero_txn: row.motif_zero_txn || undefined,
        motif_inactif: row.motif_inactif || undefined,
        appel_statut: row.appel_statut || undefined,
      };
      if (plainPin) out.mot_de_passe = hashPwd(plainPin);
      return out;
    },

    // Fusionne un profil serveur fraîchement vérifié dans le cache local
    // (voir Auth.login()). Un compte déjà connu sur CET appareil (créé avant
    // l'activation de la synchronisation, id local "u_xxx") garde son id
    // d'origine — le changer casserait les données déjà liées à cet id
    // (transactions, favoris...) ; seuls les autres champs sont mis à jour.
    // Un compte jamais vu ici est simplement ajouté, id serveur compris.
    cacheFromServer(row, plainPin) {
      const mapped = users.fromProfileRow(row, plainPin);
      const list = get(KEY.users);
      const idx = list.findIndex(u => mapped.role === u.role && (
        (mapped.telephone && mapped.telephone === u.telephone) ||
        (mapped.email && mapped.email === u.email)
      ));
      if (idx === -1) {
        list.push(mapped);
        set(KEY.users, list);
        return mapped;
      }
      const { id, ...fieldsWithoutId } = mapped;
      list[idx] = { ...list[idx], ...fieldsWithoutId };
      set(KEY.users, list);
      return list[idx];
    },

    // Reprend le profil du compte CONNECTÉ depuis le serveur (solde compris)
    // — sans ça, une modification faite ailleurs (recharge par
    // l'administration, transfert accepté par une cabine, etc.) restait
    // invisible sur cet appareil jusqu'à la prochaine déconnexion/
    // reconnexion : cacheFromServer() n'était jusqu'ici appelé qu'au login
    // (voir Auth.login()). Auth.refresh() (js/auth.js) reste purement local
    // (relit DB.users, ne contacte jamais le serveur) : il fallait ce point
    // d'entrée en amont pour qu'il ait quelque chose de neuf à relire.
    // Appelé depuis le même cycle de sondage périodique que
    // DB.transactions.refresh() (voir startClientPresence()/js/client.js et
    // le setInterval de js/cabine.js).
    async refreshSelf() {
      if (!ServerAPI.isConfigured || !Net.isOnline()) return null;
      const res = await ServerAPI.whoami();
      if (!res.ok) return null;
      return users.cacheFromServer(res.profile);
    },

    // Fusionne la liste complète des comptes d'un rôle (voir
    // api/list_profiles.php) — utilisé par le tableau de bord admin
    // (refreshUsersFromServer(), js/admin.js) pour refléter TOUS les
    // comptes existants, pas seulement ceux déjà connus sur cet appareil
    // (voir le diagnostic : un client inscrit depuis son propre téléphone
    // n'apparaissait jamais dans les listes de l'admin). Aucun PIN ici
    // (fromProfileRow(row) sans 2e argument) : mot_de_passe n'est jamais
    // touché, contrairement à cacheFromServer() (appelé au login avec le
    // PIN qui vient d'être vérifié).
    // `rows` est la liste COMPLÈTE de ce rôle côté serveur (list_profiles.php
    // ne filtre que par rôle, jamais paginé) : purge donc aussi, avant de
    // fusionner, toute entrée locale de ce même rôle absente de cette liste
    // — sans ça, un compte supprimé via admin_delete_account.php restait
    // affiché indéfiniment (jamais retiré, seulement jamais mis à jour).
    // Un compte créé hors ligne (id encore préfixé 'u_', voir users.create())
    // n'est jamais purgé ici : il n'a pas encore de contrepartie serveur à
    // comparer, ce n'est pas un compte supprimé.
    mergeProfileList(rows, role) {
      const serverKeys = new Set(rows.map(row => {
        const m = users.fromProfileRow(row);
        return (m.telephone || '') + '|' + (m.email || '');
      }));
      const list = get(KEY.users).filter(u => (
        u.role !== role || u.id.startsWith('u_') || serverKeys.has((u.telephone || '') + '|' + (u.email || ''))
      ));
      rows.forEach(row => {
        const mapped = users.fromProfileRow(row);
        const idx = list.findIndex(u => mapped.role === u.role && (
          (mapped.telephone && mapped.telephone === u.telephone) ||
          (mapped.email && mapped.email === u.email)
        ));
        if (idx === -1) {
          list.push(mapped);
        } else {
          const { id, ...fieldsWithoutId } = mapped;
          list[idx] = { ...list[idx], ...fieldsWithoutId };
        }
      });
      set(KEY.users, list);
    },

    hash: hashPwd,
  };

  /* â”€â”€ Présence en ligne (localStorage multi-onglets + serveur multi-appareils) â”€
     Chaque onglet/appareil connecté "pingue" son id périodiquement ; une
     entrée plus vieille que STALE_MS est considérée hors ligne (onglet
     fermé sans avoir pu prévenir, crash, etc.). ping() écrit en local
     IMMÉDIATEMENT (même comportement qu'avant, y compris hors ligne) puis
     pousse vers le serveur en tâche de fond (best-effort — voir
     api/presence_ping.php) ; refresh() tire la liste serveur pour que ce
     même appareil sache aussi qui est en ligne SUR LES AUTRES appareils,
     prérequis à la migration de l'attribution des commandes (Phase 4) qui
     doit distinguer une cabine réellement joignable d'un autre appareil du
     même compte resté ouvert mais inactif. onlineCabineIds()/onlineIds()
     restent synchrones (lisent ce même cache local fusionné) : appelées
     depuis DB.business.findReassignmentTarget, encore 100% synchrone. */
  // Signature légère de tout ce qu'un cycle de sondage périodique
  // (HEARTBEAT_MS ci-dessous) vient de re-synchroniser depuis le serveur —
  // comparée avant/après par chaque espace (voir startClientPresence()/
  // js/client.js, le setInterval de boot()/js/cabine.js et js/admin.js)
  // pour savoir si un re-rendu de la section affichée est réellement
  // nécessaire, plutôt que de reconstruire tout son HTML à chaque tick
  // même quand rien n'a changé (coûteux sur Android bas de gamme). Ne
  // couvre que ce qu'un cycle de sondage rafraîchit vraiment (transactions/
  // notifications/profil, + tous les comptes pour l'admin) : une
  // collection jamais retouchée ici (ex. retraits/transferts_cabine côté
  // cabine) n'aurait de toute façon pas de données plus fraîches à
  // afficher, gater dessus est donc sans risque de régression de fraîcheur.
  function pollSignature(userId, role) {
    const txns   = role === 'admin'  ? transactions.all()
                 : role === 'cabine' ? transactions.byCabine(userId)
                 : transactions.byClient(userId);
    const notifs = role === 'admin' ? notifications.all() : notifications.forUser(userId);
    const me     = users.byId(userId);
    const extra  = role === 'admin' ? users.all() : null;
    return JSON.stringify({ txns, notifs, me, extra });
  }

  const presence = {
    // Cadence du sondage périodique (présence + resynchronisation générale)
    // des 3 espaces (voir startClientPresence()/js/client.js, le
    // setInterval de boot()/js/cabine.js, et celui de js/admin.js — tous
    // partagent cette même constante). Resserré à 1s (depuis 2s, avant ça
    // 3s) sur demande explicite — en dessous de cette valeur, le risque de
    // saturer l'hébergement mutualisé (chaque tick relance plusieurs
    // requêtes : transactions, notifications, présence, sweep...) dépasse
    // le bénéfice perçu.
    HEARTBEAT_MS: 1000,
    STALE_MS: 25000,

    _all() { return JSON.parse(localStorage.getItem(KEY.presence) || '{}'); },
    _save(map) { localStorage.setItem(KEY.presence, JSON.stringify(map)); },

    ping(userId) {
      const map = presence._all();
      map[userId] = Date.now();
      presence._save(map);
      if (ServerAPI.isConfigured && Net.isOnline()) {
        ServerAPI.presencePing().catch(() => {});
      }
    },

    // Fusionne la présence connue côté serveur (autres appareils) dans le
    // cache local — ne recule jamais un timestamp déjà plus récent
    // localement (ex. ce même appareil vient de pinguer, plus à jour que
    // la dernière lecture serveur disponible).
    async refresh() {
      if (!ServerAPI.isConfigured || !Net.isOnline()) return;
      const res = await ServerAPI.presenceOnline();
      if (!res.ok) return;
      const map = presence._all();
      res.presence.forEach(row => {
        const ts = row.ts * 1000;
        if (!map[row.profile_id] || ts > map[row.profile_id]) map[row.profile_id] = ts;
      });
      presence._save(map);
    },

    // beforeunload n'a pas de contrepartie serveur fiable (la page peut
    // être détruite avant qu'une requête réseau n'aboutisse) — le seuil de
    // fraîcheur (STALE_MS) côté refresh() suffit à faire disparaître un
    // appareil réellement fermé du prochain rafraîchissement des autres.
    leave(userId) {
      const map = presence._all();
      delete map[userId];
      presence._save(map);
    },

    onlineCabineIds() {
      const map    = presence._all();
      const cutoff = Date.now() - presence.STALE_MS;
      // Une cabine suspendue ou en pause ne compte pas parmi les cabines
      // "connectées" (ni dans le badge affiché, ni comme cible potentielle
      // de réattribution — déjà exclue par ailleurs via c.statut/en_pause,
      // ce filtre les rend simplement cohérents entre eux).
      const cabIds = new Set(
        users.byRole('cabine').filter(u => u.statut === 'actif' && !u.en_pause).map(u => u.id)
      );
      return Object.keys(map).filter(id => map[id] >= cutoff && cabIds.has(id));
    },

    onlineCabineCount() {
      return presence.onlineCabineIds().length;
    },

    // Tous rôles confondus (client + cabine + admin) : sert de proxy pour
    // les "visiteurs en temps réel" du tableau de bord admin (il n'y a pas
    // de vrai suivi de visiteurs anonymes possible sans backend).
    onlineIds() {
      const map    = presence._all();
      const cutoff = Date.now() - presence.STALE_MS;
      return Object.keys(map).filter(id => map[id] >= cutoff);
    },

    onlineTotalCount() {
      return presence.onlineIds().length;
    },
  };

  /* ── Appareils connectés (comptes partenaire uniquement) ──────────
     Aucune limite de nombre : support "Mes appareils connectés" (retrait
     manuel, par le titulaire du compte ou par l'admin) + "rester connecté"
     (token opaque, jamais le mot de passe). Un enregistrement par appareil
     connu pour un compte ; voir Auth.login()/require()/logout() dans
     auth.js pour la reprise de session et la déconnexion sur retrait. */
  const partnerDevices = {
    all:  ()   => get(KEY.partnerDevices),
    save: (l)  => set(KEY.partnerDevices, l),

    // Appareils valides pour ce compte : non expirés (mémorisés) ou vus il
    // y a moins de 24h (filet de sécurité pour une session simple dont
    // l'onglet a été fermé sans déconnexion explicite).
    forUser(userId) {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      return partnerDevices.all().filter(d => {
        if (d.user_id !== userId) return false;
        if (d.expires_at) return new Date(d.expires_at).getTime() > Date.now();
        return new Date(d.last_seen).getTime() > cutoff;
      });
    },

    // tokenOverride (optionnel) : depuis la suppression de la connexion hors
    // ligne (voir Auth.login()/Auth.resumeSession(), js/auth.js), le jeton
    // "rester connecté" est le jeton de session SERVEUR lui-même (voir
    // ServerAPI.getToken()) plutôt qu'une valeur générée localement — une
    // reprise de session doit pouvoir être revérifiée par le serveur
    // (api/session_whoami.php), ce qu'un jeton purement local ne permet pas.
    // Repli sur l'ancienne génération locale si absent (compatibilité).
    register(userId, deviceId, label, remember, tokenOverride) {
      const list = partnerDevices.all();
      const rec = {
        id: 'dev_' + uid(), user_id: userId, device_id: deviceId, label,
        remember_token: remember ? (tokenOverride || (crypto.randomUUID() + crypto.randomUUID())) : null,
        created_at: now(), last_seen: now(),
        expires_at: remember ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() : null,
      };
      list.push(rec);
      partnerDevices.save(list);
      return rec;
    },

    // Reconnexion sur un appareil déjà connu : rafraîchit last_seen (et
    // glisse l'expiration si "rester connecté" est actif ou vient d'être
    // coché). tokenOverride : voir register() ci-dessus — remplace toujours
    // le jeton existant par le jeton serveur fraîchement émis, si fourni.
    touch(deviceRecordId, remember, tokenOverride) {
      const list = partnerDevices.all();
      const rec = list.find(d => d.id === deviceRecordId);
      if (!rec) return null;
      rec.last_seen = now();
      if (remember) rec.remember_token = tokenOverride || rec.remember_token || (crypto.randomUUID() + crypto.randomUUID());
      if (rec.remember_token) rec.expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      partnerDevices.save(list);
      return rec;
    },

    remove(deviceRecordId) {
      partnerDevices.save(partnerDevices.all().filter(d => d.id !== deviceRecordId));
    },

    removeByDeviceId(userId, deviceId) {
      partnerDevices.save(partnerDevices.all().filter(d => !(d.user_id === userId && d.device_id === deviceId)));
    },

    findByToken(deviceId, token) {
      if (!token) return null;
      const rec = partnerDevices.all().find(d => d.device_id === deviceId && d.remember_token === token);
      if (!rec) return null;
      if (rec.expires_at && new Date(rec.expires_at).getTime() <= Date.now()) return null;
      return rec;
    },

    // Miroir serveur (voir api/devices_touch.php, Phase G) — appelé
    // uniquement aux évènements d'authentification réels (login, reprise
    // "rester connecté"), jamais depuis le heartbeat local très fréquent
    // (_touchCurrentCabDevice() etc., js/cabine.js) pour ne pas multiplier
    // les appels serveur inutilement. Best-effort, jamais bloquant.
    async syncSelf(deviceId, label, remember) {
      if (!ServerAPI.isConfigured || !Net.isOnline()) return;
      await ServerAPI.devicesTouch({ deviceId, label, remember });
    },

    // Rafraîchit depuis le serveur (voir api/devices_list.php) — un client/
    // une cabine ne reçoit que ses propres appareils, un admin les reçoit
    // tous (déjà filtré côté serveur par rôle).
    async refresh() {
      if (!ServerAPI.isConfigured || !Net.isOnline()) return;
      const res = await ServerAPI.devicesList();
      if (res.ok) set(KEY.partnerDevicesServer, res.devices);
    },

    allFromServer: () => get(KEY.partnerDevicesServer) || [],

    // Déconnecte réellement un appareil (voir api/devices_remove.php) —
    // supprime aussi la session serveur correspondante, contrairement à
    // remove()/removeByDeviceId() ci-dessus qui ne retirent que l'entrée
    // LOCALE (utilisées pour SA PROPRE déconnexion, où la session courante
    // est de toute façon invalidée séparément par ServerAPI.logout()).
    async revoke(deviceRecordId) {
      const res = await ServerAPI.devicesRemove(deviceRecordId);
      if (!res.ok) return { ok: false, error: res.error };
      await partnerDevices.refresh();
      return { ok: true };
    },
  };

  /* â”€â”€ Transactions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  const transactions = {
    all:  ()   => get(KEY.transactions),
    save: (l)  => set(KEY.transactions, l),
    byId: (id) => get(KEY.transactions).find(t => t.id === id),
    byClient: (cid) => get(KEY.transactions).filter(t => t.client_id === cid).sort((a,b) => new Date(b.date)-new Date(a.date)),
    byCabine: (cid) => get(KEY.transactions).filter(t => t.cabine_id === cid).sort((a,b) => new Date(b.date)-new Date(a.date)),
    pending:  ()    => get(KEY.transactions).filter(t => t.statut === 'en_attente').sort((a,b) => new Date(a.date)-new Date(b.date)),

    // Rafraîchit depuis le serveur (voir api/orders_list.php, portée par
    // rôle — un client ne reçoit que les siennes, une cabine celles qui
    // lui sont assignées, un admin tout, toujours la liste COMPLÈTE, jamais
    // paginée) — sans ceci, un appareil ne verrait jamais une commande
    // créée/traitée ailleurs malgré les endpoints d'écriture. Upsert par id,
    // mais purge aussi toute commande locale déjà synchronisée (id qui n'est
    // PAS préfixé 'txn_', voir transactions.create() plus bas) absente de
    // cette réponse : depuis api/orders_delete.php (suppression réelle par
    // le super admin), une commande supprimée restait sinon affichée
    // indéfiniment (jamais retirée, seulement jamais mise à jour). Une
    // commande créée hors ligne (id encore 'txn_...', pas encore synchronisée)
    // n'est elle jamais purgée ici : le serveur ne la connaît pas encore, ce
    // n'est pas une commande supprimée.
    async refresh() {
      if (!ServerAPI.isConfigured || !Net.isOnline()) return;
      const res = await ServerAPI.ordersList();
      if (!res.ok) return;
      const serverIds = new Set(res.transactions.map(t => t.id));
      const list = get(KEY.transactions).filter(t => t.id.startsWith('txn_') || serverIds.has(t.id));
      res.transactions.forEach(row => {
        const idx = list.findIndex(t => t.id === row.id);
        if (idx !== -1) list[idx] = row; else list.push(row);
      });
      set(KEY.transactions, list);
    },

    create(data) {
      const list = get(KEY.transactions);
      const txn  = { id: 'txn_' + uid(), date: now(), commission: 0, ...data };
      list.push(txn);
      set(KEY.transactions, list);
      return txn;
    },

    update(id, updates) {
      const list = get(KEY.transactions);
      const idx  = list.findIndex(t => t.id === id);
      if (idx === -1) return null;
      list[idx] = { ...list[idx], ...updates };
      set(KEY.transactions, list);
      return list[idx];
    },

    stats() {
      const all = get(KEY.transactions);
      const done = all.filter(t => t.statut === 'terminé');
      return {
        total:       all.length,
        done:        done.length,
        pending:     all.filter(t => t.statut === 'en_attente').length,
        refused:     all.filter(t => t.statut === 'refusé').length,
        volume:      done.reduce((s, t) => s + t.montant, 0),
        commissions: done.reduce((s, t) => s + t.commission, 0),
      };
    },

    /* Montant total des ventes (commandes terminées) ventilé par réseau
       mobile money — tableau de bord admin + classement "ventes par
       réseau" (voir loadDashboard()/loadRankings() dans js/admin.js). */
    volumeByNetwork() {
      const done = get(KEY.transactions).filter(t => t.statut === 'terminé');
      const byNet = { Orange: 0, Moov: 0, MTN: 0 };
      done.forEach(t => { if (byNet[t.operateur] !== undefined) byNet[t.operateur] += t.montant; });
      return byNet;
    },

    dailyStats(days = 7) {
      const all = get(KEY.transactions);
      const result = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        const dayTxns = all.filter(t => t.date.startsWith(key) && t.statut === 'terminé');
        result.push({
          label: d.toLocaleDateString('fr-CI', { weekday: 'short', day: 'numeric' }),
          count: dayTxns.length,
          volume: dayTxns.reduce((s, t) => s + t.montant, 0),
        });
      }
      return result;
    },

    monthlyStats(months = 6) {
      const all = get(KEY.transactions);
      const result = [];
      for (let i = months - 1; i >= 0; i--) {
        const d = new Date();
        d.setMonth(d.getMonth() - i, 1);
        const prefix = d.toISOString().slice(0, 7);
        const mTxns  = all.filter(t => t.date.startsWith(prefix) && t.statut === 'terminé');
        result.push({
          label: d.toLocaleDateString('fr-CI', { month: 'short', year: '2-digit' }),
          count: mTxns.length,
          volume: mTxns.reduce((s, t) => s + t.montant, 0),
        });
      }
      return result;
    },
  };

  /* â”€â”€ Retraits de commission (cabiniste) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
     Distincts des transactions client : représentent les virements
     versés au cabiniste sur l'une des 6 méthodes de retrait. */
  const retraits = {
    methodes: METHODES_RETRAIT,
    all:  ()   => get(KEY.retraits),
    byCabine: (cid) => get(KEY.retraits).filter(r => r.cabine_id === cid).sort((a,b) => new Date(b.date)-new Date(a.date)),

    // Rafraîchit depuis le serveur (voir api/retraits_list.php).
    async refresh() {
      if (!ServerAPI.isConfigured || !Net.isOnline()) return;
      const res = await ServerAPI.retraitsList();
      if (res.ok) set(KEY.retraits, res.retraits);
    },

    // Admin : traite un retrait — remplace le débit local
    // (DB.users.updateSolde) + create() ci-dessous par un seul appel
    // serveur atomique (voir api/retraits_create.php, corrige un bug
    // financier réel : le débit local n'a jamais été persisté côté
    // serveur, écrasé silencieusement par le prochain rafraîchissement de
    // la liste des cabines).
    async process(cabineId, montant) {
      const res = await ServerAPI.retraitsCreate(cabineId, montant);
      if (!res.ok) return { ok: false, error: res.error };
      await retraits.refresh();
      return { ok: true };
    },

    // Conservée pour compatibilité, plus appelée en pratique (voir process() ci-dessus).
    create(data) {
      const list = get(KEY.retraits);
      const ret  = { id: 'ret_' + uid(), date: now(), statut: 'en_attente', ...data };
      list.push(ret);
      set(KEY.retraits, list);
      return ret;
    },

    // Remplace confirmCabRetrait()/confirmEditPayment() (js/cabine.js/
    // js/admin.js), jusqu'ici purement locaux (voir
    // api/cabine_set_retrait_info.php — délai de 24h revérifié côté
    // serveur pour la cabine elle-même, pas pour l'admin).
    async setInfo(paiementVers, numeroCompte, targetId) {
      const res = await ServerAPI.cabineSetRetraitInfo({ paiementVers, numeroCompte, targetId });
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true };
    },
  };

  /* ── Retards (historique) ─────────────────────────────────────────────
     Une ligne par commande détectée en retard (> RETARD_MS toujours en
     attente) : source de vérité à la fois pour l'onglet admin "Commandes
     en retard" (historique persistant) et pour le comptage glissant sur
     24h qui déclenche une suspension automatique (voir business.sweepStaleOrders). */
  const retards = {
    all:  ()   => get(KEY.retards),
    byCabine: (cid) => get(KEY.retards).filter(r => r.cabine_id === cid).sort((a,b) => new Date(b.date)-new Date(a.date)),

    // Rafraîchit depuis le serveur (voir api/retards_list.php) — seule
    // écriture désormais côté serveur (api/orders_sweep.php, Phase 4) ;
    // sans ceci l'affichage local resterait figé. Portée par rôle côté
    // serveur (une cabine ne reçoit que les siennes) : remplacement total
    // du cache local plutôt qu'un upsert, cohérent avec cette portée déjà
    // filtrée en amont.
    async refresh() {
      if (!ServerAPI.isConfigured || !Net.isOnline()) return;
      const res = await ServerAPI.retardsList();
      if (res.ok) set(KEY.retards, res.retards);
    },
  };

  /* ── Commandes automatiques programmées ───────────────────────────────
     Une ligne par commande programmée par un client (payée à la
     programmation, voir business.scheduleOrder) ou par le super admin
     (sans paiement, voir business.scheduleOrderAdmin) — se déclenche à
     l'heure prévue en une vraie ligne `transactions` (voir
     triggerScheduledOrder(), api/orders_common.php), suivie ici jusqu'à
     son déclenchement (statut, cabine assignée, temps de traitement —
     voir api/orders_schedule_list.php). Source de vérité serveur, comme
     `retards` ci-dessus : remplacement total du cache local au refresh. */
  const commandesProgrammees = {
    all: () => get(KEY.commandesProgrammees),
    byClient: (cid) => get(KEY.commandesProgrammees).filter(c => c.client_id === cid).sort((a,b) => new Date(b.date_programmee)-new Date(a.date_programmee)),

    async refresh() {
      if (!ServerAPI.isConfigured || !Net.isOnline()) return;
      const res = await ServerAPI.ordersScheduleList();
      if (res.ok) set(KEY.commandesProgrammees, res.commandes);
    },
  };

  /* ── Renvois manuels de commande (historique horodaté) ─────────────────
     Une ligne par renvoi (voir business.refuseRequest) — même patron que
     `retards` : sert à détecter une fenêtre glissante de 5 renvois en
     moins de 2 min pour la suspension automatique (voir
     business.suspendCabineAuto). */
  const cabineRefusals = {
    all:  ()   => get(KEY.cabineRefusals),
    countSince: (cid, sinceMs) => get(KEY.cabineRefusals).filter(r => r.cabine_id === cid && new Date(r.date).getTime() >= sinceMs).length,

    create(cabine_id) {
      const list = get(KEY.cabineRefusals);
      const r = { id: 'crf_' + uid(), cabine_id, date: now() };
      list.push(r);
      set(KEY.cabineRefusals, list);
      return r;
    },
  };

  /* ── Transferts cabine-à-cabine ────────────────────────────────────────
     Distincts des transactions client : un cabiniste envoie une partie de
     son solde à un autre cabiniste (identifié par cabine_nom), frais de
     service à sa charge (voir business.cabineTransfer). */
  const transferts_cabine = {
    all:  ()   => get(KEY.transferts_cabine),
    byCabine: (cid) => get(KEY.transferts_cabine).filter(t => t.from_cabine_id === cid || t.to_cabine_id === cid).sort((a,b) => new Date(b.date)-new Date(a.date)),

    // Rafraîchit depuis le serveur (voir api/transferts_cabine_list.php) —
    // la table est déjà peuplée par api/cabine_transfer.php depuis le
    // début (le transfert d'argent fonctionne réellement), seule cette
    // lecture manquait : create() ci-dessous n'est donc plus jamais
    // appelée en pratique (le vrai transfert passe par
    // DB.business.cabineTransfer() -> ServerAPI.cabineTransfer()),
    // conservée seulement pour compatibilité.
    async refresh() {
      if (!ServerAPI.isConfigured || !Net.isOnline()) return;
      const res = await ServerAPI.transfertsCabineList();
      if (res.ok) set(KEY.transferts_cabine, res.transferts);
    },

    create(data) {
      const list = get(KEY.transferts_cabine);
      const t = { id: 'tsf_' + uid(), date: now(), ...data };
      list.push(t);
      set(KEY.transferts_cabine, list);
      return t;
    },
  };

  /* ── Forfaits (catalogue Orange/MTN/Moov) ─────────────────────────────
     Gérable depuis l'onglet Super Admin "Forfaits" (ajout/suppression) ;
     l'espace Client relit cette collection à chaque rendu de l'étape
     Forfait, donc toute modification y est visible sans redéploiement. */
  // Ligne serveur (snake_case, voir api/forfaits_*.php) → forme locale
  // (camelCase pour ussdTemplate, seule divergence de nommage).
  function forfaitFromRow(row) {
    const { ussd_template, ...rest } = row;
    return { ...rest, ussdTemplate: ussd_template ?? null };
  }

  const forfaits = {
    all: () => get(KEY.forfaits),
    byOperator: (op) => forfaits.all().filter(f => f.operateur === op),

    // Catégories distinctes pour un réseau, dans l'ordre d'apparition —
    // sert à générer les onglets dynamiques côté Client (tfRenderCats()).
    categoriesByOperator(op) {
      const out = [];
      forfaits.byOperator(op).forEach(f => { if (!out.includes(f.categorie)) out.push(f.categorie); });
      return out;
    },

    // Rafraîchit depuis le serveur (catalogue partagé, lecture publique —
    // voir api/forfaits_list.php) : remplacement total plutôt qu'un upsert,
    // un forfait supprimé côté admin doit disparaître ici aussi.
    async refresh() {
      if (!ServerAPI.isConfigured || !Net.isOnline()) return;
      const res = await ServerAPI.forfaitsList();
      if (res.ok) set(KEY.forfaits, res.forfaits.map(forfaitFromRow));
    },

    async create(data) {
      const res = await ServerAPI.forfaitsCreate(data);
      if (!res.ok) return { ok: false, error: res.error };
      const f = forfaitFromRow(res.forfait);
      const list = forfaits.all();
      list.push(f);
      set(KEY.forfaits, list);
      return { ok: true, forfait: f };
    },

    async update(id, updates) {
      const res = await ServerAPI.forfaitsUpdate(id, updates);
      if (!res.ok) return { ok: false, error: res.error };
      const f = forfaitFromRow(res.forfait);
      const list = forfaits.all();
      const idx  = list.findIndex(x => x.id === id);
      if (idx !== -1) list[idx] = f; else list.push(f);
      set(KEY.forfaits, list);
      return { ok: true, forfait: f };
    },

    async remove(id) {
      const res = await ServerAPI.forfaitsRemove(id);
      if (!res.ok) return { ok: false, error: res.error };
      set(KEY.forfaits, forfaits.all().filter(f => f.id !== id));
      return { ok: true };
    },
  };

  /* â”€â”€ Notifications â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  const notifications = {
    all:  ()   => get(KEY.notifications),
    forUser: (uid) => get(KEY.notifications).filter(n => n.utilisateur_id === uid).sort((a,b) => new Date(b.date)-new Date(a.date)),
    unread: (uid)  => get(KEY.notifications).filter(n => n.utilisateur_id === uid && !n.lu).length,

    // Rafraîchit depuis le serveur (voir api/notifications_list.php) — la
    // table est déjà peuplée depuis la Phase 4 par createNotification()
    // (bootstrap.php), appelée par la quasi-totalité des endpoints
    // métier ; seule cette lecture manquait. Ne remplace que les entrées
    // de CET utilisateur (garde intactes celles d'un autre compte
    // éventuellement en cache localement, ex. impersonation).
    async refresh(userId) {
      if (!ServerAPI.isConfigured || !Net.isOnline()) return;
      const res = await ServerAPI.notificationsList();
      if (!res.ok) return;
      const others = get(KEY.notifications).filter(n => n.utilisateur_id !== userId);
      set(KEY.notifications, [...others, ...res.notifications]);
    },

    // Conservée pour compatibilité — n'est plus appelée en pratique
    // depuis que chaque action métier crée déjà sa notification côté
    // serveur (createNotification(), bootstrap.php) : un create() local
    // en plus créerait un doublon (ids différents, jamais dédupliqués)
    // une fois refresh() exécuté.
    create(utilisateur_id, message, type = 'info') {
      const list = get(KEY.notifications);
      const n = { id: uid(), utilisateur_id, message, lu: false, date: now(), type };
      list.push(n);
      set(KEY.notifications, list);
      return n;
    },

    // Remplace la version locale par api/notifications_mark_read.php —
    // met aussi à jour le cache local immédiatement (pas d'attente du
    // prochain refresh() pour que le badge se corrige).
    async markRead(id) {
      const list = get(KEY.notifications);
      const idx  = list.findIndex(n => n.id === id);
      if (idx !== -1) { list[idx].lu = true; set(KEY.notifications, list); }
      if (ServerAPI.isConfigured && Net.isOnline()) await ServerAPI.notificationsMarkRead(id);
    },

    // Remplace la version locale par api/notifications_mark_all_read.php.
    async markAllRead(userId) {
      const list = get(KEY.notifications).map(n =>
        n.utilisateur_id === userId ? { ...n, lu: true } : n
      );
      set(KEY.notifications, list);
      if (ServerAPI.isConfigured && Net.isOnline()) await ServerAPI.notificationsMarkAllRead();
    },

    // Supprime une notification — voir api/notifications_delete.php. Retirée
    // du cache local immédiatement, pas d'attente du prochain refresh().
    async delete(id) {
      const list = get(KEY.notifications).filter(n => n.id !== id);
      set(KEY.notifications, list);
      if (ServerAPI.isConfigured && Net.isOnline()) await ServerAPI.notificationsDelete(id);
    },
  };

  /* â”€â”€ Réclamations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  // Réclamations — synchronisées de bout en bout (Phase 5, voir
  // api/reclamations_*.php) : lectures restent 100% synchrones (cache
  // local, comme avant), chaque mutation devient un appel serveur dédié
  // (plus de update()/addMessage() génériques — chaque transition d'état a
  // désormais sa propre règle métier vérifiée côté serveur : CAS de
  // propriété, plafond de relances, statut requis...).
  const reclamations = {
    all:             ()      => get(KEY.reclamations) || [],
    byTransaction:   (txnId) => (get(KEY.reclamations)||[]).find(r => r.transaction_id === txnId) || null,
    byCabine:        (cabId) => (get(KEY.reclamations)||[]).filter(r => r.cabine_id === cabId).sort((a,b)=>new Date(b.date_created)-new Date(a.date_created)),
    byClient:        (cliId) => (get(KEY.reclamations)||[]).filter(r => r.client_id === cliId),
    countByClient:   (cliId) => (get(KEY.reclamations)||[]).filter(r => r.client_id === cliId).length,
    pending:         ()      => (get(KEY.reclamations)||[]).filter(r => r.statut === 'en_attente'),

    // Rafraîchit depuis le serveur (portée par rôle côté serveur — voir
    // api/reclamations_list.php) : upsert par id plutôt qu'un remplacement
    // total, même patron que transactions.refresh().
    async refresh() {
      if (!ServerAPI.isConfigured || !Net.isOnline()) return;
      const res = await ServerAPI.reclamationsList();
      if (!res.ok) return;
      const list = get(KEY.reclamations) || [];
      res.reclamations.forEach(row => {
        const idx = list.findIndex(r => r.id === row.id);
        if (idx !== -1) list[idx] = row; else list.push(row);
      });
      set(KEY.reclamations, list);
    },

    // client_id/cabine_id ignorés : toujours re-dérivés de la transaction
    // réelle côté serveur (voir api/reclamations_create.php), jamais fait
    // confiance à une valeur locale potentiellement obsolète ou usurpée.
    async create({ transaction_id, client_id, cabine_id, motif }) {
      void client_id, cabine_id;
      const res = await ServerAPI.reclamationsCreate({ transactionId: transaction_id, motif });
      if (!res.ok) return { ok: false, error: res.error };
      const list = get(KEY.reclamations) || [];
      list.push(res.reclamation);
      set(KEY.reclamations, list);
      return { ok: true, reclamation: res.reclamation };
    },

    // Cabine : fournit une preuve de paiement (voir api/reclamations_resolve.php).
    async resolve(reclaId, screenshot) {
      const res = await ServerAPI.reclamationsResolve(reclaId, screenshot);
      if (!res.ok) return { ok: false, error: res.error };
      await reclamations.refresh();
      return { ok: true };
    },

    // Client : confirme avoir reçu sa commande (voir api/reclamations_confirm_received.php).
    async confirmReceived(reclaId) {
      const res = await ServerAPI.reclamationsConfirmReceived(reclaId);
      if (!res.ok) return { ok: false, error: res.error };
      await reclamations.refresh();
      return { ok: true };
    },

    // Client : relance ("toujours pas reçu") — voir api/reclamations_relance.php.
    async relance(reclaId) {
      const res = await ServerAPI.reclamationsRelance(reclaId);
      if (!res.ok) return { ok: false, error: res.error };
      await reclamations.refresh();
      return { ok: true, relancesApresPreuve: res.relancesApresPreuve };
    },

    // Cabine : transmet une demande de remboursement à l'administration —
    // voir api/reclamations_request_refund.php (déclenche aussi la
    // suspension automatique à 5 demandes/jour, désormais réellement
    // active puisque refund_requests est synchronisée).
    async requestRefund(reclaId) {
      const res = await ServerAPI.reclamationsRequestRefund(reclaId);
      if (!res.ok) return { ok: false, error: res.error };
      await reclamations.refresh();
      return { ok: true };
    },
  };

  /* ── Demandes de remboursement (soumises par la cabine suite à une
     réclamation) ──────────────────────────────────────────────────
     Visibles uniquement côté administration (onglet dédié) — création et
     traitement vivent désormais entièrement côté serveur (voir
     reclamations.requestRefund() ci-dessus et
     DB.business.processRefundRequest ci-dessous), cette collection ne sert
     plus qu'à afficher la liste. */
  const refundRequests = {
    all:            ()        => get(KEY.refundRequests) || [],
    pending:        ()        => (get(KEY.refundRequests) || []).filter(r => r.statut === 'en_attente'),
    byReclamation:  (reclaId) => (get(KEY.refundRequests) || []).find(r => r.reclamation_id === reclaId) || null,

    async refresh() {
      if (!ServerAPI.isConfigured || !Net.isOnline()) return;
      const res = await ServerAPI.refundRequestsList();
      if (res.ok) set(KEY.refundRequests, res.refundRequests);
    },
  };

  /* ── Demandes de réinitialisation de mot de passe ────────────────────
     Remplace ResetRequests (IIFE 100% localStorage, js/client.js) et la
     lecture localStorage directe côté admin.js — voir api/reset_requests_*.php.
     Le nouveau PIN est haché côté serveur DÈS la création (jamais transmis
     ni stocké en clair, contrairement à l'ancienne version locale). */
  const resetRequests = {
    all: () => get(KEY.resetRequests) || [],

    async refresh() {
      if (!ServerAPI.isConfigured || !Net.isOnline()) return;
      const res = await ServerAPI.resetRequestsList();
      if (res.ok) set(KEY.resetRequests, res.resetRequests);
    },

    async create(role, identifiant, nouveauMotDePasse) {
      const res = await ServerAPI.resetRequestsCreate({ role, identifiant, nouveauMotDePasse });
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true };
    },

    async apply(requestId) {
      const res = await ServerAPI.resetRequestsApply(requestId);
      if (!res.ok) return { ok: false, error: res.error };
      await resetRequests.refresh();
      return { ok: true };
    },

    async refuse(requestId) {
      const res = await ServerAPI.resetRequestsRefuse(requestId);
      if (!res.ok) return { ok: false, error: res.error };
      await resetRequests.refresh();
      return { ok: true };
    },
  };

  /* ── Parrainage ────────────────────────────────────────────────────────
     Remplace le compteur figé lu depuis localStorage cbp_parrain_* (jamais
     incrémenté, la fonctionnalité n'était même pas implémentée en local)
     — voir api/referrals_summary.php et creditReferralRewardIfFirstOrder()
     (api/orders_common.php) pour la règle de versement (50 F à la 1re
     commande terminée du filleul, montant déjà annoncé dans l'UI). */
  const referrals = {
    count: () => (get(KEY.referrals) || {}).count || 0,
    total: () => (get(KEY.referrals) || {}).total || 0,

    async refresh() {
      if (!ServerAPI.isConfigured || !Net.isOnline()) return;
      const res = await ServerAPI.referralsSummary();
      if (res.ok) set(KEY.referrals, { count: res.count, total: res.total });
    },
  };

  /* ── Candidatures partenaires ─────────────────────────────────────────
     Remplace Applications (IIFE 100% localStorage, js/client.js) et la
     lecture localStorage directe côté admin.js — voir
     api/partner_applications_*.php. Le PIN choisi est haché côté serveur
     DÈS la création (jamais transmis ni stocké en clair) ; la validation
     crée le compte cabine directement avec ce hash. */
  const partnerApplications = {
    all: () => get(KEY.partnerApplications) || [],

    async refresh() {
      if (!ServerAPI.isConfigured || !Net.isOnline()) return;
      const res = await ServerAPI.partnerApplicationsList();
      if (res.ok) set(KEY.partnerApplications, res.applications);
    },

    async create(payload) {
      const res = await ServerAPI.partnerApplicationsCreate(payload);
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true };
    },

    async validate(applicationId) {
      const res = await ServerAPI.partnerApplicationsValidate(applicationId);
      if (!res.ok) return { ok: false, error: res.error };
      await partnerApplications.refresh();
      return { ok: true, cabineId: res.cabineId };
    },

    async refuse(applicationId) {
      const res = await ServerAPI.partnerApplicationsRefuse(applicationId);
      if (!res.ok) return { ok: false, error: res.error };
      await partnerApplications.refresh();
      return { ok: true };
    },

    async remove(applicationId) {
      const res = await ServerAPI.partnerApplicationsDelete(applicationId);
      if (!res.ok) return { ok: false, error: res.error };
      set(KEY.partnerApplications, (get(KEY.partnerApplications) || []).filter(a => a.id !== applicationId));
      return { ok: true };
    },
  };

  /* ── Journal des accès admin (impersonation) ─────────────────────
     Traçabilité des accès directs de l'administration à l'espace
     partenaire/client sans mot de passe — voir Auth.startImpersonation()
     dans js/auth.js. Lecture seule côté admin (onglet "Journal des accès"). */
  const accessLogs = {
    all: () => get(KEY.accessLogs) || [],

    // Rafraîchit depuis le serveur (voir loadAccessLogs(), js/admin.js) —
    // remplace tout le cache local par le journal serveur : contrairement à
    // favoris, ce journal n'est pas scopé par utilisateur, tous les
    // administrateurs doivent voir le même quel que soit l'appareil.
    async refresh() {
      if (!ServerAPI.isConfigured || !Net.isOnline()) return;
      const res = await ServerAPI.accessLogsList();
      if (res.ok) set(KEY.accessLogs, res.logs);
    },

    create({ admin_id, admin_name, target_user_id, target_role, target_name }) {
      const list = get(KEY.accessLogs) || [];
      const l = { id: 'log_' + uid(), admin_id, admin_name, target_user_id, target_role, target_name, date: now() };
      list.push(l);
      set(KEY.accessLogs, list);
      // Écriture serveur best-effort, jamais bloquante ni mise en file en
      // cas d'échec — un accès délégué ne doit jamais être ralenti par sa
      // propre traçabilité (l'auteur réel est de toute façon réaffirmé
      // côté serveur depuis le jeton, voir api/access_logs_create.php).
      if (ServerAPI.isConfigured && Net.isOnline()) {
        ServerAPI.accessLogsCreate({ admin_name, target_user_id, target_role, target_name }).catch(() => {});
      }
      return l;
    },
  };

  /* ── Journal des permissions cabine ───────────────────────────────
     Historise les changements de services autorisés (Factures/Exchange/
     Recharge UV) faits par un super admin — voir onglet "Permission
     Cabine" et toggleCabinePermission() dans js/admin.js. Même patron
     que accessLogs ci-dessus, dédié plutôt que détourné de son usage
     (impersonation) actuel. */
  const permissionLogs = {
    all:       ()        => get(KEY.permissionLogs) || [],
    byCabine:  (cabineId) => (get(KEY.permissionLogs) || []).filter(l => l.cabine_id === cabineId).sort((a,b) => new Date(b.date) - new Date(a.date)),

    async refresh() {
      if (!ServerAPI.isConfigured || !Net.isOnline()) return;
      const res = await ServerAPI.permissionLogsList();
      if (res.ok) set(KEY.permissionLogs, res.logs);
    },

    create({ admin_id, admin_name, cabine_id, cabine_name, service, active }) {
      const list = get(KEY.permissionLogs) || [];
      const l = { id: 'plog_' + uid(), admin_id, admin_name, cabine_id, cabine_name, service, active, date: now() };
      list.push(l);
      set(KEY.permissionLogs, list);
      if (ServerAPI.isConfigured && Net.isOnline()) {
        ServerAPI.permissionLogsCreate({ admin_name, cabine_id, cabine_name, service, active }).catch(() => {});
      }
      return l;
    },
  };

  /* ── Journal de maintenance (onglet "UV Cabine", super admin) ─────
     Historise chaque blocage/déblocage du service Recharge UV et des
     réseaux (Orange/MTN/Moov) — même patron que permissionLogs ci-dessus,
     dédié plutôt que détourné (concept différent : permissionLogs porte
     sur les services qu'UNE cabine accepte individuellement, ceci porte
     sur un interrupteur global). */
  const maintenanceLogs = {
    all: () => get(KEY.maintenanceLogs) || [],

    async refresh() {
      if (!ServerAPI.isConfigured || !Net.isOnline()) return;
      const res = await ServerAPI.maintenanceLogsList();
      if (res.ok) set(KEY.maintenanceLogs, res.logs);
    },

    // `service`/`message` optionnels — ajoutés pour les nouveaux types
    // d'entrées (réseaux par service, messages Facture) sans rien changer
    // pour les entrées existantes (onglet UV Cabine), qui n'en ont pas besoin.
    create({ admin_id, admin_name, action, key, active, service, message }) {
      const list = get(KEY.maintenanceLogs) || [];
      const l = { id: 'mlog_' + uid(), admin_id, admin_name, action, key, active, service: service || null, message: message ?? null, date: now() };
      list.push(l);
      set(KEY.maintenanceLogs, list);
      if (ServerAPI.isConfigured && Net.isOnline()) {
        ServerAPI.maintenanceLogsCreate({ admin_name, action, key, active, service, message }).catch(() => {});
      }
      return l;
    },
  };

  /* ── Historique des suspensions cabine ────────────────────────────────
     Contrairement aux champs statut/suspendu_* sur le cabiniste (état
     courant, écrasé à chaque levée), cette collection conserve une trace
     de chaque suspension passée (auto ou manuelle) — motif, échéance
     prévue, date/auteur de la levée réelle. Un seul enregistrement
     "ouvert" (date_levee: null) à la fois par cabine. Même patron que
     permissionLogs/maintenanceLogs ci-dessus. */
  const suspensionLogs = {
    all:      ()        => get(KEY.suspensionLogs) || [],
    byCabine: (cabineId) => (get(KEY.suspensionLogs) || []).filter(l => l.cabine_id === cabineId).sort((a,b) => new Date(b.date_debut) - new Date(a.date_debut)),
    active:   (cabineId) => (get(KEY.suspensionLogs) || []).find(l => l.cabine_id === cabineId && !l.date_levee) || null,

    create({ cabine_id, motif, auto, date_fin_prevue }) {
      const list = get(KEY.suspensionLogs) || [];
      const l = { id: 'slog_' + uid(), cabine_id, motif, auto, date_debut: now(), date_fin_prevue: date_fin_prevue || null, date_levee: null, levee_par: null };
      list.push(l);
      set(KEY.suspensionLogs, list);
      return l;
    },

    close(cabineId, leveePar) {
      const list = get(KEY.suspensionLogs) || [];
      const idx = list.findIndex(l => l.cabine_id === cabineId && !l.date_levee);
      if (idx !== -1) { list[idx].date_levee = now(); list[idx].levee_par = leveePar; set(KEY.suspensionLogs, list); }
    },
  };

  /* ── Réabonnements cabine ────────────────────────────────────────
     Historique des réabonnements payés par une cabine via son solde —
     voir business.resubscribeCabine ci-dessous. Lecture seule côté admin
     (onglet "Réabonnement cabine", super administrateur uniquement). */
  const resubscriptions = {
    all: () => get(KEY.resubscriptions) || [],

    // Rafraîchit depuis le serveur (voir api/resubscriptions_list.php) —
    // la table est déjà peuplée par api/cabine_resubscribe.php depuis le
    // début, seule cette lecture manquait : create() ci-dessous n'est plus
    // jamais appelée en pratique (le vrai réabonnement passe par
    // DB.business.resubscribeCabine() -> ServerAPI.cabineResubscribe()),
    // conservée seulement pour compatibilité.
    async refresh() {
      if (!ServerAPI.isConfigured || !Net.isOnline()) return;
      const res = await ServerAPI.resubscriptionsList();
      if (res.ok) set(KEY.resubscriptions, res.resubscriptions);
    },

    create({ cabine_id, formule, prix }) {
      const list = get(KEY.resubscriptions) || [];
      const r = { id: 'rsb_' + uid(), cabine_id, formule, prix, date: now() };
      list.push(r);
      set(KEY.resubscriptions, list);
      return r;
    },
  };

  /* ── Numéros favoris (client) ─────────────────────────────────────
     Liste gérée par le client lui-même depuis son profil (nom optionnel
     + numéro), proposée en sélection rapide à l'étape "Numéro du
     destinataire" du Transfert direct. 100% privé (jamais lu par
     cabine.js/admin.js) — premier module métier synchronisé de bout en
     bout (voir api/favoris_list.php/favoris_create.php/favoris_remove.php),
     sert de preuve du patron avant le reste de la Phase 2. LocalStorage
     reste le cache affiché instantanément (all()/forUser() restent
     synchrones) ; create()/remove() écrivent en local IMMÉDIATEMENT puis
     synchronisent en tâche de fond (même patron que DB.settings.update()
     ci-dessus), refresh() tire depuis le serveur pour qu'un nouvel
     appareil retrouve ses favoris. */
  const favoris = {
    all: () => get(KEY.favoris) || [],
    forUser: (clientId) => (get(KEY.favoris) || [])
      .filter(f => f.client_id === clientId)
      .sort((a, b) => new Date(b.date_creation) - new Date(a.date_creation)),

    // Rafraîchissement en arrière-plan (voir loadFavoris(), js/client.js,
    // qui affiche le cache immédiatement puis rappelle ceci) — remplace la
    // part locale de CE client par la liste serveur, source de vérité.
    async refresh(clientId) {
      if (!ServerAPI.isConfigured || !Net.isOnline()) return;
      const res = await ServerAPI.favorisList();
      if (!res.ok) return;
      const others = (get(KEY.favoris) || []).filter(f => f.client_id !== clientId);
      set(KEY.favoris, [...others, ...res.favoris]);
    },

    async create({ client_id, nom, numero }) {
      const list = get(KEY.favoris) || [];
      const f = { id: 'fav_' + uid(), client_id, nom: nom || '', numero, date_creation: now() };
      list.push(f);
      set(KEY.favoris, list);

      if (!ServerAPI.isConfigured) return f;
      if (Net.isOnline()) {
        try {
          // synced : l'enregistrement final, id serveur compris (voir
          // SYNC_HANDLERS.favorisCreate) — jamais l'objet `f` d'origine,
          // dont l'id local devient obsolète dès l'échange réussi (un
          // appelant qui garderait `f.id` pour un remove() ultérieur
          // viserait sinon une ligne qui n'existe plus sous cet id).
          const synced = await SYNC_HANDLERS.favorisCreate({ localId: f.id, nom: f.nom, numero: f.numero });
          return synced || f;
        }
        catch (e) { /* tombe dans la mise en file ci-dessous */ }
      }
      syncQueue.enqueue({ entity: 'favorisCreate', op: 'create', payload: { localId: f.id, nom: f.nom, numero: f.numero } });
      return f;
    },

    async remove(id) {
      set(KEY.favoris, (get(KEY.favoris) || []).filter(f => f.id !== id));

      // Une création pour cet id est encore en file (jamais synchronisée) :
      // rien n'existe côté serveur, on l'annule directement plutôt que de
      // mettre une suppression en file pour une ligne qui ne sera jamais créée.
      const pendingCreate = syncQueue.all().find(i => i.entity === 'favorisCreate' && i.payload.localId === id);
      if (pendingCreate) { syncQueue.remove(pendingCreate.id); return; }

      if (!ServerAPI.isConfigured) return;
      if (Net.isOnline()) {
        try { await SYNC_HANDLERS.favorisRemove({ id }); return; }
        catch (e) { /* tombe dans la mise en file ci-dessous */ }
      }
      syncQueue.enqueue({ entity: 'favorisRemove', op: 'remove', payload: { id } });
    },
  };

  /* ── Commissions ───────────────────────────────────────────────────────
     Synchronisé de bout en bout (Phase 6, priorité la plus basse) — voir
     api/commissions_list.php/commissions_update_rate.php. calc() reste une
     estimation purement locale (utile pour un aperçu instantané avant
     confirmation, voir tfUpdateSummary()/js/client.js) : la commission
     RÉELLE d'une commande est déjà calculée côté serveur depuis la Phase 4
     (calcCommission(), api/orders_common.php), qui lit cette même table. */
  const commissions = {
    all:  ()   => get(KEY.commissions),
    active: () => get(KEY.commissions).find(c => c.actif) || { pourcentage: 5 },

    calc(montant) {
      const rule = commissions.active();
      return Math.round(montant * (rule.pourcentage / 100));
    },

    async refresh() {
      if (!ServerAPI.isConfigured || !Net.isOnline()) return;
      const res = await ServerAPI.commissionsList();
      if (res.ok) set(KEY.commissions, res.commissions);
    },

    // Applique le même taux à TOUTES les règles existantes (voir
    // api/commissions_update_rate.php — en pratique une seule règle,
    // jamais plusieurs créées par l'interface admin).
    async updateRate(pourcentage) {
      const res = await ServerAPI.commissionsUpdateRate(pourcentage);
      if (!res.ok) return { ok: false, error: res.error };
      set(KEY.commissions, res.commissions);
      return { ok: true };
    },
  };

  /* ── File d'attente de synchronisation (générique) ────────────────────
     Hors-ligne d'abord : LocalStorage est TOUJOURS la source de vérité sur
     l'appareil, le serveur (api/, PHP+MySQL) n'est qu'une synchronisation
     optionnelle en tâche de fond, jamais bloquante. Toute écriture qui n'a pas pu être poussée
     (hors ligne, ou en ligne mais échec réseau) atterrit ici pour être
     rejouée dès que possible — même patron que permissionLogs/
     suspensionLogs. `entity` doit avoir un handler dans SYNC_HANDLERS. */
  const syncQueue = {
    all: () => get(KEY.syncQueue) || [],
    enqueue({ entity, op, payload }) {
      const list = get(KEY.syncQueue) || [];
      list.push({ id: 'sq_' + uid(), entity, op, payload, created_at: now(), attempts: 0 });
      set(KEY.syncQueue, list);
    },
    remove(id) {
      set(KEY.syncQueue, (get(KEY.syncQueue) || []).filter(i => i.id !== id));
    },
    bumpAttempts(id) {
      const list = get(KEY.syncQueue) || [];
      const idx = list.findIndex(i => i.id === id);
      if (idx !== -1) { list[idx].attempts++; set(KEY.syncQueue, list); }
    },
  };

  // Un handler par entité : sait pousser un item de la file vers le serveur
  // (api/, PHP+MySQL). Lève une exception en cas d'échec (laisse l'item en
  // file pour un prochain essai) — voir drainSyncQueue() ci-dessous.
  const SYNC_HANDLERS = {
    async settings(updates) {
      // Défense en profondeur : couvre aussi une entrée déjà en file
      // (ancienne session, avant ce contrôle) — sans configuration réelle,
      // rien ne sera jamais synchronisable, donc rien à réessayer :
      // succès silencieux (voir drainSyncQueue ci-dessus, qui retire alors
      // l'entrée de la file) plutôt qu'un échec qui la ferait rester
      // indéfiniment.
      if (!ServerAPI.isConfigured) return;
      const row = {};
      for (const [jsKey, col] of Object.entries(SETTINGS_COLUMNS)) {
        if (jsKey in updates) row[col] = updates[jsKey];
      }
      await ServerAPI.updateSettings(row);
    },

    // Remplace l'id local temporaire (généré hors ligne) par l'id réel
    // renvoyé par le serveur, pour qu'un remove() ultérieur cible la bonne
    // ligne côté serveur — voir favoris.create() ci-dessous.
    async favorisCreate(payload) {
      if (!ServerAPI.isConfigured) return null;
      const res = await ServerAPI.favorisCreate({ nom: payload.nom, numero: payload.numero });
      if (!res.ok) throw new Error(res.error || 'Échec de l\'ajout du favori.');
      const list = get(KEY.favoris) || [];
      const idx = list.findIndex(f => f.id === payload.localId);
      if (idx === -1) return null;
      list[idx] = { ...list[idx], id: res.favori.id };
      set(KEY.favoris, list);
      return list[idx];
    },

    async favorisRemove(payload) {
      if (!ServerAPI.isConfigured) return;
      const res = await ServerAPI.favorisRemove(payload.id);
      if (!res.ok) throw new Error(res.error || 'Échec de la suppression du favori.');
    },
  };

  // Rejoue la file dès qu'une connexion est disponible — appelée au boot
  // de chaque page et à chaque transition offline→online (voir Net.onChange
  // dans client.js/cabine.js/admin.js).
  async function drainSyncQueue() {
    if (!Net.isOnline()) return;
    for (const item of syncQueue.all()) {
      try {
        await SYNC_HANDLERS[item.entity](item.payload);
        syncQueue.remove(item.id);
      } catch (e) {
        syncQueue.bumpAttempts(item.id);
      }
    }
  }

  /* ── Settings ─────────────────────────────────────────────────────────
     LocalStorage est la source de vérité sur l'appareil (clé KEY.settings,
     déjà écrite une fois par seed() ci-dessus) ; le serveur (table MySQL
     `settings`, une seule ligne, voir api/) n'est qu'un miroir partagé
     synchronisé en best-effort quand une connexion est là. Chaque section
     (maintenance/assistance/...) reste sa propre colonne JSON côté serveur :
     update() n'écrase que les colonnes présentes dans `updates`, ce qui
     élimine par construction
     l'ancien bug de fusion superficielle sur un blob unique. get()/update()
     restent asynchrones (déjà converti tout appelant en `async`/`await`
     dans client.js/cabine.js/admin.js), mais ne dépendent plus du réseau
     pour fonctionner. */
  const SETTINGS_COLUMNS = {
    platformName: 'platform_name', currency: 'currency', commissionRate: 'commission_rate',
    minTransfer: 'min_transfer', maxTransfer: 'max_transfer', rechargeMin: 'recharge_min',
    maintenance: 'maintenance', assistance: 'assistance',
    assistant_cabine: 'assistant_cabine', assistant_client: 'assistant_client',
    ussd_templates: 'ussd_templates', admin_schedules: 'admin_schedules',
    actualites: 'actualites',
  };
  let _settingsRefreshInFlight = null;
  function rowToSettings(row) {
    const out = {};
    for (const [jsKey, col] of Object.entries(SETTINGS_COLUMNS)) out[jsKey] = row[col];
    return out;
  }
  const settings = {
    // Cache-first (stale-while-revalidate) : ne bloque JAMAIS sur le réseau,
    // même en ligne — sur un réseau lent/instable (Côte d'Ivoire), attendre
    // une réponse serveur avant de répondre rendrait chaque vérification de
    // maintenance perceptiblement lente (cette méthode est appelée à chaque
    // clic sur un service, voir isServiceInMaintenance() etc. ci-dessous).
    // Retourne le cache local instantanément et rafraîchit depuis le serveur
    // en tâche de fond pour la prochaine lecture — jamais plus d'un
    // rafraîchissement à la fois (voir _refresh()).
    async get() {
      if (Net.isOnline()) settings._refresh();
      return get(KEY.settings) || {};
    },
    // Rafraîchissement en arrière-plan, dédupliqué (jamais deux requêtes
    // serveur en vol en même temps) — exposé séparément (plutôt que fondu
    // dans get()) pour que les tests puissent l'attendre explicitement sans
    // délai arbitraire.
    _refresh() {
      // Voir la note dans update() ci-dessous : sans configuration réelle,
      // toute tentative échouerait de toute façon (domaine placeholder,
      // ERR_NAME_NOT_RESOLVED) — jamais appelé dans ce cas, le cache
      // local reste directement la seule source de vérité.
      if (!ServerAPI.isConfigured) return Promise.resolve();
      if (_settingsRefreshInFlight) return _settingsRefreshInFlight;
      _settingsRefreshInFlight = (async () => {
        try {
          const data = await ServerAPI.getSettings();
          if (data) set(KEY.settings, rowToSettings(data));
        } catch (e) { /* réseau indisponible malgré navigator.onLine — le cache local reste valable */ }
        finally { _settingsRefreshInFlight = null; }
      })();
      return _settingsRefreshInFlight;
    },
    async update(updates) {
      // Écrit en local IMMÉDIATEMENT : source de vérité sur l'appareil,
      // l'admin voit son changement à l'instant, connexion ou pas.
      const current = get(KEY.settings) || {};
      set(KEY.settings, { ...current, ...updates });

      // Tant que le serveur n'est pas réellement configuré (voir
      // ServerAPI.isConfigured, js/server-api.js), aucune tentative réseau
      // n'a de sens : le domaine placeholder ne résoudra jamais, et mettre
      // quand même en file ferait grossir syncQueue à l'infini pour une
      // resynchronisation qui n'arrivera jamais.
      if (!ServerAPI.isConfigured) return;

      if (Net.isOnline()) {
        try {
          await SYNC_HANDLERS.settings(updates);
          return; // synchronisé tout de suite, rien à mettre en file
        } catch (e) { /* tombe dans la mise en file ci-dessous */ }
      }
      syncQueue.enqueue({ entity: 'settings', op: 'update', payload: updates });
    },
  };

  // Les listes assistant_cabine.whatsapp / assistant_client.whatsapp
  // contenaient de simples chaînes avant l'ajout du champ "Nom" — lecture
  // défensive pour rester compatible avec d'éventuelles entrées déjà
  // enregistrées sous cette forme.
  function normalizeContact(x) {
    return typeof x === 'string' ? { nom: '', numero: x } : x;
  }

  /* â”€â”€ Quotas de commission par forfait â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  // Une fois le quota de commissions atteint, l'abonnement de la cabine
  // prend fin avant même la fin du mois (statut passé à "inactif").
  const SUBSCRIPTION_QUOTAS = { Premium: 25000, VIP: 50000, VVIP: 250000 };

  /* Prix de chaque formule — repris des pages marketing client.html
     ("Nos abonnements" / inscription partenaire), jusqu'ici jamais lus
     par du JS. Payé exclusivement via le solde (voir
     business.resubscribeCabine ci-dessous). */
  const SUBSCRIPTION_PRICES = { Premium: 10000, VIP: 20000, VVIP: 50000 };

  /* â”€â”€ Business logic â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  const business = {
    /* Client crée une demande de transfert — remplace l'ancienne version
       100% locale (débit du solde, calcul de commission, création,
       attribution initiale) par un seul appel serveur atomique (voir
       api/orders_create.php) : le débit y est un compare-and-swap sur le
       solde, jamais une lecture-puis-écriture séparée comme ci-dessous
       auparavant. Exige désormais une connexion internet active (plus de
       repli/mise en file hors ligne, voir le plan Phase 2) : le solde
       local peut être obsolète (débité depuis un autre appareil), seule
       la réponse du serveur fait foi. `client_id` n'est plus utilisé (le
       serveur l'infère du jeton d'authentification, jamais d'une valeur
       fournie par l'appelant) — conservé en paramètre pour ne pas casser
       les appels existants. */
    async createTransfer({ client_id, operateur, numero_beneficiaire, montant, service, moyen_paiement, numero_paiement, details }) {
      const res = await ServerAPI.ordersCreate({ operateur, numero_beneficiaire, montant, service, moyen_paiement, numero_paiement, details });
      if (!res.ok) return { ok: false, error: res.error || 'Échec de la création de la commande.' };

      const txn = res.transaction;
      const list = get(KEY.transactions);
      list.push(txn);
      set(KEY.transactions, list);

      return { ok: true, txn };
    },

    /* Client crée une commande "service avancé" (Facture / Recharge UV /
       Exchange) — remplace l'ancienne version 100% locale de
       _svcDebitAndRecord() (js/client.js) par un appel serveur atomique
       (voir api/orders_create_advanced.php), même patron que
       createTransfer() ci-dessus. Sans ça, ces 3 types de commande
       n'étaient jamais envoyés au serveur et restaient invisibles de
       l'administration. */
    async createAdvancedOrder({ type, montant, service, operateur, numero, details, notes }) {
      const res = await ServerAPI.ordersCreateAdvanced({ type, montant, service, operateur, numero, details, notes });
      if (!res.ok) return { ok: false, error: res.error || 'Échec de la création de la commande.' };

      const txn = res.transaction;
      const list = get(KEY.transactions);
      list.push(txn);
      set(KEY.transactions, list);

      return { ok: true, txn };
    },

    /* Enregistre la photo de profil de l'utilisateur connecté côté serveur
       (voir api/client_update_photo.php) — remplace le stockage 100% local
       (localStorage) de uploadProfilePhoto() (js/client.js), qui ne
       suivait pas le compte d'un appareil à l'autre. `userId` fourni par
       l'appelant (jamais lu ici via Auth, pour ne pas faire dépendre
       js/db.js de js/auth.js). */
    async updateOwnPhoto(userId, photo) {
      const res = await ServerAPI.updateProfilePhoto(photo);
      if (!res.ok) return { ok: false, error: res.error };
      users.update(userId, { photo });
      return { ok: true };
    },

    /* Réclame la récompense "100 commandes" — remplace l'ancienne version
       100% locale de cadeauClaim() (js/client.js) par un appel serveur
       (voir api/cadeau_claim.php, qui recalcule lui-même l'éligibilité :
       jamais fiable de faire confiance à un compteur envoyé par le
       client pour une opération monétaire). */
    async claimCadeau() {
      const res = await ServerAPI.cadeauClaim();
      if (!res.ok) return { ok: false, error: res.error || 'Échec de la réclamation.' };

      const txn = res.transaction;
      const list = get(KEY.transactions);
      list.push(txn);
      set(KEY.transactions, list);

      return { ok: true, txn };
    },

    /* Nombre de commandes actuellement en attente dans l'espace d'une cabine. */
    pendingCountForCabine(cabineId) {
      return transactions.byCabine(cabineId).filter(t => t.statut === 'en_attente').length;
    },

    /* Une cabine a atteint sa limite (voir `limite_commandes`, réglable par
       l'admin — champ absent ou 0 = pas de limite). */
    isCabineAtLimit(cabineId) {
      const cab = users.byId(cabineId);
      if (!cab || !cab.limite_commandes) return false;
      return business.pendingCountForCabine(cabineId) >= cab.limite_commandes;
    },

    /* Une cabine avec au moins une réclamation non traitée (statut
       'en_attente') ne doit recevoir aucune nouvelle commande tant que
       TOUTES ses réclamations en attente n'ont pas été traitées (preuve
       fournie ou remboursement demandé — voir renderCabReclaList dans
       js/cabine.js pour ce qui compte comme "traité"). */
    hasBlockingReclamation(cabineId) {
      return reclamations.byCabine(cabineId).some(r => r.statut === 'en_attente');
    },

    /* Une cabine ne reçoit que les commandes des réseaux qu'elle a
       activés (voir toggleNetwork()/reseaux_actifs dans js/cabine.js) —
       si le champ n'est jamais renseigné, les 3 réseaux sont considérés
       actifs par défaut (compte pas encore configuré). Les opérateurs non
       reconnus (services avancés hors file d'attente) ne sont pas
       restreints. */
    cabineAcceptsNetwork(cabineId, operateur) {
      const cab = users.byId(cabineId);
      if (!cab) return false;
      const nets = cab.reseaux_actifs || { orange: true, moov: true, mtn: true };
      const op = (operateur || '').toLowerCase();
      if (op.includes('orange')) return !!nets.orange;
      if (op.includes('moov'))   return !!nets.moov;
      if (op.includes('mtn'))    return !!nets.mtn;
      return true;
    },

    /* Une cabine peut être exclue de certains services (Factures, Exchange,
       Recharge UV) via l'onglet admin "Permission Cabine" — voir
       services_actifs sur le user cabine, même logique de défaut que
       reseaux_actifs (absent = tout activé). Le transfert direct n'a pas
       de transaction.type (undefined) et n'est pas concerné par ce filtre. */
    cabineAcceptsService(cabineId, type) {
      const SERVICE_KEYS = ['facture', 'exchange', 'recharge_uv'];
      if (!SERVICE_KEYS.includes(type)) return true;
      const cab = users.byId(cabineId);
      if (!cab) return false;
      const svcs = cab.services_actifs || { facture: true, exchange: true, recharge_uv: true };
      return !!svcs[type];
    },

    /* Sélectionne la cabine cible d'une réattribution (retard ou renvoi
       manuel) : parmi les cabines actuellement connectées (presence),
       actives, non en pause, sans réclamation bloquante, acceptant le
       réseau de la commande, et sous leur limite, celle qui a le moins de
       commandes en attente (répartition par charge minimale) — évite de
       toujours favoriser la même cabine (premier arrivé) ou de
       réattribuer à une cabine hors ligne. */
    findReassignmentTarget(excludeCabineId, operateur, type) {
      const eligible = users.byRole('cabine').filter(c =>
        c.id !== excludeCabineId && c.statut === 'actif' && !c.en_pause &&
        !business.isCabineAtLimit(c.id) && !business.hasBlockingReclamation(c.id) &&
        business.cabineAcceptsNetwork(c.id, operateur) &&
        business.cabineAcceptsService(c.id, type) &&
        presence.onlineCabineIds().includes(c.id)
      );
      if (!eligible.length) return null;
      eligible.sort((a, b) => business.pendingCountForCabine(a.id) - business.pendingCountForCabine(b.id));
      return eligible[0];
    },

    /* Calcul pur, sans effet de bord — utilisé par cabine.js pour
       afficher le récapitulatif AVANT que le paiement ne soit confirmé
       (voir cabUvShowRecap, js/cabine.js). Le frais est le même que
       celui appliqué par cabineSelfRecharge ci-dessous (FRAIS_SERVICE_UV_CABINE,
       seule source de vérité). */
    previewCabineSelfRecharge(cabineId, montant) {
      const cab = users.byId(cabineId);
      const frais = FRAIS_SERVICE_UV_CABINE;
      const total = (Number(montant) || 0) + frais;
      const soldeActuel = cab ? (cab.solde || 0) : 0;
      return { frais, total, soldeActuel, soldeApres: soldeActuel - total };
    },

    /* Recharge UV en libre-service côté cabine (voir cabUvShowRecap/
       cabUvConfirmPayment, js/cabine.js) — payée exclusivement par le solde en attente de la
       cabine qui la déclenche, mais TRAITÉE par une autre cabine : la
       transaction passe par le même circuit "commande" que les demandes
       clients (en_attente → assignation → acceptRequest/refuseRequest),
       au lieu de se débiter et se terminer instantanément elle-même.
       Réutilise findReassignmentTarget (déjà conçu pour exclure la cabine
       d'origine et ne cibler qu'une cabine actuellement connectée) plutôt
       que d'inventer une nouvelle sélection. Frais de service fixe
       (FRAIS_SERVICE_UV_CABINE) ajouté au montant débité, même convention
       que FRAIS_SERVICE_AVANCE côté client (js/client.js). */
    // Remplace la version locale par api/cabine_self_recharge.php (débit
    // atomique CAS sur solde >= ? + attribution dans la même requête).
    async cabineSelfRecharge(cabineId, { network, numero, montant }) {
      const res = await ServerAPI.cabineSelfRecharge({ network, numero, montant });
      if (!res.ok) return { ok: false, error: res.error };

      const list = get(KEY.transactions);
      const idx = list.findIndex(t => t.id === res.transaction.id);
      if (idx !== -1) list[idx] = res.transaction; else list.push(res.transaction);
      set(KEY.transactions, list);

      const cab = users.byId(cabineId);
      if (cab) users.update(cabineId, { solde: (cab.solde || 0) - res.total });

      return { ok: true, transaction: res.transaction, assignedTo: res.assignedTo, frais: res.frais, total: res.total };
    },

    /* Solde réel/retirable d'une cabine (colonne profiles.solde) — utilisé
       par viewUser(), la modale "Solde après recharge" et l'export CSV
       (js/admin.js). Augmente avec chaque recharge, diminue avec chaque
       retrait/remboursement/sanction — depuis que la commission ne
       crédite plus ce solde à l'acceptation d'une commande (voir
       api/orders_accept.php), reste à jour uniquement via ces opérations,
       toujours calculé côté serveur (débit atomique CAS sur solde >= ?,
       voir api/retraits_create.php), jamais recalculé côté client. */
    cabineSoldeDisponible(user) {
      return (user && user.solde) || 0;
    },

    /* "Portefeuille" de la cabine — somme des MONTANTS (pas des
       commissions) de ses commandes TERMINÉES, à la demande explicite de
       l'administration. Utilisé comme LA source unique de "Solde actuel"
       (Recharge cabiniste), "Montant disponible" (Retraits), "Solde en
       attente" (espace cabine) et "Solde" (Gestion des cabines), voir
       js/admin.js/js/cabine.js. Distinct de cabineSoldeDisponible()
       ci-dessus : ne diminue jamais après un retrait ou une commande
       remboursée — accepté sciemment, le débit réel (profiles.solde)
       reste protégé côté serveur (CAS, voir api/retraits_create.php), qui
       refuse toujours un retrait au-delà de l'argent réellement en caisse
       quel que soit ce que cet affichage suggère. */
    cabineVolumeTraite(cabineId) {
      return transactions.byCabine(cabineId)
        .filter(t => t.statut === 'terminé')
        .reduce((s, t) => s + (t.montant || 0), 0);
    },

    /* Réglages propres à la cabine (réseaux actifs, pause du service,
       coordonnées) — remplace DB.users.update() local (js/cabine.js) par
       api/cabine_update_self.php : sans ça, ni le moteur d'attribution des
       commandes (qui lit reseaux_actifs/en_pause directement en base) ni
       un autre appareil connecté au même compte ne voyaient jamais ces
       changements. `updates` ne transporte que les clés à modifier. */
    async cabineUpdateSelf(cabineId, updates) {
      const res = await ServerAPI.cabineUpdateSelf(updates);
      if (!res.ok) return { ok: false, error: res.error };
      users.update(cabineId, updates);
      return { ok: true, profile: res.profile };
    },

    /* Changement de code PIN par la cabine — remplace DB.users.update()
       local par api/cabine_update_pin.php (revérifie le code actuel côté
       serveur, jamais fait confiance à une vérification locale seule pour
       une action de sécurité). Le cache local est mis à jour après coup
       (même hash local que tous les comptes, voir users.update()) pour que
       la connexion hors-ligne sur CET appareil reste possible. */
    async cabineUpdatePin(cabineId, currentPin, newPin) {
      const res = await ServerAPI.cabineUpdatePin(currentPin, newPin);
      if (!res.ok) return { ok: false, error: res.error };
      users.update(cabineId, { mot_de_passe: newPin });
      return { ok: true };
    },

    /* Cabine accepte une commande — remplace l'ancienne version locale
       (voir historique Git) par un appel serveur atomique (voir
       api/orders_accept.php) qui corrige la faille de concurrence
       historique : l'ancienne version ne vérifiait jamais que la commande
       appartenait bien à la cabine qui agit (seul le statut était
       contrôlé). Le crédit de commission est reflété localement tout de
       suite (le cabiniste doit voir son solde à jour sans délai) à partir
       des données déjà connues avant l'appel — un éventuel écart mineur
       est résorbé par le prochain rafraîchissement (transactions.refresh()
       ci-dessous, ou un futur cycle de présence/statut). */
    async acceptRequest(txnId, cabine_id, proof) {
      const txnBefore = transactions.byId(txnId);
      const res = await ServerAPI.ordersAccept(txnId, proof);
      if (!res.ok) return { ok: false, error: res.error || 'Échec de la validation.' };

      if (txnBefore) {
        const cab = users.byId(cabine_id);
        if (cab) {
          const newCommTotal = (cab.commissions_total || 0) + txnBefore.commission;
          const updates = {
            solde: (cab.solde || 0) + txnBefore.commission,
            commissions_total: newCommTotal,
            transferts_total: (cab.transferts_total || 0) + 1,
          };
          const quota = SUBSCRIPTION_QUOTAS[cab.abonnement || 'Premium'];
          if (quota && cab.statut === 'actif' && newCommTotal >= quota) updates.statut = 'inactif';
          users.update(cabine_id, updates);
        }
      }

      await transactions.refresh();
      return { ok: true };
    },

    /* "Conserver 5 min" — remplace la version locale (transactions.update()
       direct) par api/orders_hold.php : sans ça, le balayage serveur des
       commandes en retard (api/orders_sweep.php) ne voyait jamais la
       prolongation et pouvait réattribuer la commande malgré la
       réservation affichée à l'écran. */
    async holdOrder(txnId) {
      const res = await ServerAPI.ordersHold(txnId);
      if (!res.ok) return { ok: false, error: res.error };
      const list = get(KEY.transactions);
      const idx = list.findIndex(t => t.id === txnId);
      if (idx !== -1) list[idx] = res.transaction;
      set(KEY.transactions, list);
      return { ok: true, transaction: res.transaction };
    },

    /* Cabine refuse (renvoi manuel motivé) — remplace l'ancienne version
       locale par api/orders_refuse.php, même correctif CAS de propriété
       qu'acceptRequest ci-dessus. La réattribution (cible + notifications)
       est entièrement décidée côté serveur ; transactions.refresh()
       ci-dessous récupère l'état final (réassignée ou repassée en attente
       non assignée). */
    async refuseRequest(txnId, cabine_id, motif, justification) {
      const res = await ServerAPI.ordersRefuse(txnId, motif, justification);
      if (!res.ok) return { ok: false, error: res.error || 'Échec du renvoi.' };

      const cab = users.byId(cabine_id);
      if (cab) users.update(cabine_id, { commandes_renvoyees: (cab.commandes_renvoyees || 0) + 1 });

      await transactions.refresh();
      return { ok: true, reassignedTo: res.reassignedTo };
    },

    /* Dès qu'une cabine se connecte (voir cabine.js boot()), lui réassigne
       automatiquement les commandes en attente non assignées (pool
       "administration") — remplace la version locale par
       api/orders_assign_pending.php (chaque revendication y est un CAS
       individuel). Retourne le nombre de commandes reprises. */
    async assignPendingToCabine(cabineId) {
      const res = await ServerAPI.ordersAssignPending();
      if (res.ok && res.count > 0) await transactions.refresh();
      return res.count;
    },

    /* Admin : réassigne manuellement une commande en attente vers une
       autre cabine — remplace la version locale par api/orders_reassign.php. */
    async reassignTransaction(txnId, newCabineId) {
      const res = await ServerAPI.ordersReassign([txnId], newCabineId);
      if (!res.ok) return { ok: false, error: res.error };
      await transactions.refresh();
      const single = res.results && res.results[0];
      return single ? { ok: single.ok, error: single.error } : { ok: false, error: 'Réponse serveur inattendue.' };
    },

    /* Admin : rembourse le client pour une commande en attente ou terminée
       — remplace la version locale par api/orders_refund.php (double
       sanction cabine incluse si la commande était déjà marquée
       "Terminée" à tort). */
    async refundTransaction(txnId) {
      const res = await ServerAPI.ordersRefund(txnId);
      if (!res.ok) return { ok: false, error: res.error };
      await transactions.refresh();
      return { ok: true };
    },

    /* Admin : valide une demande de remboursement soumise par une cabine
       suite à une réclamation — remplace la version locale par
       api/orders_process_refund.php (effet financier + traçage de la
       demande et de la réclamation liée, dans une seule transaction PDO). */
    async processRefundRequest(requestId, adminId) {
      void adminId; // désormais inféré côté serveur depuis le jeton
      const res = await ServerAPI.ordersProcessRefund(requestId);
      if (!res.ok) return { ok: false, error: res.error };
      await Promise.all([transactions.refresh(), refundRequests.refresh(), reclamations.refresh()]);
      return { ok: true };
    },

    /* Admin : suspend une commande (en attente ou terminée) avec motif
       obligatoire. Ne touche pas aux soldes — c'est une mise en attente
       (gel), pas une annulation financière (voir refundTransaction pour
       ça). Réversible via reactivateTransaction. */
    // Remplace la version locale par api/orders_suspend.php.
    async suspendTransaction(txnId, motif) {
      if (!motif || !motif.trim()) return { ok: false, error: 'Le motif de suspension est obligatoire.' };
      const res = await ServerAPI.ordersSuspend(txnId, motif.trim());
      if (!res.ok) return { ok: false, error: res.error };
      await transactions.refresh();
      return { ok: true };
    },

    // Remplace la version locale par api/orders_reactivate.php.
    async reactivateTransaction(txnId) {
      const res = await ServerAPI.ordersReactivate(txnId);
      if (!res.ok) return { ok: false, error: res.error };
      await transactions.refresh();
      return { ok: true };
    },

    /* Super admin uniquement : suppression définitive d'une commande (voir
       api/orders_delete.php — bloquée côté serveur pour une commande
       'terminé', rembourser d'abord via refundTransaction). Cascade sur
       réclamation/messages/demande de remboursement/retards liés. */
    async deleteTransaction(txnId) {
      const res = await ServerAPI.ordersDelete(txnId);
      if (!res.ok) return { ok: false, error: res.error };
      await transactions.refresh();
      return { ok: true };
    },

    // Recharge de portefeuille — remplace la version locale par
    // api/orders_recharge.php (vérifie le verrou maintenance serveur lui-
    // même). `user_id` toujours transmis comme cible : le serveur l'honore
    // uniquement si l'appelant est admin (voir l'endpoint), sinon il ne
    // peut de toute façon créditer que son propre compte — aucune décision
    // "self vs autre" à prendre ici.
    async recharge(user_id, montant, method) {
      const res = await ServerAPI.ordersRecharge({ montant, method, targetId: user_id });
      if (!res.ok) return { ok: false, error: res.error };
      // Reflète le crédit localement tout de suite (le compte crédité doit
      // voir son solde à jour sans délai) — un éventuel écart mineur est
      // résorbé par la prochaine synchronisation de profil.
      const target = users.byId(user_id);
      if (target) users.update(user_id, { solde: (target.solde || 0) + montant });
      return { ok: true };
    },

    /* Lève une suspension automatique (feature 5) si son délai de 24h est
       expiré. Appelée à la fois depuis Auth.login (connexion à froid) et
       depuis sweepStaleOrders (session déjà ouverte) — voir le plan.
       Une suspension MANUELLE (suspendu_by non nul) n'a pas d'échéance —
       elle n'est jamais levée automatiquement ici, seul un admin autorisé
       peut la lever (voir js/admin.js toggleCabine). */
    checkAutoUnsuspend(cabineId) {
      const c = users.byId(cabineId);
      if (!c || !c.suspendu_auto || !c.suspendu_jusqu) return false;
      if (new Date(c.suspendu_jusqu).getTime() > Date.now()) return false;
      users.update(cabineId, { statut: 'actif', suspendu_auto: false, suspendu_by: null, suspendu_motif: null, suspendu_jusqu: null });
      suspensionLogs.close(cabineId, 'auto');
      notifications.create(cabineId, `Votre compte a été réactivé automatiquement après la période de suspension de 24h.`, 'success');
      return true;
    },

    /* Parcourt toutes les cabines actuellement suspendues automatiquement
       et lève celles dont l'échéance de 24h est dépassée — remplace la
       version locale par api/orders_sweep_unsuspend.php (couvre aussi une
       cabine suspendue sans commande en attente, donc jamais visitée par
       sweepStaleOrders ci-dessous). checkAutoUnsuspend() ci-dessus reste
       local : utilisée uniquement à la connexion (Auth._checkAccountGates,
       js/auth.js) sur le profil qui vient d'être vérifié par le serveur. */
    async sweepAutoUnsuspensions() {
      const res = await ServerAPI.ordersSweepUnsuspend();
      if (res.ok && res.liftedCount > 0) await transactions.refresh();
      return { liftedCount: res.liftedCount };
    },

    /* Suspend automatiquement les cabines dont le délai de 30 jours pour
       atteindre leur quota de commissions est dépassé — voir
       api/orders_sweep_quota.php/checkQuotaDeadline() (orders_common.php).
       Rafraîchit le profil courant : si c'est CETTE cabine qui vient
       d'être suspendue, elle doit voir le bandeau de suspension
       immédiatement, sans attendre une reconnexion. */
    async sweepQuotaDeadlines() {
      const res = await ServerAPI.ordersSweepQuota();
      if (res.ok && res.suspendedCount > 0) await users.refreshSelf();
      return { suspendedCount: res.suspendedCount };
    },

    /* Programme une commande automatique côté client — payée immédiatement
       (voir api/orders_schedule_create.php), déclenchée plus tard à
       l'heure choisie (voir sweepScheduled ci-dessous). `res.limitReached`
       signale les 20 commandes en attente déjà atteintes (voir
       handleClientWhatsappClick() côté appelant, js/client.js). */
    async scheduleOrder(payload) {
      const res = await ServerAPI.ordersScheduleCreate(payload);
      if (res.ok) await users.refreshSelf();
      return res;
    },

    /* Équivalent super admin, sans paiement (voir
       api/orders_schedule_create_admin.php) — accessible depuis l'onglet
       admin "Commande automatique". */
    async scheduleOrderAdmin(payload) {
      return ServerAPI.ordersScheduleCreateAdmin(payload);
    },

    /* Déclenche les commandes automatiques arrivées à échéance (voir
       api/orders_sweep_scheduled.php) — appelée par le sondage périodique
       des trois espaces, comme sweepAutoUnsuspensions/sweepQuotaDeadlines
       ci-dessus. Rafraîchit transactions (une nouvelle a pu apparaître,
       assignée ou non) ; commandesProgrammees.refresh() n'est PAS appelé
       ici (api/orders_schedule_list.php est réservé aux administrateurs —
       un client/une cabine y recevrait un 403) : c'est js/admin.js qui le
       rafraîchit explicitement pour l'onglet "Commande automatique". */
    async sweepScheduled() {
      const res = await ServerAPI.ordersSweepScheduled();
      if (res.ok && res.triggeredCount > 0) await transactions.refresh();
      return { triggeredCount: res.triggeredCount };
    },

    /* Suspension automatique 24h (retards, renvois répétés, demandes de
       remboursement répétées) — helper commun réutilisé par les 3
       déclencheurs pour poser les mêmes champs de façon cohérente.
       suspendu_by: null signale une suspension automatique, débloquable
       par n'importe quel administrateur (voir js/admin.js toggleCabine). */
    suspendCabineAuto(cabineId, motif) {
      const jusqu = new Date(Date.now() + 86400000).toISOString();
      users.update(cabineId, {
        statut: 'suspendu', suspendu_auto: true, suspendu_by: null,
        suspendu_motif: motif, suspendu_jusqu: jusqu,
      });
      suspensionLogs.create({ cabine_id: cabineId, motif, auto: true, date_fin_prevue: jusqu });
      notifications.create(cabineId, `Votre compte a été suspendu 24h : ${motif}.`, 'warning');
    },

    /* Suspension manuelle par un administrateur — indéfinie (pas
       d'échéance automatique), levée uniquement par cet administrateur ou
       le super administrateur (voir js/admin.js toggleCabine). */
    // Remplace la version locale par api/cabine_suspend_manual.php.
    async suspendCabineManually(cabineId, motif, adminId) {
      void adminId; // désormais inféré côté serveur depuis le jeton, jamais de ce paramètre
      const res = await ServerAPI.cabineSuspendManual(cabineId, motif);
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true };
    },

    /* Quota atteint = même condition que celle qui fait déjà passer une
       cabine à statut 'inactif' dans acceptRequest() ci-dessus — signal
       unique réutilisé pour gater le réabonnement en libre-service
       (voir resubscribeCabine ci-dessous). */
    cabineQuotaAtteint(cabineId) {
      const cab = users.byId(cabineId);
      if (!cab) return false;
      const quota = SUBSCRIPTION_QUOTAS[cab.abonnement] || SUBSCRIPTION_QUOTAS.Premium;
      return (cab.commissions_total || 0) >= quota;
    },

    /* Réabonnement cabine — paiement exclusivement via le solde, débit
       autorisé si insuffisant (solde négatif, résorbé automatiquement par
       les prochaines commissions créditées via acceptRequest). Remet le
       compteur de quota à zéro et lève une expiration par quota (statut
       'inactif'), mais ne touche pas une suspension punitive en cours.
       Réservé à la cabine elle-même — tant que son quota actuel n'est pas
       atteint, changer de formule ou se réabonner est bloqué (voir
       renderCabReaboCards()/cabSelectReaboFormule() dans js/cabine.js
       pour le verrouillage côté interface). Le super admin dispose d'un
       droit de veto séparé, voir adminSetCabineAbonnement ci-dessous. */
    // Remplace la version locale par api/cabine_resubscribe.php.
    async resubscribeCabine(cabineId, formule) {
      const res = await ServerAPI.cabineResubscribe(formule);
      if (!res.ok) return { ok: false, error: res.error };
      // res.nouveauSolde vient directement du serveur (valeur exacte après
      // débit), pas d'un calcul local approximatif.
      users.update(cabineId, { solde: res.nouveauSolde, abonnement: formule, commissions_total: 0 });
      return { ok: true, resteDu: res.resteDu, nouveauSolde: res.nouveauSolde, transactionId: res.transactionId };
    },

    /* Droit de veto du super admin : change instantanément la formule
       d'une cabine sans passer par resubscribeCabine() — remplace la
       version locale par api/admin_set_abonnement.php. */
    async adminSetCabineAbonnement(cabineId, formule) {
      const res = await ServerAPI.adminSetAbonnement(cabineId, formule);
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true };
    },

    // Remplace la version locale par api/cabine_transfer.php.
    async cabineTransfer(fromCabineId, toCabineNom, montant) {
      const res = await ServerAPI.cabineTransfer(toCabineNom, montant);
      if (!res.ok) return { ok: false, error: res.error };
      // Débit reflété localement tout de suite (voir TRANSFERT_CABINE_FRAIS,
      // même montant que côté serveur, seule source de vérité pour les frais).
      const from = users.byId(fromCabineId);
      if (from) users.update(fromCabineId, { solde: (from.solde || 0) - montant - TRANSFERT_CABINE_FRAIS });
      return { ok: true, recipient: res.recipient };
    },

    // Transfert client-à-client — remplace l'ancienne version 100% locale
    // de ctConfirmTransfer() (js/client.js), qui ne faisait que
    // users.updateSolde()/transactions.create() en local : le destinataire
    // ne voyait jamais le crédit sur son propre appareil. Voir
    // api/client_transfer.php (débit/crédit atomiques + une ligne
    // transactions par participant). transactions.refresh() rapatrie ces
    // deux nouvelles lignes juste après.
    async clientTransfer(fromClientId, toPhone, montant) {
      const res = await ServerAPI.clientTransfer(toPhone, montant);
      if (!res.ok) return { ok: false, error: res.error };
      const from = users.byId(fromClientId);
      if (from) users.update(fromClientId, { solde: (from.solde || 0) - montant });
      await transactions.refresh();
      return { ok: true, recipient: res.recipient };
    },

    /* Réassignation groupée (feature 2) — remplace la version locale par
       un seul appel à api/orders_reassign.php (transaction_ids accepte
       déjà un tableau). */
    async bulkReassign(txnIds, newCabineId) {
      const res = await ServerAPI.ordersReassign(txnIds, newCabineId);
      if (!res.ok) return { okCount: 0, failCount: txnIds.length, results: txnIds.map(id => ({ id, ok: false, error: res.error })) };
      await transactions.refresh();
      return { okCount: res.okCount, failCount: res.failCount, results: res.results };
    },

    /* Balayage périodique (features 4 et 5) — remplace la version locale
       par api/orders_sweep.php : chaque étape sensible y est un CAS qui
       élimine (pas seulement réduit) la course entre plusieurs onglets/
       appareils qui balaient au même instant. */
    async sweepStaleOrders() {
      const res = await ServerAPI.ordersSweep();
      if (res.ok && res.staleCount > 0) {
        await transactions.refresh();
        await retards.refresh();
      }
      return { staleCount: res.staleCount, suspendedCabineIds: res.suspendedCabineIds };
    },
  };

  /* â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  return { init, users, transactions, retraits, retards, transferts_cabine, notifications, commissions, settings, reclamations, refundRequests, resetRequests, partnerApplications, referrals, commandesProgrammees, accessLogs, permissionLogs, maintenanceLogs, resubscriptions, favoris, forfaits, business, uid, now, SUBSCRIPTION_QUOTAS, SUBSCRIPTION_PRICES, presence, partnerDevices, RETARD_MS, TRANSFERT_CABINE_FRAIS, normalizeContact, suspensionLogs, Net, syncQueue, drainSyncQueue, pollSignature };
})();

/* ── Maintenance (service/réseau) — fonctions globales (non namespacées
   DB.*) partagées par client.html ET cabine.html, qui chargent toutes les
   deux js/db.js avant leur script de page. Lisent DB.settings().maintenance
   (voir seed() ci-dessus et l'onglet admin "Maintenance"/"UV Cabine"). */
function normalizeMaintenanceNetwork(raw) {
  const map = { 'Orange': 'Orange', 'Orange Money': 'Orange', 'MTN': 'MTN', 'MTN MoMo': 'MTN', 'Moov': 'Moov', 'Moov Money': 'Moov', 'Wave': 'Wave', 'Wave CI': 'Wave' };
  return map[raw] || null;
}

async function isServiceInMaintenance(key) {
  return !!(await DB.settings.get()).maintenance?.services?.[key];
}

async function isNetworkInMaintenance(rawNetwork) {
  const net = normalizeMaintenanceNetwork(rawNetwork);
  if (!net) return false;
  return !!(await DB.settings.get()).maintenance?.networks?.[net];
}

// Réseaux indépendants par service (Exchange/Recharge) — voir
// maintenance.networksByService dans seed() ci-dessus. Distinct de
// isNetworkInMaintenance() qui reste partagé par Transfert direct/Facture/
// Recharge UV.
async function isNetworkInMaintenanceForService(serviceKey, rawNetwork) {
  const net = normalizeMaintenanceNetwork(rawNetwork);
  if (!net) return false;
  return !!(await DB.settings.get()).maintenance?.networksByService?.[serviceKey]?.[net];
}

function warnMaintenance(msg) {
  Toast.error(msg || 'Ce service est actuellement en maintenance.');
}

/* ── Fenêtre d'éligibilité à réclamation — fonctions globales (non
   namespacées DB.*), déplacées depuis js/client.js pour être partagées
   avec js/cabine.js (une cabine peut déposer une réclamation sur sa
   propre commande de recharge_uv en libre-service, voir cabineSelfRecharge
   ci-dessus et l'onglet Réclamation de js/cabine.js). */
const RECLA_MIN_DELAY_MS = 5 * 60 * 1000;
const RECLA_MAX_DELAY_MS = 24 * 60 * 60 * 1000;

function reclamationWindowState(txn) {
  const elapsed = Date.now() - new Date(txn.date).getTime();
  if (elapsed < RECLA_MIN_DELAY_MS) return { state: 'early', remainingMs: RECLA_MIN_DELAY_MS - elapsed };
  if (elapsed > RECLA_MAX_DELAY_MS) return { state: 'expired' };
  return { state: 'eligible' };
}

function formatMmSs(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
}

const RECLA_REASONS = {
  non_recue:    'Je n\'ai pas reçu ma commande',
  non_conforme: 'J\'ai reçu, mais pas ce que j\'ai demandé',
};

function getReclamableOrders(clientId) {
  return DB.transactions.byClient(clientId)
    .filter(t => !DB.reclamations.byTransaction(t.id))
    .filter(t => reclamationWindowState(t).state === 'eligible')
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}


