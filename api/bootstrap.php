<?php
declare(strict_types=1);

// DIAGNOSTIC TEMPORAIRE (2e passage) — à retirer dès le problème identifié.
error_reporting(E_ALL);
ini_set('display_errors', '1');
set_exception_handler(function ($e) {
  http_response_code(500);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode(['error' => 'DIAG2: ' . get_class($e) . ': ' . $e->getMessage()]);
  exit;
});

// Bootstrap commun à tous les scripts de api/ — connexion MySQL (PDO),
// en-têtes CORS/JSON, aides communes. Remplace le rôle de js/supabase-
// client.js + supabase/functions/login (Supabase), voir README.md dans ce
// dossier pour le déploiement (aucune ligne de commande nécessaire).

// L'app Android empaquetée (Capacitor, origine différente du domaine réel)
// et le site web lui-même doivent tous les deux pouvoir appeler cette API
// — jamais de cookie/session de navigateur ici (voir requireAdminToken()
// plus bas, jeton explicite envoyé dans l'en-tête Authorization), donc
// autoriser toutes les origines ne pose pas de risque CSRF : un jeton ne
// peut pas être "rejoué" à l'insu de l'utilisateur comme le ferait un
// cookie automatique.
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
  http_response_code(204);
  exit;
}

$configFile = __DIR__ . '/config.php';
if (!file_exists($configFile)) {
  http_response_code(500);
  echo json_encode(['error' => "Configuration serveur manquante — copie config.example.php en config.php et renseigne tes identifiants MySQL."]);
  exit;
}
require $configFile;

function db(): PDO {
  static $pdo = null;
  if ($pdo === null) {
    $pdo = new PDO(
      'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
      DB_USER, DB_PASS,
      [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        // Requêtes préparées natives (pas émulées) : avec l'émulation par
        // défaut de PDO, TOUTE colonne numérique revient sous forme de
        // chaîne de texte (ex. "1000" au lieu de 1000), y compris dans le
        // JSON renvoyé au client — un bug latent depuis la Phase 1, jamais
        // visible tant que rien côté JS ne faisait d'arithmétique directe
        // sur un champ serveur fraîchement synchronisé (Fmt.money()
        // coerce déjà via Math.round(), masquant le symptôme). Devient
        // bloquant avec le moteur de commandes (Phase 4) : une somme comme
        // `0 + t.montant` deviendrait une concaténation de texte ("01000")
        // au lieu d'une addition si `montant` restait une chaîne.
        PDO::ATTR_EMULATE_PREPARES => false,
      ]
    );
  }
  return $pdo;
}

// Corps JSON de la requête POST courante (tableau associatif, jamais null).
function body(): array {
  $raw = file_get_contents('php://input');
  $data = json_decode($raw, true);
  return is_array($data) ? $data : [];
}

// Réponse d'erreur JSON standard + arrêt immédiat — même format que
// { error } déjà utilisé côté JS (voir SupabaseAPI.login() historique,
// js/supabase-client.js, remplacé par ServerAPI).
function fail(string $message, int $status = 400): void {
  http_response_code($status);
  echo json_encode(['error' => $message]);
  exit;
}

// UUID v4 — remplace gen_random_uuid() (Postgres), aucune extension MySQL
// requise. Utilisé comme identifiant de profil, cohérent avec l'ancien
// schéma Supabase (id uuid).
function uuid4(): string {
  $data = random_bytes(16);
  $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
  $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);
  return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
}

// Vérifie l'en-tête "Authorization: Bearer <jeton>" émis par login.php (voir
// la table `sessions`) — remplace la vérification de session Supabase Auth
// (RLS + current_profile_role()). Retourne le profil appelant ou arrête la
// requête (401/403) si absent/expiré/rôle non autorisé.
//
// $roles : null = n'importe quel rôle authentifié suffit ; sinon un tableau
// des rôles autorisés (ex. ['cabine','admin']) — utilisé par les nouveaux
// endpoints Phase 2 (favoris, transactions, présence...) où client/cabine/
// admin doivent chacun pouvoir agir sur leurs propres données.
function requireAuth(?array $roles = null): array {
  $header = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
  if (!preg_match('/^Bearer\s+(.+)$/i', $header, $m)) fail('Authentification requise.', 401);
  $tokenHash = hash('sha256', trim($m[1]));
  $stmt = db()->prepare('SELECT profile_id, role, expires_at FROM sessions WHERE token_hash = ?');
  $stmt->execute([$tokenHash]);
  $row = $stmt->fetch();
  if (!$row || strtotime($row['expires_at']) < time()) fail('Session expirée, reconnectez-vous.', 401);
  if ($roles !== null && !in_array($row['role'], $roles, true)) fail('Accès refusé pour ce rôle.', 403);
  $stmt = db()->prepare('SELECT * FROM profiles WHERE id = ?');
  $stmt->execute([$row['profile_id']]);
  $profile = $stmt->fetch();
  if (!$profile) fail('Compte introuvable.', 401);
  return $profile;
}

// Alias historique — réservé à l'administration (voir requireAuth ci-dessus).
function requireAdminToken(): array {
  return requireAuth(['admin']);
}

