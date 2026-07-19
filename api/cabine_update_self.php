<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Auto-service : la cabine met à jour ses propres réglages (réseaux actifs,
// pause du service, coordonnées) -- remplace DB.users.update() (js/cabine.js),
// qui ne touchait jusqu'ici que le cache LOCAL de l'appareil. Sans ceci :
// le moteur d'attribution des commandes (api/orders_common.php, qui lit
// reseaux_actifs/en_pause directement en base, jamais depuis le cache d'un
// appareil) ignorait totalement ces réglages -- désactiver un réseau ou se
// mettre "en pause" n'empêchait donc jamais réellement de recevoir de
// nouvelles commandes. Toujours le compte AUTHENTIFIÉ lui-même, jamais un
// id fourni par l'appelant.
$me = requireAuth(['cabine']);

$in = body();

if (array_key_exists('telephone', $in) && $in['telephone'] !== '') {
  $dupStmt = db()->prepare('SELECT id FROM profiles WHERE telephone = ? AND role = ? AND id != ?');
  $dupStmt->execute([(string)$in['telephone'], 'cabine', $me['id']]);
  if ($dupStmt->fetch()) fail('Ce numéro est déjà utilisé par un autre compte de ce type.');
}
if (array_key_exists('email', $in) && $in['email'] !== '') {
  $dupStmt = db()->prepare('SELECT id FROM profiles WHERE LOWER(email) = LOWER(?) AND role = ? AND id != ?');
  $dupStmt->execute([(string)$in['email'], 'cabine', $me['id']]);
  if ($dupStmt->fetch()) fail('Cet email est déjà utilisé par un autre compte.');
}

$columns = [];
$params  = [];

foreach (['prenom', 'nom', 'cabine_nom', 'telephone', 'whatsapp', 'email', 'zone'] as $key) {
  if (array_key_exists($key, $in)) { $columns[] = "$key = ?"; $params[] = (string)$in[$key]; }
}

if (array_key_exists('reseaux_actifs', $in)) {
  $columns[] = 'reseaux_actifs = ?';
  $params[] = json_encode($in['reseaux_actifs']);
}

if (array_key_exists('ussd_enabled', $in)) {
  $columns[] = 'ussd_enabled = ?';
  $params[] = json_encode($in['ussd_enabled']);
}

if (array_key_exists('carte_couleur', $in)) {
  $columns[] = 'carte_couleur = ?';
  $params[] = $in['carte_couleur'] === null ? null : (string)$in['carte_couleur'];
}

if (array_key_exists('theme_sombre', $in)) {
  $columns[] = 'theme_sombre = ?';
  $params[] = !empty($in['theme_sombre']) ? 1 : 0;
}

if (array_key_exists('notif_son_actif', $in)) {
  $columns[] = 'notif_son_actif = ?';
  $params[] = !empty($in['notif_son_actif']) ? 1 : 0;
}
if (array_key_exists('notif_son_preset_commande', $in)) {
  $columns[] = 'notif_son_preset_commande = ?';
  $params[] = (string)$in['notif_son_preset_commande'];
}
if (array_key_exists('notif_son_preset_reclamation', $in)) {
  $columns[] = 'notif_son_preset_reclamation = ?';
  $params[] = (string)$in['notif_son_preset_reclamation'];
}

// Pause du service : un seul appel pose/lève la pause ET ses détails
// ensemble (jamais désynchronisés entre eux). pause_raison/pause_note/
// pause_debut valent NULL à la reprise (voir toggleCabPause(), js/cabine.js).
if (array_key_exists('en_pause', $in)) {
  $columns[] = 'en_pause = ?';    $params[] = !empty($in['en_pause']) ? 1 : 0;
  $columns[] = 'pause_raison = ?'; $params[] = isset($in['pause_raison']) ? (string)$in['pause_raison'] : null;
  $columns[] = 'pause_note = ?';   $params[] = isset($in['pause_note']) ? (string)$in['pause_note'] : null;
  // Reçu en ISO 8601 (Date.toISOString(), js/cabine.js) — reformaté pour
  // la colonne DATETIME, MySQL ne comprenant pas nativement le suffixe "Z".
  $columns[] = 'pause_debut = ?';
  $params[] = isset($in['pause_debut']) ? date('Y-m-d H:i:s', strtotime((string)$in['pause_debut'])) : null;
}

if (!$columns) fail('Aucune modification fournie.');

$params[] = $me['id'];
db()->prepare('UPDATE profiles SET ' . implode(', ', $columns) . ' WHERE id = ?')->execute($params);

$stmt = db()->prepare('SELECT * FROM profiles WHERE id = ?');
$stmt->execute([$me['id']]);
$profile = $stmt->fetch();
unset($profile['mot_de_passe_hash']);
echo json_encode(['ok' => true, 'profile' => decodeJsonColumns($profile, ['reseaux_actifs', 'services_actifs', 'ussd_enabled', 'permissions', 'puces', 'docs'])]);
