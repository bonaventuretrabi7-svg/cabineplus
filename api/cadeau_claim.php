<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Réclamation de la récompense "100 commandes" — remplace la version
// 100% locale de cadeauClaim() (js/client.js), qui créditait le solde et
// enregistrait la transaction uniquement sur l'appareil (jamais visible
// de l'administration, réclamable en double sur un autre appareil).
// Même logique d'éligibilité que _cadeauStats() (js/client.js), recalculée
// ici côté serveur pour ne jamais dépendre d'un compteur envoyé par le
// client : `done` = commandes terminées, `claimed` = récompenses déjà
// réclamées, une nouvelle récompense débloquée tous les CADEAU_GOAL.
$me = requireAuth(['client']);

$CADEAU_GOAL    = 100;
$CADEAU_MONTANT = 500;

$pdo = db();
$pdo->beginTransaction();
try {
  // Verrouille le profil pour empêcher une réclamation en double (deux
  // appareils du même client qui cliqueraient au même instant).
  $pdo->prepare('SELECT id FROM profiles WHERE id = ? FOR UPDATE')->execute([$me['id']]);

  $doneStmt = $pdo->prepare("SELECT COUNT(*) FROM transactions WHERE client_id = ? AND statut = 'terminé'");
  $doneStmt->execute([$me['id']]);
  $done = (int)$doneStmt->fetchColumn();

  $claimedStmt = $pdo->prepare("SELECT COUNT(*) FROM transactions WHERE client_id = ? AND type = 'cadeau_reward'");
  $claimedStmt->execute([$me['id']]);
  $claimed = (int)$claimedStmt->fetchColumn();

  $eligible = intdiv($done, $CADEAU_GOAL);
  if ($eligible <= $claimed) {
    $pdo->rollBack();
    fail('Aucune récompense disponible pour le moment.');
  }

  $pdo->prepare('UPDATE profiles SET solde = solde + ? WHERE id = ?')->execute([$CADEAU_MONTANT, $me['id']]);

  $txnId = uuid4();
  $notes = 'Cadeau KBINE PLUS — récompense pour ' . (($claimed + 1) * $CADEAU_GOAL) . ' commandes réalisées';
  $pdo->prepare('INSERT INTO transactions
      (id, client_id, cabine_id, type, service, montant, frais_service, statut, notes, date)
      VALUES (?, ?, NULL, \'cadeau_reward\', \'Récompense 100 commandes\', ?, 0, \'terminé\', ?, NOW())')
      ->execute([$txnId, $me['id'], $CADEAU_MONTANT, $notes]);

  $pdo->commit();
} catch (Throwable $e) {
  if ($pdo->inTransaction()) $pdo->rollBack();
  throw $e;
}

createNotification($me['id'], 'Félicitations ! ' . number_format((float)$CADEAU_MONTANT, 0, ',', ' ') . ' F ont été crédités sur votre solde (récompense 100 commandes).', 'success');

$txnStmt = $pdo->prepare('SELECT * FROM transactions WHERE id = ?');
$txnStmt->execute([$txnId]);
echo json_encode(['ok' => true, 'transaction' => decodeJsonColumns($txnStmt->fetch(), ['details'])]);
