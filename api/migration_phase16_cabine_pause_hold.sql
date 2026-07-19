-- Phase 16 -- champs manquants pour que "Pause du service" et "Conserver
-- 5 min" (cabine) soient réellement enregistrés côté serveur, au lieu de
-- rester locaux à l'appareil (voir api/cabine_update_self.php et
-- api/orders_hold.php). A coller UNE SEULE FOIS dans phpMyAdmin (onglet
-- SQL) sur la base deja en place.

ALTER TABLE profiles
  ADD COLUMN pause_raison VARCHAR(64) NULL AFTER en_pause,
  ADD COLUMN pause_note   TEXT        NULL AFTER pause_raison,
  ADD COLUMN pause_debut  DATETIME    NULL AFTER pause_note;

ALTER TABLE transactions
  ADD COLUMN hold_used TINYINT(1) NOT NULL DEFAULT 0;
