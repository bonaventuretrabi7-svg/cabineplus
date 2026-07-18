<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Supprime un numéro favori du client authentifié — voir
// DB.favoris.remove() (js/db.js) et removeFavori() (js/client.js).
// L'appartenance (client_id = ?) est vérifiée dans la clause WHERE elle-même
// plutôt qu'en 2 requêtes séparées : un id valide mais appartenant à un
// autre client ne supprime silencieusement rien (rowCount = 0), jamais une
// erreur qui confirmerait l'existence du favori d'un autre compte.
$me = requireAuth(['client']);

$in = body();
$id = (string)($in['id'] ?? '');
if ($id === '') fail('Identifiant requis.');

db()->prepare('DELETE FROM favoris WHERE id = ? AND client_id = ?')->execute([$id, $me['id']]);
echo json_encode(['ok' => true]);
