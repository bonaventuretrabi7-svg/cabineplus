<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Liste de TOUTES les commandes automatiques programmées (client ou super
// admin), avec le statut de la vraie commande une fois déclenchée (cabine
// assignée, temps de traitement) — voir l'onglet admin "Commande
// automatique" (js/admin.js). Accessible à tout administrateur (simple ou
// super), pas seulement celui qui a créé une commande.
requireAuth(['admin']);

$rows = db()->query(
  "SELECT cp.*,
     t.cabine_id AS txn_cabine_id, t.statut AS txn_statut,
     t.date_assignation AS txn_date_assignation, t.date_fin AS txn_date_fin,
     cl.prenom AS client_prenom, cl.nom AS client_nom,
     cab.prenom AS cabine_prenom, cab.nom AS cabine_nom, cab.cabine_nom AS cabine_cabine_nom,
     adm.prenom AS admin_prenom, adm.nom AS admin_nom
   FROM commandes_programmees cp
   LEFT JOIN transactions t   ON t.id = cp.transaction_id
   LEFT JOIN profiles cl      ON cl.id = cp.client_id
   LEFT JOIN profiles cab     ON cab.id = t.cabine_id
   LEFT JOIN profiles adm     ON adm.id = cp.created_by_admin_id
   ORDER BY cp.date_programmee DESC"
)->fetchAll();

echo json_encode(['ok' => true, 'commandes' => $rows]);
