<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Journal des permissions cabine — voir DB.permissionLogs.create()
// (js/db.js) et toggleCabinePermission() (js/admin.js). Réservé à un jeton
// admin ; l'auteur (admin_id) vient du jeton, jamais du corps de la requête.
$me = requireAuth(['admin']);

$in = body();
$id = uuid4();
db()->prepare('INSERT INTO permission_logs (id, admin_id, admin_name, cabine_id, cabine_name, service, active, date) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())')
    ->execute([
      $id, $me['id'], (string)($in['admin_name'] ?? ''),
      (string)($in['cabine_id'] ?? ''), (string)($in['cabine_name'] ?? ''),
      (string)($in['service'] ?? ''), !empty($in['active']) ? 1 : 0,
    ]);

echo json_encode(['ok' => true]);
