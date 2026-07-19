<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// "Conserver 5 min" -- la cabine réserve une commande en attente en
// repoussant sa date d'assignation de 5 minutes, pour ne pas se la faire
// réattribuer pendant qu'elle la garde volontairement. Remplace
// DB.transactions.update() (js/cabine.js, holdRequest()), qui ne
// modifiait que le cache LOCAL : le balayage serveur des commandes en
// retard (api/orders_sweep.php) ne voyait jamais cette prolongation et
// pouvait réattribuer la commande à une autre cabine malgré la
// réservation affichée. Usage unique par commande (CAS sur hold_used = 0).
$me = requireAuth(['cabine']);

$in = body();
$txnId = (string)($in['transaction_id'] ?? '');
if ($txnId === '') fail('Commande requise.');

$pdo = db();
$pdo->beginTransaction();
try {
  $stmt = $pdo->prepare('SELECT * FROM transactions WHERE id = ? FOR UPDATE');
  $stmt->execute([$txnId]);
  $txn = $stmt->fetch();
  if (!$txn || $txn['cabine_id'] !== $me['id']) { $pdo->rollBack(); fail('Commande introuvable.', 404); }
  if ($txn['statut'] !== 'en_attente') { $pdo->rollBack(); fail('Cette commande ne peut plus être réservée.'); }

  $base = strtotime($txn['date_assignation'] ?: $txn['date']);
  $newAssignation = date('Y-m-d H:i:s', $base + 5 * 60);

  $upd = $pdo->prepare('UPDATE transactions SET date_assignation = ?, hold_used = 1 WHERE id = ? AND hold_used = 0');
  $upd->execute([$newAssignation, $txnId]);
  if ($upd->rowCount() === 0) { $pdo->rollBack(); fail('Cette commande a déjà été réservée une fois.'); }

  $pdo->commit();
} catch (Throwable $e) {
  if ($pdo->inTransaction()) $pdo->rollBack();
  throw $e;
}

$stmt = $pdo->prepare('SELECT * FROM transactions WHERE id = ?');
$stmt->execute([$txnId]);
echo json_encode(['ok' => true, 'transaction' => decodeJsonColumns($stmt->fetch(), ['details'])]);
