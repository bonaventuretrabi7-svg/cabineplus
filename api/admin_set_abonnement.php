<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Droit de veto du super admin : change instantanément la formule d'une
// cabine — remplace DB.business.adminSetCabineAbonnement() (js/db.js).
// Aucun débit de solde, aucune vérification de quota (contrairement au
// flux self-service, api/cabine_resubscribe.php).
requireAuth(['admin']);

$in = body();
$cabineId = (string)($in['cabine_id'] ?? '');
$formule = (string)($in['formule'] ?? '');

$prices = ['Premium' => 10000, 'VIP' => 20000, 'VVIP' => 50000];
if (!isset($prices[$formule])) fail('Formule invalide.');

// Existence vérifiée séparément plutôt que via rowCount() de l'UPDATE
// ci-dessous : si la cabine a déjà cette formule ET commissions_total à 0,
// rowCount() vaudrait 0 (aucune LIGNE changée) alors que la cabine existe
// bel et bien — rowCount() reflète les changements, pas les lignes
// matchées par le WHERE (comportement par défaut de PDO MySQL).
$checkStmt = db()->prepare("SELECT id, statut, suspendu_motif FROM profiles WHERE id = ? AND role = 'cabine'");
$checkStmt->execute([$cabineId]);
$cab = $checkStmt->fetch();
if (!$cab) fail('Cabine introuvable.');

// abonnement_debut repart de NOW() (nouveau délai de 30 jours, voir
// checkQuotaDeadline(), api/orders_common.php) et une éventuelle
// suspension causée par ce même délai est levée — le veto du super admin
// équivaut à un réabonnement forcé, jamais les AUTRES suspensions
// (retards, manuelle), qui restent de leur ressort propre.
$sql = "UPDATE profiles SET abonnement = ?, abonnement_debut = NOW(), commissions_total = 0";
$params = [$formule];
if ($cab['statut'] === 'suspendu' && strpos((string)$cab['suspendu_motif'], 'Quota de commissions') === 0) {
  $sql .= ", statut = 'actif', suspendu_auto = 0, suspendu_by = NULL, suspendu_motif = NULL, suspendu_jusqu = NULL";
}
$sql .= " WHERE id = ? AND role = 'cabine'";
$params[] = $cabineId;
db()->prepare($sql)->execute($params);

createNotification($cabineId, 'Votre formule a été changée en ' . $formule . ' par l\'administration.', 'info');

echo json_encode(['ok' => true]);
