-- Phase 18 -- derniers réglages d'affichage cabine encore 100% locaux à
-- l'appareil (mode sombre, son de notification actif/mélodie) --
-- désormais persistés via api/cabine_update_self.php. A coller UNE SEULE
-- FOIS dans phpMyAdmin (onglet SQL) sur la base deja en place.

ALTER TABLE profiles
  ADD COLUMN theme_sombre                TINYINT(1)  NULL AFTER carte_couleur,
  ADD COLUMN notif_son_actif             TINYINT(1)  NULL AFTER theme_sombre,
  ADD COLUMN notif_son_preset_commande   VARCHAR(32) NULL AFTER notif_son_actif,
  ADD COLUMN notif_son_preset_reclamation VARCHAR(32) NULL AFTER notif_son_preset_commande;
