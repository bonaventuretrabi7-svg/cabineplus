-- Phase 26 -- ajoute le support "Forfait" aux commandes automatiques
-- programmées (en plus de "Transfert direct") — le client/le super admin
-- choisit désormais un type d'opération (Crédit ou Forfait) ; pour un
-- forfait, `details` porte le forfait_id/nom/code USSD, exactement comme
-- pour une commande en temps réel (voir api/orders_create.php et
-- triggerScheduledOrder(), api/orders_common.php).
-- A coller UNE SEULE FOIS dans phpMyAdmin (onglet SQL) sur la base déjà en place.

ALTER TABLE commandes_programmees
  ADD COLUMN details JSON NULL AFTER service;
