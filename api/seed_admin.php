<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

// Crée le compte super admin — équivalent de supabase/migrations/0003_seed.sql.
// Un hash bcrypt ne peut pas être calculé en SQL pur côté MySQL (contrairement
// à Postgres/pgcrypto), d'où ce petit script PHP à visiter UNE SEULE FOIS
// dans un navigateur juste après avoir créé les tables (schema.sql) —
// aucune ligne de commande. Ne fait rien (et n'écrase rien) si un super
// admin existe déjà. SUPPRIME CE FICHIER une fois utilisé : il n'a plus
// aucune utilité ensuite et ne doit pas rester accessible publiquement.

$pdo = db();
$stmt = $pdo->query("SELECT id FROM profiles WHERE role = 'admin' AND admin_level = 'super' LIMIT 1");
if ($stmt->fetch()) {
  echo json_encode(['ok' => false, 'message' => 'Un super administrateur existe déjà — rien à faire.']);
  exit;
}

$id = uuid4();
$pdo->prepare("INSERT INTO profiles (id, nom, prenom, telephone, email, mot_de_passe_hash, role, solde, statut, admin_level, zone, date_creation)
               VALUES (?, ?, ?, ?, ?, ?, 'admin', 0, 'actif', 'super', ?, NOW())")
    ->execute([$id, 'TRA BI', 'BONAVENTURE VANIE HOLLAND', '0789794720', 'bonaventuretrab7@gmail.com', password_hash('1973', PASSWORD_BCRYPT), 'Abidjan']);

echo json_encode(['ok' => true, 'message' => 'Super administrateur créé. Supprime maintenant ce fichier (seed_admin.php).']);
