<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Liste des demandes de remboursement — lecture seule, voir
// DB.refundRequests (js/db.js). Réservée à l'administration (onglet dédié).
requireAuth(['admin']);

$rows = db()->query('SELECT * FROM refund_requests ORDER BY date_created DESC')->fetchAll();
echo json_encode(['refundRequests' => $rows]);
