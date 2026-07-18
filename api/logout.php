<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Invalide le jeton envoyé (best-effort — voir Auth.logout(), js/auth.js) :
// aucune erreur si absent/déjà expiré, la déconnexion locale reste
// inconditionnelle côté client de toute façon.
$header = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
if (preg_match('/^Bearer\s+(.+)$/i', $header, $m)) {
  $tokenHash = hash('sha256', trim($m[1]));
  db()->prepare('DELETE FROM sessions WHERE token_hash = ?')->execute([$tokenHash]);
  // Voir Phase G (mise en conformité temps réel) — l'entrée "appareil
  // connecté" correspondante (api/devices_*.php) ne doit pas survivre à
  // une déconnexion normale, sinon "Mes appareils connectés" listerait un
  // appareil déjà déconnecté jusqu'à sa prochaine reconnexion.
  db()->prepare('DELETE FROM devices WHERE token_hash = ?')->execute([$tokenHash]);
}
echo json_encode(['ok' => true]);
