<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';
require __DIR__ . '/orders_common.php';

// Recharge UV en libre-service côté cabine — remplace
// DB.business.cabineSelfRecharge() (js/db.js). Payée exclusivement par le
// solde de la cabine qui la déclenche, mais TRAITÉE par une autre cabine :
// passe par le même circuit "commande" (en_attente → assignation →
// orders_accept.php/orders_refuse.php) plutôt que de se débiter et se
// terminer instantanément. Débit atomique (CAS sur solde >= ?) + attribution
// dans la même requête, même patron qu'orders_create.php.
$me = requireAuth(['cabine']);
if ($me['statut'] === 'suspendu') fail('Votre compte est suspendu. Vous ne pouvez pas passer de commande de recharge UV.');

$in      = body();
$network = (string)($in['network'] ?? '');
$numero  = (string)($in['numero'] ?? '');
$montant = (int)($in['montant'] ?? 0);
if ($montant < 10000) fail('Montant minimum : 10 000 FCFA.');

$FRAIS_SERVICE_UV_CABINE = 200;
$total = $montant + $FRAIS_SERVICE_UV_CABINE;

$pdo = db();
$pdo->beginTransaction();
try {
  $debit = $pdo->prepare('UPDATE profiles SET solde = solde - ? WHERE id = ? AND solde >= ?');
  $debit->execute([$total, $me['id'], $total]);
  if ($debit->rowCount() === 0) {
    $pdo->rollBack();
    fail('Solde insuffisant.');
  }

  $txnId = uuid4();
  $pdo->prepare("INSERT INTO transactions
      (id, client_id, cabine_id, type, service, operateur, numero_beneficiaire, montant, frais_service, statut, commission, date)
      VALUES (?, ?, NULL, 'recharge_uv', 'Recharge UV', ?, ?, ?, ?, 'en_attente', 0, NOW())")
      ->execute([$txnId, $me['id'], $network, $numero, $montant, $FRAIS_SERVICE_UV_CABINE]);

  // findReassignmentTarget (pas pickInitialCabine) : exclut explicitement
  // la cabine d'origine et ne cible qu'une cabine actuellement en ligne —
  // même contrat que la version locale d'origine.
  $target = findReassignmentTarget($pdo, $me['id'], $network, 'recharge_uv');
  if ($target) {
    $pdo->prepare("UPDATE transactions SET cabine_id = ?, date_assignation = NOW() WHERE id = ? AND cabine_id IS NULL AND statut = 'en_attente'")
        ->execute([$target['id'], $txnId]);
  }

  $pdo->commit();
} catch (Throwable $e) {
  if ($pdo->inTransaction()) $pdo->rollBack();
  throw $e;
}

if ($target) {
  createNotification($target['id'], 'Nouvelle demande de recharge UV ' . $network . ' ' . number_format((float)$montant, 0, ',', ' ') . ' F.', 'new_request');
}

$txnStmt = $pdo->prepare('SELECT * FROM transactions WHERE id = ?');
$txnStmt->execute([$txnId]);
echo json_encode(['ok' => true, 'transaction' => $txnStmt->fetch(), 'assignedTo' => $target['id'] ?? null, 'frais' => $FRAIS_SERVICE_UV_CABINE, 'total' => $total]);
