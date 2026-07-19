<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';
require __DIR__ . '/orders_common.php';

// Parcourt toutes les cabines actives dont le délai de 30 jours pour
// atteindre le quota de commissions est dépassé, et les suspend — voir
// checkQuotaDeadline() (orders_common.php). Même patron que
// orders_sweep_unsuspend.php, appelé par le même sondage périodique côté
// client (client.js/cabine.js/admin.js).
requireAuth();

$pdo = db();
$ids = array_column(
  $pdo->query("SELECT id FROM profiles WHERE role = 'cabine' AND statut = 'actif' AND abonnement_debut IS NOT NULL")->fetchAll(),
  'id'
);

$suspendedCount = 0;
foreach ($ids as $id) {
  if (checkQuotaDeadline($pdo, $id)) $suspendedCount++;
}

echo json_encode(['ok' => true, 'suspendedCount' => $suspendedCount]);
