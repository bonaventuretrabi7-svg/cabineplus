-- Phase 11 (mise en conformite temps reel, phase H/9) -- parrainage,
-- jusqu'ici jamais implemente meme localement (compteurs figes a 0, aucune
-- regle nulle part). Regle : 50 F credites au parrain des que son filleul
-- termine sa toute premiere commande (montant deja affiche dans l'UI
-- existante, "+50 F par ami inscrit"). A coller UNE SEULE FOIS dans
-- phpMyAdmin (onglet SQL) sur la base deja en place.

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
