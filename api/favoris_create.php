<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Ajoute un numéro favori pour le client authentifié — voir
// DB.favoris.create() (js/db.js) et addFavori() (js/client.js).
$me = requireAuth(['client']);

$in     = body();
$nom    = trim((string)($in['nom'] ?? ''));
$numero = trim((string)($in['numero'] ?? ''));
if ($numero === '') fail('Numéro requis.');

$id = uuid4();
db()->prepare('INSERT INTO favoris (id, client_id, nom, numero, date_creation) VALUES (?, ?, ?, ?, NOW())')
    ->execute([$id, $me['id'], $nom, $numero]);

$stmt = db()->prepare('SELECT * FROM favoris WHERE id = ?');
$stmt->execute([$id]);
echo json_encode(['favori' => $stmt->fetch()]);
