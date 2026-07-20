<?php
declare(strict_types=1);

// Envoi de notifications push (Firebase Cloud Messaging, API HTTP v1) —
// déclenché automatiquement par createNotification() (api/bootstrap.php)
// pour que les points d'appel existants n'aient rien à changer. Best-
// effort : toute erreur (identifiants absents, jeton invalide, réseau) est
// avalée ici, jamais remontée à l'appelant — une notification push ratée
// ne doit jamais faire échouer l'opération métier qui la déclenche (même
// philosophie que createNotification() elle-même).
//
// Nécessite deux fichiers, ni l'un ni l'autre commités sur GitHub (voir
// .gitignore) :
//  - api/config.php : constante FCM_SERVICE_ACCOUNT_FILE (voir
//    api/config.example.php).
//  - le fichier JSON de clé de compte de service lui-même, déposé
//    directement sur l'hébergement.
// Tant que ce fichier n'existe pas, sendPushToProfile() ne fait rien
// silencieusement — le reste de l'app (notifications in-app, tout le
// reste) continue de fonctionner normalement.

// Échange la clé de compte de service contre un jeton d'accès OAuth2 (JWT
// auto-signé, RS256) — mis en cache pour la durée de la requête PHP
// courante seulement (pas de cache partagé entre requêtes, l'app n'a pas
// un volume qui le justifie).
function _fcmAccessToken(): ?string {
  static $cached = null;
  static $cachedExp = 0;
  $now = time();
  if ($cached && $now < $cachedExp - 30) return $cached;

  if (!defined('FCM_SERVICE_ACCOUNT_FILE') || !file_exists(FCM_SERVICE_ACCOUNT_FILE)) return null;
  $sa = json_decode((string)file_get_contents(FCM_SERVICE_ACCOUNT_FILE), true);
  if (!$sa || empty($sa['client_email']) || empty($sa['private_key'])) return null;

  $header = ['alg' => 'RS256', 'typ' => 'JWT'];
  $claims = [
    'iss'   => $sa['client_email'],
    'scope' => 'https://www.googleapis.com/auth/firebase.messaging',
    'aud'   => 'https://oauth2.googleapis.com/token',
    'iat'   => $now,
    'exp'   => $now + 3600,
  ];
  $b64json = function (array $d): string { return rtrim(strtr(base64_encode((string)json_encode($d)), '+/', '-_'), '='); };
  $b64raw  = function (string $d): string { return rtrim(strtr(base64_encode($d), '+/', '-_'), '='); };
  $unsigned = $b64json($header) . '.' . $b64json($claims);

  $signature = '';
  if (!openssl_sign($unsigned, $signature, $sa['private_key'], 'sha256WithRSAEncryption')) return null;
  $jwt = $unsigned . '.' . $b64raw($signature);

  $ch = curl_init('https://oauth2.googleapis.com/token');
  curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POSTFIELDS     => http_build_query([
      'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      'assertion'  => $jwt,
    ]),
    CURLOPT_TIMEOUT => 8,
  ]);
  $res = curl_exec($ch);
  curl_close($ch);
  if (!$res) return null;
  $data = json_decode($res, true);
  if (empty($data['access_token'])) return null;

  $cached    = $data['access_token'];
  $cachedExp = $now + (int)($data['expires_in'] ?? 3600);
  return $cached;
}

// Envoie une notification push à TOUS les appareils enregistrés d'un
// profil (client/cabine/admin) — silencieux si FCM n'est pas configuré ou
// si l'utilisateur n'a aucun appareil enregistré (ex. jamais ouvert l'app
// native Android, ou utilisé uniquement la version web).
function sendPushToProfile(string $profileId, string $title, string $body): void {
  try {
    if (!defined('FCM_SERVICE_ACCOUNT_FILE') || !file_exists(FCM_SERVICE_ACCOUNT_FILE)) return;
    $sa = json_decode((string)file_get_contents(FCM_SERVICE_ACCOUNT_FILE), true);
    if (!$sa || empty($sa['project_id'])) return;

    $accessToken = _fcmAccessToken();
    if (!$accessToken) return;

    $stmt = db()->prepare('SELECT id, token FROM push_tokens WHERE profile_id = ?');
    $stmt->execute([$profileId]);
    $tokens = $stmt->fetchAll();
    if (!$tokens) return;

    $url = 'https://fcm.googleapis.com/v1/projects/' . $sa['project_id'] . '/messages:send';
    foreach ($tokens as $row) {
      $payload = [
        'message' => [
          'token'        => $row['token'],
          'notification' => ['title' => $title, 'body' => $body],
          'android'      => ['priority' => 'high'],
        ],
      ];
      $ch = curl_init($url);
      curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => ['Authorization: Bearer ' . $accessToken, 'Content-Type: application/json'],
        CURLOPT_POSTFIELDS     => (string)json_encode($payload),
        CURLOPT_TIMEOUT        => 8,
      ]);
      $res = curl_exec($ch);
      curl_close($ch);
      // Jeton invalide/appareil désinstallé (UNREGISTERED) : nettoyage
      // silencieux pour ne pas retenter indéfiniment un appareil qui
      // n'existe plus.
      if ($res && strpos($res, 'UNREGISTERED') !== false) {
        db()->prepare('DELETE FROM push_tokens WHERE id = ?')->execute([$row['id']]);
      }
    }
  } catch (Throwable $e) {
    // Best-effort — jamais remonté à l'appelant.
  }
}
