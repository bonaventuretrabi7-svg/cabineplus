<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Journal des accès admin (impersonation) — voir DB.accessLogs.create()
// (js/db.js) et Auth.startImpersonation() (js/auth.js). Réservé à un
// jeton admin : l'auteur (admin_id) vient du jeton lui-même, jamais du
// corps de la requête, pour ne jamais pouvoir usurper l'identité d'un
// autre administrateur dans le journal.
$me = requireAuth(['admin']);

$in = body();
$id = uuid4();
db()->prepare('INSERT INTO access_logs (id, admin_id, admin_name, target_user_id, target_role, target_name, date) VALUES (?, ?, ?, ?, ?, ?, NOW())')
    ->execute([
      $id, $me['id'], (string)($in['admin_name'] ?? ''),
      (string)($in['target_user_id'] ?? ''), (string)($in['target_role'] ?? ''), (string)($in['target_name'] ?? ''),
    ]);

echo json_encode(['ok' => true]);
