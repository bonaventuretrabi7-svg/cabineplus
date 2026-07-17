/* ================================================================
   KBINE PLUS | Notification de nouvelle version disponible
   ================================================================
   Enregistre sw.js (voir ce fichier — service worker minimal, aucun
   cache) et affiche une bannière non-bloquante dès qu'une nouvelle
   version est détectée en attente (registration.waiting). N'affiche
   jamais la bannière tant qu'une modale est ouverte (le client ne doit
   pas être interrompu en pleine action) — la vérification est reportée,
   pas annulée. Le clic sur "Actualiser" fait passer le nouveau service
   worker en contrôle (postMessage + attente de controllerchange) puis
   recharge la page pour charger la nouvelle version.

   Si le client ignore la bannière (ou la ferme), rien ne force la mise
   à jour : le service worker en attente prendra naturellement le
   contrôle tout seul à la prochaine fermeture complète + réouverture de
   l'app (comportement standard du navigateur, rien à coder pour ça).

   N'a d'effet réel que sur le site web — dans l'app Android empaquetée
   (Capacitor), le contenu est figé dans l'APK au moment du build, donc
   il n'y a pas de nouvelle version à détecter à distance dans ce
   contexte (la mise à jour de l'app passe par un nouvel APK).

   Chargé après js/client.js (n'a besoin que du DOM et de currentUser
   pour le gating modale — voir index.html). */
const UpdateNotifier = (() => {
  const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1h : le navigateur revérifie déjà sw.js à chaque navigation, ceci couvre les sessions longues sans rechargement

  let _registration = null;
  let _bannerShown = false; // n'affiche qu'une fois par session pour une mise à jour donnée
  let _pendingShow = false; // une mise à jour est détectée mais reportée (modale ouverte)
  let _el = null;

  function _isBusy() {
    // Même signal que PullToRefresh pour "le client est en pleine
    // action" — ne pas dupliquer une autre logique de détection.
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
  // détection), retente à chaque fermeture de modale — voir closeModal()
  // dans js/auth.js, qui ne connaît pas ce module : on observe plutôt le
  // DOM directement, pas d'appel croisé à ajouter côté auth.js.
  function _watchForModalClose() {
    document.addEventListener('click', () => {
      if (_pendingShow && !_isBusy()) _showBanner();
    }, { capture: true });
  }

  async function init() {
    if (!('serviceWorker' in navigator)) return;

    _el = document.getElementById('update-banner');
    _watchForModalClose();

    try {
      _registration = await navigator.serviceWorker.register('/sw.js');
    } catch (e) { return; } // hors ligne, ou hébergement sans HTTPS (dev local) — pas bloquant

    // Cas 1 : une mise à jour était déjà en attente avant même ce
    // chargement (déployée pendant que le client n'utilisait pas l'app).
    if (_registration.waiting && navigator.serviceWorker.controller) _showBanner();

    // Cas 2 : une mise à jour démarre PENDANT que le client est sur la
    // page (déploiement en direct pendant sa session).
    _registration.addEventListener('updatefound', () => {
      const newWorker = _registration.installing;
      if (!newWorker) return;
      newWorker.addEventListener('statechange', () => {
        // "installed" + un controller déjà actif = une VERSION PRÉCÉDENTE
        // contrôlait déjà la page (sinon c'est juste la toute première
        // installation du service worker, rien à notifier).
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) _showBanner();
      });
    });

    setInterval(() => { try { _registration.update(); } catch (e) {} }, CHECK_INTERVAL_MS);
  }

  function applyUpdate() {
    if (_el) _el.classList.remove('upb-show');
    if (!_registration || !_registration.waiting) { window.location.reload(); return; }
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
    _registration.waiting.postMessage('SKIP_WAITING');
  }

  function dismiss() {
    if (_el) _el.classList.remove('upb-show');
  }

  return { init, applyUpdate, dismiss };
})();
