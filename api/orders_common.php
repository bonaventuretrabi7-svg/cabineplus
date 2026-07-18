<?php
declare(strict_types=1);

// Fonctions métier partagées par les endpoints du moteur de commandes
// (Phase 4, synchronisation multi-appareils) — portage direct de
// DB.business.* (js/db.js) : mêmes règles, même ordre de filtres, pour un
// comportement identique à l'ancienne version 100% locale. Inclus après
// bootstrap.php (require __DIR__ . '/bootstrap.php' déjà fait par
// l'appelant) — utilise db()/uuid4()/createNotification() définies là-bas.

const ORDER_SUBSCRIPTION_QUOTAS = ['Premium' => 25000, 'VIP' => 50000, 'VVIP' => 250000];
const ORDER_SUBSCRIPTION_PRICES = ['Premium' => 10000, 'VIP' => 20000, 'VVIP' => 50000];
const ORDER_STALE_PRESENCE_SECONDS = 25; // même valeur que DB.presence.STALE_MS (js/db.js)
const ORDER_RETARD_SECONDS = 180;        // même valeur que DB.RETARD_MS (js/db.js, 3 min)

function pendingCountForCabine(PDO $pdo, string $cabineId): int {
  $stmt = $pdo->prepare("SELECT COUNT(*) FROM transactions WHERE cabine_id = ? AND statut = 'en_attente'");
  $stmt->execute([$cabineId]);
  return (int)$stmt->fetchColumn();
}

function isCabineAtLimit(PDO $pdo, array $cab): bool {
  if (empty($cab['limite_commandes'])) return false;
  return pendingCountForCabine($pdo, $cab['id']) >= (int)$cab['limite_commandes'];
}

function hasBlockingReclamation(PDO $pdo, string $cabineId): bool {
  $stmt = $pdo->prepare("SELECT COUNT(*) FROM reclamations WHERE cabine_id = ? AND statut = 'en_attente'");
  $stmt->execute([$cabineId]);
  return ((int)$stmt->fetchColumn()) > 0;
}

function cabineAcceptsNetwork(array $cab, ?string $operateur): bool {
  $nets = !empty($cab['reseaux_actifs']) ? json_decode((string)$cab['reseaux_actifs'], true) : ['orange' => true, 'moov' => true, 'mtn' => true];
  $op = strtolower($operateur ?? '');
  if (strpos($op, 'orange') !== false) return !empty($nets['orange']);
  if (strpos($op, 'moov') !== false)   return !empty($nets['moov']);
  if (strpos($op, 'mtn') !== false)    return !empty($nets['mtn']);
  return true;
}

function cabineAcceptsService(array $cab, ?string $type): bool {
  $serviceKeys = ['facture', 'exchange', 'recharge_uv'];
  if (!in_array($type, $serviceKeys, true)) return true;
  $svcs = !empty($cab['services_actifs']) ? json_decode((string)$cab['services_actifs'], true) : ['facture' => true, 'exchange' => true, 'recharge_uv' => true];
  return !empty($svcs[$type]);
}

