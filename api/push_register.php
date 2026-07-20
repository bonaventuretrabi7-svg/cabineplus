<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Enregistre le jeton FCM de l'appareil courant pour l'utilisateur connecté
// (n'importe quel rôle) — appelé après PushNotifications.register() côté
// app (voir js/push-notifications.js). Upsert par jeton (unique, voir
// migration_phase24) : si le même appareil se reconnecte avec un AUTRE
// compte (partage d'appareil, changement de partenaire...), le jeton est
// simplement réattribué au nouveau profil — jamais besoin d'un
// désenregistrement explicite à la déconnexion.
$me = requireAuth();

$in = body();
$token    = trim((string)($in['token'] ?? ''));
$platform = (string)($in['platform'] ?? 'android');
if ($token === '') fail('Jeton requis.');

$pdo = db();
$stmt = $pdo->prepare('SELECT id FROM push_tokens WHERE token = ?');
$stmt->execute([$token]);
$existing = $stmt->fetch();

if ($existing) {
  $pdo->prepare('UPDATE push_tokens SET profile_id = ?, platform = ?, updated_at = NOW() WHERE id = ?')
      ->execute([$me['id'], $platform, $existing['id']]);
} else {
  $pdo->prepare('INSERT INTO push_tokens (id, profile_id, token, platform, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())')
      ->execute([uuid4(), $me['id'], $token, $platform]);
}

echo json_encode(['ok' => true]);
