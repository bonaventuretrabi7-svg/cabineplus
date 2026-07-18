<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Journal de maintenance (service/réseau) — voir DB.maintenanceLogs.create()
// (js/db.js) et l'onglet "UV Cabine" (js/admin.js). Réservé à un jeton
// admin ; l'auteur (admin_id) vient du jeton, jamais du corps de la requête.
$me = requireAuth(['admin']);

$in = body();
$id = uuid4();
db()->prepare('INSERT INTO maintenance_logs (id, admin_id, admin_name, action, `key`, active, service, message, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())')
    ->execute([
      $id, $me['id'], (string)($in['admin_name'] ?? ''),
      (string)($in['action'] ?? ''), (string)($in['key'] ?? ''),
      !empty($in['active']) ? 1 : 0,
      isset($in['service']) ? (string)$in['service'] : null,
      isset($in['message']) ? (string)$in['message'] : null,
    ]);

echo json_encode(['ok' => true]);
