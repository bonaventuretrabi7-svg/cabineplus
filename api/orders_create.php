<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';
require __DIR__ . '/orders_common.php';

// Création d'une commande "Transfert direct"/"Forfait" par le client —
// remplace DB.business.createTransfer() (js/db.js). Débit atomique
// (compare-and-swap sur le solde, jamais lecture-puis-écriture séparée) +
// attribution initiale à une cabine éligible dans la même requête.
$me = requireAuth(['client']);

$in                 = body();
$operateur          = (string)($in['operateur'] ?? '');
$numeroBeneficiaire = (string)($in['numero_beneficiaire'] ?? '');
$montant            = (int)($in['montant'] ?? 0);
$service            = isset($in['service']) && $in['service'] !== '' ? (string)$in['service'] : 'Transfert direct';
$moyenPaiement      = isset($in['moyen_paiement']) ? (string)$in['moyen_paiement'] : null;
$numeroPaiement     = isset($in['numero_paiement']) ? (string)$in['numero_paiement'] : null;
$details            = array_key_exists('details', $in) ? json_encode($in['details']) : null;

if ($operateur === '' || $numeroBeneficiaire === '' || $montant <= 0) fail('Paramètres de commande invalides.');

$FRAIS_SERVICE = 15;
$totalDebit = $montant + $FRAIS_SERVICE;

$pdo = db();
$pdo->beginTransaction();
try {
  $debit = $pdo->prepare('UPDATE profiles SET solde = solde - ? WHERE id = ? AND solde >= ?');
  $debit->execute([$totalDebit, $me['id'], $totalDebit]);
  if ($debit->rowCount() === 0) {
    $pdo->rollBack();
    fail('Solde insuffisant (montant + 15 FCFA de frais de service).', 400);
  }

  $commission = calcCommission($pdo, $montant);
  $txnId = uuid4();
  $pdo->prepare('INSERT INTO transactions
      (id, client_id, cabine_id, operateur, numero_beneficiaire, montant, frais_service, commission, statut, service, moyen_paiement, numero_paiement, details, date)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, \'en_attente\', ?, ?, ?, ?, NOW())')
      ->execute([$txnId, $me['id'], $operateur, $numeroBeneficiaire, $montant, $FRAIS_SERVICE, $commission, $service, $moyenPaiement, $numeroPaiement, $details]);

  // Attribution initiale — voir pickInitialCabine() (orders_common.php) :
  // aucune exigence de présence en ligne, sélection aléatoire parmi les
  // cabines éligibles (même contrat que DB.business.assignCabine).
  $cab = pickInitialCabine($pdo, $operateur, null);
  if ($cab) {
    $pdo->prepare("UPDATE transactions SET cabine_id = ?, date_assignation = NOW() WHERE id = ? AND cabine_id IS NULL AND statut = 'en_attente'")
        ->execute([$cab['id'], $txnId]);
  }

  $pdo->commit();
} catch (Throwable $e) {
  if ($pdo->inTransaction()) $pdo->rollBack();
  throw $e;
}

createNotification($me['id'], 'Votre demande de ' . number_format((float)$montant, 0, ',', ' ') . ' F (' . $operateur . ') est en attente de traitement.', 'order_pending');
if ($cab) {
  createNotification($cab['id'], 'Nouvelle demande de transfert ' . $operateur . ' ' . number_format((float)$montant, 0, ',', ' ') . ' F.', 'new_request');
}
$clientName = trim($me['prenom'] . ' ' . $me['nom']);
notifyAllCabines('Le client ' . $clientName . ' a passé une commande ' . $operateur . ' de ' . number_format((float)$montant, 0, ',', ' ') . ' F.', 'new_request');

$txnStmt = $pdo->prepare('SELECT * FROM transactions WHERE id = ?');
$txnStmt->execute([$txnId]);
echo json_encode(['ok' => true, 'transaction' => $txnStmt->fetch()]);
