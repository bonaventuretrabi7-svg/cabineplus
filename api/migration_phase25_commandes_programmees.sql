-- Phase 25 -- commandes automatiques programmées par un client (payées à
-- la programmation) ou par le super administrateur (sans paiement,
-- traitement réel identique à une commande normale une fois déclenchée) —
-- voir api/orders_schedule_create.php, api/orders_schedule_create_admin.php,
-- api/orders_sweep_scheduled.php et api/orders_common.php (triggerScheduledOrder()).
-- A coller UNE SEULE FOIS dans phpMyAdmin (onglet SQL) sur la base déjà en place.

CREATE TABLE IF NOT EXISTS commandes_programmees (
  id                   CHAR(36)     NOT NULL PRIMARY KEY,
  client_id            CHAR(36)     NULL,
  created_by_admin_id  CHAR(36)     NULL,
  operateur            VARCHAR(32)  NOT NULL,
  numero_beneficiaire  VARCHAR(32)  NOT NULL,
  montant              BIGINT       NOT NULL DEFAULT 0,
  frais_service        BIGINT       NOT NULL DEFAULT 0,
  service              VARCHAR(64)  NULL,
  moyen_paiement       VARCHAR(64)  NULL,
  numero_paiement      VARCHAR(64)  NULL,
  date_programmee      DATETIME     NOT NULL,
  statut               VARCHAR(32)  NOT NULL DEFAULT 'en_attente',
  transaction_id       CHAR(36)     NULL,
  date_creation        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_declenchement   DATETIME     NULL,
  KEY idx_cp_client (client_id),
  KEY idx_cp_statut_date (statut, date_programmee)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
