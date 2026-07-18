<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Liste complète du journal de maintenance — lecture seule, voir
// DB.maintenanceLogs (js/db.js). Réservé à un jeton admin.
requireAuth(['admin']);

$rows = db()->query('SELECT * FROM maintenance_logs ORDER BY date DESC')->fetchAll();
echo json_encode(['logs' => $rows]);
