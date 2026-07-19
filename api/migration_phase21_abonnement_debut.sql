-- Phase 21 -- date de début du cycle d'abonnement en cours, nécessaire
-- pour afficher l'échéance des 30 jours au partenaire et déclencher la
-- suspension automatique si le quota n'est pas atteint dans ce délai (voir
-- checkQuotaDeadline(), api/orders_common.php). A coller UNE SEULE FOIS
-- dans phpMyAdmin (onglet SQL) sur la base deja en place.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS abonnement_debut DATETIME NULL;

-- Amorce le cycle pour les cabines déjà actives (sans quoi leur échéance
-- ne serait jamais calculée tant qu'elles ne se réabonnent pas) — part de
-- leur date de création, un point de départ raisonnable faute de mieux.
UPDATE profiles SET abonnement_debut = date_creation
WHERE role = 'cabine' AND abonnement_debut IS NULL;
