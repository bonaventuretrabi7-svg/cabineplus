<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Vérification identifiant + PIN — remplace verify_login()/find_profile_
// for_login()/register_failed_login()/reset_login_attempts() (Supabase,
// voir supabase/migrations/0002_auth.sql et 0005_login_attempts.sql) ainsi
// que supabase/functions/login. Pas de "faux compte Supabase Auth" ici :
// un jeton opaque (table `sessions`) suffit, généré directement à chaque
// connexion réussie.

$in = body();
$identifiant = trim((string)($in['identifiant'] ?? ''));
$pin          = (string)($in['pin'] ?? '');
$role         = (string)($in['role'] ?? '');
// Mode silencieux : établit un jeton en arrière-plan pour un appareil déjà
// connecté avec succès en LOCAL (voir Auth.login(), js/auth.js) — jamais
// atteint pour un compte réellement bloqué (déjà vérifié en local avant cet
// appel). Aucun effet sur le compteur de tentatives en cas d'échec : un
// échec ici (ex. mot de passe changé ailleurs depuis) ne doit jamais faire
// progresser vers un blocage.
$silent = !empty($in['silent']);

if ($identifiant === '' || $pin === '' || !in_array($role, ['client', 'cabine', 'admin'], true)) {
  fail('Identifiant, PIN et rôle requis.');
}

$pdo = db();
$stmt = $role === 'client'
  ? $pdo->prepare('SELECT * FROM profiles WHERE role = ? AND telephone = ?')
  : $pdo->prepare('SELECT * FROM profiles WHERE role = ? AND LOWER(email) = LOWER(?)');
$stmt->execute([$role, $identifiant]);
$profile = $stmt->fetch();

if (!$profile) fail('Compte introuvable.', 401);

// Statut vérifié avant même la comparaison du PIN : un compte bloqué ne
// doit plus jamais réévaluer une tentative.
if (!$silent && $profile['statut'] === 'bloqué') {
  fail("Compte bloqué après 3 tentatives incorrectes. Contactez l'administration pour le débloquer.", 403);
}

if (!password_verify($pin, $profile['mot_de_passe_hash'])) {
  if ($silent) fail('Session non établie.', 401);
  $attempts = (int)$profile['tentatives_echouees'] + 1;
  // Le super admin n'est jamais bloqué (seul compte admin possible, aucune
  // auto-inscription admin — un blocage définitif rendrait le panneau
  // admin à jamais inaccessible).
  $blocked = $attempts >= 3 && $profile['admin_level'] !== 'super';
  $pdo->prepare('UPDATE profiles SET tentatives_echouees = ?, statut = ? WHERE id = ?')
      ->execute([$attempts, $blocked ? 'bloqué' : $profile['statut'], $profile['id']]);
  fail($blocked
    ? "Compte bloqué après 3 tentatives incorrectes. Contactez l'administration pour le débloquer."
    : 'Identifiant ou PIN incorrect.', 401);
}

if (!$silent && (int)$profile['tentatives_echouees'] !== 0) {
  $pdo->prepare('UPDATE profiles SET tentatives_echouees = 0 WHERE id = ?')->execute([$profile['id']]);
  $profile['tentatives_echouees'] = 0;
}

$token = bin2hex(random_bytes(32));
$pdo->prepare('INSERT INTO sessions (token_hash, profile_id, role, expires_at) VALUES (?, ?, ?, ?)')
    ->execute([hash('sha256', $token), $profile['id'], $profile['role'], date('Y-m-d H:i:s', time() + 2592000)]);

unset($profile['mot_de_passe_hash']);
echo json_encode(['profile' => $profile, 'token' => $token]);
