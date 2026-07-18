<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Moyen/numéro de retrait d'une cabine — remplace confirmCabRetrait()
// (js/cabine.js) et confirmEditPayment() (js/admin.js), jusqu'ici
// purement locaux (jamais persistés côté serveur, donc invisibles d'un
// autre appareil et perdus au moindre rafraîchissement de la liste des
// cabines). Une cabine ne peut modifier que son PROPRE moyen de retrait,
// avec un délai de 24h entre deux modifications (voir RETRAIT_COOLDOWN_MS,
// js/cabine.js — même règle revérifiée ici) ; l'admin peut modifier
// n'importe quelle cabine (target_id) SANS ce délai, comme côté local.
$me = requireAuth(['cabine', 'admin']);

$in = body();
$paiementVers = trim((string)($in['paiement_vers'] ?? ''));
$numeroCompte = trim((string)($in['numero_compte'] ?? ''));
if ($paiementVers === '' || $numeroCompte === '') fail('Réseau et numéro de réception requis.');

$targetId = $me['id'];
if ($me['role'] === 'admin' && !empty($in['target_id'])) {
  $targetId = (string)$in['target_id'];
}

$pdo = db();
$targetStmt = $pdo->prepare("SELECT id, retrait_derniere_maj FROM profiles WHERE id = ? AND role = 'cabine'");
$targetStmt->execute([$targetId]);
$target = $targetStmt->fetch();
if (!$target) fail('Cabine introuvable.');

const RETRAIT_COOLDOWN_SECONDS = 86400; // 24h, même valeur que RETRAIT_COOLDOWN_MS (js/cabine.js)
if ($me['role'] === 'cabine' && $target['retrait_derniere_maj']
    && (time() - strtotime($target['retrait_derniere_maj'])) < RETRAIT_COOLDOWN_SECONDS) {
  fail('Modification déjà effectuée récemment — réessayez dans 24h.', 429);
}

$pdo->prepare('UPDATE profiles SET paiement_vers = ?, numero_compte = ?, retrait_derniere_maj = NOW() WHERE id = ?')
    ->execute([$paiementVers, $numeroCompte, $targetId]);

echo json_encode(['ok' => true]);
