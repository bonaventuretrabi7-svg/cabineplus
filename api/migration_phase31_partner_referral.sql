-- Phase 31 -- parrainage sur les candidatures partenaire. Le formulaire de
-- candidature (js/client.js, prgSubmit()) accepte désormais un code de
-- parrainage facultatif ("KP<téléphone>") ; s'il correspond à un client
-- existant, ce client reçoit 1 000 FCFA sur son solde dès que la
-- candidature est validée par l'administration (voir
-- partner_applications_validate.php). A coller UNE SEULE FOIS dans
-- phpMyAdmin (onglet SQL) sur la base déjà en place.

ALTER TABLE partner_applications
  ADD COLUMN IF NOT EXISTS parrain_telephone VARCHAR(32) NULL AFTER puces;
