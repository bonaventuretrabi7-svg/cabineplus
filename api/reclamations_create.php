<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Dépôt d'une réclamation sur une commande — remplace DB.reclamations.create()
// (js/db.js). Ouvert au client ET à la cabine (une cabine peut déposer une
// réclamation sur sa PROPRE commande de recharge UV en libre-service, où
// elle joue le rôle de "client" — voir DB.business.cabineSelfRecharge,
// client_id y vaut alors l'id de la cabine elle-même). client_id/cabine_id
// ne sont JAMAIS pris du corps de la requête : toujours re-dérivés de la
// transaction réelle, pour qu'un appelant ne puisse jamais créer une
// réclamation au nom d'un autre compte.
$me = requireAuth(['client', 'cabine']);

$in = body();
$txnId = (string)($in['transaction_id'] ?? '');
$motif = trim((string)($in['motif'] ?? ''));
if ($txnId === '' || $motif === '') fail('Commande et motif requis.');

$pdo = db();
$txnStmt = $pdo->prepare('SELECT client_id, cabine_id FROM transactions WHERE id = ?');
$txnStmt->execute([$txnId]);
$txn = $txnStmt->fetch();
if (!$txn) fail('Commande introuvable.');

// L'appelant doit être une des deux parties de CETTE commande précise.
if ($txn['client_id'] !== $me['id'] && $txn['cabine_id'] !== $me['id']) {
  fail('Vous n\'êtes pas partie prenante de cette commande.', 403);
}

$dupStmt = $pdo->prepare('SELECT id FROM reclamations WHERE transaction_id = ?');
$dupStmt->execute([$txnId]);
if ($dupStmt->fetch()) fail('Une réclamation existe déjà pour cette commande.');

$reclaId = uuid4();
$pdo->prepare('INSERT INTO reclamations (id, transaction_id, client_id, cabine_id, motif, statut, screenshot, date_created, date_resolved, relances_apres_preuve, confirmed_by_client)
    VALUES (?, ?, ?, ?, ?, \'en_attente\', NULL, NOW(), NULL, 0, NULL)')
    ->execute([$reclaId, $txnId, $txn['client_id'], $txn['cabine_id'], $motif]);

$pdo->prepare('INSERT INTO reclamation_messages (id, reclamation_id, sender, type, texte, image, date) VALUES (?, ?, \'client\', \'texte\', ?, NULL, NOW())')
    ->execute([uuid4(), $reclaId, $motif]);

if ($txn['cabine_id']) {
  createNotification($txn['cabine_id'], 'Réclamation reçue sur une commande.', 'reclamation');
}

$reclaStmt = $pdo->prepare('SELECT * FROM reclamations WHERE id = ?');
$reclaStmt->execute([$reclaId]);
echo json_encode(['ok' => true, 'reclamation' => $reclaStmt->fetch()]);
