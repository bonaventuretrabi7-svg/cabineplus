-- Phase 24 -- notifications push (Firebase Cloud Messaging) pour les trois
-- espaces (client/cabine/admin) sur l'app Android. Un jeton = un appareil,
-- réattribué automatiquement au bon compte à chaque connexion (voir
-- api/push_register.php). A coller UNE SEULE FOIS dans phpMyAdmin (onglet
-- SQL) sur la base déjà en place.

CREATE TABLE IF NOT EXISTS push_tokens (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  profile_id  CHAR(36)     NOT NULL,
  token       VARCHAR(255) NOT NULL,
  platform    VARCHAR(16)  NOT NULL DEFAULT 'android',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_token (token),
  KEY idx_push_tokens_profile (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