// Cabines actuellement "en ligne" (voir api/presence_ping.php — présence
// côté serveur, prérequis Phase 3) parmi celles actives et non en pause.
function onlineCabineIds(PDO $pdo): array {
  $stmt = $pdo->query("SELECT p.profile_id FROM presence p
    INNER JOIN profiles pr ON pr.id = p.profile_id
    WHERE pr.role = 'cabine' AND pr.statut = 'actif' AND (pr.en_pause = 0 OR pr.en_pause IS NULL)
      AND p.last_seen_at >= NOW() - INTERVAL " . ORDER_STALE_PRESENCE_SECONDS . " SECOND");
  return array_column($stmt->fetchAll(), 'profile_id');
}

// Sélectionne la cabine cible d'une réattribution (retard ou renvoi
// manuel) : parmi les cabines actuellement en ligne, actives, non en
// pause, sans réclamation bloquante, acceptant le réseau/service de la
// commande, et sous leur limite, celle qui a le moins de commandes en
// attente (répartition par charge minimale). Retourne null si aucune
// éligible — même contrat que DB.business.findReassignmentTarget (js/db.js).
function findReassignmentTarget(PDO $pdo, string $excludeCabineId, ?string $operateur, ?string $type): ?array {
  $onlineIds = array_values(array_diff(onlineCabineIds($pdo), [$excludeCabineId]));
  if (!$onlineIds) return null;

  $placeholders = implode(',', array_fill(0, count($onlineIds), '?'));
  $stmt = $pdo->prepare("SELECT * FROM profiles WHERE role = 'cabine' AND id IN ($placeholders)");
  $stmt->execute($onlineIds);
  $candidates = $stmt->fetchAll();

  $eligible = [];
  foreach ($candidates as $cab) {
    if ($cab['statut'] !== 'actif') continue;
    if (!empty($cab['en_pause'])) continue;
    if (isCabineAtLimit($pdo, $cab)) continue;
    if (hasBlockingReclamation($pdo, $cab['id'])) continue;
    if (!cabineAcceptsNetwork($cab, $operateur)) continue;
    if (!cabineAcceptsService($cab, $type)) continue;
    $eligible[] = $cab;
  }
  if (!$eligible) return null;

  usort($eligible, fn($a, $b) => pendingCountForCabine($pdo, $a['id']) <=> pendingCountForCabine($pdo, $b['id']));
  return $eligible[0];
}

// Attribution INITIALE (première création d'une commande) : contrairement
// à findReassignmentTarget ci-dessus, ne filtre PAS sur la présence en
// ligne (une commande peut naître avant même qu'une cabine ait pingué) et
// sélectionne au hasard parmi les cabines éligibles plutôt que par charge
// minimale — même contrat que DB.business.assignCabine (js/db.js).
function pickInitialCabine(PDO $pdo, ?string $operateur, ?string $type): ?array {
  $stmt = $pdo->query("SELECT * FROM profiles WHERE role = 'cabine' AND statut = 'actif' AND (en_pause = 0 OR en_pause IS NULL)");
  $candidates = $stmt->fetchAll();

  $eligible = [];
  foreach ($candidates as $cab) {
    if (isCabineAtLimit($pdo, $cab)) continue;
    if (hasBlockingReclamation($pdo, $cab['id'])) continue;
    if (!cabineAcceptsNetwork($cab, $operateur)) continue;
    if (!cabineAcceptsService($cab, $type)) continue;
    $eligible[] = $cab;
  }
  if (!$eligible) return null;

  return $eligible[random_int(0, count($eligible) - 1)];
}

// Commission active (voir DB.commissions.calc, js/db.js) — 5% par défaut
// tant qu'aucune règle explicite n'est active (même repli que côté local).
function calcCommission(PDO $pdo, int $montant): int {
  $stmt = $pdo->query("SELECT pourcentage FROM commissions WHERE actif = 1 LIMIT 1");
  $pct = $stmt->fetchColumn();
  if ($pct === false) $pct = 5;
  return (int)round($montant * ((float)$pct / 100));
}

// Suspension automatique 24h (retards, renvois répétés, remboursements
// répétés) — voir DB.business.suspendCabineAuto (js/db.js). suspendu_by
// NULL signale une suspension automatique, débloquable par n'importe quel
// administrateur.
function suspendCabineAuto(PDO $pdo, string $cabineId, string $motif): void {
  $jusqu = date('Y-m-d H:i:s', time() + 86400);
  $pdo->prepare("UPDATE profiles SET statut='suspendu', suspendu_auto=1, suspendu_by=NULL, suspendu_motif=?, suspendu_jusqu=? WHERE id=?")
      ->execute([$motif, $jusqu, $cabineId]);
  $pdo->prepare('INSERT INTO suspension_logs (id, cabine_id, motif, auto, date_debut, date_fin_prevue, date_levee, levee_par) VALUES (?, ?, ?, 1, NOW(), ?, NULL, NULL)')
      ->execute([uuid4(), $cabineId, $motif, $jusqu]);
  createNotification($cabineId, "Votre compte a été suspendu 24h : $motif.", 'warning');
}

// Lève une suspension automatique (feature 5) si son délai de 24h est
// expiré — voir DB.business.checkAutoUnsuspend (js/db.js). Une suspension
// MANUELLE (suspendu_by non nul) n'a pas d'échéance, jamais levée ici.
// L'UPDATE porte sa propre garde CAS (WHERE suspendu_auto=1 AND
// suspendu_jusqu=?) pour ne jamais lever deux fois la même suspension si
// deux requêtes concurrentes (deux onglets qui balaient en même temps)
// l'atteignent au même instant.
function checkAutoUnsuspend(PDO $pdo, string $cabineId): bool {
  $stmt = $pdo->prepare('SELECT suspendu_auto, suspendu_jusqu FROM profiles WHERE id = ?');
  $stmt->execute([$cabineId]);
  $c = $stmt->fetch();
  if (!$c || empty($c['suspendu_auto']) || !$c['suspendu_jusqu']) return false;
  if (strtotime($c['suspendu_jusqu']) > time()) return false;

  $upd = $pdo->prepare("UPDATE profiles SET statut='actif', suspendu_auto=0, suspendu_by=NULL, suspendu_motif=NULL, suspendu_jusqu=NULL
    WHERE id = ? AND suspendu_auto = 1 AND suspendu_jusqu = ?");
  $upd->execute([$cabineId, $c['suspendu_jusqu']]);
  if ($upd->rowCount() === 0) return false;

  $pdo->prepare("UPDATE suspension_logs SET date_levee = NOW(), levee_par = 'auto' WHERE cabine_id = ? AND date_levee IS NULL")->execute([$cabineId]);
  createNotification($cabineId, 'Votre compte a été réactivé automatiquement après la période de suspension de 24h.', 'success');
  return true;
}

// Effet financier d'un remboursement admin (voir orders_refund.php et
// orders_process_refund.php, qui l'appellent tous les deux — extrait ici
// pour ne jamais laisser diverger les deux copies). Suppose déjà dans une
// transaction PDO ouverte par l'appelant ; ne fait AUCUN commit/rollback
// elle-même. Retourne la ligne transactions telle qu'avant remboursement
// (utile pour les notifications post-commit).
function refundTransactionEffect(PDO $pdo, string $txnId): array {
  $PENALITE_REMBOURSEMENT_TERMINE = 60;

  $txnStmt = $pdo->prepare('SELECT * FROM transactions WHERE id = ? FOR UPDATE');
  $txnStmt->execute([$txnId]);
  $txn = $txnStmt->fetch();
  if (!$txn || ($txn['statut'] !== 'en_attente' && $txn['statut'] !== 'terminé')) {
    fail('Cette commande ne peut pas être remboursée.');
  }

  if ($txn['statut'] === 'terminé' && $txn['cabine_id']) {
    $cabStmt = $pdo->prepare('SELECT id FROM profiles WHERE id = ?');
    $cabStmt->execute([$txn['cabine_id']]);
    if ($cabStmt->fetch()) {
      $commission = (int)$txn['commission'];
      $sanction = (int)$txn['montant'] + $PENALITE_REMBOURSEMENT_TERMINE;
      $pdo->prepare('UPDATE profiles SET
          solde = solde - ?,
          commissions_total = GREATEST(0, commissions_total - ?),
          transferts_total = GREATEST(0, transferts_total - 1),
          remboursements_recus = remboursements_recus + 1
        WHERE id = ?')
        ->execute([$commission + $sanction, $commission, $txn['cabine_id']]);

      $pdo->prepare('INSERT INTO retraits (id, cabine_id, montant, statut, methode_retrait, type, motif, date) VALUES (?, ?, ?, \'terminé\', \'Sanction\', \'sanction\', ?, NOW())')
          ->execute([uuid4(), $txn['cabine_id'], $sanction, 'Remboursement commande — montant (' . number_format((float)$txn['montant'], 0, ',', ' ') . ' F) + pénalité (' . $PENALITE_REMBOURSEMENT_TERMINE . ' F)']);

      createNotification($txn['cabine_id'], 'Une commande que vous aviez marquée "Terminée" a été remboursée par l\'administration : ' . number_format((float)$sanction, 0, ',', ' ') . ' F (montant + pénalité de ' . $PENALITE_REMBOURSEMENT_TERMINE . ' F) ont été prélevés sur votre solde.', 'warning');
    }
  }

  $pdo->prepare('UPDATE profiles SET solde = solde + ? WHERE id = ?')->execute([(int)$txn['montant'], $txn['client_id']]);
  $pdo->prepare("UPDATE transactions SET statut='remboursé', date_remboursement=NOW() WHERE id=?")->execute([$txnId]);

  return $txn;
}
