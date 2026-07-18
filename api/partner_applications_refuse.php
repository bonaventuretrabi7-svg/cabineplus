<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Refuse une candidature partenaire — remplace refusePartnerRequest()
// (js/admin.js).
requireAuth(['admin']);

$in = body();
$id = (string)($in['application_id'] ?? '');
if ($id === '') fail('Identifiant de candidature requis.');

$stmt = db()->prepare("UPDATE partner_applications SET statut = 'refusée', date_traitement = NOW() WHERE id = ? AND statut = 'en_attente'");
$stmt->execute([$id]);
if ($stmt->rowCount() === 0) fail('Candidature introuvable ou déjà traitée.');

echo json_encode(['ok' => true]);
