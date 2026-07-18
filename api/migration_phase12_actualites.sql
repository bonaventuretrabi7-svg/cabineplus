-- Phase 12 (mise en conformite temps reel, phase I/9, derniere phase) --
-- le bandeau "Actualites" de l'accueil client affichait des faits divers
-- Football/Politique codes en dur, sans aucun rapport avec KBINE PLUS.
-- Transforme en annonces gerees par l'administration (promotions,
-- maintenance, nouveautes), meme patron que maintenance/assistance deja
-- en place -- pas de nouvelle table, une seule colonne JSON de plus sur
-- `settings`. A coller UNE SEULE FOIS dans phpMyAdmin (onglet SQL) sur la
-- base deja en place.

ALTER TABLE settings ADD COLUMN actualites JSON NULL;
