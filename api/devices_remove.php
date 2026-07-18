<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Déconnecte un appareil — remplace deconnecterAppareil() (js/admin.js) et
// le retrait local (js/cabine.js "Mes appareils connectés"), jusqu'ici
// purement cosmétiques : la session du jeton concerné restait valide côté
// serveur malgré le retrait de la liste locale. Supprime désormais aussi
// la ligne `sessions` correspondante (par token_hash) : une vraie
// révocation, le prochain appel de cet appareil échoue avec 401. Un
// compte ne peut révoquer que SES PROPRES appareils, sauf l'admin qui
// peut révoquer n'importe lequel.
$me = requireAuth();

$in = body();
$id = (string)($in['id'] ?? '');
if ($id === '') fail('Identifiant d\'appareil requis.');

$pdo = db();
$devStmt = $pdo->prepare('SELECT * FROM devices WHERE id = ?');
$devStmt->execute([$id]);
$device = $devStmt->fetch();
if (!$device) fail('Appareil introuvable.');
if ($device['profile_id'] !== $me['id'] && $me['role'] !== 'admin') {
  fail('Vous ne pouvez déconnecter que vos propres appareils.', 403);
}

$pdo->prepare('DELETE FROM devices WHERE id = ?')->execute([$id]);
if ($device['token_hash']) {
  $pdo->prepare('DELETE FROM sessions WHERE token_hash = ?')->execute([$device['token_hash']]);
}

echo json_encode(['ok' => true]);
