<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Suppression d'une notification par son propriétaire — remplace
// DB.notifications.delete() (js/db.js). Portée par utilisateur
// (WHERE utilisateur_id = ?) : impossible de supprimer la notification
// d'un autre compte même en devinant son id.
$me = requireAuth();

$in = body();
$id = (string)($in['id'] ?? '');
if ($id === '') fail('Identifiant de notification requis.');

$stmt = db()->prepare('DELETE FROM notifications WHERE id = ? AND utilisateur_id = ?');
$stmt->execute([$id, $me['id']]);
if ($stmt->rowCount() === 0) fail('Notification introuvable.', 404);

echo json_encode(['ok' => true]);
