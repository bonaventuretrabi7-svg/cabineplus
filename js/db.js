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

  function now() { return new Date().toISOString(); }

  /* ── Connectivité (hors-ligne d'abord — LocalStorage reste la source de
     vérité, Supabase n'est jamais qu'une synchronisation optionnelle en
     tâche de fond, voir DB.settings et DB.syncQueue ci-dessous). Pas de
     plugin Capacitor natif : navigator.onLine + les événements standards
     online/offline fonctionnent déjà dans la WebView. Défense en
     profondeur : même si navigator.onLine ment (cas connu sur Android),
     l'échec réel de l'appel réseau est de toute façon intercepté à part. */
  const Net = {
    isOnline: () => (typeof navigator !== 'undefined' ? navigator.onLine : true),
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

    // Convertit une ligne `profiles` (Supabase, snake_case, mot de passe en
    // bcrypt) vers le format local — utilisé uniquement après une
    // vérification SERVEUR réussie (voir Auth.login() dans js/auth.js).
    // `plainPin` : le code EN CLAIR qui vient d'être validé côté serveur ;
    // jamais conservé tel quel, seulement son hash LOCAL (hashPwd(), le même
    // que tous les autres comptes) pour que les connexions suivantes sur CET
    // appareil fonctionnent hors ligne sans dépendre du bcrypt serveur
    // (format incompatible avec checkPwd() ci-dessus).
    fromProfileRow(row, plainPin) {
      return {
        id: row.id, nom: row.nom || '', prenom: row.prenom || '',
        telephone: row.telephone || '', email: row.email || '',
        mot_de_passe: hashPwd(plainPin),
        role: row.role, solde: row.solde || 0, statut: row.statut,
        admin_level: row.admin_level || undefined,
        permissions: row.permissions || undefined,
        zone: row.zone || undefined, cabine_nom: row.cabine_nom || undefined,
        commissions_total: row.commissions_total || 0,
        transferts_total: row.transferts_total || 0,
        limite_commandes: row.limite_commandes ?? undefined,
        tentatives_echouees: row.tentatives_echouees || 0,
        suspendu_auto: row.suspendu_auto || false,
        suspendu_by: row.suspendu_by || null,
        suspendu_motif: row.suspendu_motif || null,
        suspendu_jusqu: row.suspendu_jusqu || null,
        abonnement: row.abonnement || undefined,
        date_creation: row.date_creation,
      };
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

    hash: hashPwd,
  };

  /* â”€â”€ Présence en ligne (localStorage, multi-onglets) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  // Chaque onglet connecté "pinge" son id périodiquement ; une entrée plus
  // vieille que STALE_MS est considérée hors ligne (onglet fermé sans avoir
  // pu prévenir, crash, etc.).
  const presence = {
    HEARTBEAT_MS: 10000,
    STALE_MS: 25000,

    _all() { return JSON.parse(localStorage.getItem(KEY.presence) || '{}'); },
    _save(map) { localStorage.setItem(KEY.presence, JSON.stringify(map)); },

    ping(userId) {
      const map = presence._all();
      map[userId] = Date.now();
      presence._save(map);
    },

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
     Limite de 2 appareils simultanés + support "rester connecté" (token
     opaque, jamais le mot de passe). Un enregistrement par appareil connu
     pour un compte ; voir Auth.login()/require()/logout() dans auth.js
     pour l'application de la limite et la reprise de session. */
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

    register(userId, deviceId, label, remember) {
      const list = partnerDevices.all();
      const rec = {
        id: 'dev_' + uid(), user_id: userId, device_id: deviceId, label,
        remember_token: remember ? (crypto.randomUUID() + crypto.randomUUID()) : null,
        created_at: now(), last_seen: now(),
        expires_at: remember ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() : null,
      };
      list.push(rec);
      partnerDevices.save(list);
      return rec;
    },

    // Reconnexion sur un appareil déjà connu : rafraîchit last_seen (et
    // glisse l'expiration si "rester connecté" est actif ou vient d'être coché).
    touch(deviceRecordId, remember) {
      const list = partnerDevices.all();
      const rec = list.find(d => d.id === deviceRecordId);
      if (!rec) return null;
      rec.last_seen = now();
      if (remember && !rec.remember_token) rec.remember_token = crypto.randomUUID() + crypto.randomUUID();
      if (rec.remember_token) rec.expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      partnerDevices.save(list);
      return rec;
    },

    evictOldest(userId) {
      const active = partnerDevices.forUser(userId).sort((a, b) => new Date(a.last_seen) - new Date(b.last_seen));
      const oldest = active[0];
      if (!oldest) return null;
      partnerDevices.save(partnerDevices.all().filter(d => d.id !== oldest.id));
      return oldest;
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
  };

  /* â”€â”€ Transactions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  const transactions = {
    all:  ()   => get(KEY.transactions),
    save: (l)  => set(KEY.transactions, l),
    byId: (id) => get(KEY.transactions).find(t => t.id === id),
    byClient: (cid) => get(KEY.transactions).filter(t => t.client_id === cid).sort((a,b) => new Date(b.date)-new Date(a.date)),
    byCabine: (cid) => get(KEY.transactions).filter(t => t.cabine_id === cid).sort((a,b) => new Date(b.date)-new Date(a.date)),
    pending:  ()    => get(KEY.transactions).filter(t => t.statut === 'en_attente').sort((a,b) => new Date(a.date)-new Date(b.date)),

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

    create(data) {
      const list = get(KEY.retraits);
      const ret  = { id: 'ret_' + uid(), date: now(), statut: 'en_attente', ...data };
      list.push(ret);
      set(KEY.retraits, list);
      return ret;
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
    countSince: (cid, sinceMs) => get(KEY.retards).filter(r => r.cabine_id === cid && new Date(r.date).getTime() >= sinceMs).length,

    create(data) {
      const list = get(KEY.retards);
      const r = { id: 'rtd_' + uid(), date: now(), reassigned_to_cabine_id: null, triggered_suspension: false, ...data };
      list.push(r);
      set(KEY.retards, list);
      return r;
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

    create(data) {
      const list = forfaits.all();
      const f = { id: 'frf_' + uid(), ussdTemplate: null, verified: true, ...data };
      list.push(f);
      set(KEY.forfaits, list);
      return f;
    },

    update(id, updates) {
      const list = forfaits.all();
      const idx  = list.findIndex(f => f.id === id);
      if (idx === -1) return null;
      list[idx] = { ...list[idx], ...updates };
      set(KEY.forfaits, list);
      return list[idx];
    },

    remove(id) {
      set(KEY.forfaits, forfaits.all().filter(f => f.id !== id));
    },
  };

  /* â”€â”€ Notifications â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  const notifications = {
    all:  ()   => get(KEY.notifications),
    forUser: (uid) => get(KEY.notifications).filter(n => n.utilisateur_id === uid).sort((a,b) => new Date(b.date)-new Date(a.date)),
    unread: (uid)  => get(KEY.notifications).filter(n => n.utilisateur_id === uid && !n.lu).length,

    create(utilisateur_id, message, type = 'info') {
      const list = get(KEY.notifications);
      const n = { id: uid(), utilisateur_id, message, lu: false, date: now(), type };
      list.push(n);
      set(KEY.notifications, list);
      return n;
    },

    markRead(id) {
      const list = get(KEY.notifications);
      const idx  = list.findIndex(n => n.id === id);
      if (idx !== -1) { list[idx].lu = true; set(KEY.notifications, list); }
    },

    markAllRead(userId) {
      const list = get(KEY.notifications).map(n =>
        n.utilisateur_id === userId ? { ...n, lu: true } : n
      );
      set(KEY.notifications, list);
    },
  };

  /* â”€â”€ Réclamations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  const reclamations = {
    all:             ()      => get(KEY.reclamations) || [],
    byTransaction:   (txnId) => (get(KEY.reclamations)||[]).find(r => r.transaction_id === txnId) || null,
    byCabine:        (cabId) => (get(KEY.reclamations)||[]).filter(r => r.cabine_id === cabId).sort((a,b)=>new Date(b.date_created)-new Date(a.date_created)),
    byClient:        (cliId) => (get(KEY.reclamations)||[]).filter(r => r.client_id === cliId),
    countByClient:   (cliId) => (get(KEY.reclamations)||[]).filter(r => r.client_id === cliId).length,
    pending:         ()      => (get(KEY.reclamations)||[]).filter(r => r.statut === 'en_attente'),

    create({ transaction_id, client_id, cabine_id, motif }) {
      const list = get(KEY.reclamations) || [];
      const r = { id: uid(), transaction_id, client_id, cabine_id, motif,
                  statut: 'en_attente', screenshot: null,
                  date_created: now(), date_resolved: null,
                  // Fil de discussion : seedé avec la déclaration initiale du
                  // client. relances_apres_preuve ne compte que les messages
                  // "toujours pas reçu" envoyés APRÈS qu'une preuve (screenshot)
                  // a déjà été fournie par la cabine — voir rclHubQuickReply()
                  // dans js/client.js.
                  messages: [{ sender: 'client', type: 'texte', texte: motif, date: now() }],
                  relances_apres_preuve: 0 };
      list.push(r);
      set(KEY.reclamations, list);
      return r;
    },

    update(id, updates) {
      const list = get(KEY.reclamations) || [];
      const idx  = list.findIndex(r => r.id === id);
      if (idx !== -1) { list[idx] = { ...list[idx], ...updates }; set(KEY.reclamations, list); }
    },

    addMessage(id, message) {
      const list = get(KEY.reclamations) || [];
      const idx  = list.findIndex(r => r.id === id);
      if (idx === -1) return null;
      list[idx] = { ...list[idx], messages: [...(list[idx].messages || []), { ...message, date: now() }] };
      set(KEY.reclamations, list);
      return list[idx];
    },
  };

  /* ── Demandes de remboursement (soumises par la cabine suite à une
     réclamation) ──────────────────────────────────────────────────
     Visibles uniquement côté administration (onglet dédié) jusqu'à
     validation — voir DB.business.processRefundRequest ci-dessous, qui
     réutilise refundTransaction() pour l'effet financier réel. */
  const refundRequests = {
    all:            ()        => get(KEY.refundRequests) || [],
    pending:        ()        => (get(KEY.refundRequests) || []).filter(r => r.statut === 'en_attente'),
    byReclamation:  (reclaId) => (get(KEY.refundRequests) || []).find(r => r.reclamation_id === reclaId) || null,
    countSince:     (cabineId, sinceMs) => (get(KEY.refundRequests) || []).filter(r => r.cabine_id === cabineId && new Date(r.date_created).getTime() >= sinceMs).length,

    create({ reclamation_id, transaction_id, cabine_id, client_id, motif }) {
      const list = get(KEY.refundRequests) || [];
      const r = { id: 'rfr_' + uid(), reclamation_id, transaction_id, cabine_id, client_id, motif,
                  statut: 'en_attente', date_created: now(), date_traitement: null, processed_by: null };
      list.push(r);
      set(KEY.refundRequests, list);
      return r;
    },

    update(id, updates) {
      const list = get(KEY.refundRequests) || [];
      const idx  = list.findIndex(r => r.id === id);
      if (idx !== -1) { list[idx] = { ...list[idx], ...updates }; set(KEY.refundRequests, list); }
    },
  };

  /* ── Journal des accès admin (impersonation) ─────────────────────
     Traçabilité des accès directs de l'administration à l'espace
     partenaire/client sans mot de passe — voir Auth.startImpersonation()
     dans js/auth.js. Lecture seule côté admin (onglet "Journal des accès"). */
  const accessLogs = {
    all: () => get(KEY.accessLogs) || [],

    create({ admin_id, admin_name, target_user_id, target_role, target_name }) {
      const list = get(KEY.accessLogs) || [];
      const l = { id: 'log_' + uid(), admin_id, admin_name, target_user_id, target_role, target_name, date: now() };
      list.push(l);
      set(KEY.accessLogs, list);
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

    create({ admin_id, admin_name, cabine_id, cabine_name, service, active }) {
      const list = get(KEY.permissionLogs) || [];
      const l = { id: 'plog_' + uid(), admin_id, admin_name, cabine_id, cabine_name, service, active, date: now() };
      list.push(l);
      set(KEY.permissionLogs, list);
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

    // `service`/`message` optionnels — ajoutés pour les nouveaux types
    // d'entrées (réseaux par service, messages Facture) sans rien changer
    // pour les entrées existantes (onglet UV Cabine), qui n'en ont pas besoin.
    create({ admin_id, admin_name, action, key, active, service, message }) {
      const list = get(KEY.maintenanceLogs) || [];
      const l = { id: 'mlog_' + uid(), admin_id, admin_name, action, key, active, service: service || null, message: message ?? null, date: now() };
      list.push(l);
      set(KEY.maintenanceLogs, list);
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
     destinataire" du Transfert direct (voir openContactsPicker() dans
     js/client.js). Store séparé keyé par client_id, même patron que
     partnerDevices ci-dessus plutôt qu'un tableau embarqué sur users. */
  const favoris = {
    all: () => get(KEY.favoris) || [],
    forUser: (clientId) => (get(KEY.favoris) || [])
      .filter(f => f.client_id === clientId)
      .sort((a, b) => new Date(b.date_creation) - new Date(a.date_creation)),

    create({ client_id, nom, numero }) {
      const list = get(KEY.favoris) || [];
      const f = { id: 'fav_' + uid(), client_id, nom: nom || '', numero, date_creation: now() };
      list.push(f);
      set(KEY.favoris, list);
      return f;
    },

    remove(id) {
      const list = (get(KEY.favoris) || []).filter(f => f.id !== id);
      set(KEY.favoris, list);
    },
  };

  /* ── Commissions ───────────────────────────────────────────────── */
  const commissions = {
    all:  ()   => get(KEY.commissions),
    save: (l)  => set(KEY.commissions, l),
    active: () => get(KEY.commissions).find(c => c.actif) || { pourcentage: 5 },

    calc(montant) {
      const rule = commissions.active();
      return Math.round(montant * (rule.pourcentage / 100));
    },

    update(id, updates) {
      const list = get(KEY.commissions);
      const idx  = list.findIndex(c => c.id === id);
      if (idx !== -1) { list[idx] = { ...list[idx], ...updates }; set(KEY.commissions, list); }
    },
  };

  /* ── File d'attente de synchronisation (générique) ────────────────────
     Hors-ligne d'abord : LocalStorage est TOUJOURS la source de vérité sur
     l'appareil, Supabase n'est qu'une synchronisation optionnelle en tâche
     de fond, jamais bloquante. Toute écriture qui n'a pas pu être poussée
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

  // Un handler par entité : sait pousser un item de la file vers Supabase.
  // Lève une exception en cas d'échec (laisse l'item en file pour un
  // prochain essai) — voir drainSyncQueue() ci-dessous. Le futur Lot 2
  // (auth/DB.users/DB.business) enregistrera ses propres handlers ici
  // plutôt que de dupliquer la boucle de drainage.
  const SYNC_HANDLERS = {
    async settings(updates) {
      // Défense en profondeur : couvre aussi une entrée déjà en file
      // (ancienne session, avant ce contrôle) — sans configuration réelle,
      // rien ne sera jamais synchronisable, donc rien à réessayer :
      // succès silencieux (voir drainSyncQueue ci-dessus, qui retire alors
      // l'entrée de la file) plutôt qu'un échec qui la ferait rester
      // indéfiniment.
      if (!SupabaseAPI.isConfigured) return;
      const row = {};
      for (const [jsKey, col] of Object.entries(SETTINGS_COLUMNS)) {
        if (jsKey in updates) row[col] = updates[jsKey];
      }
      row.updated_at = now();
      const { error } = await SupabaseAPI.client.from('settings').update(row).eq('id', true);
      if (error) throw error;
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
     déjà écrite une fois par seed() ci-dessus) ; Supabase (table `settings`,
     une seule ligne) n'est qu'un miroir partagé synchronisé en best-effort
     quand une connexion est là. Chaque section (maintenance/assistance/...)
     reste sa propre colonne JSONB côté Supabase : update() n'écrase que les
     colonnes présentes dans `updates`, ce qui élimine par construction
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
    // une réponse Supabase avant de répondre rendrait chaque vérification de
    // maintenance perceptiblement lente (cette méthode est appelée à chaque
    // clic sur un service, voir isServiceInMaintenance() etc. ci-dessous).
    // Retourne le cache local instantanément et rafraîchit Supabase en tâche
    // de fond pour la prochaine lecture — jamais plus d'un rafraîchissement
    // à la fois (voir _refresh()).
    async get() {
      if (Net.isOnline()) settings._refresh();
      return get(KEY.settings) || {};
    },
    // Rafraîchissement en arrière-plan, dédupliqué (jamais deux requêtes
    // Supabase en vol en même temps) — exposé séparément (plutôt que fondu
    // dans get()) pour que les tests puissent l'attendre explicitement sans
    // délai arbitraire.
    _refresh() {
      // Voir la note dans update() ci-dessous : sans configuration réelle,
      // toute tentative échouerait de toute façon (domaine placeholder,
      // ERR_NAME_NOT_RESOLVED) — jamais appelé dans ce cas, le cache
      // local reste directement la seule source de vérité.
      if (!SupabaseAPI.isConfigured) return Promise.resolve();
      if (_settingsRefreshInFlight) return _settingsRefreshInFlight;
      _settingsRefreshInFlight = (async () => {
        try {
          const { data, error } = await SupabaseAPI.client.from('settings').select('*').eq('id', true).single();
          if (!error && data) set(KEY.settings, rowToSettings(data));
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

      // Tant que Supabase n'est pas réellement configuré (voir
      // SupabaseAPI.isConfigured, js/supabase-client.js), aucune tentative
      // réseau n'a de sens : le domaine placeholder ne résoudra jamais,
      // et mettre quand même en file ferait grossir syncQueue à l'infini
      // pour une resynchronisation qui n'arrivera jamais.
      if (!SupabaseAPI.isConfigured) return;

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
    /* Client creates transfer request */
    createTransfer({ client_id, operateur, numero_beneficiaire, montant, service, moyen_paiement, numero_paiement, details }) {
      const FRAIS_SERVICE = 15;
      const client = users.byId(client_id);
      const totalDebit = montant + FRAIS_SERVICE;
      if (!client || client.solde < totalDebit) return { ok: false, error: 'Solde insuffisant (montant + 15 F de frais de service).' };

      // Debit client (montant + frais)
      users.updateSolde(client_id, -totalDebit);

      // Compute commission
      const commission = commissions.calc(montant);

      // Create transaction
      const txn = transactions.create({ client_id, operateur, numero_beneficiaire, montant, frais_service: FRAIS_SERVICE, commission, statut: 'en_attente', cabine_id: null, service: service || 'Transfert direct', moyen_paiement: moyen_paiement || null, numero_paiement: numero_paiement || null, details: details || null });

      // Auto-assign to available cabine
      business.assignCabine(txn.id);

      notifications.create(client_id, `Votre demande de ${montant.toLocaleString()} F (${operateur}) est en attente de traitement.`, 'info');

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

    /* Auto-assign transaction to an available cabine (sous sa limite de commandes) */
    assignCabine(txnId) {
      const txn = transactions.byId(txnId);
      if (!txn) return;
      const cabs = users.byRole('cabine').filter(c =>
        c.statut === 'actif' && !c.en_pause && !business.isCabineAtLimit(c.id) &&
        !business.hasBlockingReclamation(c.id) && business.cabineAcceptsNetwork(c.id, txn.operateur) &&
        business.cabineAcceptsService(c.id, txn.type)
      );
      if (!cabs.length) return;
      const cab = cabs[Math.floor(Math.random() * cabs.length)];
      transactions.update(txnId, { cabine_id: cab.id, date_assignation: now() });
      notifications.create(cab.id, `Nouvelle demande de transfert ${txn.operateur} ${txn.montant.toLocaleString()} F.`, 'new_request');
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
    cabineSelfRecharge(cabineId, { network, numero, montant }) {
      const cab = users.byId(cabineId);
      if (!cab || cab.role !== 'cabine') return { ok: false, error: 'Compte cabine invalide.' };
      if (cab.statut === 'suspendu') {
        return { ok: false, error: 'Votre compte est suspendu. Vous ne pouvez pas passer de commande de recharge UV.' };
      }
      if (!montant || montant < 10000) return { ok: false, error: 'Montant minimum : 10 000 F.' };
      const frais = FRAIS_SERVICE_UV_CABINE;
      const total = montant + frais;
      if ((cab.solde || 0) < total) {
        return { ok: false, error: `Solde insuffisant. Disponible : ${Fmt.money(cab.solde || 0)}, requis : ${Fmt.money(total)} (dont ${Fmt.money(frais)} de frais).` };
      }

      users.updateSolde(cabineId, -total);

      const txn = transactions.create({
        client_id: cabineId, cabine_id: null,
        type: 'recharge_uv', service: 'Recharge UV',
        operateur: network, numero_beneficiaire: numero, montant,
        frais_service: frais,
        statut: 'en_attente', commission: 0,
      });

      const target = business.findReassignmentTarget(cabineId, network, 'recharge_uv');
      if (target) {
        transactions.update(txn.id, { cabine_id: target.id, date_assignation: now() });
        notifications.create(target.id, `Nouvelle demande de recharge UV ${network} ${montant.toLocaleString()} F.`, 'new_request');
      }

      return { ok: true, transaction: transactions.byId(txn.id), assignedTo: target ? target.id : null, frais, total };
    },

    /* Cabine accepts request */
    acceptRequest(txnId, cabine_id, proof) {
      const txn = transactions.byId(txnId);
      if (!txn || txn.statut !== 'en_attente') return { ok: false, error: 'Demande introuvable ou déjà traitée.' };

      transactions.update(txnId, {
        statut: 'terminé', cabine_id, date_fin: now(),
        ...(proof ? { preuve_paiement: proof } : {}),
      });

      // Credit commission to cabine
      users.updateSolde(cabine_id, txn.commission);
      const cab = users.byId(cabine_id);
      const newCommTotal = (cab.commissions_total || 0) + txn.commission;
      users.update(cabine_id, {
        commissions_total: newCommTotal,
        transferts_total:  (cab.transferts_total  || 0) + 1,
      });

      notifications.create(txn.client_id, `Votre transfert de ${txn.montant.toLocaleString()} F (${txn.operateur} ${txn.numero_beneficiaire}) est terminé !`, 'success');
      notifications.create(cabine_id, `Commission de ${txn.commission.toLocaleString()} F créditée.`, 'commission');

      // Quota de commission du forfait atteint â†’ fin anticipée de l'abonnement
      const plan  = cab.abonnement || 'Premium';
      const quota = SUBSCRIPTION_QUOTAS[plan];
      if (quota && cab.statut === 'actif' && newCommTotal >= quota) {
        users.update(cabine_id, { statut: 'inactif' });
        notifications.create(cabine_id, `Quota de commission du forfait ${plan} atteint (${quota.toLocaleString()} F). Votre abonnement a pris fin.`, 'warning');
      }

      return { ok: true };
    },

    /* Cabine refuses (renvoi manuel motivé) — même logique de réattribution
       que le timeout (sweepStaleOrders) : réassignée à une cabine connectée
       la moins chargée si disponible (findReassignmentTarget), sinon
       repasse en attente non assignée côté administration — jamais de
       refus/remboursement automatique. */
    refuseRequest(txnId, cabine_id, motif, justification) {
      const txn = transactions.byId(txnId);
      if (!txn || txn.statut !== 'en_attente') return { ok: false, error: 'Demande introuvable.' };

      // Compte le renvoi, quelle que soit l'issue.
      const refusingCab = users.byId(cabine_id);
      if (refusingCab) users.update(cabine_id, { commandes_renvoyees: (refusingCab.commandes_renvoyees || 0) + 1 });

      // Fenêtre glissante de 2 min : 5 renvois → suspension automatique 24h
      // (voir DB.cabineRefusals et business.suspendCabineAuto ci-dessus).
      cabineRefusals.create(cabine_id);
      if (cabineRefusals.countSince(cabine_id, Date.now() - 120000) >= 5) {
        business.suspendCabineAuto(cabine_id, '5 commandes renvoyées en moins de 2 minutes');
      }

      transactions.update(txnId, {
        dernier_renvoi_motif: motif || null,
        dernier_renvoi_justification: motif === 'autre' ? (justification || '') : null,
        dernier_renvoi_date: now(),
        dernier_renvoi_cabine_id: cabine_id,
      });

      const target = business.findReassignmentTarget(cabine_id, txn.operateur, txn.type);
      if (target) {
        transactions.update(txnId, { cabine_id: target.id, date_assignation: now() });
        notifications.create(target.id, `Nouvelle demande de transfert ${txn.operateur} ${txn.montant.toLocaleString()} F (réaffectée).`, 'new_request');
      } else {
        transactions.update(txnId, { cabine_id: null });
        notifications.create(cabine_id, `La commande ${Fmt.ref(txnId)} que vous avez renvoyée reste en attente côté administration — aucune autre cabine connectée disponible.`, 'info');
      }

      return { ok: true, reassignedTo: target ? target.id : null };
    },

    /* Dès qu'une cabine se connecte (voir cabine.js boot()), lui réassigne
       automatiquement les commandes en attente non assignées (pool
       "administration", cabine_id: null) — la plus ancienne d'abord
       ("premier arrivé"), jusqu'à ce que sa limite de commandes soit
       atteinte. Retourne le nombre de commandes reprises. */
    assignPendingToCabine(cabineId) {
      const cab = users.byId(cabineId);
      if (!cab || cab.role !== 'cabine' || cab.statut !== 'actif' || cab.en_pause) return 0;
      if (business.hasBlockingReclamation(cabineId)) return 0;

      // t.client_id !== cabineId : une cabine ne peut jamais reprendre elle-même
      // une commande qu'elle a elle-même initiée (voir business.cabineSelfRecharge)
      // — sans effet sur les commandes clients, où client_id n'est jamais un id de cabine.
      const pool = transactions.pending()
        .filter(t => !t.cabine_id && t.client_id !== cabineId && business.cabineAcceptsNetwork(cabineId, t.operateur) && business.cabineAcceptsService(cabineId, t.type))
        .sort((a, b) => new Date(a.date) - new Date(b.date));

      let count = 0;
      for (const t of pool) {
        if (business.isCabineAtLimit(cabineId)) break;
        transactions.update(t.id, { cabine_id: cabineId, date_assignation: now() });
        notifications.create(cabineId, `Nouvelle commande assignée : ${t.operateur} ${t.montant.toLocaleString()} F.`, 'new_request');
        count++;
      }
      return count;
    },

    /* Admin : réassigne manuellement une commande en attente vers une autre cabine */
    reassignTransaction(txnId, newCabineId) {
      const txn = transactions.byId(txnId);
      if (!txn || txn.statut !== 'en_attente') return { ok: false, error: 'Commande introuvable ou déjà traitée.' };
      const newCab = users.byId(newCabineId);
      if (!newCab || newCab.role !== 'cabine') return { ok: false, error: 'Cabine invalide.' };
      if (business.isCabineAtLimit(newCabineId)) return { ok: false, error: 'Cette cabine a atteint sa limite de commandes.' };

      const oldCabineId = txn.cabine_id;
      transactions.update(txnId, { cabine_id: newCabineId, date_assignation: now() });
      if (oldCabineId) notifications.create(oldCabineId, `La commande ${Fmt.ref(txnId)} a été réassignée à une autre cabine par l'administration.`, 'info');
      notifications.create(newCabineId, `Nouvelle commande assignée par l'administration : ${txn.operateur} ${txn.montant.toLocaleString()} F.`, 'new_request');
      return { ok: true };
    },

    /* Admin : rembourse le client pour une commande en attente ou terminée.
       Si elle était déjà terminée, retire la commission déjà versée au cabiniste. */
    refundTransaction(txnId) {
      const txn = transactions.byId(txnId);
      if (!txn || (txn.statut !== 'en_attente' && txn.statut !== 'terminé')) {
        return { ok: false, error: 'Cette commande ne peut pas être remboursée.' };
      }

      if (txn.statut === 'terminé' && txn.cabine_id) {
        const cab = users.byId(txn.cabine_id);
        if (cab) {
          users.updateSolde(txn.cabine_id, -(txn.commission || 0));
          users.update(txn.cabine_id, {
            commissions_total: Math.max(0, (cab.commissions_total || 0) - (txn.commission || 0)),
            transferts_total:  Math.max(0, (cab.transferts_total  || 0) - 1),
            remboursements_recus: (cab.remboursements_recus || 0) + 1,
          });

          // Double sanction : la cabine avait marqué la commande "Terminée"
          // à tort — le montant total de la commande est prélevé sur son
          // solde, plus une pénalité fixe (PENALITE_REMBOURSEMENT_TERMINE),
          // distincts du simple retrait de commission ci-dessus. Tracés
          // comme un retrait négatif dans son historique (voir
          // loadCabRetraits() dans js/cabine.js, qui isole les entrées
          // type: 'sanction' des retraits classiques).
          const sanction = txn.montant + PENALITE_REMBOURSEMENT_TERMINE;
          users.updateSolde(txn.cabine_id, -sanction);
          retraits.create({
            cabine_id: txn.cabine_id, montant: sanction, statut: 'terminé', type: 'sanction',
            methode_retrait: 'Sanction',
            motif: `Remboursement commande ${Fmt.ref(txnId)} — montant (${txn.montant.toLocaleString()} F) + pénalité (${PENALITE_REMBOURSEMENT_TERMINE} F)`,
          });
          notifications.create(txn.cabine_id, `Une commande que vous aviez marquée "Terminée" a été remboursée par l'administration : ${sanction.toLocaleString()} F (montant + pénalité de ${PENALITE_REMBOURSEMENT_TERMINE} F) ont été prélevés sur votre solde.`, 'warning');
        }
      }

      users.updateSolde(txn.client_id, txn.montant);
      transactions.update(txnId, { statut: 'remboursé', date_remboursement: now() });
      notifications.create(txn.client_id, `Votre commande ${Fmt.ref(txnId)} de ${txn.montant.toLocaleString()} F a été remboursée par l'administration.`, 'success');

      return { ok: true };
    },

    /* Admin : valide une demande de remboursement soumise par une cabine
       suite à une réclamation (voir DB.refundRequests). Réutilise
       refundTransaction() pour l'effet financier, puis trace la demande et
       la réclamation liée comme traitées. */
    processRefundRequest(requestId, adminId) {
      const req = refundRequests.all().find(r => r.id === requestId);
      if (!req || req.statut !== 'en_attente') {
        return { ok: false, error: 'Demande introuvable ou déjà traitée.' };
      }

      const res = business.refundTransaction(req.transaction_id);
      if (!res.ok) return res;

      refundRequests.update(requestId, { statut: 'traité', date_traitement: now(), processed_by: adminId });
      reclamations.update(req.reclamation_id, { statut: 'remboursée', date_resolved: now() });
      notifications.create(req.cabine_id, `Le remboursement de la commande ${Fmt.ref(req.transaction_id)} a été validé par l'administration.`, 'success');

      return { ok: true };
    },

    /* Admin : suspend une commande (en attente ou terminée) avec motif
       obligatoire. Ne touche pas aux soldes — c'est une mise en attente
       (gel), pas une annulation financière (voir refundTransaction pour
       ça). Réversible via reactivateTransaction. */
    suspendTransaction(txnId, motif) {
      const txn = transactions.byId(txnId);
      if (!txn) return { ok: false, error: 'Commande introuvable.' };
      if (!motif || !motif.trim()) return { ok: false, error: 'Le motif de suspension est obligatoire.' };
      if (txn.statut !== 'en_attente' && txn.statut !== 'terminé') {
        return { ok: false, error: 'Cette commande ne peut pas être suspendue.' };
      }

      transactions.update(txnId, {
        statut: 'suspendue',
        statut_avant_suspension: txn.statut,
        motif_suspension: motif.trim(),
        date_suspension: now(),
      });
      if (txn.cabine_id) notifications.create(txn.cabine_id, `La commande ${Fmt.ref(txnId)} a été suspendue par l'administration : ${motif.trim()}`, 'warning');
      return { ok: true };
    },

    /* Admin : réactive une commande suspendue, restaure son statut précédent. */
    reactivateTransaction(txnId) {
      const txn = transactions.byId(txnId);
      if (!txn || txn.statut !== 'suspendue') return { ok: false, error: 'Cette commande n\'est pas suspendue.' };

      transactions.update(txnId, {
        statut: txn.statut_avant_suspension || 'en_attente',
        statut_avant_suspension: null,
        motif_suspension: null,
      });
      if (txn.cabine_id) notifications.create(txn.cabine_id, `La commande ${Fmt.ref(txnId)} a été réactivée par l'administration.`, 'info');
      return { ok: true };
    },

    /* Recharge wallet (simulated). `method` optionnel pour compatibilité
       ascendante des appels existants ; vérifié contre
       maintenance.networksByService.recharge (voir isNetworkInMaintenanceForService)
       — c'est le verrou serveur, même un appel direct contournant l'UI est
       refusé pour un réseau désactivé. */
    recharge(user_id, montant, method) {
      if (montant < 1000) return { ok: false, error: 'Montant minimum : 1 000 F.' };
      if (method && isNetworkInMaintenanceForService('recharge', method)) {
        return { ok: false, error: 'Ce réseau est temporairement indisponible pour la recharge.' };
      }
      users.updateSolde(user_id, montant);
      notifications.create(user_id, `Votre portefeuille a été rechargé de ${montant.toLocaleString()} F.`, 'info');
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
       et lève celles dont l'échéance de 24h est dépassée — contrairement
       à checkAutoUnsuspend() (appelé ponctuellement pour UNE cabine),
       celle-ci couvre aussi une cabine suspendue qui n'a plus aucune
       commande en attente (le cas normal), donc jamais visitée par
       sweepStaleOrders ci-dessous. Appelée depuis les mêmes points de
       sondage périodiques que sweepStaleOrders (client.js/cabine.js/admin.js). */
    sweepAutoUnsuspensions() {
      try {
        let liftedCount = 0;
        users.byRole('cabine')
          .filter(c => c.statut === 'suspendu' && c.suspendu_auto)
          .forEach(c => { if (business.checkAutoUnsuspend(c.id)) liftedCount++; });
        return { liftedCount };
      } catch (e) {
        console.error('[DB] sweepAutoUnsuspensions failed:', e);
        return { liftedCount: 0 };
      }
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
    suspendCabineManually(cabineId, motif, adminId) {
      users.update(cabineId, {
        statut: 'suspendu', suspendu_auto: false, suspendu_by: adminId,
        suspendu_motif: motif, suspendu_jusqu: null,
      });
      suspensionLogs.create({ cabine_id: cabineId, motif, auto: false, date_fin_prevue: null });
      notifications.create(cabineId, `Votre compte a été suspendu par l'administration : ${motif}.`, 'warning');
    },

    /* Suspension automatique si la cabine a soumis 5 demandes de
       remboursement (voir DB.refundRequests) au cours de la journée en
       cours — appelée depuis requestReclamationRefund() dans js/cabine.js
       juste après la création de la demande. */
    checkRefundRequestSuspension(cabineId) {
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      if (refundRequests.countSince(cabineId, todayStart.getTime()) >= 5) {
        business.suspendCabineAuto(cabineId, '5 demandes de remboursement en une journée');
      }
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
    resubscribeCabine(cabineId, formule) {
      const prix = SUBSCRIPTION_PRICES[formule];
      const cab  = users.byId(cabineId);
      if (!prix || !cab || cab.role !== 'cabine') return { ok: false, error: 'Formule ou compte invalide.' };
      if (!business.cabineQuotaAtteint(cabineId)) {
        return { ok: false, error: 'Vous devez atteindre votre quota actuel avant de changer de formule ou de vous réabonner.' };
      }

      const nouveauSolde = (cab.solde || 0) - prix;
      const resteDu = nouveauSolde < 0 ? Math.abs(nouveauSolde) : 0;

      users.update(cabineId, {
        solde: nouveauSolde,
        abonnement: formule,
        commissions_total: 0,
        statut: cab.statut === 'inactif' ? 'actif' : cab.statut,
      });

      resubscriptions.create({ cabine_id: cabineId, formule, prix });

      // Preuve de débit consultable dans l'historique — voir l'onglet
      // "Historique" cabine (js/cabine.js) qui lit transactions.byCabine(),
      // même patron d'enregistrement que les autres types déjà rendus par
      // renderHistoryList() côté client (id, statut, service, details.ref).
      const txn = transactions.create({
        type: 'reabonnement',
        cabine_id: cabineId,
        montant: prix,
        statut: 'terminé',
        service: `Réabonnement ${formule}`,
        date_fin: now(),
        details: { moyen_paiement: 'Solde cabine', formule },
      });

      notifications.create(cabineId, resteDu > 0
        ? `Réabonnement ${formule} confirmé (${prix.toLocaleString()} F) — il vous reste ${resteDu.toLocaleString()} F à rembourser (solde négatif).`
        : `Réabonnement ${formule} confirmé — ${prix.toLocaleString()} F prélevés de votre solde.`, 'info');

      return { ok: true, resteDu, nouveauSolde, transactionId: txn.id };
    },

    /* Droit de veto du super admin : change instantanément la formule
       d'une cabine sans passer par resubscribeCabine() — aucun débit de
       solde, aucune vérification de quota (contrairement au flux
       self-service ci-dessus). Remet quand même le compteur de quota à
       zéro pour repartir sur un cycle propre dans la nouvelle formule. */
    adminSetCabineAbonnement(cabineId, formule) {
      const prix = SUBSCRIPTION_PRICES[formule];
      const cab  = users.byId(cabineId);
      if (!prix || !cab || cab.role !== 'cabine') return { ok: false, error: 'Formule ou compte invalide.' };

      users.update(cabineId, { abonnement: formule, commissions_total: 0 });
      notifications.create(cabineId, `Votre formule a été changée en ${formule} par l'administration.`, 'info');

      return { ok: true };
    },

    /* Transfert d'argent entre deux cabinistes, identifié par le NOM de la
       cabine (feature 1). Frais de service à la charge de l'expéditeur. */
    cabineTransfer(fromCabineId, toCabineNom, montant) {
      const from = users.byId(fromCabineId);
      if (!from) return { ok: false, error: 'Cabine expéditrice introuvable.' };
      if (!montant || montant <= 0) return { ok: false, error: 'Montant invalide.' };

      const needle = (toCabineNom || '').trim().toLowerCase();
      const matches = users.byRole('cabine').filter(c =>
        c.statut === 'actif' && (c.cabine_nom || '').trim().toLowerCase() === needle
      );

      if (!matches.length) return { ok: false, error: 'Cabine introuvable ou inactive.' };
      if (matches.length > 1) return { ok: false, error: 'Plusieurs cabines portent ce nom, veuillez préciser.', matches };

      const to = matches[0];
      if (to.id === from.id) return { ok: false, error: 'Vous ne pouvez pas vous transférer de l\'argent à vous-même.' };

      const total = montant + TRANSFERT_CABINE_FRAIS;
      if ((from.solde || 0) < total) return { ok: false, error: `Solde insuffisant (total requis avec frais : ${total.toLocaleString()} F).` };

      users.updateSolde(from.id, -total);
      users.updateSolde(to.id, montant);
      const transfert = transferts_cabine.create({
        from_cabine_id: from.id, to_cabine_id: to.id, montant, frais: TRANSFERT_CABINE_FRAIS,
      });

      notifications.create(from.id, `Vous avez transféré ${montant.toLocaleString()} F à ${to.cabine_nom || (to.prenom + ' ' + to.nom)} (frais : ${TRANSFERT_CABINE_FRAIS} F).`, 'transfer');
      notifications.create(to.id, `Vous avez reçu ${montant.toLocaleString()} F de la part de ${from.cabine_nom || (from.prenom + ' ' + from.nom)}.`, 'transfer');

      return { ok: true, recipient: to, transfert };
    },

    /* Réassignation groupée (feature 2) — boucle reassignTransaction et
       retourne le détail par id pour un toast récapitulatif côté admin. */
    bulkReassign(txnIds, newCabineId) {
      const results = txnIds.map(id => ({ id, ...business.reassignTransaction(id, newCabineId) }));
      return {
        okCount: results.filter(r => r.ok).length,
        failCount: results.filter(r => !r.ok).length,
        results,
      };
    },

    /* Balayage périodique (features 4 et 5) — simule, sans backend, la
       réattribution automatique après RETARD_MS et la suspension après 3
       retards en 24h. Voir le plan pour le détail de chaque étape. */
    sweepStaleOrders() {
      try {
        const nowTs = Date.now();
        let staleCount = 0;
        const suspendedCabineIds = [];

        transactions.pending().forEach(t => {
          if (!t.cabine_id) return;
          const assignedAt = new Date(t.date_assignation || t.date).getTime();
          if (nowTs - assignedAt <= RETARD_MS) return;
          if (t.retard_logged_cabine_id === t.cabine_id) return; // déjà logué pour cette période d'attribution

          const cabineId = t.cabine_id;
          business.checkAutoUnsuspend(cabineId);

          // Écrit le garde-fou en premier pour réduire la fenêtre de course
          // entre plusieurs onglets (limitation acceptée sans backend).
          transactions.update(t.id, { retard_logged_cabine_id: cabineId });
          staleCount++;

          const retardRow = retards.create({ transaction_id: t.id, cabine_id: cabineId });

          let triggeredSuspension = false;
          // Journée calendaire (minuit local), pas une fenêtre glissante de 24h —
          // cohérent avec le compteur déjà affiché à la cabine (loadCabRealtimeStats,
          // js/cabine.js) et avec checkRefundRequestSuspension ci-dessous.
          const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
          if (retards.countSince(cabineId, todayStart.getTime()) >= 3) {
            business.suspendCabineAuto(cabineId, '3 retards de traitement au cours de la journée');
            suspendedCabineIds.push(cabineId);
            triggeredSuspension = true;
          }

          const target = business.findReassignmentTarget(cabineId, t.operateur, t.type);

          let reassignedToCabineId = null;
          if (target) {
            transactions.update(t.id, { cabine_id: target.id, date_assignation: now() });
            notifications.create(target.id, `Nouvelle commande assignée automatiquement (réattribution pour retard) : ${t.operateur} ${t.montant.toLocaleString()} F.`, 'new_request');
            notifications.create(cabineId, `La commande ${Fmt.ref(t.id)} a été réattribuée automatiquement suite à un retard.`, 'reassigned');
            reassignedToCabineId = target.id;
          } else {
            // Aucune cabine connectée disponible : la commande repasse dans
            // le pool "en attente, non assignée" côté administration au lieu
            // de rester collée à la cabine en retard (voir assignCabine() /
            // assignPendingToCabine() qui la reprendront dès qu'une cabine
            // sera disponible).
            transactions.update(t.id, { cabine_id: null });
          }

          const list = get(KEY.retards);
          const idx = list.findIndex(r => r.id === retardRow.id);
          if (idx !== -1) {
            list[idx].reassigned_to_cabine_id = reassignedToCabineId;
            list[idx].triggered_suspension = triggeredSuspension;
            set(KEY.retards, list);
          }
        });

        return { staleCount, suspendedCabineIds };
      } catch (e) {
        console.error('[DB] sweepStaleOrders failed:', e);
        return { staleCount: 0, suspendedCabineIds: [] };
      }
    },
  };

  /* â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  return { init, users, transactions, retraits, retards, transferts_cabine, notifications, commissions, settings, reclamations, refundRequests, accessLogs, permissionLogs, maintenanceLogs, resubscriptions, favoris, forfaits, business, uid, now, SUBSCRIPTION_QUOTAS, SUBSCRIPTION_PRICES, presence, partnerDevices, RETARD_MS, TRANSFERT_CABINE_FRAIS, normalizeContact, suspensionLogs, Net, syncQueue, drainSyncQueue };
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


