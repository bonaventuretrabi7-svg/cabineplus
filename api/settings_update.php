<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Mise à jour des réglages globaux — remplace .from('settings').update()
// côté Supabase (voir SYNC_HANDLERS.settings dans js/db.js). Réservée à un
// jeton admin valide (équivalent de la policy settings_update Supabase,
// using (current_profile_role() = 'admin')). N'écrase que les colonnes
// présentes dans le corps de la requête (déjà mappées en snake_case côté
// js/db.js via SETTINGS_COLUMNS avant l'appel) — jamais un remplacement
// intégral du blob.
requireAdminToken();

$in = body();
$columns = [
  'platform_name' => 's', 'currency' => 's', 'commission_rate' => 'n',
  'min_transfer' => 'n', 'max_transfer' => 'n', 'recharge_min' => 'n',
  'maintenance' => 'j', 'assistance' => 'j', 'assistant_cabine' => 'j',
  'assistant_client' => 'j', 'ussd_templates' => 'j', 'admin_schedules' => 'j',
];

$sets = [];
$params = [];
foreach ($columns as $col => $type) {
  if (array_key_exists($col, $in)) {
    $sets[] = "$col = ?";
    $params[] = $type === 'j' ? json_encode($in[$col]) : $in[$col];
  }
}
if (!$sets) fail('Aucune modification fournie.');

$params[] = 1;
db()->prepare('UPDATE settings SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($params);

$stmt = db()->query('SELECT * FROM settings WHERE id = 1');
$row = decodeJsonColumns($stmt->fetch(), ['maintenance', 'assistance', 'assistant_cabine', 'assistant_client', 'ussd_templates', 'admin_schedules']);
echo json_encode(['settings' => $row]);
