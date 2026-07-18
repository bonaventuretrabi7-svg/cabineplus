<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Liste des profils actuellement "en ligne" (tous rôles) — voir
// DB.presence.refresh() (js/db.js), qui applique elle-même le seuil de
// fraîcheur (STALE_MS) après réception, comme pour la présence locale par
// onglet déjà en place. UNIX_TIMESTAMP() renvoie un epoch en secondes plutôt
// que la chaîne DATETIME brute, pour éviter toute ambiguïté de fuseau/format
// au moment du parsing côté JS (`new Date('YYYY-MM-DD HH:MM:SS')` n'est pas
// fiable de façon portable entre navigateurs).
requireAuth();

$rows = db()->query('SELECT profile_id, UNIX_TIMESTAMP(last_seen_at) AS ts FROM presence')->fetchAll();
echo json_encode(['presence' => $rows]);
