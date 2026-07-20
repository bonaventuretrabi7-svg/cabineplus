/* Notifications push (Firebase Cloud Messaging, plugin
   @capacitor/push-notifications) — uniquement dans l'app Android empaquetée
   (Capacitor), jamais sur le site web (pas de service worker/API Web Push
   configurée ici). Un plugin Capacitor natif ne se charge pas via
   <script src> : une fois installé, Capacitor l'expose lui-même au runtime
   sur window.Capacitor.Plugins.<Nom> — undefined dans un navigateur
   desktop classique ou sous Node (tests), voir _contactsPlugin() dans
   js/client.js pour le même patron déjà en place.

   PushNotif.init() est appelé une fois, juste après qu'un utilisateur soit
   authentifié (client/cabine/admin) — voir boot() dans js/client.js,
   js/cabine.js et js/admin.js — pour enregistrer le jeton de CET appareil
   auprès du compte CONNECTÉ (api/push_register.php). Si l'utilisateur
   refuse la permission ou est hors app native, ne fait rien silencieusement
   : l'app reste utilisable normalement, seules les notifications restent
   alors uniquement visibles en ouvrant l'app (cloche/badges existants). */
const PushNotif = (() => {
  let initialized = false;

  function _plugin() {
    return (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins)
      ? window.Capacitor.Plugins.PushNotifications
      : undefined;
  }

  async function init() {
    if (initialized) return;
    const PushNotifications = _plugin();
    if (!PushNotifications) return;
    initialized = true;

    try {
      const perm = await PushNotifications.requestPermissions();
      if (perm.receive !== 'granted') return;

      PushNotifications.addListener('registration', (token) => {
        ServerAPI.pushRegisterToken(token.value, 'android').catch(() => {});
      });
      // Best-effort — un échec d'enregistrement du jeton ne doit jamais
      // perturber le reste de l'app.
      PushNotifications.addListener('registrationError', () => {});

      await PushNotifications.register();
    } catch (e) {
      // Best-effort — voir commentaire ci-dessus.
    }
  }

  return { init };
})();
