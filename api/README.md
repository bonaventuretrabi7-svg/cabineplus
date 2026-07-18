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

**Base déjà en place (mise à jour Phase 2) :** `schema.sql` a été complété
avec de nouvelles tables (transactions, notifications, favoris,
réclamations...) et de nouvelles colonnes sur `profiles` — le recoller en
entier échouerait (`ALTER TABLE` déjà appliqué manque, colonnes déjà
présentes). Colle plutôt le contenu de
**`api/migration_phase2_1_foundations.sql`** (à n'exécuter qu'une seule
fois) dans le même onglet SQL.

**Base déjà en place (mise à jour Phase 6) :** colle aussi le contenu de
**`api/migration_phase6_forfaits_commissions.sql`** (une seule fois) —
colonnes manquantes sur `forfaits`/`commissions`, dont le schéma exact
n'était pas encore connu à la Phase 1.

**Base déjà en place (mise en conformité temps réel, phase D/9) :** colle
aussi le contenu de **`api/migration_phase7_retraits.sql`** (une seule
fois) — moyen/numéro de retrait de la cabine (`paiement_vers`,
`numero_compte`, `retrait_derniere_maj`), jusqu'ici purement locaux.

**Base déjà en place (mise en conformité temps réel, phase E/9) :** colle
aussi le contenu de **`api/migration_phase8_reset_requests.sql`** (une
seule fois) — nouvelle table `reset_requests` (demandes de réinitialisation
de mot de passe, jusqu'ici 100% locales).

**Base déjà en place (mise en conformité temps réel, phase F/9) :** colle
aussi le contenu de **`api/migration_phase9_partner_applications.sql`**
(une seule fois) — nouvelle table `partner_applications` + colonnes
manquantes sur `profiles` (`whatsapp`, `photo`, `code_qr`, `motivation`,
`experience`, `puces`, `paiement_abo`).

**Base déjà en place (mise en conformité temps réel, phase G/9) :** colle
aussi le contenu de **`api/migration_phase10_devices.sql`** (une seule
fois) — nouvelle table `devices` (appareils connectés, avec vraie
révocation à distance).

## 3. Déposer les fichiers PHP sur l'hébergement

hPanel → Sites web → ton domaine → **Gestionnaire de fichiers** → ouvre le
dossier `public_html` (racine du site, là où se trouve déjà `index.html`).
Crée-y un dossier **`api`**, et dépose DANS ce dossier tous les fichiers de
`api/` présents dans ce dépôt :

- `bootstrap.php`
- `login.php`
- `logout.php`
- `session_whoami.php`
- `create_account.php`
- `admin_create_account.php`
- `settings_get.php`
- `settings_update.php`
- `list_profiles.php`
- `favoris_list.php`
- `favoris_create.php`
- `favoris_remove.php`
- `access_logs_list.php`
- `access_logs_create.php`
- `permission_logs_list.php`
- `permission_logs_create.php`
- `maintenance_logs_list.php`
- `maintenance_logs_create.php`
- `presence_ping.php`
- `presence_online.php`
- `orders_common.php`
- `orders_create.php`
- `orders_accept.php`
- `orders_refuse.php`
- `orders_assign_pending.php`
- `orders_reassign.php`
- `orders_sweep.php`
- `orders_sweep_unsuspend.php`
- `orders_list.php`
- `retards_list.php`
- `orders_recharge.php`
- `orders_refund.php`
- `orders_suspend.php`
- `orders_reactivate.php`
- `orders_delete.php`
- `transferts_cabine_list.php`
- `resubscriptions_list.php`
- `notifications_list.php`
- `notifications_mark_read.php`
- `notifications_mark_all_read.php`
- `retraits_create.php`
- `retraits_list.php`
- `cabine_set_retrait_info.php`
- `reset_requests_create.php`
- `reset_requests_list.php`
- `reset_requests_apply.php`
- `reset_requests_refuse.php`
- `partner_applications_create.php`
- `partner_applications_list.php`
- `partner_applications_validate.php`
- `partner_applications_refuse.php`
- `devices_touch.php`
- `devices_list.php`
- `devices_remove.php`
- `cabine_suspend_manual.php`
- `cabine_self_recharge.php`
- `cabine_resubscribe.php`
- `admin_set_abonnement.php`
- `cabine_transfer.php`
- `reclamations_create.php`
- `reclamations_list.php`
- `reclamations_resolve.php`
- `reclamations_confirm_received.php`
- `reclamations_relance.php`
- `reclamations_request_refund.php`
- `orders_process_refund.php`
- `refund_requests_list.php`
- `forfaits_list.php`
- `forfaits_create.php`
- `forfaits_update.php`
- `forfaits_remove.php`
- `commissions_list.php`
- `commissions_update_rate.php`
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

Déjà fait (compte créé avec succès, `seed_admin.php` supprimé du serveur
ET retiré du dépôt — il ne sera plus jamais redéposé par la synchronisation
automatique). Si tu dois un jour recréer une base de données neuve : ce
fichier n'existe plus, insérer directement le compte super admin en SQL
nécessitera de recalculer un hash bcrypt côté PHP (redemande-le si besoin).

## 6. Vérifier

Visite `https://kbineplus.com/api/settings_get.php` — tu dois voir un JSON
commençant par `{"settings":{...}}`. Si tu vois plutôt un message d'erreur
sur `config.php`, relis l'étape 4.

C'est tout — le site (déjà configuré côté client, voir `js/server-config.js`)
utilise maintenant cette API automatiquement.
