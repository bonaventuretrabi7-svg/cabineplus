-- Phase 7 (mise en conformite temps reel, phase D/9) -- moyen/numero de
-- retrait de la cabine, jusqu'ici purement locaux (jamais persistes cote
-- serveur, voir confirmCabRetrait()/confirmEditPayment()). A coller UNE
-- SEULE FOIS dans phpMyAdmin (onglet SQL) sur la base deja en place.

ALTER TABLE profiles
  ADD COLUMN paiement_vers        VARCHAR(64) NULL,
  ADD COLUMN numero_compte        VARCHAR(64) NULL,
  ADD COLUMN retrait_derniere_maj DATETIME    NULL;
