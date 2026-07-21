<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Création d'une commande "service avancé" (Facture / Recharge UV /
// Exchange) par le client — remplace la version 100% locale de
// _svcDebitAndRecord() (js/client.js), qui ne débitait/enregistrait que
// côté appareil et restait donc invisible de l'administration (voir
// loadTransactions()/loadRechargeUvAdmin()/loadExchangeAdmin(), js/admin.js,
// déjà filtrés sur `type` mais jamais alimentés côté serveur pour ces 3
// types). Assignation à une cabine éligible dès la création (même
// pickInitialCabine() qu'api/orders_create.php, déjà prêt pour ce cas via
// cabineAcceptsService()) — sans quoi la commande restait "en_attente"
// pour toujours : aucune cabine ne pouvait la voir ni la marquer
// "terminé", donc le client ne recevait jamais la notification de fin
// (bug remonté : "le client ne reçoit pas de notification" sur une
// Recharge UV). js/cabine.js sait déjà afficher/terminer ces types
// (acceptRequest()/submitFactureProofAndComplete()) une fois assignés.
require __DIR__ . '/orders_common.php';
$me = requireAuth(['client']);

$in        = body();
$type      = (string)($in['type'] ?? '');
$montant   = (int)($in['montant'] ?? 0);
$service   = isset($in['service']) ? (string)$in['service'] : '';
$operateur = isset($in['operateur']) ? (string)$in['operateur'] : '';
$numero    = isset($in['numero']) ? (string)$in['numero'] : '';
$details   = array_key_exists('details', $in) ? json_encode($in['details']) : null;
$notes     = isset($in['notes']) ? (string)$in['notes'] : null;

if (!in_array($type, ['facture', 'recharge_uv', 'exchange'], true)) fail('Type de commande invalide.');
if ($montant <= 0) fail('Montant invalide.');
if ($type === 'recharge_uv' && $montant < 10000) fail('Montant minimum : 10 000 FCFA.');

$FRAIS_SERVICE_AVANCE = 200;
$totalDebit = $montant + $FRAIS_SERVICE_AVANCE;

$pdo = db();
$pdo->beginTransaction();
try {
  $debit = $pdo->prepare('UPDATE profiles SET solde = solde - ? WHERE id = ? AND solde >= ?');
  $debit->execute([$totalDebit, $me['id'], $totalDebit]);
  if ($debit->rowCount() === 0) {
    $pdo->rollBack();
    fail('Solde insuffisant (montant + 200 FCFA de frais de service).', 400);
  }

  $txnId = uuid4();
  $pdo->prepare('INSERT INTO transactions
      (id, client_id, cabine_id, type, service, operateur, numero_beneficiaire, montant, frais_service, statut, details, notes, date)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, \'en_attente\', ?, ?, NOW())')
      ->execute([$txnId, $me['id'], $type, $service, $operateur, $numero, $montant, $FRAIS_SERVICE_AVANCE, $details, $notes]);

  // Attribution initiale — voir pickInitialCabine() (orders_common.php),
  // même contrat qu'api/orders_create.php : aucune exigence de présence en
  // ligne, sélection aléatoire parmi les cabines éligibles ayant activé ce
  // service (cabineAcceptsService()).
  $cab = pickInitialCabine($pdo, null, $type);
  if ($cab) {
    $pdo->prepare("UPDATE transactions SET cabine_id = ?, date_assignation = NOW() WHERE id = ? AND cabine_id IS NULL AND statut = 'en_attente'")
        ->execute([$cab['id'], $txnId]);
  }

  $pdo->commit();
} catch (Throwable $e) {
  if ($pdo->inTransaction()) $pdo->rollBack();
  throw $e;
}

createNotification($me['id'], 'Votre demande de ' . number_format((float)$montant, 0, ',', ' ') . ' F (' . $service . ') est en attente de traitement.', 'order_pending');
if ($cab) {
  createNotification($cab['id'], 'Nouvelle demande de ' . $service . ' — ' . number_format((float)$montant, 0, ',', ' ') . ' F.', 'new_request');
}
$clientName = trim($me['prenom'] . ' ' . $me['nom']);
notifyAllCabines('Le client ' . $clientName . ' a passé une commande ' . $service . ' de ' . number_format((float)$montant, 0, ',', ' ') . ' F.', 'new_request');

$txnStmt = $pdo->prepare('SELECT * FROM transactions WHERE id = ?');
$txnStmt->execute([$txnId]);
echo json_encode(['ok' => true, 'transaction' => decodeJsonColumns($txnStmt->fetch(), ['details'])]);
