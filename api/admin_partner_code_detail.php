<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Détail des personnes ayant utilisé un code de parrainage donné (voir
// admin_partner_codes_report.php pour le résumé agrégé) — fusionne les
// deux flux (client parrainé via referrals, candidature partenaire
// parrainée via partner_applications.parrain_telephone), avec le rôle de
// chacun (client / partenaire) et, pour les partenaires, le statut de la
// candidature.
requireAuth(['admin']);

$in = body();
$telephone = trim((string)($in['telephone'] ?? ''));
if ($telephone === '') fail('Numéro de téléphone requis.');

$pdo = db();

// referrals.referrer_id référence profiles.id, pas le téléphone -- il
// faut d'abord retrouver l'id du client parrain.
$refStmt = $pdo->prepare("SELECT id FROM profiles WHERE role = 'client' AND telephone = ?");
$refStmt->execute([$telephone]);
$referrer = $refStmt->fetch();

$people = [];

if ($referrer) {
  $clientStmt = $pdo->prepare("
    SELECT p.prenom, p.nom, r.date, r.reward_verse
    FROM referrals r
    JOIN profiles p ON p.id = r.referred_id
    WHERE r.referrer_id = ?
  ");
  $clientStmt->execute([$referrer['id']]);
  foreach ($clientStmt->fetchAll() as $row) {
    $people[] = [
      'prenom' => $row['prenom'],
      'nom'    => $row['nom'],
      'role'   => 'client',
      'statut' => $row['reward_verse'] ? 'Récompense versée (25 F)' : 'En attente de la 1re commande',
      'date'   => $row['date'],
    ];
  }
}

$partnerStmt = $pdo->prepare("SELECT prenom, nom, statut, date_created FROM partner_applications WHERE parrain_telephone = ?");
$partnerStmt->execute([$telephone]);
foreach ($partnerStmt->fetchAll() as $row) {
  $statutLabel = $row['statut'] === 'validée'
    ? 'Partenaire validé (1 000 F versés)'
    : ($row['statut'] === 'refusée' ? 'Candidature refusée' : 'Candidature en attente');
  $people[] = [
    'prenom' => $row['prenom'],
    'nom'    => $row['nom'],
    'role'   => 'partenaire',
    'statut' => $statutLabel,
    'date'   => $row['date_created'],
  ];
}

usort($people, fn($a, $b) => strcmp($b['date'], $a['date']));

echo json_encode(['ok' => true, 'people' => $people]);
