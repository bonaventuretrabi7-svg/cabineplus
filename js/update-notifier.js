/* ================================================================
   KBINE PLUS | Notification de nouvelle version disponible
   ================================================================
   Uniquement dans l'application Android empaquetée (Capacitor) — un
   client qui utilise le site web reçoit toujours la dernière version au
   prochain chargement de page (site déjà déployé = déjà à jour), rien à
   lui signaler ici.

   Dans l'app, le contenu est figé dans l'APK au moment du build : ce
   module compare la version embarquée dans l'app installée
   (app-version.json local, empaqueté avec l'APK) à celle actuellement en
   ligne sur le site (même fichier, hébergé à la racine du domaine) — si
   le site affiche un numéro plus grand, un APK plus récent a été publié
   depuis, et on propose de le télécharger.

   N'affiche jamais la bannière tant qu'une modale est ouverte (le client
   ne doit pas être interrompu en pleine action) — la vérification est
   reportée, pas annulée.

   Chargé après js/client.js (n'a besoin que du DOM pour le gating
   modale — voir index.html). */
const UpdateNotifier = (() => {
  const REMOTE_VERSION_URL = 'https://kbineplus.com/app-version.json';
  const APK_URL = 'https://kbineplus.com/downloads/kbineplus.apk';

  let _bannerShown = false; // n'affiche qu'une fois par session
  let _pendingShow = false; // détectée mais reportée (modale ouverte)
  let _el = null;

  // Même détection que window.Capacitor.Plugins ailleurs (js/biometric.js) :
  // n'existe que dans l'app empaquetée, jamais dans un navigateur classique.
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

  async function init() {
    if (!_isNativeApp()) return; // site web : jamais concerné, voir en tête de fichier

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

  return { init, applyUpdate, dismiss };
})();
