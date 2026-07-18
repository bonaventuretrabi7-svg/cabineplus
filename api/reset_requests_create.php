<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Dépôt d'une demande de réinitialisation de mot de passe — remplace
// submitResetRequest() (js/client.js), 100% locale jusqu'ici (jamais vue
// par l'administration sur un autre appareil). Public (aucune
// authentification) : un compte verrouillé ne peut par définition pas
// s'authentifier pour faire cette demande — même point d'entrée public
// que create_account.php. Le nouveau PIN est haché IMMÉDIATEMENT (jamais
// stocké en clair, contrairement à l'ancienne version locale) : l'admin
// ne voit jamais le code choisi, seulement de quoi l'appliquer.
$in = body();
$role        = (string)($in['role'] ?? '');
$identifiant = trim((string)($in['identifiant'] ?? ''));
$pin         = (string)($in['nouveau_mot_de_passe'] ?? '');

if (!in_array($role, ['client', 'cabine', 'admin'], true)) fail('Rôle invalide.');
if ($identifiant === '') fail('Identifiant requis.');
if (!preg_match('/^\d{4}$/', $pin)) fail('Le nouveau code doit contenir exactement 4 chiffres.');

$pdo = db();
$stmt = $role === 'client'
  ? $pdo->prepare('SELECT * FROM profiles WHERE role = ? AND telephone = ?')
  : $pdo->prepare('SELECT * FROM profiles WHERE role = ? AND LOWER(email) = LOWER(?)');
$stmt->execute([$role, $identifiant]);
$user = $stmt->fetch();
if (!$user) fail('Aucun compte trouvé.');
if ($user['role'] === 'admin' && $user['admin_level'] === 'super') fail('Contactez directement le support pour ce type de compte.');

$dupStmt = $pdo->prepare("SELECT id FROM reset_requests WHERE profile_id = ? AND statut = 'en_attente'");
$dupStmt->execute([$user['id']]);
if ($dupStmt->fetch()) fail('Une demande est déjà en cours pour ce compte.');

$id = uuid4();
$nom = trim(($user['prenom'] ?? '') . ' ' . ($user['nom'] ?? ''));
$pdo->prepare('INSERT INTO reset_requests (id, profile_id, role, telephone, nom, nouveau_mot_de_passe_hash, statut, date_created)
    VALUES (?, ?, ?, ?, ?, ?, \'en_attente\', NOW())')
    ->execute([$id, $user['id'], $user['role'], $user['telephone'], $nom, password_hash($pin, PASSWORD_BCRYPT)]);

echo json_encode(['ok' => true]);
