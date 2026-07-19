-- KBINE PLUS | Schéma MySQL — remplace le backend Supabase (voir supabase/,
-- conservé dans le dépôt mais désormais hors service) par une base MySQL
-- hébergée sur l'hébergement Hostinger existant du site, pilotée par les
-- scripts PHP de ce dossier (api/). Aucune ligne de commande nécessaire :
-- ce fichier se colle tel quel dans phpMyAdmin (onglet "SQL").
--
-- Portée : authentification + profil (client/cabine/admin), réglages
-- globaux (DB.settings), et synchronisation complète des données métier
-- (Phase 2 : transactions, notifications, favoris, réclamations,
-- attribution des commandes...) — voir api/migration_phase2_1_foundations.sql
-- pour appliquer ces ajouts à une base déjà en place (installation
-- existante) plutôt que de recoller ce fichier en entier.

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
  en_pause             TINYINT(1)   NOT NULL DEFAULT 0,
  pause_raison         VARCHAR(64)  NULL,
  pause_note           TEXT         NULL,
  pause_debut          DATETIME     NULL,
  reseaux_actifs       JSON         NULL,
  services_actifs      JSON         NULL,
  commandes_renvoyees  INT          NOT NULL DEFAULT 0,
  remboursements_recus INT          NOT NULL DEFAULT 0,
  paiement_vers         VARCHAR(64)  NULL,
  numero_compte         VARCHAR(64)  NULL,
  retrait_derniere_maj  DATETIME     NULL,
  whatsapp              VARCHAR(32)  NULL,
  photo                 LONGTEXT     NULL,
  code_qr               LONGTEXT     NULL,
  motivation            TEXT         NULL,
  experience            VARCHAR(64)  NULL,
  puces                 JSON         NULL,
  paiement_abo          VARCHAR(64)  NULL,
  poste                 VARCHAR(64)  NULL,
  pays                  VARCHAR(190) NULL,
  ville                 VARCHAR(190) NULL,
  quartier              VARCHAR(190) NULL,
  date_naissance        DATE         NULL,
  docs                  JSON         NULL,
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

