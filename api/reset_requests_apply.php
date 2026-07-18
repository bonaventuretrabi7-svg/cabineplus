<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Applique une demande de réinitialisation — remplace adminTraiterReset()
// (js/admin.js). Le hash a déjà été calculé à la création de la demande
// (reset_requests_create.php) : jamais de PIN en clair à aucun moment de
// ce flux.
$me = requireAuth(['admin']);

$in = body();
$id = (string)($in['request_id'] ?? '');
if ($id === '') fail('Identifiant de demande requis.');

$pdo = db();
$pdo->beginTransaction();
try {
  $stmt = $pdo->prepare("SELECT * FROM reset_requests WHERE id = ? AND statut = 'en_attente' FOR UPDATE");
  $stmt->execute([$id]);
  $req = $stmt->fetch();
  if (!$req) {
    $pdo->rollBack();
    fail('Demande introuvable ou déjà traitée.');
  }
  // Une demande liée à un compte admin ne peut être traitée que par le
  // super administrateur (même restriction que la liste, revérifiée ici
  // pour qu'un appel direct par id ne puisse pas la contourner).
  if ($req['role'] === 'admin' && $me['admin_level'] !== 'super') {
    $pdo->rollBack();
    fail('Seul le super administrateur peut traiter une demande liée à un compte administrateur.', 403);
  }

  $pdo->prepare('UPDATE profiles SET mot_de_passe_hash = ? WHERE id = ?')
      ->execute([$req['nouveau_mot_de_passe_hash'], $req['profile_id']]);
  $pdo->prepare("UPDATE reset_requests SET statut = 'traité', date_traitement = NOW(), processed_by = ? WHERE id = ?")
      ->execute([$me['id'], $id]);

  $pdo->commit();
} catch (Throwable $e) {
  if ($pdo->inTransaction()) $pdo->rollBack();
  throw $e;
}

echo json_encode(['ok' => true]);
