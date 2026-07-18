<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Dépôt d'une candidature partenaire — remplace Applications.create()
// (js/client.js, prgSubmit()), 100% locale jusqu'ici (jamais vue par
// l'administration à moins d'utiliser le même navigateur). Public (aucune
// authentification) : un futur partenaire n'a pas encore de compte, même
// point d'entrée public que create_account.php. Le PIN choisi est haché
// IMMÉDIATEMENT (jamais stocké en clair) — voir
// partner_applications_validate.php, qui crée le compte cabine directement
// avec ce hash, sans jamais repasser par un PIN en clair.
$in = body();
$prenom     = trim((string)($in['prenom'] ?? ''));
$nom        = trim((string)($in['nom'] ?? ''));
$email      = trim((string)($in['email'] ?? ''));
$telephone  = trim((string)($in['telephone'] ?? ''));
$whatsapp   = trim((string)($in['whatsapp'] ?? ''));
$cabineNom  = trim((string)($in['cabine_nom'] ?? ''));
$pin        = (string)($in['pin'] ?? '');
$photo      = (string)($in['photo'] ?? '');
$codeQr     = (string)($in['code_qr'] ?? '');
$motivation = trim((string)($in['motivation'] ?? ''));
$abonnement = (string)($in['abonnement'] ?? '');
$paiementAbo  = (string)($in['paiement_abo'] ?? '');
$paiementVers = (string)($in['paiement_vers'] ?? '');
$numeroCompte = trim((string)($in['numero_compte'] ?? ''));
$experience   = (string)($in['experience'] ?? '');
$puces        = isset($in['puces']) ? json_encode($in['puces']) : null;

if ($prenom === '' || $nom === '' || $telephone === '') fail('Prénom, nom et téléphone requis.');
if (!preg_match('/^\d{4}$/', $pin)) fail('Le code PIN doit contenir exactement 4 chiffres.');
if (!preg_match('/^[^\s@]+@gmail\.com$/i', $email)) fail('Adresse Gmail invalide (ex : nom@gmail.com).');

$id = uuid4();
db()->prepare('INSERT INTO partner_applications
    (id, prenom, nom, email, telephone, whatsapp, cabine_nom, mot_de_passe_hash, photo, code_qr,
     motivation, abonnement, paiement_abo, paiement_vers, numero_compte, experience, puces, statut, date_created)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'en_attente\', NOW())')
    ->execute([$id, $prenom, $nom, $email, $telephone, $whatsapp, $cabineNom, password_hash($pin, PASSWORD_BCRYPT),
        $photo ?: null, $codeQr ?: null, $motivation, $abonnement ?: null, $paiementAbo ?: null,
        $paiementVers ?: null, $numeroCompte, $experience ?: null, $puces]);

echo json_encode(['ok' => true]);
