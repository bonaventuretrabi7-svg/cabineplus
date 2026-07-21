<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';
require __DIR__ . '/orders_common.php';

// Déclenche les commandes automatiques programmées arrivées à échéance —
// même mécanisme de sondage périodique que api/orders_sweep.php (voir son
// commentaire sur l'absence de cron), PLUS un déclencheur externe
// optionnel (voir requireAuthOrCron(), bootstrap.php, et
// .github/workflows/scheduled-orders-cron.yml) pour garantir le
// déclenchement même si aucun appareil n'a l'app ouverte au moment prévu.
requireAuthOrCron();

$pdo = db();
$due = $pdo->query("SELECT * FROM commandes_programmees WHERE statut = 'en_attente' AND date_programmee <= NOW() ORDER BY date_programmee ASC LIMIT 50")->fetchAll();

$triggeredCount = 0;
foreach ($due as $cp) {
  // CAS : seule la requête qui gagne cette course déclenche réellement
  // cette commande — protège contre deux sondages simultanés (ou un
  // sondage + le déclencheur externe) qui la verraient "due" en même temps.
  $claim = $pdo->prepare("UPDATE commandes_programmees SET statut = 'en_cours' WHERE id = ? AND statut = 'en_attente'");
  $claim->execute([$cp['id']]);
  if ($claim->rowCount() === 0) continue;

  $result = triggerScheduledOrder($pdo, $cp);
  $triggeredCount++;

  $txn = $result['txn'];
  $cab = $result['cabine'];
  if ($cp['client_id']) {
    createNotification($cp['client_id'], 'Votre commande programmée (' . $cp['operateur'] . ' ' . number_format((float)$cp['montant'], 0, ',', ' ') . ' F) vient de démarrer.', 'order_pending');

    $nameStmt = $pdo->prepare('SELECT nom, prenom FROM profiles WHERE id = ?');
    $nameStmt->execute([$cp['client_id']]);
    $clientRow  = $nameStmt->fetch();
    $clientName = $clientRow ? trim($clientRow['prenom'] . ' ' . $clientRow['nom']) : 'Un client';
    notifyAllCabines('Le client ' . $clientName . ' a passé une commande ' . $cp['operateur'] . ' de ' . number_format((float)$cp['montant'], 0, ',', ' ') . ' F.', 'new_request');
  }
  if ($cab) {
    createNotification($cab['id'], 'Nouvelle demande de transfert ' . $cp['operateur'] . ' ' . number_format((float)$cp['montant'], 0, ',', ' ') . ' F.', 'new_request');
  }
}

echo json_encode(['ok' => true, 'triggeredCount' => $triggeredCount]);
