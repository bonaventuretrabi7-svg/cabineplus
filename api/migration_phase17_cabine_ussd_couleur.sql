-- Phase 17 -- deux derniers réglages cabine encore 100% locaux à
-- l'appareil (voir toggleUssdNetwork()/previewCabCardColor(), js/cabine.js,
-- désormais persistés via api/cabine_update_self.php). A coller UNE SEULE
-- FOIS dans phpMyAdmin (onglet SQL) sur la base deja en place.

ALTER TABLE profiles
  ADD COLUMN ussd_enabled  JSON        NULL AFTER services_actifs,
  ADD COLUMN carte_couleur VARCHAR(32) NULL AFTER ussd_enabled;
