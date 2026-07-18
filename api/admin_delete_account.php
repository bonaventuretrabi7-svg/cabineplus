<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Supprime définitivement un compte et TOUTES ses données liées — remplace
// deleteUser() (js/admin.js), qui ne supprimait jusqu'ici que le cache
// LOCAL de l'admin qui cliquait (DB.users.delete()) : le compte
// réapparaissait au prochain rafraîchissement (refreshUsersFromServer()),
// aucune suppression n'avait jamais réellement lieu côté serveur.
// Réservé au SUPER administrateur (action la plus destructrice de toute
// l'app, irréversible). Un compte ne peut jamais se supprimer lui-même,
// ni supprimer LE super administrateur (éviterait un verrouillage total
// s'il n'y en a qu'un).
$me = requireAuth(['admin']);
if ($me['admin_level'] !== 'super') fail('Seul le super administrateur peut supprimer un compte.', 403);

$in = body();
$targetId = (string)($in['id'] ?? '');
if ($targetId === '') fail('Identifiant de compte requis.');
if ($targetId === $me['id']) fail('Vous ne pouvez pas supprimer votre propre compte.');

$pdo = db();
$targetStmt = $pdo->prepare('SELECT * FROM profiles WHERE id = ?');
$targetStmt->execute([$targetId]);
$target = $targetStmt->fetch();
if (!$target) fail('Compte introuvable.', 404);
if ($target['role'] === 'admin' && $target['admin_level'] === 'super') {
  fail('Le compte super administrateur ne peut jamais être supprimé.', 403);
}

$pdo->beginTransaction();
try {
  // Réclamations liées (comme client OU comme cabine) — messages d'abord.
  $reclaStmt = $pdo->prepare('SELECT id FROM reclamations WHERE client_id = ? OR cabine_id = ?');
  $reclaStmt->execute([$targetId, $targetId]);
  $reclaIds = array_column($reclaStmt->fetchAll(), 'id');
  if ($reclaIds) {
    $placeholders = implode(',', array_fill(0, count($reclaIds), '?'));
    $pdo->prepare("DELETE FROM reclamation_messages WHERE reclamation_id IN ($placeholders)")->execute($reclaIds);
  }
  $pdo->prepare('DELETE FROM refund_requests WHERE client_id = ? OR cabine_id = ?')->execute([$targetId, $targetId]);
  $pdo->prepare('DELETE FROM reclamations WHERE client_id = ? OR cabine_id = ?')->execute([$targetId, $targetId]);

  $pdo->prepare('DELETE FROM transactions WHERE client_id = ? OR cabine_id = ?')->execute([$targetId, $targetId]);
  $pdo->prepare('DELETE FROM retraits WHERE cabine_id = ?')->execute([$targetId]);
  $pdo->prepare('DELETE FROM retards WHERE cabine_id = ?')->execute([$targetId]);
  $pdo->prepare('DELETE FROM cabine_refusals WHERE cabine_id = ?')->execute([$targetId]);
  $pdo->prepare('DELETE FROM transferts_cabine WHERE from_cabine_id = ? OR to_cabine_id = ?')->execute([$targetId, $targetId]);
  $pdo->prepare('DELETE FROM resubscriptions WHERE cabine_id = ?')->execute([$targetId]);
  $pdo->prepare('DELETE FROM suspension_logs WHERE cabine_id = ?')->execute([$targetId]);
  $pdo->prepare('DELETE FROM favoris WHERE client_id = ?')->execute([$targetId]);
  $pdo->prepare('DELETE FROM notifications WHERE utilisateur_id = ?')->execute([$targetId]);
  $pdo->prepare('DELETE FROM sessions WHERE profile_id = ?')->execute([$targetId]);
  $pdo->prepare('DELETE FROM devices WHERE profile_id = ?')->execute([$targetId]);
  $pdo->prepare('DELETE FROM presence WHERE profile_id = ?')->execute([$targetId]);
  $pdo->prepare('DELETE FROM reset_requests WHERE profile_id = ?')->execute([$targetId]);
  $pdo->prepare('DELETE FROM referrals WHERE referrer_id = ? OR referred_id = ?')->execute([$targetId, $targetId]);
  $pdo->prepare('DELETE FROM access_logs WHERE admin_id = ? OR target_user_id = ?')->execute([$targetId, $targetId]);
  $pdo->prepare('DELETE FROM permission_logs WHERE admin_id = ? OR cabine_id = ?')->execute([$targetId, $targetId]);
  $pdo->prepare('DELETE FROM maintenance_logs WHERE admin_id = ?')->execute([$targetId]);
  // processed_by (nullable) : réfère un admin qui a traité la demande d'un
  // TIERS — la demande elle-même n'appartient pas forcément à ce compte,
  // ne jamais la supprimer, seulement oublier qui l'a traitée.
  $pdo->prepare('UPDATE refund_requests SET processed_by = NULL WHERE processed_by = ?')->execute([$targetId]);
  $pdo->prepare('UPDATE reset_requests SET processed_by = NULL WHERE processed_by = ?')->execute([$targetId]);
  $pdo->prepare('UPDATE partner_applications SET processed_by = NULL WHERE processed_by = ?')->execute([$targetId]);

  $pdo->prepare('DELETE FROM profiles WHERE id = ?')->execute([$targetId]);

  $pdo->commit();
} catch (Throwable $e) {
  if ($pdo->inTransaction()) $pdo->rollBack();
  throw $e;
}

echo json_encode(['ok' => true]);
