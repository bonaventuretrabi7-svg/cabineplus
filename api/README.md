# Déploiement de l'API (PHP + MySQL, hébergement Hostinger)

Remplace le backend Supabase (voir l'historique Git — dossier `supabase/`
retiré). Aucune ligne de commande nécessaire : tout se fait depuis hPanel
(gestionnaire de fichiers + phpMyAdmin).

## 1. Créer la base de données

Déjà fait si tu as suivi les étapes précédentes : hPanel → Bases de données
→ MySQL → base `u260924130_kbineplus` (ou équivalent) créée.

## 2. Créer les tables

hPanel → Bases de données → clique **"Accéder à phpMyAdmin"** sur ta base
→ onglet **SQL** → colle le contenu de `api/schema.sql` → **Exécuter**.

## 3. Déposer les fichiers PHP sur l'hébergement

hPanel → Sites web → ton domaine → **Gestionnaire de fichiers** → ouvre le
dossier `public_html` (racine du site, là où se trouve déjà `index.html`).
Crée-y un dossier **`api`**, et dépose DANS ce dossier tous les fichiers de
`api/` présents dans ce dépôt :

- `bootstrap.php`
- `login.php`
- `logout.php`
- `create_account.php`
- `admin_create_account.php`
- `settings_get.php`
- `settings_update.php`
- `seed_admin.php`
- `config.example.php`
- `.htaccess`

(`schema.sql` et ce `README.md` n'ont pas besoin d'être déposés — ils ne
servent qu'à toi, pas au site.)

## 4. Configurer les identifiants MySQL

Dans le Gestionnaire de fichiers, dans le dossier `api/` que tu viens de
créer sur le serveur : duplique `config.example.php`, renomme la copie en
**`config.php`**, ouvre-la avec l'éditeur de code intégré et renseigne tes
vraies valeurs :

```php
define('DB_HOST', 'localhost');
define('DB_NAME', 'u260924130_kbineplus');   // le nom exact de ta base
define('DB_USER', 'u260924130_kbineplus');   // le nom exact de l'utilisateur
define('DB_PASS', 'TON-VRAI-MOT-DE-PASSE');  // celui choisi/généré à la création
```

Enregistre. **Ce fichier ne doit jamais être envoyé sur GitHub** (déjà
exclu via `.gitignore`) — il contient un mot de passe réel.

## 5. Créer le compte super administrateur

Visite une seule fois, dans ton navigateur : `https://kbineplus.com/api/seed_admin.php`

Tu dois voir `{"ok":true,...}`. Si tu vois `{"ok":false,"message":"Un
super administrateur existe déjà..."}`, c'est que cette étape a déjà été
faite — rien à refaire.

**Ensuite, supprime `seed_admin.php`** du Gestionnaire de fichiers (ce
script n'a plus aucune utilité et ne doit pas rester accessible).

## 6. Vérifier

Visite `https://kbineplus.com/api/settings_get.php` — tu dois voir un JSON
commençant par `{"settings":{...}}`. Si tu vois plutôt un message d'erreur
sur `config.php`, relis l'étape 4.

C'est tout — le site (déjà configuré côté client, voir `js/server-config.js`)
utilise maintenant cette API automatiquement.
