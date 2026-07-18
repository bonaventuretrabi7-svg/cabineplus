<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Refuse une demande de réinitialisation — remplace refuseReset()
// (js/admin.js).
$me = requireAuth(['admin']);

$in = body();
$id = (string)($in['request_id'] ?? '');
if ($id === '') fail('Identifiant de demande requis.');

$pdo = db();
$checkStmt = $pdo->prepare('SELECT role FROM reset_requests WHERE id = ?');
$checkStmt->execute([$id]);
$req = $checkStmt->fetch();
if (!$req) fail('Demande introuvable.');
if ($req['role'] === 'admin' && $me['admin_level'] !== 'super') {
  fail('Seul le super administrateur peut traiter une demande liée à un compte administrateur.', 403);
}

$stmt = $pdo->prepare("UPDATE reset_requests SET statut = 'refusé', date_traitement = NOW() WHERE id = ? AND statut = 'en_attente'");
$stmt->execute([$id]);
if ($stmt->rowCount() === 0) fail('Demande introuvable ou déjà traitée.');

echo json_encode(['ok' => true]);
