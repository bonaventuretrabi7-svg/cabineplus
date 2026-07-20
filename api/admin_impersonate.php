<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Émet un vrai jeton de session au nom du compte visité (client/cabine/
// administrateur simple) pour l'accès direct admin sans mot de passe (voir
// Auth.startImpersonation(), js/auth.js) — remplace l'ancien comportement
// qui gardait le jeton de l'ADMIN pendant toute l'impersonation : les
// endpoints réservés par rôle (ex. requireAuth(['cabine']) dans
// cabine_update_self.php) échouaient alors avec "Accès refusé pour ce
// rôle", même si l'écran affichait correctement le profil de la cible —
// seul currentUser (local) changeait, jamais le jeton serveur réellement
// utilisé pour les requêtes suivantes.
$me = requireAuth(['admin']);

$in = body();
$targetId = (string)($in['target_id'] ?? '');
if ($targetId === '') fail('Identifiant de compte requis.');

$pdo = db();
$stmt = $pdo->prepare('SELECT * FROM profiles WHERE id = ?');
$stmt->execute([$targetId]);
$target = $stmt->fetch();
if (!$target) fail('Compte introuvable.', 404);

if (!in_array($target['role'], ['client', 'cabine', 'admin'], true)) fail('Compte cible invalide.');

// Mêmes règles que la vérification côté client jusqu'ici (Auth.startImpersonation()) :
// accès direct vers un autre administrateur réservé au super admin, jamais
// super → super.
if ($target['role'] === 'admin') {
  if ($me['admin_level'] !== 'super') fail("Seul le super administrateur peut accéder à l'espace d'un autre administrateur.", 403);
  if ($target['admin_level'] === 'super') fail('Accès direct impossible vers un autre super administrateur.', 403);
}

$sessionToken = bin2hex(random_bytes(32));
$pdo->prepare('INSERT INTO sessions (token_hash, profile_id, role, expires_at) VALUES (?, ?, ?, ?)')
    ->execute([hash('sha256', $sessionToken), $target['id'], $target['role'], date('Y-m-d H:i:s', time() + 2592000)]);

unset($target['mot_de_passe_hash']);
echo json_encode(['profile' => $target, 'token' => $sessionToken]);
