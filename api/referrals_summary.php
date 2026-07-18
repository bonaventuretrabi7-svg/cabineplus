<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Résumé du parrainage du client authentifié — remplace le compteur
// figé à 0 lu depuis localStorage (renderParrainage(), js/client.js) :
// jusqu'ici rien n'incrémentait jamais ces valeurs, la fonctionnalité
// n'était même pas implémentée en local. Voir creditReferralRewardIfFirstOrder()
// (orders_common.php) pour la règle de versement.
$me = requireAuth(['client']);

$stmt = db()->prepare('SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN reward_verse = 1 THEN reward_montant ELSE 0 END), 0) AS total
    FROM referrals WHERE referrer_id = ?');
$stmt->execute([$me['id']]);
$row = $stmt->fetch();

echo json_encode(['ok' => true, 'count' => (int)$row['count'], 'total' => (int)$row['total']]);
