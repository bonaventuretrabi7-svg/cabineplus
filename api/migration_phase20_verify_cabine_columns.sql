-- Phase 20 -- script de VÉRIFICATION/RÉPARATION, à coller si les
-- personnalisations cabine (réseaux actifs, couleur de carte, mode
-- sombre, son...) ne s'enregistrent plus : reprend TOUTES les colonnes
-- des phases 16 à 19 avec "IF NOT EXISTS", donc sans risque de rejouer
-- une colonne déjà présente. À utiliser à la place des scripts
-- phase16/17/18/19 individuels si un doute existe sur ce qui a déjà été
-- appliqué (nécessite MySQL 8+ ou MariaDB 10.0+, déjà le cas sur la
-- plupart des hébergements récents, dont Hostinger).

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS pause_raison VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS pause_note   TEXT        NULL,
  ADD COLUMN IF NOT EXISTS pause_debut  DATETIME    NULL,
  ADD COLUMN IF NOT EXISTS ussd_enabled  JSON        NULL,
  ADD COLUMN IF NOT EXISTS carte_couleur VARCHAR(32) NULL,
  ADD COLUMN IF NOT EXISTS theme_sombre                 TINYINT(1)   NULL,
  ADD COLUMN IF NOT EXISTS notif_son_actif               TINYINT(1)   NULL,
  ADD COLUMN IF NOT EXISTS notif_son_preset_commande     VARCHAR(32)  NULL,
  ADD COLUMN IF NOT EXISTS notif_son_preset_reclamation  VARCHAR(32)  NULL,
  ADD COLUMN IF NOT EXISTS motif_zero_txn TEXT        NULL,
  ADD COLUMN IF NOT EXISTS motif_inactif  TEXT        NULL,
  ADD COLUMN IF NOT EXISTS appel_statut   VARCHAR(32) NULL;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS hold_used TINYINT(1) NOT NULL DEFAULT 0;
