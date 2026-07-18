<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// La cabine fournit une preuve de paiement pour résoudre une réclamation —
// remplace resolveReclamation() (js/cabine.js) + les mutations
// DB.reclamations.update()/addMessage() correspondantes. CAS de propriété :
// seule la cabine visée par CETTE réclamation peut la résoudre.
$me = requireAuth(['cabine']);

$in = body();
$reclaId = (string)($in['reclamation_id'] ?? '');
$screenshot = (string)($in['screenshot'] ?? '');
if ($reclaId === '' || $screenshot === '') fail('Réclamation et capture d\'écran requises.');

$pdo = db();
$stmt = $pdo->prepare("UPDATE reclamations SET statut = 'résolue', screenshot = ?, date_resolved = NOW() WHERE id = ? AND cabine_id = ?");
$stmt->execute([$screenshot, $reclaId, $me['id']]);
if ($stmt->rowCount() === 0) {
  // Existe mais rien changé (déjà résolue avec la même capture, edge case
  // improbable) vs n'existe pas / n'appartient pas à cette cabine : on
  // distingue pour un message d'erreur honnête.
  $checkStmt = $pdo->prepare('SELECT id FROM reclamations WHERE id = ? AND cabine_id = ?');
  $checkStmt->execute([$reclaId, $me['id']]);
  if (!$checkStmt->fetch()) fail('Réclamation introuvable.', 404);
}

$pdo->prepare('INSERT INTO reclamation_messages (id, reclamation_id, sender, type, texte, image, date) VALUES (?, ?, \'cabine\', \'texte\', ?, NULL, NOW())')
    ->execute([uuid4(), $reclaId, 'Nous sommes désolés pour le désagrément rencontré. Voici la preuve du transfert :']);
$pdo->prepare('INSERT INTO reclamation_messages (id, reclamation_id, sender, type, texte, image, date) VALUES (?, ?, \'cabine\', \'image\', NULL, ?, NOW())')
    ->execute([uuid4(), $reclaId, $screenshot]);

$reclaStmt = $pdo->prepare('SELECT client_id, transaction_id FROM reclamations WHERE id = ?');
$reclaStmt->execute([$reclaId]);
$recla = $reclaStmt->fetch();
if ($recla) {
  createNotification($recla['client_id'], 'Votre réclamation a été traitée. Une preuve a été fournie.', 'success');
}

echo json_encode(['ok' => true]);
