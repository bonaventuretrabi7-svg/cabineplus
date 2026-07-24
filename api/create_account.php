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
// Parrainage (client -> client uniquement, voir renderParrainage(),
// js/client.js — le "lien de parrainage" partagé encode le téléphone du
// parrain) : purement optionnel, un identifiant inconnu/absent n'empêche
// jamais la création du compte, juste aucune relation enregistrée.
$parrainTelephone = isset($in['parrain_telephone']) && $in['parrain_telephone'] !== '' ? trim((string)$in['parrain_telephone']) : null;

if (!in_array($role, ['client', 'cabine'], true)) fail('Rôle non autorisé pour une inscription publique.');
if ($telephone === '' || !preg_match('/^\d{4}$/', $pin)) fail('Téléphone et PIN (4 chiffres) requis.');
// Numéro ivoirien valide uniquement (plan de numérotation 2021) — même
// règle que handleAuthGateRegister(), js/client.js.
if (!preg_match('/^(01|05|07)[0-9]{8}$/', $telephone)) fail('Numéro invalide — doit commencer par 01, 05 ou 07 (10 chiffres).');
// Surnom obligatoire côté client (voir handleAuthGateRegister(), js/client.js) —
// affiché ensuite à chaque connexion (showLoginSuccess()/afterLogin()). La
// cabine a son propre parcours d'inscription (prg-*, index.html) qui
// renseigne déjà prenom/nom, donc non concernée par cette contrainte.
if ($role === 'client' && $prenom === '') fail('Le surnom est requis.');
// Lettres seules ou lettres + chiffres, jamais des chiffres seuls (même
// règle que handleAuthGateRegister(), js/client.js) — revalidé ici pour ne
// pas dépendre uniquement du contrôle côté client.
if ($role === 'client' && preg_match('/^[0-9]+$/', $prenom)) fail('Le surnom ne peut pas contenir uniquement des chiffres.');

$pdo = db();
$stmt = $pdo->prepare('SELECT id FROM profiles WHERE telephone = ? AND role = ?');
$stmt->execute([$telephone, $role]);
if ($stmt->fetch()) fail('Ce numéro est déjà utilisé par un autre compte de ce type.');

$id = uuid4();
// abonnement_debut : amorce le délai de 30 jours pour atteindre le quota
// (voir checkQuotaDeadline(), api/orders_common.php) — uniquement pour une
// cabine, sans effet sur un client.
$abonnementDebut = $role === 'cabine' ? date('Y-m-d H:i:s') : null;
$pdo->prepare('INSERT INTO profiles (id, role, nom, prenom, telephone, email, mot_de_passe_hash, cabine_nom, solde, statut, abonnement_debut)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, "actif", ?)')
    ->execute([$id, $role, $nom, $prenom, $telephone, $email, password_hash($pin, PASSWORD_BCRYPT), $cabineNom, $abonnementDebut]);

if ($role === 'client' && $parrainTelephone !== null && $parrainTelephone !== $telephone) {
  $refStmt = $pdo->prepare("SELECT id FROM profiles WHERE role = 'client' AND telephone = ?");
  $refStmt->execute([$parrainTelephone]);
  $referrer = $refStmt->fetch();
  if ($referrer) {
    $pdo->prepare('INSERT INTO referrals (id, referrer_id, referred_id, reward_montant, reward_verse, date) VALUES (?, ?, ?, 25, 0, NOW())')
        ->execute([uuid4(), $referrer['id'], $id]);
  }
}

$stmt = $pdo->prepare('SELECT * FROM profiles WHERE id = ?');
$stmt->execute([$id]);
$profile = $stmt->fetch();
unset($profile['mot_de_passe_hash']);
echo json_encode(['profile' => $profile]);
