-- KBINE PLUS | Schéma MySQL — remplace le backend Supabase (voir supabase/,
-- conservé dans le dépôt mais désormais hors service) par une base MySQL
-- hébergée sur l'hébergement Hostinger existant du site, pilotée par les
-- scripts PHP de ce dossier (api/). Aucune ligne de commande nécessaire :
-- ce fichier se colle tel quel dans phpMyAdmin (onglet "SQL").
--
-- Portée : authentification + profil (client/cabine/admin) et réglages
-- globaux (DB.settings) — les mêmes deux périmètres que le Lot 1 et la
-- Phase 1 Supabase. Les autres tables (transactions, retraits...) restent
-- 100% locales (LocalStorage) comme aujourd'hui — synchronisation complète
-- des données métier hors périmètre (Phase 2, plus tard).

CREATE TABLE IF NOT EXISTS profiles (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  nom                 VARCHAR(190)  NOT NULL DEFAULT '',
  prenom              VARCHAR(190)  NOT NULL DEFAULT '',
  telephone           VARCHAR(32)   NULL,
  email               VARCHAR(190)  NULL,
  mot_de_passe_hash   VARCHAR(255)  NOT NULL,
  role                ENUM('client','cabine','admin') NOT NULL,
  solde               BIGINT        NOT NULL DEFAULT 0,
  statut              VARCHAR(32)   NOT NULL DEFAULT 'actif',
  admin_level         VARCHAR(32)   NULL,
  permissions         JSON          NULL,
  zone                VARCHAR(190)  NULL,
  cabine_nom          VARCHAR(190)  NULL,
  commissions_total   BIGINT        NOT NULL DEFAULT 0,
  transferts_total    BIGINT        NOT NULL DEFAULT 0,
  limite_commandes    INT           NULL,
  tentatives_echouees INT           NOT NULL DEFAULT 0,
  suspendu_auto       TINYINT(1)    NOT NULL DEFAULT 0,
  suspendu_by         CHAR(36)      NULL,
  suspendu_motif      TEXT          NULL,
  suspendu_jusqu      DATETIME      NULL,
  abonnement          VARCHAR(32)   NULL,
  date_creation       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_telephone_role (telephone, role),
  UNIQUE KEY uniq_email_role (email, role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Jeton d'accès opaque émis à la connexion (voir api/login.php) — remplace
-- les sessions Supabase Auth. Un admin authentifié envoie ce jeton
-- (Authorization: Bearer <token>) pour prouver son rôle sur les actions
-- protégées (créer un compte cabine/admin, modifier les réglages globaux),
-- sans jamais renvoyer son PIN après la connexion initiale.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  CHAR(64)  NOT NULL PRIMARY KEY,
  profile_id  CHAR(36)  NOT NULL,
  role        VARCHAR(16) NOT NULL,
  expires_at  DATETIME  NOT NULL,
  created_at  DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_profile (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Réglages globaux (une seule ligne) — équivalent de la table `settings`
-- Supabase (voir DB.settings dans js/db.js).
CREATE TABLE IF NOT EXISTS settings (
  id                TINYINT(1)   NOT NULL PRIMARY KEY DEFAULT 1,
  platform_name     VARCHAR(190) NOT NULL DEFAULT 'KBINE PLUS',
  currency          VARCHAR(16)  NOT NULL DEFAULT 'FCFA',
  commission_rate   DECIMAL(6,2) NOT NULL DEFAULT 5,
  min_transfer      BIGINT       NOT NULL DEFAULT 500,
  max_transfer      BIGINT       NOT NULL DEFAULT 100000,
  recharge_min      BIGINT       NOT NULL DEFAULT 1000,
  maintenance       JSON         NULL,
  assistance        JSON         NULL,
  assistant_cabine  JSON         NULL,
  assistant_client  JSON         NULL,
  ussd_templates    JSON         NULL,
  admin_schedules   JSON         NULL,
  updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_settings_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO settings (id, maintenance, assistance, assistant_cabine, assistant_client, ussd_templates, admin_schedules)
VALUES (
  1,
  JSON_OBJECT(
    'global',    JSON_OBJECT('enabled', FALSE, 'message', ''),
    'services',  JSON_OBJECT('recharger', FALSE, 'depenses', FALSE, 'transferer', FALSE, 'historique', FALSE, 'facture', FALSE, 'recharge_uv', FALSE, 'exchange', FALSE),
    'networks',  JSON_OBJECT('Orange', FALSE, 'MTN', FALSE, 'Moov', FALSE),
    'networksByService', JSON_OBJECT(
      'exchange', JSON_OBJECT('Orange', FALSE, 'MTN', FALSE, 'Moov', FALSE),
      'recharge', JSON_OBJECT('Orange', FALSE, 'MTN', FALSE, 'Moov', FALSE, 'Wave', FALSE)
    ),
    'factureServices', JSON_OBJECT(
      'cie_prepaye', JSON_OBJECT('blocked', FALSE, 'message', ''),
      'cie_facture',  JSON_OBJECT('blocked', FALSE, 'message', ''),
      'sodeci',       JSON_OBJECT('blocked', FALSE, 'message', ''),
      'canal_plus',   JSON_OBJECT('blocked', FALSE, 'message', ''),
      'canalbox',     JSON_OBJECT('blocked', FALSE, 'message', ''),
      'sotra',        JSON_OBJECT('blocked', FALSE, 'message', '')
    )
  ),
  JSON_OBJECT('whatsapp', JSON_ARRAY(), 'email', '', 'facebook', '', 'snapchat', ''),
  JSON_OBJECT('whatsapp', JSON_ARRAY()),
  JSON_OBJECT('whatsapp', JSON_ARRAY(), 'schedule', JSON_ARRAY()),
  JSON_OBJECT('mtn', '*133*6*2*{numero_destinataire}#', 'moov_marchand', '*155*6*2*{numero_destinataire}#'),
  JSON_ARRAY()
);

-- Compte super admin (seul moyen de démarrer — mot de passe haché à
-- l'insertion via PASSWORD('1973') n'existe pas en MySQL pour bcrypt ; le
-- hash est déjà calculé ci-dessous avec password_hash('1973', PASSWORD_BCRYPT)
-- côté PHP — voir api/seed_admin.php, à exécuter UNE SEULE FOIS après avoir
-- créé les tables (ce fichier ne peut pas calculer un hash bcrypt en SQL pur).
