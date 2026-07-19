<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Création de compte PAR L'ADMINISTRATION (cabine approuvée, admin simple
// ajouté par le super admin — voir finishCreateUser()/validatePartnerRequest()
// dans js/admin.js). Remplace admin_create_account() (Supabase, voir
// supabase/migrations/0006_admin_create_account.sql). Réservée à un jeton
// admin valide (voir requireAdminToken() dans bootstrap.php) — autorise en
// plus le rôle 'admin', jamais permis en auto-inscription (create_account.php).
requireAdminToken();

$in         = body();
$role       = (string)($in['role'] ?? '');
$nom        = trim((string)($in['nom'] ?? ''));
$prenom     = trim((string)($in['prenom'] ?? ''));
$telephone  = isset($in['telephone']) && $in['telephone'] !== '' ? trim((string)$in['telephone']) : null;
$pin        = (string)($in['pin'] ?? '');
$email      = isset($in['email']) && $in['email'] !== '' ? trim((string)$in['email']) : null;
$cabineNom  = isset($in['cabine_nom']) && $in['cabine_nom'] !== '' ? trim((string)$in['cabine_nom']) : null;
$adminLevel = isset($in['admin_level']) && $in['admin_level'] !== '' ? trim((string)$in['admin_level']) : null;
// Champs de profil administrateur (voir handleCreateUser()/finishCreateUser()
// dans js/admin.js) : collectés depuis le tout début du formulaire mais
// jamais transmis au serveur jusqu'ici -- un "Assistant clientèle" créé par
// le super admin se retrouvait donc sans permissions ni poste dès sa
// première connexion sur son propre appareil (rien à y synchroniser).
$permissions   = array_key_exists('permissions', $in) ? json_encode($in['permissions']) : null;
$whatsapp      = isset($in['whatsapp']) && $in['whatsapp'] !== '' ? trim((string)$in['whatsapp']) : null;
$photo         = isset($in['photo']) && $in['photo'] !== '' ? (string)$in['photo'] : null;
$poste         = isset($in['poste']) && $in['poste'] !== '' ? trim((string)$in['poste']) : null;
$pays          = isset($in['pays']) && $in['pays'] !== '' ? trim((string)$in['pays']) : null;
$ville         = isset($in['ville']) && $in['ville'] !== '' ? trim((string)$in['ville']) : null;
$quartier      = isset($in['quartier']) && $in['quartier'] !== '' ? trim((string)$in['quartier']) : null;
$dateNaissance = isset($in['date_naissance']) && $in['date_naissance'] !== '' ? (string)$in['date_naissance'] : null;
$docs          = array_key_exists('docs', $in) ? json_encode($in['docs']) : null;

if (!in_array($role, ['client', 'cabine', 'admin'], true)) fail('Rôle invalide.');
if (!preg_match('/^\d{4}$/', $pin)) fail('PIN (4 chiffres) requis.');

$pdo = db();
if ($telephone !== null) {
  $stmt = $pdo->prepare('SELECT id FROM profiles WHERE telephone = ? AND role = ?');
  $stmt->execute([$telephone, $role]);
  if ($stmt->fetch()) fail('Ce numéro est déjà utilisé par un autre compte de ce type.');
}
if ($email !== null) {
  $stmt = $pdo->prepare('SELECT id FROM profiles WHERE LOWER(email) = LOWER(?) AND role = ?');
  $stmt->execute([$email, $role]);
  if ($stmt->fetch()) fail('Cet email est déjà utilisé par un autre compte.');
}

$id = uuid4();
// abonnement_debut : amorce le délai de 30 jours pour atteindre le quota
// (voir checkQuotaDeadline(), api/orders_common.php) — uniquement pour une
// cabine, sans effet sur client/admin.
$abonnementDebut = $role === 'cabine' ? date('Y-m-d H:i:s') : null;
$pdo->prepare('INSERT INTO profiles
      (id, role, nom, prenom, telephone, email, mot_de_passe_hash, cabine_nom, admin_level, solde, statut,
       permissions, whatsapp, photo, poste, pays, ville, quartier, date_naissance, docs, abonnement_debut)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, "actif", ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    ->execute([$id, $role, $nom, $prenom, $telephone, $email, password_hash($pin, PASSWORD_BCRYPT), $cabineNom, $adminLevel,
               $permissions, $whatsapp, $photo, $poste, $pays, $ville, $quartier, $dateNaissance, $docs, $abonnementDebut]);

$stmt = $pdo->prepare('SELECT * FROM profiles WHERE id = ?');
$stmt->execute([$id]);
$profile = $stmt->fetch();
unset($profile['mot_de_passe_hash']);
echo json_encode(['profile' => $profile]);
