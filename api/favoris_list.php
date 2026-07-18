<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Liste des numéros favoris du client authentifié — voir DB.favoris
// (js/db.js) et loadFavoris() (js/client.js). 100% privé : jamais lu par
// cabine.js/admin.js, donc réservé au rôle client, filtré sur son propre
// id (jamais un id fourni par le corps de la requête).
$me = requireAuth(['client']);

$stmt = db()->prepare('SELECT * FROM favoris WHERE client_id = ? ORDER BY date_creation DESC');
$stmt->execute([$me['id']]);
echo json_encode(['favoris' => $stmt->fetchAll()]);
