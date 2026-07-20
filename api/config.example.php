<?php
// Copie ce fichier en "config.php" (même dossier) et renseigne tes vraies
// valeurs — voir hPanel > Bases de données MySQL pour le nom de la base et
// de l'utilisateur (ex. "u260924130_kbineplus"), et le mot de passe que tu
// as choisi/généré à la création. "config.php" ne doit JAMAIS être envoyé
// sur GitHub (voir .gitignore) — il contient un mot de passe réel.
define('DB_HOST', 'localhost');
define('DB_NAME', 'u260924130_kbineplus');
define('DB_USER', 'u260924130_kbineplus');
define('DB_PASS', 'REMPLACE-MOI');

// Notifications push (Firebase Cloud Messaging) — chemin vers la clé de
// compte de service Firebase (JSON, téléchargée depuis la console Firebase
// > Paramètres du projet > Comptes de service > "Générer une nouvelle clé
// privée"). Dépose ce fichier directement sur l'hébergement, JAMAIS sur
// GitHub (voir .gitignore) — il donne accès à l'envoi de notifications
// pour tout le projet. Tant que ce fichier n'existe pas, les notifications
// restent uniquement visibles dans l'app (aucune erreur, best-effort, voir
// api/push_common.php).
define('FCM_SERVICE_ACCOUNT_FILE', __DIR__ . '/firebase-service-account.json');