// Autorise soit une session normale (n'importe quel rôle — même contrat que
// requireAuth() sans argument, pour rester appelable par le sondage
// périodique client.js/cabine.js/admin.js déjà en place), soit un appel
// "hors session" authentifié par un secret partagé (en-tête
// X-Cron-Secret) — seul moyen pour un déclencheur externe (ex. tâche
// planifiée GitHub Actions, voir .github/workflows/) d'appeler un endpoint
// sans qu'aucun appareil n'ait besoin d'être ouvert. CRON_SECRET n'est
// défini que si l'hébergeur l'a configuré (voir config.example.php) —
// hash_equals() pour une comparaison à temps constant, comme un jeton de
// session classique.
function requireAuthOrCron(): void {
  $secret = $_SERVER['HTTP_X_CRON_SECRET'] ?? '';
  if (defined('CRON_SECRET') && CRON_SECRET !== '' && $secret !== '' && hash_equals(CRON_SECRET, $secret)) return;
  requireAuth();
}

// Décode les colonnes JSON (stockées en texte par MySQL, contrairement à
// Postgres/jsonb) avant de les renvoyer au client — utilisé par
// settings_get.php/settings_update.php.
function decodeJsonColumns(array $row, array $columns): array {
  foreach ($columns as $col) {
    if (isset($row[$col]) && is_string($row[$col])) $row[$col] = json_decode($row[$col], true);
  }
  return $row;
}

require __DIR__ . '/push_common.php';

// Crée une notification pour un utilisateur — équivalent serveur de
// DB.notifications.create() (js/db.js), utilisé par tous les endpoints du
// moteur de commandes (Phase 4). Best-effort intentionnel : jamais dans la
// même transaction PDO qu'une mutation financière (voir orders_accept.php
// etc.) pour qu'un échec d'écriture de notification ne fasse jamais annuler
// un débit/crédit déjà validé. Déclenche aussi une notification push sur
// le téléphone (voir sendPushToProfile(), api/push_common.php) — même
// best-effort, un échec d'envoi push ne remonte jamais ici non plus.
// Catégories seules autorisées côté CLIENT (demande explicite) : sa
// commande en cours, sa commande terminée, un transfert client-à-client
// envoyé ou reçu, sa réclamation en cours, sa réclamation terminée — tout
// le reste (remboursement, recharge de portefeuille, cadeau/parrainage,
// statut de candidature partenaire...) ne doit jamais lui être créé.
// Cabine/admin ne sont pas concernés par ce filtre.
const CLIENT_NOTIFICATION_TYPES = [
  'order_pending', 'order_completed', 'transfer_sent', 'transfer_received',
  'reclamation_pending', 'reclamation_completed',
];

function createNotification(string $userId, string $message, string $type = 'info'): void {
  $roleStmt = db()->prepare('SELECT role FROM profiles WHERE id = ?');
  $roleStmt->execute([$userId]);
  if ($roleStmt->fetchColumn() === 'client' && !in_array($type, CLIENT_NOTIFICATION_TYPES, true)) return;

  db()->prepare('INSERT INTO notifications (id, utilisateur_id, message, lu, date, type) VALUES (?, ?, ?, 0, NOW(), ?)')
      ->execute([uuid4(), $userId, $message, $type]);
  sendPushToProfile($userId, 'KBINE PLUS', $message);
}

// Diffusion à TOUTES les cabines (recharge/transfert/cadeau client, commande
// passée) — demande explicite du client de l'app : chaque cabine doit être
// notifiée de l'activité de N'IMPORTE QUEL client, pas seulement de celle
// qui la concerne directement. Best-effort comme createNotification()
// elle-même, appelée une fois par cabine.
function notifyAllCabines(string $message, string $type = 'info'): void {
  $stmt = db()->query("SELECT id FROM profiles WHERE role = 'cabine'");
  foreach ($stmt->fetchAll() as $row) {
    createNotification($row['id'], $message, $type);
  }
}

// Diffusion à TOUS les administrateurs — même patron que notifyAllCabines()
// ci-dessus, utilisée pour l'alerte de seuil de solde cabine ci-dessous.
function notifyAllAdmins(string $message, string $type = 'info'): void {
  $stmt = db()->query("SELECT id FROM profiles WHERE role = 'admin'");
  foreach ($stmt->fetchAll() as $row) {
    createNotification($row['id'], $message, $type);
  }
}

// Alerte l'administration quand le solde disponible d'une cabine dépasse
// 50 000 F suite à un crédit — seuls deux cas font réellement augmenter le
// solde réel d'une cabine (recharge par un admin, voir orders_recharge.php,
// et transfert reçu d'une autre cabine, voir cabine_transfer.php ; la
// commission n'est plus créditée au solde réel, voir orders_accept.php).
// Ne se déclenche qu'au moment où le solde FRANCHIT le seuil vers le haut
// (soldeAvant <= seuil < soldeApres) — pas de colonne d'état à maintenir,
// le franchissement se déduit directement des deux valeurs au moment du
// crédit, sans jamais re-notifier tant que le solde reste au-dessus.
function notifyAdminsIfCabineSoldeCrossed(PDO $pdo, string $cabineId, int $soldeAvant, int $soldeApres): void {
  $CABINE_SOLDE_SEUIL = 50000;
  if ($soldeAvant > $CABINE_SOLDE_SEUIL || $soldeApres <= $CABINE_SOLDE_SEUIL) return;
  $stmt = $pdo->prepare('SELECT nom, prenom, cabine_nom FROM profiles WHERE id = ?');
  $stmt->execute([$cabineId]);
  $cab = $stmt->fetch();
  if (!$cab) return;
  $name = $cab['cabine_nom'] ?: trim($cab['prenom'] . ' ' . $cab['nom']);
  notifyAllAdmins('La cabine ' . $name . ' a dépassé 50 000 F de solde disponible (' . number_format((float)$soldeApres, 0, ',', ' ') . ' F).', 'warning');
}
