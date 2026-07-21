<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Transfert d'argent entre deux cabinistes, identifié par le NOM de la
// cabine — remplace DB.business.cabineTransfer() (js/db.js). Frais de
// service à la charge de l'expéditeur. Débit atomique (CAS sur solde >= ?).
$me = requireAuth(['cabine']);

$in = body();
$toCabineNom = trim((string)($in['to_cabine_nom'] ?? ''));
$montant = (int)($in['montant'] ?? 0);
if ($montant <= 0) fail('Montant invalide.');

$TRANSFERT_CABINE_FRAIS = 150;

$pdo = db();
$stmt = $pdo->prepare("SELECT * FROM profiles WHERE role = 'cabine' AND statut = 'actif' AND LOWER(TRIM(cabine_nom)) = LOWER(?)");
$stmt->execute([$toCabineNom]);
$matches = $stmt->fetchAll();

if (!$matches) fail('Cabine introuvable ou inactive.');
if (count($matches) > 1) fail('Plusieurs cabines portent ce nom, veuillez préciser.');

$to = $matches[0];
if ($to['id'] === $me['id']) fail("Vous ne pouvez pas vous transférer de l'argent à vous-même.");

$total = $montant + $TRANSFERT_CABINE_FRAIS;

$pdo->beginTransaction();
try {
  $debit = $pdo->prepare('UPDATE profiles SET solde = solde - ? WHERE id = ? AND solde >= ?');
  $debit->execute([$total, $me['id'], $total]);
  if ($debit->rowCount() === 0) {
    $pdo->rollBack();
    fail('Solde insuffisant (total requis avec frais : ' . number_format((float)$total, 0, ',', ' ') . ' F).');
  }

  $pdo->prepare('UPDATE profiles SET solde = solde + ? WHERE id = ?')->execute([$montant, $to['id']]);
  $pdo->prepare('INSERT INTO transferts_cabine (id, from_cabine_id, to_cabine_id, montant, frais, date) VALUES (?, ?, ?, ?, ?, NOW())')
      ->execute([uuid4(), $me['id'], $to['id'], $montant, $TRANSFERT_CABINE_FRAIS]);

  $pdo->commit();
} catch (Throwable $e) {
  if ($pdo->inTransaction()) $pdo->rollBack();
  throw $e;
}

$toName = $to['cabine_nom'] ?: ($to['prenom'] . ' ' . $to['nom']);
$fromNameStmt = $pdo->prepare('SELECT cabine_nom, prenom, nom FROM profiles WHERE id = ?');
$fromNameStmt->execute([$me['id']]);
$fromRow = $fromNameStmt->fetch();
$fromName = $fromRow['cabine_nom'] ?: ($fromRow['prenom'] . ' ' . $fromRow['nom']);

createNotification($me['id'], 'Vous avez transféré ' . number_format((float)$montant, 0, ',', ' ') . ' F à ' . $toName . ' (frais : ' . $TRANSFERT_CABINE_FRAIS . ' F).', 'transfer');
createNotification($to['id'], 'Vous avez reçu ' . number_format((float)$montant, 0, ',', ' ') . ' F de la part de ' . $fromName . '.', 'transfer');
notifyAdminsIfCabineSoldeCrossed($pdo, $to['id'], (int)$to['solde'], (int)$to['solde'] + $montant);

echo json_encode(['ok' => true, 'recipient' => ['id' => $to['id'], 'cabine_nom' => $to['cabine_nom'], 'prenom' => $to['prenom'], 'nom' => $to['nom']]]);
