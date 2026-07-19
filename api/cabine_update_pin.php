<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Changement de code PIN par la cabine elle-même -- remplace
// DB.users.update(currentUser.id, {mot_de_passe}) (js/cabine.js), qui ne
// changeait le code que dans le cache LOCAL de l'appareil : le hash
// serveur restait l'ancien, si bien qu'une connexion depuis un autre
// appareil (ou après effacement des données du navigateur) exigeait
// encore l'ancien code. Le code actuel est revérifié ici côté serveur
// (jamais fait confiance à une vérification locale pour une action de
// sécurité) avant d'accepter le nouveau.
$me = requireAuth(['cabine']);

$in = body();
$currentPin = (string)($in['current_pin'] ?? '');
$newPin     = (string)($in['new_pin'] ?? '');

if (!password_verify($currentPin, $me['mot_de_passe_hash'])) fail('Code PIN actuel incorrect.');
if (!preg_match('/^\d{4}$/', $newPin)) fail('Le nouveau code doit contenir exactement 4 chiffres.');

db()->prepare('UPDATE profiles SET mot_de_passe_hash = ? WHERE id = ?')
    ->execute([password_hash($newPin, PASSWORD_BCRYPT), $me['id']]);

echo json_encode(['ok' => true]);
