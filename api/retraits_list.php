<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Historique des retraits — lecture seule, voir DB.retraits (js/db.js).
// Inclut aussi les sanctions (type='sanction', voir refundTransactionEffect()
// dans orders_common.php). Une cabine voit ses propres retraits, un
// administrateur voit tout.
$me = requireAuth(['cabine', 'admin']);

if ($me['role'] === 'cabine') {
  $stmt = db()->prepare('SELECT * FROM retraits WHERE cabine_id = ? ORDER BY date DESC');
  $stmt->execute([$me['id']]);
} else {
  $stmt = db()->query('SELECT * FROM retraits ORDER BY date DESC');
}

echo json_encode(['retraits' => $stmt->fetchAll()]);
