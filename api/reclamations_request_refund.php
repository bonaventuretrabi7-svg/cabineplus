<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';
require __DIR__ . '/orders_common.php';

// La cabine transmet une demande de remboursement à l'administration suite
// à une réclamation qu'elle reconnaît — remplace requestReclamationRefund()
// (js/cabine.js). Déclenche aussi checkRefundRequestSuspension (5 demandes
// en une journée calendaire → suspension automatique 24h), jusqu'ici jamais
// réellement actif puisque refund_requests restait 100% local.
$me = requireAuth(['cabine']);

$in = body();
$reclaId = (string)($in['reclamation_id'] ?? '');
if ($reclaId === '') fail('Réclamation requise.');

$pdo = db();

// Étape 1 — transition d'état de la réclamation (CAS de propriété + statut).
$stmt = $pdo->prepare("UPDATE reclamations SET statut = 'remboursement_demande' WHERE id = ? AND cabine_id = ? AND statut = 'en_attente'");
$stmt->execute([$reclaId, $me['id']]);
if ($stmt->rowCount() === 0) fail('Cette réclamation ne peut pas faire l\'objet d\'une demande de remboursement.', 409);

$reclaStmt = $pdo->prepare('SELECT * FROM reclamations WHERE id = ?');
$reclaStmt->execute([$reclaId]);
$recla = $reclaStmt->fetch();

$txnStmt = $pdo->prepare("SELECT statut FROM transactions WHERE id = ?");
$txnStmt->execute([$recla['transaction_id']]);
$txnStatut = $txnStmt->fetchColumn();
if ($txnStatut !== 'terminé') {
  // Annule la transition ci-dessus : la commande ne justifie pas de
  // remboursement (pas encore terminée).
  $pdo->prepare("UPDATE reclamations SET statut = 'en_attente' WHERE id = ?")->execute([$reclaId]);
  fail('Cette commande ne peut pas faire l\'objet d\'un remboursement.');
}

$pdo->prepare('INSERT INTO refund_requests (id, reclamation_id, transaction_id, cabine_id, client_id, motif, statut, date_created, date_traitement, processed_by)
    VALUES (?, ?, ?, ?, ?, ?, \'en_attente\', NOW(), NULL, NULL)')
    ->execute([uuid4(), $reclaId, $recla['transaction_id'], $me['id'], $recla['client_id'], $recla['motif']]);

// 5 demandes de remboursement en une journée calendaire → suspension auto 24h.
$countStmt = $pdo->prepare('SELECT COUNT(*) FROM refund_requests WHERE cabine_id = ? AND date_created >= CURDATE()');
$countStmt->execute([$me['id']]);
if ((int)$countStmt->fetchColumn() >= 5) {
  suspendCabineAuto($pdo, $me['id'], '5 demandes de remboursement en une journée');
}

echo json_encode(['ok' => true]);
