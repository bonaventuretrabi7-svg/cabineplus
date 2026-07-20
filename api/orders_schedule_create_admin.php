<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';
require __DIR__ . '/orders_common.php';

// Programmation d'une commande automatique par le SUPER administrateur —
// aucun paiement (client_id NULL, created_by_admin_id renseigné). Une fois
// déclenchée (voir api/orders_sweep_scheduled.php), la commande est traitée
// exactement comme une commande normale (commission/quota de la cabine
// comptés normalement — choix explicite de l'administration), seule
// différence : aucun solde client n'a été débité au départ.
$me = requireAuth(['admin']);
if ($me['admin_level'] !== 'super') fail('Seul le super administrateur peut programmer une commande automatique.', 403);

$in = body();
$operateur          = (string)($in['operateur'] ?? '');
$numeroBeneficiaire = (string)($in['numero_beneficiaire'] ?? '');
$montant             = (int)($in['montant'] ?? 0);
$service             = isset($in['service']) && $in['service'] !== '' ? (string)$in['service'] : 'Transfert direct';
$datesProgrammee     = (string)($in['date_programmee'] ?? '');

if ($operateur === '' || $numeroBeneficiaire === '' || $montant <= 0) fail('Paramètres de commande invalides.');
$ts = strtotime($datesProgrammee);
if (!$ts) fail('Date/heure programmée invalide.');
if ($ts <= time() + 60) fail('La date/heure programmée doit être au moins 1 minute dans le futur.');

$cpId = uuid4();
db()->prepare('INSERT INTO commandes_programmees
    (id, created_by_admin_id, operateur, numero_beneficiaire, montant, frais_service, service, date_programmee, statut, date_creation)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, \'en_attente\', NOW())')
    ->execute([$cpId, $me['id'], $operateur, $numeroBeneficiaire, $montant, $service, date('Y-m-d H:i:s', $ts)]);

$cpStmt = db()->prepare('SELECT * FROM commandes_programmees WHERE id = ?');
$cpStmt->execute([$cpId]);
echo json_encode(['ok' => true, 'commande' => $cpStmt->fetch()]);
