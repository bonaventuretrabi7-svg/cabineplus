<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Recharge de portefeuille (simulée) — remplace DB.business.recharge()
// (js/db.js). Crédite toujours le compte authentifié lui-même (jamais un
// id fourni par l'appelant), utilisé par les 3 rôles (l'admin peut créditer
// un client/cabine — voir loadRechargeClient()/loadRechargeCabiniste() dans
// js/admin.js — c'est pourquoi target_id est accepté mais réservé aux
// admins ci-dessous).
$me = requireAuth();

$in = body();
$montant = (int)($in['montant'] ?? 0);
$method  = isset($in['method']) && $in['method'] !== '' ? (string)$in['method'] : null;
if ($montant < 1000) fail('Montant minimum : 1 000 FCFA.');

// Réseau en maintenance pour la recharge — même verrou que
// isNetworkInMaintenanceForService('recharge', method) côté client
// (js/db.js) : vérifié ici aussi, un appel direct contournant l'UI reste
// refusé pour un réseau désactivé.
if ($method !== null) {
  $netMap = ['Orange' => 'Orange', 'Orange Money' => 'Orange', 'MTN' => 'MTN', 'MTN MoMo' => 'MTN', 'Moov' => 'Moov', 'Moov Money' => 'Moov', 'Wave' => 'Wave', 'Wave CI' => 'Wave'];
  $net = $netMap[$method] ?? null;
  if ($net) {
    $settingsStmt = db()->query('SELECT maintenance FROM settings WHERE id = 1');
    $maintenance = json_decode((string)($settingsStmt->fetchColumn() ?: '{}'), true);
    if (!empty($maintenance['networksByService']['recharge'][$net])) {
      fail('Ce réseau est temporairement indisponible pour la recharge.');
    }
  }
}

// Un admin peut créditer un autre compte (client/cabine) ; les autres
// rôles ne peuvent créditer qu'eux-mêmes.
$targetId = $me['id'];
if ($me['role'] === 'admin' && !empty($in['target_id'])) {
  $targetId = (string)$in['target_id'];
  $checkStmt = db()->prepare('SELECT id FROM profiles WHERE id = ?');
  $checkStmt->execute([$targetId]);
  if (!$checkStmt->fetch()) fail('Compte introuvable.');
}

db()->prepare('UPDATE profiles SET solde = solde + ? WHERE id = ?')->execute([$montant, $targetId]);
createNotification($targetId, 'Votre portefeuille a été rechargé de ' . number_format((float)$montant, 0, ',', ' ') . ' F.', 'info');

echo json_encode(['ok' => true]);
