<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Préférences de son de notification de l'administrateur connecté (actif
// + mélodie par catégorie) -- remplace le stockage 100% local
// (localStorage) de AdminSound (js/admin.js). Contrairement à
// api/admin_update_profile.php (réservé au super admin, pour modifier
// N'IMPORTE QUEL compte admin), cet endpoint est en libre-service : tout
// admin (simple ou super) peut régler SA PROPRE préférence, comme
// api/cabine_update_self.php côté cabine.
$me = requireAuth(['admin']);

$in = body();
$columns = [];
$params  = [];

if (array_key_exists('notif_son_actif', $in)) {
  $columns[] = 'notif_son_actif = ?';
  $params[] = !empty($in['notif_son_actif']) ? 1 : 0;
}
if (array_key_exists('notif_son_preset_commande', $in)) {
  $columns[] = 'notif_son_preset_commande = ?';
  $params[] = (string)$in['notif_son_preset_commande'];
}
if (array_key_exists('notif_son_preset_reclamation', $in)) {
  $columns[] = 'notif_son_preset_reclamation = ?';
  $params[] = (string)$in['notif_son_preset_reclamation'];
}
if (!$columns) fail('Aucune modification fournie.');

$params[] = $me['id'];
db()->prepare('UPDATE profiles SET ' . implode(', ', $columns) . ' WHERE id = ?')->execute($params);

echo json_encode(['ok' => true]);
