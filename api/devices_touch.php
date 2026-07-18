<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Enregistre/rafraîchit l'appareil de l'utilisateur authentifié — remplace
// DB.partnerDevices.register()/touch() (js/db.js), jusqu'ici 100% locaux
// (aucun appareil connecté n'était donc jamais visible/révocable depuis un
// AUTRE appareil que celui-ci, ni par l'administration côté client/admin
// simple). Le hash du jeton courant (même schéma que `sessions`, jamais le
// jeton en clair) permet une vraie révocation à distance — voir
// devices_remove.php.
$me = requireAuth();

$in = body();
$deviceId = trim((string)($in['device_id'] ?? ''));
$label    = trim((string)($in['label'] ?? ''));
$remember = !empty($in['remember']);
if ($deviceId === '') fail('Identifiant d\'appareil requis.');

$header = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
$tokenHash = null;
if (preg_match('/^Bearer\s+(.+)$/i', $header, $m)) {
  $tokenHash = hash('sha256', trim($m[1]));
}

$pdo = db();
$existing = $pdo->prepare('SELECT id FROM devices WHERE profile_id = ? AND device_id = ?');
$existing->execute([$me['id'], $deviceId]);
$row = $existing->fetch();

if ($row) {
  $pdo->prepare('UPDATE devices SET label = ?, last_seen_at = NOW(), remembered = ?, token_hash = COALESCE(?, token_hash) WHERE id = ?')
      ->execute([$label ?: null, $remember ? 1 : 0, $tokenHash, $row['id']]);
  $id = $row['id'];
} else {
  $id = uuid4();
  $pdo->prepare('INSERT INTO devices (id, profile_id, device_id, label, token_hash, remembered, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())')
      ->execute([$id, $me['id'], $deviceId, $label ?: null, $tokenHash, $remember ? 1 : 0]);
}

echo json_encode(['ok' => true, 'id' => $id]);
