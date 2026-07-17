/* ================================================================
   KBINE PLUS | Service worker — détection de version uniquement
   ================================================================
   Volontairement minimal : AUCUNE interception réseau, AUCUN cache.
   Le mode hors-ligne de l'app repose déjà entièrement sur LocalStorage
   (voir js/db.js, DB.Net/DB.syncQueue) — ce fichier n'existe que pour
   profiter du cycle de vie standard des service workers (install →
   waiting → activate) afin de savoir qu'une nouvelle version du site a
   été déployée (voir js/update-notifier.js, qui l'enregistre et affiche
   la bannière de mise à jour).

   Convention : incrémenter SW_VERSION à chaque déploiement où l'on veut
   notifier les clients déjà ouverts — même principe manuel que les
   suffixes ?v=110/?v=2 déjà utilisés sur css/style.css et js/db.js pour
   forcer un rechargement. Le contenu de ce commentaire n'a aucun effet :
   seul le changement d'octets du fichier sw.js lui-même déclenche la
   détection côté navigateur.
*/
const SW_VERSION = 1;

// N'active PAS automatiquement une nouvelle version (pas de skipWaiting()
// ici) : elle doit rester en attente tant que le client n'a pas cliqué
// sur "Actualiser" dans la bannière — sinon la notification n'aurait
// aucun sens (l'ancienne page resterait affichée alors que le nouveau
// service worker aurait déjà pris le contrôle).
self.addEventListener('install', () => {});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Déclenché par js/update-notifier.js (bouton "Actualiser" de la
// bannière) : fait passer ce service worker en attente à l'état actif
// immédiatement, sans attendre la fermeture de tous les onglets.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
