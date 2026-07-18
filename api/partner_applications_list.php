<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Liste des candidatures partenaires — réservée à l'administration. Le
// hash du PIN choisi n'est jamais renvoyé.
requireAuth(['admin']);

$rows = db()->query('SELECT * FROM partner_applications ORDER BY date_created DESC')->fetchAll();
foreach ($rows as &$r) {
  unset($r['mot_de_passe_hash']);
  if (isset($r['puces'])) $r['puces'] = json_decode((string)$r['puces'], true);
}
unset($r);

echo json_encode(['applications' => $rows]);
