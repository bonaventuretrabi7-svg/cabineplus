<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Vérifie qu'un numéro correspond à un compte CLIENT existant — appelé
// AVANT de demander le code PIN (voir agLoginGoStep(), js/client.js),
// pour ne montrer l'étape PIN que si le numéro est reconnu (même schéma
// que l'écran de connexion partenaire, voir prtGoStep()/DB.users.byEmail
// côté cabine/admin). Public (aucune authentification : l'utilisateur
// n'est justement pas encore connecté à ce stade) — ne renvoie que
// prénom/nom pour l'affichage "Bonjour, {prénom}", jamais le solde, le
// statut détaillé ni bien sûr le hash du PIN. Le statut du compte
// (bloqué/suspendu/inactif) reste vérifié uniquement à la vraie tentative
// de connexion (api/login.php), pas ici.
$in = body();
$phone = trim((string)($in['telephone'] ?? ''));
if (!preg_match('/^[0-9]{10}$/', $phone)) fail('Numéro invalide.');

$stmt = db()->prepare("SELECT prenom, nom FROM profiles WHERE role = 'client' AND telephone = ?");
$stmt->execute([$phone]);
$row = $stmt->fetch();

echo json_encode(['ok' => true, 'found' => (bool)$row, 'prenom' => $row['prenom'] ?? null, 'nom' => $row['nom'] ?? null]);
