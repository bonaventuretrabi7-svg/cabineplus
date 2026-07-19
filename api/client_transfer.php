<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Transfert d'argent entre deux comptes clients, identifié par NUMÉRO DE
// TÉLÉPHONE — remplace la version locale de ctConfirmTransfer() (js/client.js),
// qui ne faisait que DB.users.updateSolde()/DB.transactions.create() en local
// (jamais synchronisé, le destinataire ne voyait donc jamais le crédit sur
// son propre appareil). Débit atomique (CAS sur solde >= ?), pas de frais
// (contrairement à cabine_transfer.php). Deux lignes `transactions` insérées
// (une par participant, client_id différent) pour que l'historique de
// chacun reflète sa moitié de l'opération (voir orders_list.php, filtré par
// client_id).
$me = requireAuth(['client']);

$in = body();
$toPhone = trim((string)($in['to_phone'] ?? ''));
$montant = (int)($in['montant'] ?? 0);
if ($montant < 100) fail('Montant minimum : 100 FCFA.');
if (!preg_match('/^[0-9]{10}$/', $toPhone)) fail('Numéro de compte invalide.');
if ($toPhone === $me['telephone']) fail("Vous ne pouvez pas vous transférer de l'argent à vous-même.");

$pdo = db();
$stmt = $pdo->prepare("SELECT * FROM profiles WHERE role = 'client' AND statut = 'actif' AND telephone = ?");
$stmt->execute([$toPhone]);
$to = $stmt->fetch();
if (!$to) fail('Aucun compte client actif trouvé pour ce numéro.');

$pdo->beginTransaction();
try {
  $debit = $pdo->prepare('UPDATE profiles SET solde = solde - ? WHERE id = ? AND solde >= ?');
  $debit->execute([$montant, $me['id'], $montant]);
  if ($debit->rowCount() === 0) {
    $pdo->rollBack();
    fail('Solde insuffisant — disponible : ' . number_format((float)$me['solde'], 0, ',', ' ') . ' F.');
  }

  $pdo->prepare('UPDATE profiles SET solde = solde + ? WHERE id = ?')->execute([$montant, $to['id']]);

  $pdo->prepare("INSERT INTO transactions (id, client_id, type, numero_beneficiaire, montant, statut, date) VALUES (?, ?, 'transfert_client_envoi', ?, ?, 'terminé', NOW())")
      ->execute([uuid4(), $me['id'], $to['telephone'], $montant]);
  $pdo->prepare("INSERT INTO transactions (id, client_id, type, numero_beneficiaire, montant, statut, date) VALUES (?, ?, 'transfert_client_reception', ?, ?, 'terminé', NOW())")
      ->execute([uuid4(), $to['id'], $me['telephone'], $montant]);

  $pdo->commit();
} catch (Throwable $e) {
  if ($pdo->inTransaction()) $pdo->rollBack();
  throw $e;
}

$fromName = trim($me['prenom'] . ' ' . $me['nom']);
createNotification($to['id'], 'Vous avez reçu ' . number_format((float)$montant, 0, ',', ' ') . ' F de la part de ' . $fromName . '.', 'transfer');

echo json_encode(['ok' => true, 'recipient' => ['id' => $to['id'], 'prenom' => $to['prenom'], 'nom' => $to['nom']]]);
