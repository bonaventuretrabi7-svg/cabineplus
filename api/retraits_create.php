<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Admin : traite le retrait d'une cabine — remplace confirmProcessRetrait()
// (js/admin.js), qui débitait le solde UNIQUEMENT en local
// (DB.users.updateSolde()) : le prochain rafraîchissement périodique de la
// liste des cabines (refreshUsersFromServer()) écrasait ce débit local
// avec la valeur serveur inchangée — le retrait n'avait alors, dans les
// faits, jamais eu lieu financièrement. Débit atomique (CAS sur
// solde >= ?), même patron que orders_create.php.
$me = requireAuth(['admin']);

$in = body();
$cabineId = (string)($in['cabine_id'] ?? '');
$montant  = (int)($in['montant'] ?? 0);
if ($montant <= 0) fail('Montant invalide.');

$pdo = db();
$pdo->beginTransaction();
try {
  $cabStmt = $pdo->prepare("SELECT * FROM profiles WHERE id = ? AND role = 'cabine' FOR UPDATE");
  $cabStmt->execute([$cabineId]);
  $cab = $cabStmt->fetch();
  if (!$cab) {
    $pdo->rollBack();
    fail('Cabine introuvable.');
  }

  $debit = $pdo->prepare('UPDATE profiles SET solde = solde - ? WHERE id = ? AND solde >= ?');
  $debit->execute([$montant, $cabineId, $montant]);
  if ($debit->rowCount() === 0) {
    $pdo->rollBack();
    fail('Le montant dépasse le solde disponible.');
  }

  $retraitId = uuid4();
  $pdo->prepare("INSERT INTO retraits (id, cabine_id, montant, statut, methode_retrait, numero_paiement, date)
      VALUES (?, ?, ?, 'terminé', ?, ?, NOW())")
      ->execute([$retraitId, $cabineId, $montant, $cab['paiement_vers'] ?: 'Non renseigné', $cab['numero_compte'] ?: '']);

  $pdo->commit();
} catch (Throwable $e) {
  if ($pdo->inTransaction()) $pdo->rollBack();
  throw $e;
}

createNotification($cabineId, 'Un retrait de ' . number_format((float)$montant, 0, ',', ' ') . ' F a été traité par l\'administration.', 'success');

echo json_encode(['ok' => true, 'retraitId' => $retraitId]);
