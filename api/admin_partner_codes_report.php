<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Rapport "Code partenaire" (admin, voir loadPartnerCodesReport(),
// js/admin.js) : pour chaque client ayant déjà servi de code de
// parrainage au moins une fois, agrège les DEUX flux de parrainage de
// l'app — client -> client (table referrals, 25 F au client parrain à la
// 1re commande du filleul) et client -> candidature partenaire
// (partner_applications.parrain_telephone, 1 000 F au client parrain si
// la candidature est validée). "Souscrit" = candidature partenaire
// validée (a pris l'abonnement Premium), jamais une simple inscription
// client — voir migration/discussion produit. Colonnes "jour" recalculées
// pour $date (aujourd'hui par défaut) ; colonnes "total" toujours
// cumulées depuis le début, sans rapport avec $date.
requireAuth(['admin']);

$in = body();
$date   = (string)($in['date'] ?? date('Y-m-d'));
$surnom = trim((string)($in['surnom'] ?? ''));

$pdo = db();

// Parrainage client -> client : clé = referrer_id (profiles.id).
$clientStmt = $pdo->prepare("
  SELECT referrer_id AS ref_key,
    COUNT(*) AS total_inscrits,
    SUM(CASE WHEN DATE(date) = ? THEN 1 ELSE 0 END) AS jour_inscrits
  FROM referrals
  GROUP BY referrer_id
");
$clientStmt->execute([$date]);
$clientAgg = [];
foreach ($clientStmt->fetchAll() as $r) $clientAgg[$r['ref_key']] = $r;

// Parrainage client -> candidature partenaire : clé = parrain_telephone
// (profiles.telephone, pas d'id direct dans partner_applications).
$partnerStmt = $pdo->prepare("
  SELECT parrain_telephone AS ref_key,
    COUNT(*) AS total_inscrits,
    SUM(CASE WHEN DATE(date_created) = ? THEN 1 ELSE 0 END) AS jour_inscrits,
    SUM(CASE WHEN statut = 'validée' THEN 1 ELSE 0 END) AS total_souscrits,
    SUM(CASE WHEN statut = 'validée' AND DATE(date_traitement) = ? THEN 1 ELSE 0 END) AS jour_souscrits
  FROM partner_applications
  WHERE parrain_telephone IS NOT NULL AND parrain_telephone != ''
  GROUP BY parrain_telephone
");
$partnerStmt->execute([$date, $date]);
$partnerAgg = [];
foreach ($partnerStmt->fetchAll() as $r) $partnerAgg[$r['ref_key']] = $r;

if ($surnom !== '') {
  // Recherche explicite par surnom : n'importe quel client, même sans
  // activité de parrainage (l'admin peut vouloir confirmer qu'un client
  // précis n'a encore jamais été utilisé comme code).
  $profStmt = $pdo->prepare("SELECT id, telephone, prenom, nom FROM profiles WHERE role = 'client' AND prenom LIKE ? ORDER BY prenom ASC");
  $profStmt->execute(['%' . $surnom . '%']);
  $profiles = $profStmt->fetchAll();
} else {
  // Vue par défaut : uniquement les clients ayant déjà servi de parrain
  // au moins une fois, pour ne pas lister tous les clients de l'app.
  $referrerIds   = array_keys($clientAgg);
  $parrainPhones = array_keys($partnerAgg);
  if (!$referrerIds && !$parrainPhones) {
    echo json_encode(['ok' => true, 'date' => $date, 'codes' => []]);
    exit;
  }
  $conditions = [];
  $params = [];
  if ($referrerIds) {
    $conditions[] = 'id IN (' . implode(',', array_fill(0, count($referrerIds), '?')) . ')';
    array_push($params, ...$referrerIds);
  }
  if ($parrainPhones) {
    $conditions[] = 'telephone IN (' . implode(',', array_fill(0, count($parrainPhones), '?')) . ')';
    array_push($params, ...$parrainPhones);
  }
  $profStmt = $pdo->prepare("SELECT id, telephone, prenom, nom FROM profiles WHERE role = 'client' AND (" . implode(' OR ', $conditions) . ') ORDER BY prenom ASC');
  $profStmt->execute($params);
  $profiles = $profStmt->fetchAll();
}

$codes = [];
foreach ($profiles as $p) {
  $c  = $clientAgg[$p['id']] ?? null;
  $pa = $partnerAgg[$p['telephone']] ?? null;
  $codes[] = [
    'telephone'       => $p['telephone'],
    'prenom'          => $p['prenom'],
    'nom'             => $p['nom'],
    'code'            => 'KP' . $p['telephone'],
    'total_inscrits'  => (int)($c['total_inscrits'] ?? 0) + (int)($pa['total_inscrits'] ?? 0),
    'jour_inscrits'   => (int)($c['jour_inscrits'] ?? 0) + (int)($pa['jour_inscrits'] ?? 0),
    'total_souscrits' => (int)($pa['total_souscrits'] ?? 0),
    'jour_souscrits'  => (int)($pa['jour_souscrits'] ?? 0),
  ];
}

echo json_encode(['ok' => true, 'date' => $date, 'codes' => $codes]);
