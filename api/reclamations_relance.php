<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Le client indique ne toujours pas avoir reçu sa commande — remplace la
// branche "non_recue" de rclHubQuickReply() (js/client.js). Avant toute
// preuve fournie par la cabine : simple relance (message seul). Après une
// première preuve : repasse en 'en_attente' et incrémente
// relances_apres_preuve, plafonné à 3 (la 4e tentative redirige vers
// l'assistance WhatsApp, entièrement côté client — non dupliqué ici).
$me = requireAuth(['client', 'cabine']);

$in = body();
$reclaId = (string)($in['reclamation_id'] ?? '');
if ($reclaId === '') fail('Réclamation requise.');

$pdo = db();
$reclaStmt = $pdo->prepare('SELECT * FROM reclamations WHERE id = ? AND client_id = ?');
$reclaStmt->execute([$reclaId, $me['id']]);
$recla = $reclaStmt->fetch();
if (!$recla) fail('Réclamation introuvable.', 404);
if (!empty($recla['confirmed_by_client']) || in_array($recla['statut'], ['remboursement_demande', 'remboursée'], true)) {
  fail('Cette réclamation ne peut plus être relancée.', 409);
}

$texte = "Je n'ai pas reçu ma commande";

if (empty($recla['screenshot'])) {
  // Aucune preuve encore fournie : simple relance, la limite ne s'applique
  // qu'"après" une première preuve.
  $pdo->prepare('INSERT INTO reclamation_messages (id, reclamation_id, sender, type, texte, image, date) VALUES (?, ?, \'client\', \'texte\', ?, NULL, NOW())')
      ->execute([uuid4(), $reclaId, $texte]);
  echo json_encode(['ok' => true, 'relances_apres_preuve' => (int)$recla['relances_apres_preuve']]);
  exit;
}

if ((int)$recla['relances_apres_preuve'] >= 3) {
  fail('Limite de relances atteinte.', 409);
}

// CAS : le compteur est réévalué dans le WHERE lui-même pour éviter qu'un
// double-clic rapide ne dépasse la limite de 3.
$stmt = $pdo->prepare("UPDATE reclamations SET statut = 'en_attente', relances_apres_preuve = relances_apres_preuve + 1
  WHERE id = ? AND client_id = ? AND relances_apres_preuve < 3");
$stmt->execute([$reclaId, $me['id']]);
if ($stmt->rowCount() === 0) fail('Limite de relances atteinte.', 409);

$pdo->prepare('INSERT INTO reclamation_messages (id, reclamation_id, sender, type, texte, image, date) VALUES (?, ?, \'client\', \'texte\', ?, NULL, NOW())')
    ->execute([uuid4(), $reclaId, $texte]);

if ($recla['cabine_id']) {
  createNotification($recla['cabine_id'], 'Le client indique ne toujours pas avoir reçu sa commande.', 'reclamation');
}

$freshStmt = $pdo->prepare('SELECT relances_apres_preuve FROM reclamations WHERE id = ?');
$freshStmt->execute([$reclaId]);
echo json_encode(['ok' => true, 'relances_apres_preuve' => (int)$freshStmt->fetchColumn()]);