-- Liens de connexion sans mot de passe pour un administrateur simple,
-- générés par le super admin (voir api/admin_create_login_link.php et
-- api/admin_magic_login.php, Phase 15).
CREATE TABLE IF NOT EXISTS admin_login_links (
  id          CHAR(36)  NOT NULL PRIMARY KEY,
  admin_id    CHAR(36)  NOT NULL,
  token_hash  CHAR(64)  NOT NULL,
  expires_at  DATETIME  NOT NULL,
  used_at     DATETIME  NULL,
  created_by  CHAR(36)  NOT NULL,
  created_at  DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_admin (admin_id)
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
  actualites        JSON         NULL,
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

-- ── Présence en ligne (remplace le Map localStorage par appareil) ──────
CREATE TABLE IF NOT EXISTS presence (
  profile_id    CHAR(36)  NOT NULL PRIMARY KEY,
  last_seen_at  DATETIME  NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Transactions (commandes) — cœur du moteur d'attribution ────────────
CREATE TABLE IF NOT EXISTS transactions (
  id                            CHAR(36)     NOT NULL PRIMARY KEY,
  client_id                     CHAR(36)     NULL,
  cabine_id                     CHAR(36)     NULL,
  type                          VARCHAR(32)  NULL,
  service                       VARCHAR(64)  NULL,
  operateur                     VARCHAR(32)  NULL,
  numero_beneficiaire           VARCHAR(32)  NULL,
  montant                       BIGINT       NOT NULL DEFAULT 0,
  frais_service                 BIGINT       NOT NULL DEFAULT 0,
  commission                    BIGINT       NOT NULL DEFAULT 0,
  statut                        VARCHAR(32)  NOT NULL DEFAULT 'en_attente',
  moyen_paiement                VARCHAR(64)  NULL,
  numero_paiement                VARCHAR(64)  NULL,
  details                       JSON         NULL,
  notes                         TEXT         NULL,
  date                          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_assignation               DATETIME     NULL,
  date_fin                      DATETIME     NULL,
  date_suspension                DATETIME     NULL,
  date_remboursement            DATETIME     NULL,
  preuve_paiement                LONGTEXT     NULL,
  retard_logged_cabine_id        CHAR(36)     NULL,
  dernier_renvoi_motif           VARCHAR(64)  NULL,
  dernier_renvoi_justification   TEXT         NULL,
  dernier_renvoi_date            DATETIME     NULL,
  dernier_renvoi_cabine_id       CHAR(36)     NULL,
  statut_avant_suspension        VARCHAR(32)  NULL,
  motif_suspension                TEXT         NULL,
  hold_used                      TINYINT(1)   NOT NULL DEFAULT 0,
  KEY idx_txn_client (client_id),
  KEY idx_txn_cabine (cabine_id),
  KEY idx_txn_statut (statut)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Retraits de commission (cabiniste) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS retraits (
  id               CHAR(36)     NOT NULL PRIMARY KEY,
  cabine_id        CHAR(36)     NOT NULL,
  montant          BIGINT       NOT NULL,
  statut           VARCHAR(32)  NOT NULL DEFAULT 'en_attente',
  methode_retrait  VARCHAR(64)  NULL,
  numero_paiement  VARCHAR(64)  NULL,
  type             VARCHAR(32)  NULL,
  motif            TEXT         NULL,
  date             DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_retraits_cabine (cabine_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Retards (historique des commandes réattribuées pour dépassement) ───
CREATE TABLE IF NOT EXISTS retards (
  id                        CHAR(36)   NOT NULL PRIMARY KEY,
  transaction_id            CHAR(36)   NOT NULL,
  cabine_id                 CHAR(36)   NOT NULL,
  date                      DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reassigned_to_cabine_id   CHAR(36)   NULL,
  triggered_suspension      TINYINT(1) NOT NULL DEFAULT 0,
  KEY idx_retards_cabine (cabine_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Renvois manuels de commande (historique horodaté) ───────────────────
CREATE TABLE IF NOT EXISTS cabine_refusals (
  id          CHAR(36)  NOT NULL PRIMARY KEY,
  cabine_id   CHAR(36)  NOT NULL,
  date        DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_refusals_cabine (cabine_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Transferts cabine-à-cabine ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transferts_cabine (
  id             CHAR(36)  NOT NULL PRIMARY KEY,
  from_cabine_id CHAR(36)  NOT NULL,
  to_cabine_id   CHAR(36)  NOT NULL,
  montant        BIGINT    NOT NULL,
  frais          BIGINT    NOT NULL DEFAULT 0,
  date           DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_transferts_from (from_cabine_id),
  KEY idx_transferts_to (to_cabine_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Forfaits (catalogue Orange/MTN/Moov) — champs affinés à l'étape 6 ──
CREATE TABLE IF NOT EXISTS forfaits (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  operateur      VARCHAR(32)  NOT NULL,
  categorie      VARCHAR(64)  NULL,
  nom            VARCHAR(190) NULL,
  detail         TEXT         NULL,
  duree          VARCHAR(64)  NULL,
  prix           BIGINT       NULL,
  ussd_template  VARCHAR(255) NULL,
  verified       TINYINT(1)   NOT NULL DEFAULT 1,
  details        JSON         NULL,
  KEY idx_forfaits_operateur (operateur)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Notifications ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  utilisateur_id  CHAR(36)     NOT NULL,
  message         TEXT         NOT NULL,
  lu              TINYINT(1)   NOT NULL DEFAULT 0,
  date            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  type            VARCHAR(32)  NOT NULL DEFAULT 'info',
  KEY idx_notif_user (utilisateur_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Réclamations ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reclamations (
  id                      CHAR(36)     NOT NULL PRIMARY KEY,
  transaction_id          CHAR(36)     NOT NULL,
  client_id               CHAR(36)     NOT NULL,
  cabine_id               CHAR(36)     NULL,
  motif                   TEXT         NULL,
  statut                  VARCHAR(32)  NOT NULL DEFAULT 'en_attente',
  screenshot               LONGTEXT     NULL,
  date_created             DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_resolved            DATETIME     NULL,
  relances_apres_preuve    INT          NOT NULL DEFAULT 0,
  confirmed_by_client      TINYINT(1)   NULL,
  KEY idx_recl_transaction (transaction_id),
  KEY idx_recl_client (client_id),
  KEY idx_recl_cabine (cabine_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Messages de réclamation (normalisé, remplace messages[] embarqué) ──
CREATE TABLE IF NOT EXISTS reclamation_messages (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  reclamation_id  CHAR(36)     NOT NULL,
  sender          VARCHAR(32)  NOT NULL,
  type            VARCHAR(32)  NOT NULL DEFAULT 'texte',
  texte           TEXT         NULL,
  image           LONGTEXT     NULL,
  date            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_reclmsg_reclamation (reclamation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Demandes de remboursement (soumises par la cabine) ──────────────────
CREATE TABLE IF NOT EXISTS refund_requests (
  id               CHAR(36)     NOT NULL PRIMARY KEY,
  reclamation_id   CHAR(36)     NOT NULL,
  transaction_id   CHAR(36)     NOT NULL,
  cabine_id        CHAR(36)     NOT NULL,
  client_id        CHAR(36)     NOT NULL,
  motif            TEXT         NULL,
  statut           VARCHAR(32)  NOT NULL DEFAULT 'en_attente',
  date_created      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_traitement   DATETIME     NULL,
  processed_by     CHAR(36)     NULL,
  KEY idx_rfr_reclamation (reclamation_id),
  KEY idx_rfr_cabine (cabine_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Numéros favoris (client) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS favoris (
  id             CHAR(36)  NOT NULL PRIMARY KEY,
  client_id      CHAR(36)  NOT NULL,
  nom            VARCHAR(190) NULL,
  numero         VARCHAR(32)  NOT NULL,
  date_creation  DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_favoris_client (client_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Règle de commission active ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commissions (
  id           CHAR(36)      NOT NULL PRIMARY KEY,
  label        VARCHAR(190)  NULL,
  pourcentage  DECIMAL(6,2)  NOT NULL DEFAULT 5,
  montant_min  BIGINT        NULL,
  montant_max  BIGINT        NULL,
  actif        TINYINT(1)    NOT NULL DEFAULT 1,
  date         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO commissions (id, label, pourcentage, montant_min, montant_max, actif, date)
VALUES (UUID(), 'Commission standard', 5, 0, 99999, 1, '2024-01-01 00:00:00');

-- ── Journal des accès admin (impersonation) — lecture seule ─────────────
CREATE TABLE IF NOT EXISTS access_logs (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  admin_id        CHAR(36)     NOT NULL,
  admin_name      VARCHAR(190) NULL,
  target_user_id  CHAR(36)     NULL,
  target_role     VARCHAR(16)  NULL,
  target_name     VARCHAR(190) NULL,
  date            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Journal des permissions cabine — lecture seule ──────────────────────
CREATE TABLE IF NOT EXISTS permission_logs (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  admin_id     CHAR(36)     NOT NULL,
  admin_name   VARCHAR(190) NULL,
  cabine_id    CHAR(36)     NOT NULL,
  cabine_name  VARCHAR(190) NULL,
  service      VARCHAR(64)  NULL,
  active       TINYINT(1)   NULL,
  date         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_permlog_cabine (cabine_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Journal de maintenance (service/réseau) — lecture seule ─────────────
CREATE TABLE IF NOT EXISTS maintenance_logs (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  admin_id     CHAR(36)     NOT NULL,
  admin_name   VARCHAR(190) NULL,
  action       VARCHAR(64)  NULL,
  `key`        VARCHAR(64)  NULL,
  active       TINYINT(1)   NULL,
  service      VARCHAR(64)  NULL,
  message      TEXT         NULL,
  date         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Historique des suspensions cabine — lecture seule ───────────────────
CREATE TABLE IF NOT EXISTS suspension_logs (
  id               CHAR(36)     NOT NULL PRIMARY KEY,
  cabine_id        CHAR(36)     NOT NULL,
  motif            TEXT         NULL,
  auto             TINYINT(1)   NOT NULL DEFAULT 0,
  date_debut        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_fin_prevue   DATETIME     NULL,
  date_levee        DATETIME     NULL,
  levee_par        VARCHAR(64)  NULL,
  KEY idx_susplog_cabine (cabine_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Réabonnements cabine — lecture seule ────────────────────────────────
CREATE TABLE IF NOT EXISTS resubscriptions (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  cabine_id   CHAR(36)     NOT NULL,
  formule     VARCHAR(32)  NOT NULL,
  prix        BIGINT       NOT NULL,
  date        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_resub_cabine (cabine_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Demandes de réinitialisation de mot de passe ────────────────────────
CREATE TABLE IF NOT EXISTS reset_requests (
  id                        CHAR(36)     NOT NULL PRIMARY KEY,
  profile_id                CHAR(36)     NOT NULL,
  role                      VARCHAR(16)  NOT NULL,
  telephone                 VARCHAR(32)  NULL,
  nom                       VARCHAR(190) NULL,
  nouveau_mot_de_passe_hash VARCHAR(255) NOT NULL,
  statut                    VARCHAR(32)  NOT NULL DEFAULT 'en_attente',
  date_created              DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_traitement           DATETIME     NULL,
  processed_by              CHAR(36)     NULL,
  KEY idx_reset_profile (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Candidatures partenaires (auto-inscription cabine, en attente) ──────
CREATE TABLE IF NOT EXISTS partner_applications (
  id                CHAR(36)     NOT NULL PRIMARY KEY,
  prenom            VARCHAR(190) NULL,
  nom               VARCHAR(190) NULL,
  email             VARCHAR(190) NULL,
  telephone         VARCHAR(32)  NULL,
  whatsapp          VARCHAR(32)  NULL,
  cabine_nom        VARCHAR(190) NULL,
  mot_de_passe_hash VARCHAR(255) NOT NULL,
  photo             LONGTEXT     NULL,
  code_qr           LONGTEXT     NULL,
  motivation        TEXT         NULL,
  abonnement        VARCHAR(32)  NULL,
  paiement_abo      VARCHAR(64)  NULL,
  paiement_vers     VARCHAR(64)  NULL,
  numero_compte     VARCHAR(64)  NULL,
  experience        VARCHAR(64)  NULL,
  puces             JSON         NULL,
  statut            VARCHAR(32)  NOT NULL DEFAULT 'en_attente',
  date_created      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_traitement   DATETIME     NULL,
  processed_by      CHAR(36)     NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Appareils connectés (client/cabine/admin simple) ────────────────────
-- token_hash (jamais le jeton en clair, même schéma que `sessions`) permet
-- de vraiment révoquer un appareil : supprimer ce jeton de `sessions`
-- déconnecte réellement la session, pas seulement un retrait cosmétique
-- de la liste.
CREATE TABLE IF NOT EXISTS devices (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  profile_id   CHAR(36)     NOT NULL,
  device_id    CHAR(36)     NOT NULL,
  label        VARCHAR(190) NULL,
  token_hash   CHAR(64)     NULL,
  remembered   TINYINT(1)   NOT NULL DEFAULT 0,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_profile_device (profile_id, device_id),
  KEY idx_devices_profile (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Parrainage (client -> client) ────────────────────────────────────
-- reward_montant figé à l'inscription (pas de dérive si le taux change
-- plus tard) ; reward_verse=0 jusqu'à la 1re commande terminée du
-- filleul (voir creditReferralRewardIfFirstOrder(), orders_common.php).
CREATE TABLE IF NOT EXISTS referrals (
  id              CHAR(36)   NOT NULL PRIMARY KEY,
  referrer_id     CHAR(36)   NOT NULL,
  referred_id     CHAR(36)   NOT NULL,
  reward_montant  BIGINT     NOT NULL DEFAULT 50,
  reward_verse    TINYINT(1) NOT NULL DEFAULT 0,
  date            DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_referred (referred_id),
  KEY idx_referrer (referrer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Compte super admin (seul moyen de démarrer — mot de passe haché à
-- l'insertion via PASSWORD('1973') n'existe pas en MySQL pour bcrypt ; le
-- hash est déjà calculé ci-dessous avec password_hash('1973', PASSWORD_BCRYPT)
-- côté PHP — voir api/seed_admin.php, à exécuter UNE SEULE FOIS après avoir
-- créé les tables (ce fichier ne peut pas calculer un hash bcrypt en SQL pur).
