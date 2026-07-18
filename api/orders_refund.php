<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';
require __DIR__ . '/orders_common.php';

// Admin : rembourse le client pour une commande en attente ou terminée —
// remplace DB.business.refundTransaction() (js/db.js). L'effet financier
// réel (double sanction cabine incluse si la commande était déjà marquée
// "Terminée" à tort) vit dans refundTransactionEffect() (orders_common.php),
// partagée avec orders_process_refund.php pour ne jamais laisser diverger
// les deux copies.
requireAuth(['admin']);

$in = body();
$txnId = (string)($in['transaction_id'] ?? '');
if ($txnId === '') fail('Identifiant de commande requis.');

$pdo = db();
$pdo->beginTransaction();
try {
  $txn = refundTransactionEffect($pdo, $txnId);
  $pdo->commit();
} catch (Throwable $e) {
  if ($pdo->inTransaction()) $pdo->rollBack();
  throw $e;
}

createNotification($txn['client_id'], 'Votre commande de ' . number_format((float)$txn['montant'], 0, ',', ' ') . ' F a été remboursée par l\'administration.', 'success');

echo json_encode(['ok' => true]);
