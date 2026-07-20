<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';
require __DIR__ . '/orders_common.php';

// Programmation d'une commande automatique par un client — payée
// IMMÉDIATEMENT (même débit atomique que api/orders_create.php), la vraie
// commande n'étant créée/assignée qu'à l'heure choisie (voir
// api/orders_sweep_scheduled.php + triggerScheduledOrder(), orders_common.php).
// Limite : 20 commandes programmées EN ATTENTE simultanément par client —
// au-delà, `limitReached: true` dans la réponse (voir js/client.js, qui
// redirige alors vers l'assistant WhatsApp au lieu d'un simple message).
const SCHEDULE_MAX_EN_ATTENTE = 20;

$me = requireAuth(['client']);

$in = body();
$operateur          = (string)($in['operateur'] ?? '');
$numeroBeneficiaire = (string)($in['numero_beneficiaire'] ?? '');
$montant            = (int)($in['montant'] ?? 0);
$service            = isset($in['service']) && $in['service'] !== '' ? (string)$in['service'] : 'Transfert direct';
$details            = array_key_exists('details', $in) ? json_encode($in['details']) : null;
$datesProgrammee    = (string)($in['date_programmee'] ?? '');
$moyenPaiement      = isset($in['moyen_paiement']) ? (string)$in['moyen_paiement'] : null;
$numeroPaiement     = isset($in['numero_paiement']) ? (string)$in['numero_paiement'] : null;

if ($operateur === '' || $numeroBeneficiaire === '' || $montant <= 0) fail('Paramètres de commande invalides.');
$ts = strtotime($datesProgrammee);
if (!$ts) fail('Date/heure programmée invalide.');
if ($ts <= time() + 60) fail('La date/heure programmée doit être au moins 1 minute dans le futur.');

$pdo = db();

$countStmt = $pdo->prepare("SELECT COUNT(*) FROM commandes_programmees WHERE client_id = ? AND statut = 'en_attente'");
$countStmt->execute([$me['id']]);
if ((int)$countStmt->fetchColumn() >= SCHEDULE_MAX_EN_ATTENTE) {
  http_response_code(400);
  echo json_encode(['error' => 'Limite de ' . SCHEDULE_MAX_EN_ATTENTE . ' commandes programmées atteinte.', 'limitReached' => true]);
  exit;
}

$FRAIS_SERVICE = 15;
$totalDebit = $montant + $FRAIS_SERVICE;

$pdo->beginTransaction();
try {
  $debit = $pdo->prepare('UPDATE profiles SET solde = solde - ? WHERE id = ? AND solde >= ?');
  $debit->execute([$totalDebit, $me['id'], $totalDebit]);
  if ($debit->rowCount() === 0) {
    $pdo->rollBack();
    fail('Solde insuffisant (montant + 15 FCFA de frais de service).', 400);
  }

  $cpId = uuid4();
  $pdo->prepare('INSERT INTO commandes_programmees
      (id, client_id, operateur, numero_beneficiaire, montant, frais_service, service, details, moyen_paiement, numero_paiement, date_programmee, statut, date_creation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'en_attente\', NOW())')
      ->execute([$cpId, $me['id'], $operateur, $numeroBeneficiaire, $montant, $FRAIS_SERVICE, $service, $details, $moyenPaiement, $numeroPaiement, date('Y-m-d H:i:s', $ts)]);

  $pdo->commit();
} catch (Throwable $e) {
  if ($pdo->inTransaction()) $pdo->rollBack();
  throw $e;
}

createNotification($me['id'], 'Commande programmée pour le ' . date('d/m/Y à H:i', $ts) . ' (' . $operateur . ', ' . number_format((float)$montant, 0, ',', ' ') . ' F) — paiement effectué.', 'info');

$cpStmt = $pdo->prepare('SELECT * FROM commandes_programmees WHERE id = ?');
$cpStmt->execute([$cpId]);
echo json_encode(['ok' => true, 'commande' => $cpStmt->fetch()]);
