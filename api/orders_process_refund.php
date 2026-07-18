<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';
require __DIR__ . '/orders_common.php';

// Admin : valide une demande de remboursement soumise par une cabine suite
// à une réclamation — remplace DB.business.processRefundRequest() (js/db.js),
// jusqu'ici différée car refund_requests/reclamations restaient 100%
// locales. Réutilise refundTransactionEffect() (orders_common.php) pour
// l'effet financier, puis trace la demande et la réclamation liée comme
// traitées, dans la même transaction PDO.
$me = requireAuth(['admin']);

$in = body();
$requestId = (string)($in['request_id'] ?? '');
if ($requestId === '') fail('Identifiant de demande requis.');

$pdo = db();
$pdo->beginTransaction();
try {
  $reqStmt = $pdo->prepare('SELECT * FROM refund_requests WHERE id = ? FOR UPDATE');
  $reqStmt->execute([$requestId]);
  $req = $reqStmt->fetch();
  if (!$req || $req['statut'] !== 'en_attente') {
    $pdo->rollBack();
    fail('Demande introuvable ou déjà traitée.');
  }

  $txn = refundTransactionEffect($pdo, $req['transaction_id']);

  $pdo->prepare("UPDATE refund_requests SET statut = 'traité', date_traitement = NOW(), processed_by = ? WHERE id = ?")
      ->execute([$me['id'], $requestId]);
  $pdo->prepare("UPDATE reclamations SET statut = 'remboursée', date_resolved = NOW() WHERE id = ?")
      ->execute([$req['reclamation_id']]);

  $pdo->commit();
} catch (Throwable $e) {
  if ($pdo->inTransaction()) $pdo->rollBack();
  throw $e;
}

createNotification($txn['client_id'], 'Votre commande de ' . number_format((float)$txn['montant'], 0, ',', ' ') . ' F a été remboursée par l\'administration.', 'success');
createNotification($req['cabine_id'], 'Le remboursement d\'une commande a été validé par l\'administration.', 'success');

echo json_encode(['ok' => true]);
