-- Phase 19 -- notes de suivi admin ("Zéro transaction" / "Client-cabine
-- inactif") encore 100% locales à l'appareil de l'admin qui les écrivait,
-- invisibles pour les autres administrateurs (voir saveZeroTxnNote()/
-- setZeroTxnAppelStatut()/saveInactifNote()/setInactifAppelStatut(),
-- js/admin.js, désormais persistées via api/admin_update_user.php). A
-- coller UNE SEULE FOIS dans phpMyAdmin (onglet SQL) sur la base deja en
-- place.

ALTER TABLE profiles
  ADD COLUMN motif_zero_txn TEXT        NULL,
  ADD COLUMN motif_inactif  TEXT        NULL,
  ADD COLUMN appel_statut   VARCHAR(32) NULL;
