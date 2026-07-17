<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Auto-inscription client/cabine — remplace create_account() (Supabase,
// voir supabase/migrations/0002_auth.sql, accordée à anon). Utilisée par
// handleAuthGateRegister() dans js/client.js. Aucune authentification
// requise : c'est le point d'entrée public de création de compte.

$in = body();
$role      = (string)($in['role'] ?? '');
$nom       = trim((string)($in['nom'] ?? ''));
$prenom    = trim((string)($in['prenom'] ?? ''));
$telephone = trim((string)($in['telephone'] ?? ''));
$pin       = (string)($in['pin'] ?? '');
$email     = isset($in['email']) && $in['email'] !== '' ? trim((string)$in['email']) : null;
$cabineNom = isset($in['cabine_nom']) && $in['cabine_nom'] !== '' ? trim((string)$in['cabine_nom']) : null;

if (!in_array($role, ['client', 'cabine'], true)) fail('Rôle non autorisé pour une inscription publique.');
if ($telephone === '' || !preg_match('/^\d{4}$/', $pin)) fail('Téléphone et PIN (4 chiffres) requis.');

$pdo = db();
$stmt = $pdo->prepare('SELECT id FROM profiles WHERE telephone = ? AND role = ?');
$stmt->execute([$telephone, $role]);
if ($stmt->fetch()) fail('Ce numéro est déjà utilisé par un autre compte de ce type.');

$id = uuid4();
$pdo->prepare('INSERT INTO profiles (id, role, nom, prenom, telephone, email, mot_de_passe_hash, cabine_nom, solde, statut)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, "actif")')
    ->execute([$id, $role, $nom, $prenom, $telephone, $email, password_hash($pin, PASSWORD_BCRYPT), $cabineNom]);

$stmt = $pdo->prepare('SELECT * FROM profiles WHERE id = ?');
$stmt->execute([$id]);
$profile = $stmt->fetch();
unset($profile['mot_de_passe_hash']);
echo json_encode(['profile' => $profile]);
