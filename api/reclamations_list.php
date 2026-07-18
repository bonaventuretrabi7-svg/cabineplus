<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Liste des réclamations pertinentes pour l'utilisateur authentifié, fil de
// messages inclus (reconstruit depuis reclamation_messages en tableau
// imbriqué `messages`, même forme que l'ancien objet 100% local — voir
// DB.reclamations, js/db.js) pour limiter les changements côté client.
// Portée par rôle : un client/une cabine ne voit que les réclamations où
// il est partie prenante (client_id OU cabine_id — une cabine peut être
// des deux côtés à la fois pour sa propre commande de recharge UV, voir
// reclamations_create.php), un admin voit tout.
$me = requireAuth();

$pdo = db();
if ($me['role'] === 'admin') {
  $rows = $pdo->query('SELECT * FROM reclamations ORDER BY date_created DESC')->fetchAll();
} else {
  $stmt = $pdo->prepare('SELECT * FROM reclamations WHERE client_id = ? OR cabine_id = ? ORDER BY date_created DESC');
  $stmt->execute([$me['id'], $me['id']]);
  $rows = $stmt->fetchAll();
}

if ($rows) {
  $ids = array_column($rows, 'id');
  $placeholders = implode(',', array_fill(0, count($ids), '?'));
  $msgStmt = $pdo->prepare("SELECT * FROM reclamation_messages WHERE reclamation_id IN ($placeholders) ORDER BY date ASC");
  $msgStmt->execute($ids);
  $byRecla = [];
  foreach ($msgStmt->fetchAll() as $m) {
    $byRecla[$m['reclamation_id']][] = $m;
  }
  foreach ($rows as &$r) {
    $r['messages'] = $byRecla[$r['id']] ?? [];
  }
  unset($r);
}

echo json_encode(['reclamations' => $rows]);
