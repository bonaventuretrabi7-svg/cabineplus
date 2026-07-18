<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Liste des demandes de réinitialisation — réservée à l'administration.
// Une demande venant d'un compte admin est visible UNIQUEMENT du super
// administrateur (même règle que loadResetRequests(), js/admin.js) ; les
// demandes client/cabine restent visibles à tout admin disposant de la
// permission. Le hash du nouveau mot de passe n'est jamais renvoyé.
$me = requireAuth(['admin']);

$rows = $me['admin_level'] === 'super'
  ? db()->query('SELECT * FROM reset_requests ORDER BY date_created DESC')->fetchAll()
  : db()->query("SELECT * FROM reset_requests WHERE role != 'admin' ORDER BY date_created DESC")->fetchAll();

foreach ($rows as &$r) unset($r['nouveau_mot_de_passe_hash']);
unset($r);

echo json_encode(['resetRequests' => $rows]);
