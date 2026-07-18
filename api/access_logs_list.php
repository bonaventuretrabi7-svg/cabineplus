<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Liste complète du journal des accès admin — lecture seule (voir
// loadAccessLogs(), js/admin.js). Réservé à un jeton admin, tous les
// administrateurs voient le même journal quel que soit l'appareil.
requireAuth(['admin']);

$rows = db()->query('SELECT * FROM access_logs ORDER BY date DESC')->fetchAll();
echo json_encode(['logs' => $rows]);
