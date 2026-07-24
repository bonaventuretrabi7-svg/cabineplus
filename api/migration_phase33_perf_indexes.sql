-- Phase 33 -- index de performance pour les verifications anti-doublons
-- (partner_applications_check_{phone,email,fullname,cabine_nom}.php,
-- create_account.php, check_surnom.php). Jusqu'ici :
-- - partner_applications n'avait AUCUN index secondaire -- chaque appel
--   (declenche a chaque etape de la candidature partenaire, plusieurs fois
--   par saisie) faisait un scan complet de table.
-- - Les comparaisons du type LOWER(TRIM(colonne)) = LOWER(TRIM(?))
--   empechaient MySQL d'utiliser un index meme quand un existait (la
--   colonne est enveloppee dans une fonction, l'index porte sur la valeur
--   brute).
--
-- Colonnes generees STORED (meme principe que client_prenom_key, voir
-- migration_phase32_client_surnom_unique.sql) : la comparaison porte
-- desormais sur la colonne generee elle-meme (jamais enveloppee cote
-- colonne), ce qui permet a MySQL d'utiliser l'index normalement. A coller
-- UNE SEULE FOIS dans phpMyAdmin (onglet SQL) sur la base deja en place.

-- IF NOT EXISTS partout (colonnes ET index) : rejouable sans erreur meme
-- si une tentative precedente a partiellement reussi avant d'echouer plus
-- loin (ex. "#1060 Duplicate column" sur une 2e execution).
ALTER TABLE partner_applications
  ADD COLUMN IF NOT EXISTS email_key VARCHAR(190)
    GENERATED ALWAYS AS (LOWER(email)) STORED,
  ADD COLUMN IF NOT EXISTS cabine_nom_key VARCHAR(190)
    GENERATED ALWAYS AS (LOWER(TRIM(cabine_nom))) STORED,
  ADD COLUMN IF NOT EXISTS fullname_key VARCHAR(380)
    GENERATED ALWAYS AS (CONCAT(LOWER(TRIM(prenom)), '|', LOWER(TRIM(nom)))) STORED;

ALTER TABLE partner_applications
  ADD INDEX IF NOT EXISTS idx_pa_telephone (telephone),
  ADD INDEX IF NOT EXISTS idx_pa_email_key (email_key),
  ADD INDEX IF NOT EXISTS idx_pa_cabine_nom_key (cabine_nom_key),
  ADD INDEX IF NOT EXISTS idx_pa_fullname_key (fullname_key),
  ADD INDEX IF NOT EXISTS idx_pa_statut (statut);

-- profiles.client_prenom_key existe deja (phase 32) pour le surnom client
-- -- il ne couvrait que role='client'. Meme principe ici pour role='cabine'
-- (verifications de doublon nom de cabine / nom complet a la candidature).
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS cabine_nom_key VARCHAR(190)
    GENERATED ALWAYS AS (CASE WHEN role = 'cabine' THEN LOWER(TRIM(cabine_nom)) ELSE NULL END) STORED,
  ADD COLUMN IF NOT EXISTS cabine_fullname_key VARCHAR(380)
    GENERATED ALWAYS AS (CASE WHEN role = 'cabine' THEN CONCAT(LOWER(TRIM(prenom)), '|', LOWER(TRIM(nom))) ELSE NULL END) STORED;

ALTER TABLE profiles
  ADD INDEX IF NOT EXISTS idx_profiles_cabine_nom_key (cabine_nom_key),
  ADD INDEX IF NOT EXISTS idx_profiles_cabine_fullname_key (cabine_fullname_key);
