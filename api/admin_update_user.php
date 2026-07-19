<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Modifie un compte client/cabine (coordonnées + solde) -- remplace
// saveUserEdits() (js/admin.js), qui ne mettait jusqu'ici à jour que le
// cache LOCAL de l'admin qui cliquait (DB.users.update()/updateSolde()) :
// aucune de ces informations, y compris un changement de solde, n'atteignait
// jamais le serveur -- un autre appareil (ou l'admin lui-même après
// rechargement de page) ne voyait jamais la modification. Même patron que
// api/admin_update_profile.php (réservé aux comptes admin), mais pour
// client/cabine.
$me = requireAuth(['admin']);

$in = body();
$targetId = (string)($in['id'] ?? '');
if ($targetId === '') fail('Identifiant de compte requis.');

$pdo = db();
$pdo->beginTransaction();
try {
  $stmt = $pdo->prepare('SELECT * FROM profiles WHERE id = ? FOR UPDATE');
  $stmt->execute([$targetId]);
  $target = $stmt->fetch();
  if (!$target || !in_array($target['role'], ['client', 'cabine'], true)) {
    $pdo->rollBack();
    fail('Compte introuvable.', 404);
  }

  if (array_key_exists('telephone', $in) && $in['telephone'] !== '') {
    $dupStmt = $pdo->prepare('SELECT id FROM profiles WHERE telephone = ? AND role = ? AND id != ?');
    $dupStmt->execute([(string)$in['telephone'], $target['role'], $targetId]);
    if ($dupStmt->fetch()) {
      $pdo->rollBack();
      fail('Ce numéro est déjà utilisé par un autre compte de ce type.');
    }
  }

  $columns = [];
  $params  = [];
  foreach (['prenom', 'nom', 'telephone', 'email'] as $key) {
    if (array_key_exists($key, $in)) { $columns[] = "$key = ?"; $params[] = (string)$in[$key]; }
  }
  if ($target['role'] === 'cabine' && array_key_exists('limite_commandes', $in)) {
    $columns[] = 'limite_commandes = ?';
    $params[]  = ($in['limite_commandes'] === null || $in['limite_commandes'] === '') ? null : (int)$in['limite_commandes'];
  }
  if ($columns) {
    $params[] = $targetId;
    $pdo->prepare('UPDATE profiles SET ' . implode(', ', $columns) . ' WHERE id = ?')->execute($params);
  }

  // Solde fixé à la valeur exacte saisie par l'admin (pas un delta) --
  // sûr ici grâce au verrou FOR UPDATE ci-dessus, aucune autre transaction
  // ne peut modifier ce solde entre la lecture et cette écriture.
  if (array_key_exists('nouveau_solde', $in)) {
    $nouveauSolde = (int)$in['nouveau_solde'];
    if ($nouveauSolde < 0) { $pdo->rollBack(); fail('Solde invalide.'); }
    $pdo->prepare('UPDATE profiles SET solde = ? WHERE id = ?')->execute([$nouveauSolde, $targetId]);
  }

  $pdo->commit();
} catch (Throwable $e) {
  if ($pdo->inTransaction()) $pdo->rollBack();
  throw $e;
}

$stmt = $pdo->prepare('SELECT * FROM profiles WHERE id = ?');
$stmt->execute([$targetId]);
$profile = $stmt->fetch();
unset($profile['mot_de_passe_hash']);
echo json_encode(['ok' => true, 'profile' => $profile]);
