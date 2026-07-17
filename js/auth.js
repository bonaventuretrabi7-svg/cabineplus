/* ================================================================
   KBINE PLUS | Authentification
   ================================================================ */

const Auth = (() => {
  const SESSION_KEY = 'cbp_session';
  // Session client mise de côté quand on se connecte à un compte admin/cabine
  // depuis l'espace client, pour pouvoir y revenir sans se reconnecter (voir
  // login() ci-dessous et Auth.restoreClientBackup()).
  const CLIENT_BACKUP_KEY = 'cbp_client_backup';

  const get  = ()        => JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
  const save = (user)    => sessionStorage.setItem(SESSION_KEY, JSON.stringify(user));
  const clear = ()       => sessionStorage.removeItem(SESSION_KEY);

  const DEVICE_ID_KEY     = 'kbine_device_id';
  const REMEMBER_TOKEN_KEY = 'kbine_remember_token';

  // Identifiant stable de ce navigateur (pas un fingerprint — un simple
  // jeton généré une fois et conservé en localStorage), utilisé pour la
  // limite de 2 appareils sur les comptes partenaire (voir DB.partnerDevices).
  function getDeviceId() {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(DEVICE_ID_KEY, id); }
    return id;
  }

  // Étiquette cosmétique uniquement (page "Mes appareils connectés") —
  // aucune valeur de sécurité.
  function _deviceLabel() {
    const ua = navigator.userAgent || '';
    let os = 'Appareil inconnu';
    if (/Android/i.test(ua)) os = 'Android';
    else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
    else if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Macintosh/i.test(ua)) os = 'Mac';
    else if (/Linux/i.test(ua)) os = 'Linux';
    let browser = 'Navigateur';
    if (/Edg\//i.test(ua)) browser = 'Edge';
    else if (/Chrome\//i.test(ua)) browser = 'Chrome';
    else if (/Firefox\//i.test(ua)) browser = 'Firefox';
    else if (/Safari\//i.test(ua)) browser = 'Safari';
    return `${browser} sur ${os}`;
  }

  // Limite de 2 appareils simultanés (feature 4) — cabine de longue date,
  // étendue à client et administrateur simple (jamais au super admin).
  function _hasDeviceLimit(user) {
    return user.role === 'cabine' || user.role === 'client' || (user.role === 'admin' && user.admin_level === 'simple');
  }

  // Règles partagées cabine/admin : connexion réservée à une adresse Gmail
  // (identifiant) + un code PIN à exactement 4 chiffres (mot de passe).
  // Réutilisées par tous les formulaires (connexion, création de compte,
  // édition de profil, réinitialisation) dans js/client.js, js/admin.js et
  // js/cabine.js, pour n'avoir qu'une seule définition de la règle.
  const GMAIL_RE = /^[^\s@]+@gmail\.com$/i;
  function isValidGmail(email) { return GMAIL_RE.test((email || '').trim()); }
  function isValidPin(pin)     { return /^\d{4}$/.test(pin || ''); }

  // Vérifications de statut de compte (bloqué / suspension expirée /
  // suspendu / inactif / programmation admin simple) — extraites de
  // login() pour être réutilisées telles quelles par la connexion
  // biométrique (js/biometric.js), qui ne repasse jamais par le code mais
  // doit appliquer exactement les mêmes règles de statut. Retourne
  // { ok:false, error } ou { ok:true, user } (user éventuellement
  // rafraîchi si une suspension auto vient d'être levée).
  async function _checkAccountGates(user) {
    // Blocage après 3 mots de passe incorrects consécutifs (feature 3).
    if (user.statut === 'bloqué') {
      return { ok: false, error: 'Compte bloqué après 3 tentatives incorrectes. Contactez l\'administration pour le débloquer.' };
    }
    // Une suspension automatique (feature 5) expirée après 24h doit lever le
    // blocage même si aucun onglet n'a fait tourner le balayage périodique
    // entre-temps (voir DB.business.sweepStaleOrders / checkAutoUnsuspend).
    if (user.statut === 'suspendu' && user.suspendu_auto && user.suspendu_jusqu && new Date(user.suspendu_jusqu) <= new Date()) {
      DB.business.checkAutoUnsuspend(user.id);
      user = DB.users.byId(user.id);
    }
    // Un compte partenaire suspendu peut quand même se connecter — il doit
    // voir le bandeau de suspension (motif + heure de déblocage) sur son
    // tableau de bord (voir cabine.js). L'absence de nouvelles commandes
    // pendant la suspension est déjà garantie par les filtres `statut ===
    // 'actif'` dans assignCabine/findReassignmentTarget/assignPendingToCabine
    // (js/db.js) — bloquer la connexion elle-même n'est donc plus nécessaire
    // pour ce rôle, et empêcherait le partenaire de voir pourquoi.
    if (user.statut === 'suspendu' && user.role !== 'cabine') {
      return { ok: false, error: 'Votre compte est suspendu. Contactez l\'administration.' };
    }
    // Un compte cabine inactif (quota de commission atteint) peut lui aussi
    // se connecter — il doit pouvoir accéder à l'onglet Réabonnement pour
    // repartir sur un nouveau cycle (voir resubscribeCabine, js/db.js). Les
    // mêmes filtres statut === 'actif' empêchent déjà toute nouvelle
    // commande d'être assignée pendant l'inactivité.
    if (user.statut === 'inactif' && user.role !== 'admin' && user.role !== 'cabine') return { ok: false, error: 'Votre compte est inactif.' };

    // Un administrateur simple ne peut se connecter que s'il a au moins
    // une programmation enregistrée à son nom (voir l'onglet "Gestion des
    // Administrateurs", super admin uniquement) — simple vérification
    // d'existence, pas un contrôle d'horaire en direct : une fois
    // programmé au moins une fois, l'accès reste ouvert en permanence.
    // Ne s'applique jamais au super admin.
    if (user.role === 'admin' && user.admin_level === 'simple') {
      const schedules = (await DB.settings.get()).admin_schedules || [];
      if (!schedules.some(s => s.admin_id === user.id)) {
        return { ok: false, error: 'Accès refusé : Aucune programmation en cours.' };
      }
    }

    return { ok: true, user };
  }

  // Bascule client → admin/cabine : on conserve la session client en
  // arrière-plan pour permettre d'y revenir directement à la déconnexion
  // (voir admin.js/cabine.js logoutReturnToClient()). Ne se déclenche
  // qu'au moment de la bascule elle-même — une session déjà admin/cabine
  // qui se reconnecte à un autre compte du même type ne touche pas à une
  // sauvegarde déjà en place. Extraite pour être réutilisée par la
  // connexion biométrique (js/biometric.js).
  function _backupClientSessionIfSwitching(user) {
    if (user.role === 'admin' || user.role === 'cabine') {
      const previous = get();
      if (previous && previous.role === 'client') {
        sessionStorage.setItem(CLIENT_BACKUP_KEY, JSON.stringify(previous));
      }
    }
  }

  // Limite de 2 appareils simultanés + "rester connecté" (voir
  // DB.partnerDevices dans js/db.js et _hasDeviceLimit ci-dessus). Extraite
  // pour être réutilisée par la connexion biométrique (js/biometric.js) —
  // un déverrouillage par empreinte doit compter comme une connexion pour
  // cette limite, exactement comme une connexion au code.
  function _applyDeviceBookkeeping(user, remember) {
    const result = {};
    if (_hasDeviceLimit(user)) {
      const deviceId = getDeviceId();
      const known = DB.partnerDevices.forUser(user.id).find(d => d.device_id === deviceId);
      if (known) {
        const rec = DB.partnerDevices.touch(known.id, !!remember);
        if (rec.remember_token) result.rememberToken = rec.remember_token;
      } else {
        if (DB.partnerDevices.forUser(user.id).length >= 2) {
          const evicted = DB.partnerDevices.evictOldest(user.id);
          if (evicted) result.evictedDevice = evicted.label;
        }
        const rec = DB.partnerDevices.register(user.id, deviceId, _deviceLabel(), !!remember);
        if (rec.remember_token) result.rememberToken = rec.remember_token;
      }
    }
    return result;
  }

  // expectedRole (optionnel) : chaque formulaire de connexion (client,
  // partenaire, admin — tous dans js/client.js, passerelle unique) sait
  // déjà quel espace il cible. Depuis que 2 comptes de rôles différents
  // peuvent partager le même numéro (feature 5, unicité par rôle et non
  // plus globale), DB.users.byPhone() seul (premier trouvé, tous rôles
  // confondus) ne suffit plus à désigner le bon compte — on préfère un
  // compte du rôle attendu s'il existe, avec repli sur l'ancien
  // comportement si aucun indice n'est fourni (rétrocompatible).
  async function login(identifier, password, remember, expectedRole) {
    // Cabine/admin : connexion réservée à une adresse Gmail — aucun autre
    // identifiant (téléphone compris) n'est accepté pour ces deux rôles,
    // quel que soit ce qui est stocké en base (voir migrateCabineSeedEmails
    // dans js/db.js pour les comptes seedés avant cette règle).
    if ((expectedRole === 'admin' || expectedRole === 'cabine') && !isValidGmail(identifier)) {
      return { ok: false, error: 'Connexion réservée à une adresse Gmail (ex : nom@gmail.com).' };
    }
    const candidates = DB.users.all().filter(u => u.email === identifier.toLowerCase().trim() || u.telephone === identifier.trim());
    let user = (expectedRole && candidates.find(u => u.role === expectedRole)) || candidates[0];

    // Vérification locale d'abord (rapide, fonctionne hors ligne) — un compte
    // déjà "onboardé" sur cet appareil (voir DB.users.cacheFromServer) n'a
    // jamais besoin du réseau pour se reconnecter.
    let localOk = false;
    if (user) {
      // Blocage vérifié avant même la comparaison du mot de passe : un compte
      // bloqué ne doit plus jamais réévaluer une tentative.
      if (user.statut === 'bloqué') {
        return { ok: false, error: 'Compte bloqué après 3 tentatives incorrectes. Contactez l\'administration pour le débloquer.' };
      }
      localOk = DB.users.checkPwd(user, password);
    }

    // Repli serveur : compte inconnu sur CET appareil, ou mot de passe local
    // qui ne correspond pas (nouvel appareil jamais synchronisé, ou compte
    // créé/modifié ailleurs — voir le diagnostic : DB.users vivait
    // auparavant 100% en local, par appareil, d'où le blocage rapporté).
    // Ignoré hors ligne (DB.Net.isOnline()) : le comportement local existant
    // reste la seule source de vérité quand le réseau est indisponible.
    if (!localOk && expectedRole && SupabaseAPI.isConfigured && DB.Net.isOnline()) {
      const res = await SupabaseAPI.login(identifier, password, expectedRole);
      if (res.ok) {
        user = DB.users.cacheFromServer(res.profile, password);
        localOk = true;
      } else if (!user) {
        // Jamais vu ni localement ni côté serveur.
        return { ok: false, error: res.error || 'Compte introuvable.' };
      }
      // Sinon (res.ok faux mais compte local existant) : on retombe sur le
      // message d'erreur local ci-dessous, comportement inchangé.
    } else if (localOk && expectedRole === 'admin' && SupabaseAPI.isConfigured && DB.Net.isOnline()) {
      // Un admin déjà "onboardé" localement ne passe jamais par le repli
      // serveur ci-dessus — sans ceci, son navigateur n'obtiendrait jamais
      // de session Supabase Auth réelle, nécessaire pour les créations de
      // compte authentifiées côté serveur (voir adminCreateAccount() dans
      // js/supabase-client.js et finishCreateUser() dans js/admin.js).
      // Mode "silent" : jamais bloquant, jamais présenté à l'utilisateur,
      // aucun effet sur le compteur de tentatives en cas d'échec.
      SupabaseAPI.establishSession(identifier, password, 'admin').catch(() => {});
    }

    if (!user) return { ok: false, error: 'Compte introuvable.' };

    if (!localOk) {
      // Compteur d'échecs LOCAL uniquement — le serveur gère le sien
      // séparément (voir register_failed_login dans supabase/migrations/
      // 0005_login_attempts.sql), appliqué uniquement lors d'une tentative
      // effectivement vérifiée côté serveur.
      const attempts = (user.tentatives_echouees || 0) + 1;
      const updates  = { tentatives_echouees: attempts };
      if (attempts >= 3) updates.statut = 'bloqué';
      DB.users.update(user.id, updates);
      return attempts >= 3
        ? { ok: false, error: 'Compte bloqué après 3 tentatives incorrectes. Contactez l\'administration pour le débloquer.' }
        : { ok: false, error: 'Mot de passe incorrect.' };
    }
    if (user.tentatives_echouees) DB.users.update(user.id, { tentatives_echouees: 0 });

    const gates = await _checkAccountGates(user);
    if (!gates.ok) return gates;
    user = gates.user;

    _backupClientSessionIfSwitching(user);
    save(user);

    const result = { ok: true, user, ..._applyDeviceBookkeeping(user, remember) };
    return result;
  }

  function logout() {
    // Un admin en impersonation qui clique sur "Déconnexion" (bouton normal
    // de l'espace visité, pas le bandeau "Retour à l'administration") doit
    // simplement retrouver sa session admin, pas se retrouver déconnecté.
    if (isImpersonating()) {
      endImpersonation();
      window.location.href = 'admin.html';
      return;
    }
    const user = get();
    if (user) {
      ResumeState.clearAllForUser(user.id);
      if (_hasDeviceLimit(user)) {
        DB.partnerDevices.removeByDeviceId(user.id, getDeviceId());
        localStorage.removeItem(REMEMBER_TOKEN_KEY);
      }
    }
    clear();
    window.location.href = 'index.html';
  }

  function hasClientBackup() {
    return !!sessionStorage.getItem(CLIENT_BACKUP_KEY);
  }

  // Accès direct admin → espace cabine/client, sans mot de passe (voir
  // DB.accessLogs pour la traçabilité) — même principe que
  // restoreClientBackup() ci-dessous : save() n'exige jamais de mot de
  // passe, réutilisé ici dans l'autre sens (admin → cabine/client).
  // Pile (et non un slot unique) pour supporter les connexions déléguées
  // imbriquées (ex. super admin → administrateur simple → partenaire) :
  // chaque startImpersonation() empile un niveau, chaque endImpersonation()
  // n'en dépile qu'un seul — un "Retour" ne remonte donc que d'un cran à
  // la fois, jusqu'à vider la pile pour revenir à la session d'origine.
  const IMPERSONATION_STACK_KEY = 'cbp_impersonation_stack';

  function _impersonationStack() {
    return JSON.parse(sessionStorage.getItem(IMPERSONATION_STACK_KEY) || '[]');
  }

  function startImpersonation(targetUserId) {
    const admin = get();
    if (!admin || admin.role !== 'admin') return { ok: false, error: 'Accès réservé à l\'administration.' };
    const target = DB.users.byId(targetUserId);
    if (!target) return { ok: false, error: 'Compte cible invalide.' };

    const targetIsAdmin = target.role === 'admin';
    if (target.role !== 'client' && target.role !== 'cabine' && !targetIsAdmin) {
      return { ok: false, error: 'Compte cible invalide.' };
    }
    // Accès direct vers un autre administrateur : réservé au super admin,
    // et seulement vers un administrateur simple (jamais super → super).
    if (targetIsAdmin) {
      if (admin.admin_level !== 'super') return { ok: false, error: 'Seul le super administrateur peut accéder à l\'espace d\'un autre administrateur.' };
      if (target.admin_level === 'super') return { ok: false, error: 'Accès direct impossible vers un autre super administrateur.' };
    }

    const adminName  = `${admin.prenom} ${admin.nom}`.trim();
    const targetName = `${target.prenom} ${target.nom}`.trim();

    const stack = _impersonationStack();
    stack.push({
      returnSession: admin,
      admin_id: admin.id, admin_name: adminName,
      target_id: target.id, target_role: target.role, target_name: targetName,
      started_at: new Date().toISOString(),
    });
    sessionStorage.setItem(IMPERSONATION_STACK_KEY, JSON.stringify(stack));
    save(target);

    DB.accessLogs.create({
      admin_id: admin.id, admin_name: adminName,
      target_user_id: target.id, target_role: target.role, target_name: targetName,
    });

    return { ok: true, role: target.role };
  }

  function isImpersonating() {
    return _impersonationStack().length > 0;
  }

  function impersonationInfo() {
    const stack = _impersonationStack();
    return stack.length ? stack[stack.length - 1] : null;
  }

  /* Restaure la session mise de côté au niveau précédent de la pile (et la
     consomme) — utilisé par le bouton "Retour" affiché dans cabine.html/
     client.html/admin.html pendant une impersonation. Ne remonte que d'un
     niveau à la fois : depuis un partenaire atteint via un administrateur
     simple lui-même délégué par le super admin, un premier retour
     retombe sur l'administrateur simple, un second sur le super admin. */
  function endImpersonation() {
    const stack = _impersonationStack();
    if (!stack.length) return null;
    const top = stack.pop();
    if (stack.length) sessionStorage.setItem(IMPERSONATION_STACK_KEY, JSON.stringify(stack));
    else sessionStorage.removeItem(IMPERSONATION_STACK_KEY);
    save(top.returnSession);
    return top.returnSession;
  }

  /* Restaure la session client mise de côté (et la consomme) — utilisé par
     le choix "Retourner à mon espace client" à la déconnexion admin/cabine. */
  function restoreClientBackup() {
    const raw = sessionStorage.getItem(CLIENT_BACKUP_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(CLIENT_BACKUP_KEY);
    const user = JSON.parse(raw);
    save(user);
    return user;
  }

  function current() { return get(); }

  // opts.silent (cabine.js/admin.js boot()) : n'appelle jamais
  // window.location.href quand aucune session valide n'existe pour ce rôle
  // — l'appelant affiche alors son propre écran de connexion (voir
  // showCabineLoginGate()/showAdminLoginGate()) plutôt que d'être bouché
  // vers index.html sans explication (voir le diagnostic : un lien direct
  // vers /cabine ou /admin sans session active ne faisait jamais "sortir"
  // l'espace demandé). Une session déjà active mais évincée en cours de
  // route (limite de 2 appareils) redirige toujours vers index.html quel
  // que soit ce drapeau — ce n'est pas le même cas ("jamais connecté ici")
  // et le message d'éviction affiché là-bas doit rester atteint.
  function require(role, opts) {
    const silent = !!(opts && opts.silent);
    let user = get();
    if (!user) { if (!silent) window.location.href = 'index.html'; return null; }
    // Resynchronise toujours avec la base : une session ouverte avant un
    // changement de rôle/permissions (ex. admin_level, permissions[]) ne
    // doit pas rester figée sur l'instantané pris au moment du login.
    const fresh = DB.users.byId(user.id);
    if (fresh) { user = fresh; save(user); }
    if (role && user.role !== role) { if (!silent) window.location.href = 'index.html'; return null; }
    // Un compte partenaire évincé (limite de 2 appareils atteinte depuis un
    // autre appareil) doit être déconnecté ici dès sa prochaine action —
    // aucun push temps réel n'existe dans cette maquette (voir cabine.js boot()).
    // Ignoré pendant une impersonation admin : l'appareil de l'admin n'est
    // jamais enregistré dans DB.partnerDevices, il serait sinon détecté
    // comme "non reconnu" et immédiatement éjecté.
    if (_hasDeviceLimit(user) && !isImpersonating()) {
      const stillKnown = DB.partnerDevices.forUser(user.id).some(d => d.device_id === getDeviceId());
      if (!stillKnown) {
        clear();
        localStorage.removeItem(REMEMBER_TOKEN_KEY);
        sessionStorage.setItem('cbp_device_evicted', '1');
        window.location.href = 'index.html';
        return null;
      }
    }
    return user;
  }

  function refresh() {
    const s = get();
    if (!s) return null;
    const fresh = DB.users.byId(s.id);
    if (fresh) save(fresh);
    return fresh;
  }

  return { login, logout, current, require, refresh, save, hasClientBackup, restoreClientBackup, getDeviceId, REMEMBER_TOKEN_KEY, startImpersonation, endImpersonation, isImpersonating, impersonationInfo, isValidGmail, isValidPin, _checkAccountGates, _backupClientSessionIfSwitching, _applyDeviceBookkeeping };
})();

/* Persistance d'état "reprendre où j'en étais" — un seul instantané JSON
   par espace (client/cabine/admin), scopé par utilisateur pour qu'aucun
   brouillon ne puisse fuiter vers un autre compte partageant le même
   onglet. sessionStorage : survit à un F5, s'efface à la fermeture de
   l'onglet et à la déconnexion (voir Auth.logout() ci-dessus). */
const ResumeState = (() => {
  function key(scope) {
    const u = Auth.current();
    return 'kbine_resume_' + scope + (u ? '_' + u.id : '');
  }
  function save(scope, data) {
    try { sessionStorage.setItem(key(scope), JSON.stringify(data)); } catch (e) { /* quota/stockage indisponible - ignoré */ }
  }
  function load(scope) {
    try {
      const raw = sessionStorage.getItem(key(scope));
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function clear(scope) { sessionStorage.removeItem(key(scope)); }
  function clearAllForUser(userId) {
    if (!userId) return;
    ['client', 'cabine', 'admin'].forEach(s => sessionStorage.removeItem('kbine_resume_' + s + '_' + userId));
  }
  return { save, load, clear, clearAllForUser };
})();

/* â”€â”€ Toast helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
const Toast = {
  show(msg, type = 'info', duration = 3500) {
    const container = document.getElementById('toast-container') || (() => {
      const d = document.createElement('div'); d.id = 'toast-container'; document.body.appendChild(d); return d;
    })();

    // Anti-spam : si un toast identique (même type + même message) est
    // déjà affiché, on ignore l'appel au lieu d'en empiler un autre — un
    // clic répété (même 1000 fois) sur un même bouton ne montre qu'un
    // seul exemplaire à la fois.
    const dupeKey = type + '::' + msg;
    if ([...container.children].some(el => el.dataset.dupeKey === dupeKey)) return;

    const labels = { success: 'Succès', error: 'Erreur', info: 'Information', warning: 'Attention' };
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.dataset.dupeKey = dupeKey;
    t.innerHTML = `
      <div class="toast-inner">
        <div class="toast-logo-badge">
          <img src="img/logo.png" alt="" class="toast-logo-img">
        </div>
        <div class="toast-content">
          <div class="toast-type">${labels[type] || type}</div>
          <div class="toast-msg">${msg}</div>
        </div>
        <div class="toast-close" onclick="this.closest('.toast').remove()"><i class="fa-solid fa-xmark"></i></div>
      </div>
      <div class="toast-progress" style="animation-duration:${duration}ms"></div>`;
    container.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0'; t.style.transform = 'translateX(110%)'; t.style.transition = '.3s ease';
      setTimeout(() => t.remove(), 300);
    }, duration);
  },
  success: (m, d) => Toast.show(m, 'success', d),
  error:   (m, d) => Toast.show(m, 'error', d),
  info:    (m, d) => Toast.show(m, 'info', d),
  warning: (m, d) => Toast.show(m, 'warning', d),
};

/* â”€â”€ Format helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
/* Source unique du code couleur des statuts de transaction/commande,
   réutilisée par Fmt.status() (badge) et Fmt.rowColors() (teinte de
   ligne/carte dans admin.js/client.js/cabine.js) — évite d'avoir une
   palette légèrement différente à chaque endroit qui affiche un statut.
   "en_retard" n'est pas un statut stocké en base (voir Fmt.isLate) :
   c'est une commande "en_attente" qui a dépassé DB.RETARD_MS — quand
   c'est le cas, sa couleur remplace celle de "en_attente" partout. */
const STATUS_COLORS = {
  'terminé':    { line: '#009A44', bg: 'rgba(0,154,68,.12)',   text: '#065F46' },
  'en_attente': { line: '#D97706', bg: 'rgba(217,119,6,.12)',  text: '#92400E' },
  'en_retard':  { line: '#DC2626', bg: 'rgba(220,38,38,.13)',  text: '#991B1B' },
  'remboursé':  { line: '#C2410C', bg: 'rgba(194,65,12,.12)',  text: '#7C2D12' },
  'refusé':     { line: '#57534E', bg: 'rgba(87,83,78,.12)',   text: '#292524' },
  'suspendue':  { line: '#7C3AED', bg: 'rgba(124,58,237,.12)', text: '#5B21B6' },
};

// L'espace cabine garde "FCFA" en toutes lettres (demande explicite) —
// client/admin passent à "F" seul. auth.js étant partagé par les 3 pages,
// on distingue via le nom du fichier HTML courant plutôt que de dupliquer
// Fmt.money() dans chaque page.
const _isCabineSpace = /cabine\.html/i.test(window.location.pathname);

const Fmt = {
  money: (n) => Math.round(n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (_isCabineSpace ? ' FCFA' : ' F'),
  // Référence affichée d'une commande : "KBINE" + chiffres, dérivés de
  // façon déterministe de son id réel (même commande → toujours la même
  // référence). Remplace l'ancien "#" + 8 derniers caractères (lettres et
  // chiffres) de l'id — l'id technique lui-même (clé de la transaction)
  // n'est pas modifié, seul l'affichage change.
  ref: (id) => {
    let h = 0;
    const s = String(id || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return 'KBINE' + String(h % 1000000).padStart(6, '0');
  },
  date:  (d) => new Date(d).toLocaleDateString('fr-CI', { day: '2-digit', month: 'short', year: 'numeric' }),
  datetime: (d) => new Date(d).toLocaleString('fr-CI', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
  time:  (d) => new Date(d).toLocaleTimeString('fr-CI', { hour: '2-digit', minute: '2-digit' }),
  initials: (nom, prenom) => ((prenom || '')[0] || '') + ((nom || '')[0] || ''),
  status: (s) => {
    const meta = {
      'en_attente': { icon: 'fa-clock',             label: 'En attente' },
      'terminé':    { icon: 'fa-check',             label: 'Terminé' },
      'refusé':     { icon: 'fa-xmark',              label: 'Refusé' },
      'remboursé':  { icon: 'fa-rotate-left',        label: 'Remboursé' },
      'suspendue':  { icon: 'fa-circle-pause',       label: 'Suspendue' },
    }[s];
    const c = STATUS_COLORS[s];
    if (!meta || !c) return `<span class="badge">${s}</span>`;
    return `<span class="badge" style="background:${c.bg};color:${c.text};"><i class="fa-solid ${meta.icon}"></i> ${meta.label}</span>`;
  },
  // Une commande "en_attente" est en retard au-delà de DB.RETARD_MS
  // (3 min) depuis son assignation (ou sa création si jamais assignée) —
  // même règle que _startOrderCountdownTick()/_startHistoryCountdownTick()
  // et le badge "retards" de loadCabines(), désormais centralisée ici.
  isLate: (t) => t.statut === 'en_attente' && (Date.now() - new Date(t.date_assignation || t.date).getTime()) > DB.RETARD_MS,
  // Couleurs de teinte de ligne/carte (liseré + fond) pour une transaction
  // donnée — voir STATUS_COLORS ci-dessus. Distinct de Fmt.status() (qui
  // reste utilisable avec un simple statut string, y compris hors du
  // domaine transactions, ex. DB.retraits).
  rowColors: (t) => STATUS_COLORS[Fmt.isLate(t) ? 'en_retard' : t.statut]
    || { line: '#9CA3AF', bg: 'rgba(156,163,175,.12)', text: '#374151' },
  operator: (op) => ({
    'Orange': '<span style="color:#FF6200;font-weight:700"><i class="fa-solid fa-signal"></i> Orange</span>',
    'MTN':    '<span style="color:#FFCC00;font-weight:700"><i class="fa-solid fa-signal"></i> MTN</span>',
    'Moov':   '<span style="color:#0066CC;font-weight:700"><i class="fa-solid fa-signal"></i> Moov</span>',
  })[op] || op,
  // Espace tous les 2 chiffres pour un affichage uniforme (ex. "07 12 34 56 78")
  // dans les 3 espaces — jamais tronqué (affichage, pas saisie).
  phone: (v) => (v || '').toString().replace(/\D/g, '').replace(/(\d{2})(?=\d)/g, '$1 '),
  // Lien "click-to-chat" wa.me — retire le 0 initial d'un numéro local
  // ivoirien avant de préfixer 225 (un numéro déjà international n'est
  // pas modifié). Centralisé ici pour être réutilisé partout où un
  // contact WhatsApp est proposé (assistance client, contact admin…).
  whatsappLink: (rawNumber, message) => {
    let digits = (rawNumber || '').toString().replace(/\D/g, '');
    if (!digits) return null;
    if (digits.startsWith('0')) digits = digits.slice(1);
    if (!digits.startsWith('225')) digits = '225' + digits;
    return `https://wa.me/${digits}` + (message ? '?text=' + encodeURIComponent(message) : '');
  },
};

/* Formatage "à la volée" d'un champ téléphone : espace tous les 2 chiffres,
   plafonné à 10 chiffres (numéros CI). Partagé par les 3 espaces via
   oninput="formatPhoneInput(this)". */
function formatPhoneInput(input) {
  input.value = Fmt.phone(input.value.replace(/\D/g, '').slice(0, 10));
}

/* Préfixe réseau mobile money — inséré automatiquement dès la sélection du
   réseau (avant même la saisie du numéro), voir tfSelectOp/uvSelectNetwork/
   exchSelectDebitNet/exchSelectRecepNet dans js/client.js et les radios
   "cab-uv-net" dans cabine.html. */
const NETWORK_PREFIX = { Orange: '07', Moov: '01', MTN: '05' };

function applyNetworkPrefix(inputId, network) {
  const prefix = NETWORK_PREFIX[network];
  if (!prefix) return;
  const input = document.getElementById(inputId);
  if (!input) return;
  // Ne vide pas ce que l'utilisateur avait déjà tapé : ne remplace que les
  // 2 premiers chiffres par le nouveau préfixe, conserve le reste.
  const rest = input.value.replace(/\D/g, '').slice(2, 10);
  input.value = Fmt.phone(prefix + rest);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/* â”€â”€ Theme â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
const Theme = {
  init() {
    if (localStorage.getItem('cbp_dark') === 'true') document.body.classList.add('dark');
  },
  toggle() {
    document.body.classList.toggle('dark');
    localStorage.setItem('cbp_dark', document.body.classList.contains('dark'));
    document.querySelectorAll('.theme-icon').forEach(i => {
      i.className = document.body.classList.contains('dark')
        ? 'fa-solid fa-sun theme-icon'
        : 'fa-solid fa-moon theme-icon';
    });
  },
};

/* â”€â”€ Sidebar toggler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function initSidebar() {
  const sidebar  = document.querySelector('.sidebar');
  const overlay  = document.querySelector('.sidebar-overlay');
  const menuBtn  = document.querySelector('.topbar-menu-btn');
  if (!sidebar) return;
  menuBtn?.addEventListener('click', () => { sidebar.classList.toggle('open'); overlay.classList.toggle('open'); });
  overlay?.addEventListener('click', () => { sidebar.classList.remove('open'); overlay.classList.remove('open'); });
}

/* â”€â”€ View router â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function initRouter(defaultView, onShow) {
  const navItems = document.querySelectorAll('.nav-item[data-view]');
  const views    = document.querySelectorAll('.view');

  function showView(name) {
    views.forEach(v => v.classList.toggle('active', v.dataset.view === name));
    navItems.forEach(n => n.classList.toggle('active', n.dataset.view === name));
    const titleEl = document.querySelector('.topbar-title');
    const active  = document.querySelector(`.nav-item[data-view="${name}"]`);
    if (titleEl && active) titleEl.textContent = active.querySelector('.nav-label')?.textContent || 'KBINE PLUS';
    // Close mobile sidebar
    document.querySelector('.sidebar')?.classList.remove('open');
    document.querySelector('.sidebar-overlay')?.classList.remove('open');
    // Callback optionnel (ex: persister la vue active — voir restoreAdminState()
    // dans admin.js) : reste générique ici, ne présume de rien côté appelant.
    if (onShow) onShow(name);
  }

  navItems.forEach(item => item.addEventListener('click', () => showView(item.dataset.view)));
  showView(defaultView || 'dashboard');
  return { showView };
}

/* â”€â”€ Modal helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function openModal(id)  { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) e.target.classList.remove('open');
});

/* â”€â”€ Number formatting â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function fmtInput(input) {
  input.addEventListener('input', () => {
    const raw = input.value.replace(/\D/g,'');
    input.value = raw;
  });
}

/* Anime un chiffre de 0 (ou de sa valeur actuelle) jusqu'à target, pour
   donner un peu de vie aux cartes plutôt qu'un texte qui change d'un
   coup. formatter (ex. Fmt.money) est réappliqué à chaque frame sur la
   valeur arrondie intermédiaire. Respecte prefers-reduced-motion (saute
   directement à la valeur finale). Partagée par les 3 pages (client,
   admin, cabine) — utilisée par les KPI du tableau de bord admin et par
   le compteur "clients" de l'accueil client (voir js/client.js). */
function animateCountUp(el, target, formatter, duration = 800) {
  if (!el) return;
  target = Number(target) || 0;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) { el.textContent = formatter ? formatter(target) : target; return; }
  const start = performance.now();
  const step = (now) => {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const val = Math.round(target * eased);
    el.textContent = formatter ? formatter(val) : val;
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}



