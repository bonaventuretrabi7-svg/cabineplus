-- Phase 9 (mise en conformite temps reel, phase F/9) -- candidatures
-- partenaires, jusqu'ici 100% locales (localStorage cbp_applications,
-- partagee par coincidence uniquement si client et admin utilisaient le
-- MEME navigateur). A coller UNE SEULE FOIS dans phpMyAdmin (onglet SQL)
-- sur la base deja en place.

-- Colonnes profiles manquantes -- deja ecrites localement sur un compte
-- cabine (whatsapp/photo tres largement lus ailleurs dans l'app) mais
-- jamais persistees cote serveur.
ALTER TABLE profiles
  ADD COLUMN whatsapp     VARCHAR(32)  NULL,
  ADD COLUMN photo        LONGTEXT     NULL,
  ADD COLUMN code_qr      LONGTEXT     NULL,
  ADD COLUMN motivation   TEXT         NULL,
  ADD COLUMN experience   VARCHAR(64)  NULL,
  ADD COLUMN puces        JSON         NULL,
  ADD COLUMN paiement_abo VARCHAR(64)  NULL;

CREATE TABLE IF NOT EXISTS partner_applications (
  id                CHAR(36)     NOT NULL PRIMARY KEY,
  prenom            VARCHAR(190) NULL,
  nom               VARCHAR(190) NULL,
  email             VARCHAR(190) NULL,
  telephone         VARCHAR(32)  NULL,
  whatsapp          VARCHAR(32)  NULL,
  cabine_nom        VARCHAR(190) NULL,
  mot_de_passe_hash VARCHAR(255) NOT NULL,
  photo             LONGTEXT     NULL,
  code_qr           LONGTEXT     NULL,
  motivation        TEXT         NULL,
  abonnement        VARCHAR(32)  NULL,
  paiement_abo      VARCHAR(64)  NULL,
  paiement_vers     VARCHAR(64)  NULL,
  numero_compte     VARCHAR(64)  NULL,
  experience        VARCHAR(64)  NULL,
  puces             JSON         NULL,
  statut            VARCHAR(32)  NOT NULL DEFAULT 'en_attente',
  date_created      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_traitement   DATETIME     NULL,
  processed_by      CHAR(36)     NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
