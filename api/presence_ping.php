<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Signale l'utilisateur authentifié comme "en ligne" — voir DB.presence.ping()
// (js/db.js). N'importe quel rôle peut pinguer pour lui-même (jamais pour un
// autre id, toujours celui du jeton) ; upsert simple, une seule ligne par
// profil (voir table `presence`, profile_id CHAR(36) PRIMARY KEY).
$me = requireAuth();

db()->prepare('INSERT INTO presence (profile_id, last_seen_at) VALUES (?, NOW())
  ON DUPLICATE KEY UPDATE last_seen_at = NOW()')
    ->execute([$me['id']]);

echo json_encode(['ok' => true]);
