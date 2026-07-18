<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Liste complète du journal des permissions cabine — lecture seule, voir
// DB.permissionLogs (js/db.js). Réservé à un jeton admin.
requireAuth(['admin']);

$rows = db()->query('SELECT * FROM permission_logs ORDER BY date DESC')->fetchAll();
echo json_encode(['logs' => $rows]);
