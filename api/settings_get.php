<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Lecture des réglages globaux — remplace .from('settings').select() côté
// Supabase (voir DB.settings.get()/._refresh() dans js/db.js). Lecture
// publique (aucun jeton requis), comme la policy settings_select
// Supabase d'origine (using (true)).

$stmt = db()->query('SELECT * FROM settings WHERE id = 1');
$row = $stmt->fetch();
if (!$row) fail('Réglages introuvables.', 500);

$row = decodeJsonColumns($row, ['maintenance', 'assistance', 'assistant_cabine', 'assistant_client', 'ussd_templates', 'admin_schedules', 'actualites']);
echo json_encode(['settings' => $row]);
