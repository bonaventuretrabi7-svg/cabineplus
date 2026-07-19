/* ================================================================
   KBINE PLUS | Notification de nouvelle version disponible
   ================================================================
   Dans l'app Android empaquetée (Capacitor) : le contenu est figé dans
   l'APK au moment du build, ce module compare la version embarquée dans
   l'app installée (app-version.json local, empaqueté avec l'APK) à celle
   actuellement en ligne sur le site (même fichier, hébergé à la racine
   du domaine) — si le site affiche un numéro plus grand, un APK plus
   récent a été publié depuis, et on propose de le télécharger (geste
   manuel : impossible d'installer un nouvel APK sans l'action du client,
   contrainte Android, pas de mécanisme de mise à jour automatique hors
   Play Store).

   Sur le site web (client/cabine/admin) : un onglet resté ouvert pendant
   qu'un déploiement a lieu continuerait sinon à tourner sur l'ancien code
   jusqu'à ce que le client pense à recharger la page lui-même — ce module
   revérifie donc app-version.json en tâche de fond (WEB_POLL_INTERVAL_MS)
   et recharge la page tout seul dès qu'un déploiement plus récent est
   détecté, sans action du client.

   N'interrompt jamais une action en cours (bannière APK ou rechargement
   web) tant qu'une modale est ouverte — la vérification est reportée, pas
   annulée.

   Chargé après js/client.js/js/cabine.js/js/admin.js (n'a besoin que du
   DOM pour le gating modale — voir index.html/cabine.html/admin.html). */
const UpdateNotifier = (() => {
  const REMOTE_VERSION_URL = 'https://kbineplus.com/app-version.json';
  const APK_URL = 'https://kbineplus.com/downloads/kbineplus.apk';
  const WEB_POLL_INTERVAL_MS = 60000; // 1 min — suffisant, jamais gênant

  let _bannerShown = false; // n'affiche qu'une fois par session
  let _pendingShow = false; // détectée mais reportée (modale ouverte)
  let _el = null;
  let _webLoadedVersion = null; // version chargée par CET onglet (site web)
  let _webPollTimer = null;

  // window.Capacitor n'existe que dans l'app empaquetée, jamais dans un
  // navigateur classique.
  function _isNativeApp() {
    return typeof window !== 'undefined' && !!window.Capacitor;
  }

  function _isBusy() {
    return !!document.querySelector('.modal-overlay.open');
  }

  function _showBanner() {
    if (_bannerShown) return;
    if (_isBusy()) { _pendingShow = true; return; }
    _bannerShown = true;
    _pendingShow = false;
    if (_el) _el.classList.add('upb-show');
  }

  // Si l'affichage a été reporté (modale ouverte au moment de la
  // détection), retente à chaque interaction — même patron que le
  // précédent mécanisme service worker.
  function _watchForModalClose() {
    document.addEventListener('click', () => {
      if (_pendingShow && !_isBusy()) _showBanner();
    }, { capture: true });
  }

  // Site web (client/cabine/admin) : capture la version avec laquelle CET
  // onglet a été chargé, puis la revérifie périodiquement — dès qu'un
  // déploiement plus récent est détecté, recharge la page automatiquement
  // (jamais pendant qu'une modale est ouverte, voir _isBusy() ci-dessus :
  // reporté au prochain tick plutôt que d'interrompre une action en cours,
  // ex. l'admin en train de traiter un remboursement).
  async function _initWeb() {
    try {
      const res = await fetch('app-version.json', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      _webLoadedVersion = Number(data.version);
    } catch (e) {
      return; // hors ligne au chargement — pas de version de référence, on ne pollra pas dans le vide
    }
    _webPollTimer = setInterval(_checkWebUpdate, WEB_POLL_INTERVAL_MS);
  }

  async function _checkWebUpdate() {
    if (_webLoadedVersion === null || _isBusy()) return;
    try {
      const res = await fetch('app-version.json', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (Number(data.version) > _webLoadedVersion) {
        clearInterval(_webPollTimer);
        if (typeof Toast !== 'undefined') Toast.info('Nouvelle version disponible — actualisation…', 2000);
        setTimeout(() => window.location.reload(), 1200);
      }
    } catch (e) {
      // Hors ligne — retentera au prochain tick.
    }
  }

  async function init() {
    if (!_isNativeApp()) { await _initWeb(); return; }

    _el = document.getElementById('update-banner');
    _watchForModalClose();

    try {
      const [localRes, remoteRes] = await Promise.all([
        fetch('app-version.json', { cache: 'no-store' }),
        fetch(REMOTE_VERSION_URL, { cache: 'no-store' }),
      ]);
      if (!localRes.ok || !remoteRes.ok) return;
      const local = await localRes.json();
      const remote = await remoteRes.json();
      if (Number(remote.version) > Number(local.version)) _showBanner();
    } catch (e) {
      // Hors ligne, ou site web pas encore redéployé avec ce fichier —
      // pas grave, la vérification retentera au prochain lancement.
    }
  }

  // Aucune page à recharger ici (contrairement à un service worker) :
  // ouvre simplement le téléchargement du nouvel APK dans le navigateur
  // système — l'installation reste une action manuelle du client (pas
  // de mécanisme de mise à jour automatique hors Play Store).
  function applyUpdate() {
    if (_el) _el.classList.remove('upb-show');
    window.open(APK_URL, '_blank');
  }

  function dismiss() {
    if (_el) _el.classList.remove('upb-show');
  }

  return { init, applyUpdate, dismiss, isNative: _isNativeApp };
})();
