<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';
require __DIR__ . '/orders_common.php';

// Acceptation d'une commande par la cabine — remplace DB.business.acceptRequest()
// (js/db.js). Corrige la faille de concurrence historique : l'ancienne
// version locale ne vérifiait jamais que la commande appartenait bien à la
// cabine qui agit (seul le statut 'en_attente' était contrôlé), laissant
// n'importe quelle cabine potentiellement terminer la commande d'une autre
// via un appel direct. Ici, l'appartenance ET le statut sont vérifiés dans
// la clause WHERE d'un seul UPDATE (compare-and-swap) : deux cabines qui
// tentent d'accepter la même commande quasi simultanément ne peuvent
// jamais toutes les deux réussir, sans verrou explicite nécessaire.
$me = requireAuth(['cabine']);

$in     = body();
$txnId  = (string)($in['transaction_id'] ?? '');
$proof  = isset($in['proof']) && $in['proof'] !== '' ? (string)$in['proof'] : null;
if ($txnId === '') fail('Identifiant de commande requis.');

$pdo = db();
$pdo->beginTransaction();
try {
  $sql = "UPDATE transactions SET statut='terminé', date_fin=NOW()" . ($proof !== null ? ', preuve_paiement=?' : '') . '
    WHERE id=? AND cabine_id=? AND statut=\'en_attente\'';
  $params = $proof !== null ? [$proof, $txnId, $me['id']] : [$txnId, $me['id']];
  $stmt = $pdo->prepare($sql);
  $stmt->execute($params);
  if ($stmt->rowCount() === 0) {
    $pdo->rollBack();
    fail('Commande déjà traitée ou réattribuée.', 409);
  }

  $txnStmt = $pdo->prepare('SELECT * FROM transactions WHERE id = ?');
  $txnStmt->execute([$txnId]);
  $txn = $txnStmt->fetch();

  // La commission n'est PLUS créditée au solde réel (choix explicite de
  // l'administration) — seule une recharge manuelle fait désormais
  // augmenter le solde disponible d'une cabine. commissions_total continue
  // néanmoins d'être suivi normalement, seul repère utilisé pour le quota
  // d'abonnement (voir plus bas) et les statistiques admin.
  $commission = (int)$txn['commission'];
  $pdo->prepare('UPDATE profiles SET commissions_total = commissions_total + ?, transferts_total = transferts_total + 1 WHERE id = ?')
      ->execute([$commission, $me['id']]);

  // Relu APRÈS le crédit ci-dessus : commissions_total reflète déjà cette
  // commission (l'UPDATE a déjà tourné) — ne jamais l'ajouter une seconde
  // fois ici, sous peine de compter la commission en double pour le quota.
  $cabStmt = $pdo->prepare('SELECT * FROM profiles WHERE id = ?');
  $cabStmt->execute([$me['id']]);
  $cab = $cabStmt->fetch();
  $newCommTotal = (int)$cab['commissions_total'];

  // Quota de commission du forfait atteint → fin anticipée de l'abonnement
  // (voir SUBSCRIPTION_QUOTAS, js/db.js — même valeurs, seule source de
  // vérité désormais côté serveur).
  $quotas = ['Premium' => 25000, 'VIP' => 50000, 'VVIP' => 250000];
  $plan   = $cab['abonnement'] ?: 'Premium';
  $quota  = $quotas[$plan] ?? null;
  $quotaReached = $quota !== null && $cab['statut'] === 'actif' && $newCommTotal >= $quota;
  if ($quotaReached) {
    $pdo->prepare("UPDATE profiles SET statut='inactif' WHERE id=?")->execute([$me['id']]);
  }

  $pdo->commit();
} catch (Throwable $e) {
  if ($pdo->inTransaction()) $pdo->rollBack();
  throw $e;
}

// Libellé adapté au type — "transfert" ne veut rien dire pour une
// Facture/Recharge UV/Exchange (voir orders_create_advanced.php) : ces
// commandes utilisent `service` au lieu de operateur+numero_beneficiaire.
$isAdvanced = in_array($txn['type'] ?? '', ['facture', 'recharge_uv', 'exchange'], true);
$clientMsg = $isAdvanced
  ? 'Votre demande de ' . number_format((float)$txn['montant'], 0, ',', ' ') . ' F (' . $txn['service'] . ') est terminée !'
  : 'Votre transfert de ' . number_format((float)$txn['montant'], 0, ',', ' ') . ' F (' . $txn['operateur'] . ' ' . $txn['numero_beneficiaire'] . ') est terminé !';
createNotification($txn['client_id'], $clientMsg, 'order_completed');
createNotification($me['id'], 'Commission de ' . number_format((float)$commission, 0, ',', ' ') . ' F enregistrée.', 'commission');
if ($quotaReached) {
  createNotification($me['id'], 'Quota de commission du forfait ' . $plan . ' atteint (' . number_format((float)$quota, 0, ',', ' ') . ' F). Votre abonnement a pris fin.', 'warning');
}
if ($txn['client_id']) creditReferralRewardIfFirstOrder($pdo, $txn['client_id']);

echo json_encode(['ok' => true]);
