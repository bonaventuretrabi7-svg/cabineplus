<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Liste des appareils connectés — un client/une cabine voit uniquement les
// siens (espace "Mes appareils connectés"), un administrateur voit tous
// les appareils (onglet admin "Appareils connectés", super admin
// uniquement côté UI). Le hash du jeton n'est jamais renvoyé.
$me = requireAuth();

if ($me['role'] === 'admin') {
  $stmt = db()->query('SELECT * FROM devices ORDER BY last_seen_at DESC');
} else {
  $stmt = db()->prepare('SELECT * FROM devices WHERE profile_id = ? ORDER BY last_seen_at DESC');
  $stmt->execute([$me['id']]);
}
$rows = $stmt->fetchAll();
foreach ($rows as &$r) unset($r['token_hash']);
unset($r);

echo json_encode(['devices' => $rows]);
