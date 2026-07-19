<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Réabonnement cabine en libre-service — remplace
// DB.business.resubscribeCabine() (js/db.js). Paiement exclusivement via
// le solde, débit autorisé même si insuffisant (solde négatif, résorbé
// automatiquement par les prochaines commissions créditées via
// orders_accept.php) — contrairement aux débits de commande, jamais un
// CAS sur solde >= ? ici, cohérent avec le comportement local d'origine.
// Réservé à la cabine elle-même tant que son quota actuel n'est pas
// atteint (vérifié ci-dessous depuis les données déjà à jour côté
// serveur, jamais depuis un cache client).
$me = requireAuth(['cabine']);

$in = body();
$formule = (string)($in['formule'] ?? '');

$prices = ['Premium' => 10000, 'VIP' => 20000, 'VVIP' => 50000];
$quotas = ['Premium' => 25000, 'VIP' => 50000, 'VVIP' => 250000];
$prix = $prices[$formule] ?? null;
if ($prix === null) fail('Formule invalide.');

$pdo = db();
$profStmt = $pdo->prepare('SELECT * FROM profiles WHERE id = ? AND role = \'cabine\'');
$profStmt->execute([$me['id']]);
$cab = $profStmt->fetch();
if (!$cab) fail('Compte invalide.');

// Un réabonnement lève aussi une suspension causée par le délai de 30
// jours dépassé (voir checkQuotaDeadline(), api/orders_common.php) — c'est
// justement l'action qui répare ce motif précis, jamais une suspension
// pour une AUTRE raison (retards, renvois répétés, manuelle par un admin),
// qui reste de son ressort propre.
$lifteQuotaSuspension = $cab['statut'] === 'suspendu' && strpos((string)$cab['suspendu_motif'], 'Quota de commissions') === 0;

$currentQuota = $quotas[$cab['abonnement']] ?? $quotas['Premium'];
// Exception : une cabine suspendue faute d'avoir atteint son quota dans le
// délai a précisément besoin de se réabonner pour en sortir — exiger le
// quota ici l'en empêcherait définitivement.
if (!$lifteQuotaSuspension && (int)$cab['commissions_total'] < $currentQuota) {
  fail('Vous devez atteindre votre quota actuel avant de changer de formule ou de vous réabonner.');
}

$nouveauStatut = $cab['statut'] === 'inactif' ? 'actif' : $cab['statut'];
if ($lifteQuotaSuspension) $nouveauStatut = 'actif';

$pdo->beginTransaction();
try {
  // Débit relatif (solde = solde - ?), jamais une valeur absolue calculée
  // avant la transaction : reste correct même si une commission a été
  // créditée entre-temps (voir orders_accept.php) — contrairement au
  // reste de cet endpoint (peu de contention réelle, action self-service
  // déclenchée une fois par la cabine elle-même), ce champ-ci PEUT changer
  // sous nos pieds via un tout autre flux, donc protégé quand même.
  // abonnement_debut repart de NOW() : un nouveau cycle de 30 jours
  // commence à chaque réabonnement.
  $sql = 'UPDATE profiles SET solde = solde - ?, abonnement = ?, abonnement_debut = NOW(), commissions_total = 0, statut = ?';
  $params = [$prix, $formule, $nouveauStatut];
  if ($lifteQuotaSuspension) {
    $sql .= ', suspendu_auto = 0, suspendu_by = NULL, suspendu_motif = NULL, suspendu_jusqu = NULL';
  }
  $sql .= ' WHERE id = ?';
  $params[] = $me['id'];
  $pdo->prepare($sql)->execute($params);

  $pdo->prepare('INSERT INTO resubscriptions (id, cabine_id, formule, prix, date) VALUES (?, ?, ?, ?, NOW())')
      ->execute([uuid4(), $me['id'], $formule, $prix]);

  $txnId = uuid4();
  $pdo->prepare("INSERT INTO transactions (id, type, cabine_id, montant, statut, service, date_fin, details, date)
      VALUES (?, 'reabonnement', ?, ?, 'terminé', ?, NOW(), ?, NOW())")
      ->execute([$txnId, $me['id'], $prix, 'Réabonnement ' . $formule, json_encode(['moyen_paiement' => 'Solde cabine', 'formule' => $formule])]);

  $freshStmt = $pdo->prepare('SELECT solde FROM profiles WHERE id = ?');
  $freshStmt->execute([$me['id']]);
  $nouveauSolde = (int)$freshStmt->fetchColumn();
  $resteDu = $nouveauSolde < 0 ? abs($nouveauSolde) : 0;

  $pdo->commit();
} catch (Throwable $e) {
  if ($pdo->inTransaction()) $pdo->rollBack();
  throw $e;
}

createNotification($me['id'], $resteDu > 0
  ? 'Réabonnement ' . $formule . ' confirmé (' . number_format((float)$prix, 0, ',', ' ') . ' F) — il vous reste ' . number_format((float)$resteDu, 0, ',', ' ') . ' F à rembourser (solde négatif).'
  : 'Réabonnement ' . $formule . ' confirmé — ' . number_format((float)$prix, 0, ',', ' ') . ' F prélevés de votre solde.', 'info');

echo json_encode(['ok' => true, 'resteDu' => $resteDu, 'nouveauSolde' => $nouveauSolde, 'transactionId' => $txnId]);
