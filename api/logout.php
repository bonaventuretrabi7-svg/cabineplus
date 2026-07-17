<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Invalide le jeton envoyé (best-effort — voir Auth.logout(), js/auth.js) :
// aucune erreur si absent/déjà expiré, la déconnexion locale reste
// inconditionnelle côté client de toute façon.
$header = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
if (preg_match('/^Bearer\s+(.+)$/i', $header, $m)) {
  db()->prepare('DELETE FROM sessions WHERE token_hash = ?')->execute([hash('sha256', trim($m[1]))]);
}
echo json_encode(['ok' => true]);
