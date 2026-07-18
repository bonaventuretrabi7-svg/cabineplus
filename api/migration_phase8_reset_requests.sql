-- Phase 8 (mise en conformite temps reel, phase E/9) -- demandes de
-- reinitialisation de mot de passe, jusqu'ici 100% locales (localStorage,
-- jamais synchronisees entre appareils). A coller UNE SEULE FOIS dans
-- phpMyAdmin (onglet SQL) sur la base deja en place.

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
