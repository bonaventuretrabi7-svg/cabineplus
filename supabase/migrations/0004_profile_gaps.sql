-- Colonnes ajoutées côté local (js/db.js) après la conception initiale du
-- schéma (0001_init.sql) — fonctionnalité retards/suspension automatique et
-- blocage après 3 tentatives incorrectes (voir Auth.login()/
-- migrateAdminIdentity() dans js/auth.js et js/db.js). Nécessaires pour que
-- verify_login() (0002_auth.sql) applique exactement les mêmes règles de
-- statut de compte que la vérification locale.

alter table profiles
  add column if not exists tentatives_echouees integer not null default 0,
  add column if not exists suspendu_auto       boolean not null default false,
  add column if not exists suspendu_by         uuid references profiles(id),
  add column if not exists suspendu_motif      text,
  add column if not exists suspendu_jusqu      timestamptz,
  add column if not exists abonnement          text;
