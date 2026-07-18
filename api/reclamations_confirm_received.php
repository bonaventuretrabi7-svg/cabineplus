<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Le client confirme avoir reçu sa commande — remplace la branche "recu" de
// rclHubQuickReply() (js/client.js). CAS : seul le client de CETTE
// réclamation peut la confirmer, et seulement si elle n'est pas déjà
// clôturée/en cours de remboursement (même garde défensive que côté client).
$me = requireAuth(['client', 'cabine']); // cabine : cas UV self-recharge, voir reclamations_create.php

$in = body();
$reclaId = (string)($in['reclamation_id'] ?? '');
if ($reclaId === '') fail('Réclamation requise.');

$pdo = db();
$stmt = $pdo->prepare("UPDATE reclamations SET statut = 'résolue', confirmed_by_client = 1,
    date_resolved = COALESCE(date_resolved, NOW())
  WHERE id = ? AND client_id = ?
    AND (confirmed_by_client IS NULL OR confirmed_by_client = 0)
    AND statut NOT IN ('remboursement_demande', 'remboursée')");
$stmt->execute([$reclaId, $me['id']]);
if ($stmt->rowCount() === 0) fail('Cette réclamation ne peut plus être confirmée.', 409);

$pdo->prepare('INSERT INTO reclamation_messages (id, reclamation_id, sender, type, texte, image, date) VALUES (?, ?, \'client\', \'texte\', ?, NULL, NOW())')
    ->execute([uuid4(), $reclaId, "J'ai reçu ma commande, merci !"]);

$reclaStmt = $pdo->prepare('SELECT cabine_id, transaction_id FROM reclamations WHERE id = ?');
$reclaStmt->execute([$reclaId]);
$recla = $reclaStmt->fetch();
if ($recla && $recla['cabine_id']) {
  createNotification($recla['cabine_id'], 'Le client confirme avoir reçu sa commande.', 'success');
}

echo json_encode(['ok' => true]);
