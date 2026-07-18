<?php
declare(strict_types=1);

// Accès direct à la base de test (MariaDB locale, voir tests-php/bootstrap.php)
// pour la remise à zéro entre tests et la création de profils/jetons de
// session sans repasser par create_account.php/login.php à chaque fois (sauf
// dans les tests qui vérifient ces endpoints eux-mêmes).
final class Fixtures
{
    private static ?PDO $pdo = null;

    public static function pdo(): PDO
    {
        if (self::$pdo === null) {
            self::$pdo = new PDO(
                'mysql:host=' . TEST_DB_HOST . ';dbname=' . TEST_DB_NAME . ';charset=utf8mb4',
                TEST_DB_USER, TEST_DB_PASS,
                [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
            );
        }
        return self::$pdo;
    }

    private static function uuid4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }

    private const TABLES = [
        'access_logs', 'cabine_refusals', 'commissions', 'favoris', 'forfaits',
        'maintenance_logs', 'notifications', 'permission_logs', 'presence',
        'profiles', 'reclamation_messages', 'reclamations', 'refund_requests',
        'resubscriptions', 'retards', 'retraits', 'reset_requests', 'partner_applications', 'devices', 'referrals', 'sessions', 'settings',
        'suspension_logs', 'transactions', 'transferts_cabine',
    ];

    // Vide toutes les tables métier et recrée les lignes singleton attendues
    // (settings, commission par défaut) — même contenu que les INSERT IGNORE
    // de api/schema.sql, pour une base identique avant chaque test.
    public static function reset(): void
    {
        $pdo = self::pdo();
        $pdo->exec('SET FOREIGN_KEY_CHECKS = 0');
        foreach (self::TABLES as $t) {
            $pdo->exec("TRUNCATE TABLE `$t`");
        }
        $pdo->exec('SET FOREIGN_KEY_CHECKS = 1');

        $pdo->exec("INSERT INTO settings (id) VALUES (1)");
        $pdo->prepare('INSERT INTO commissions (id, label, pourcentage, montant_min, montant_max, actif, date) VALUES (?, ?, 5, 0, 99999, 1, NOW())')
            ->execute([self::uuid4(), 'Commission standard']);
    }

    // Crée un profil directement en base (mot de passe = PIN '1234' par
    // défaut, haché) et retourne ['profile' => ligne DB, 'pin' => PIN en
    // clair, 'token' => jeton de session valide (comme après login.php)].
    public static function createProfile(string $role, array $overrides = []): array
    {
        $pdo = self::pdo();
        $id = self::uuid4();
        $suffix = substr($id, 0, 8);
        $pin = $overrides['pin'] ?? '1234';
        unset($overrides['pin']);

        $defaults = [
            'id' => $id,
            'nom' => ucfirst($role),
            'prenom' => 'Test',
            'telephone' => '07' . substr(bin2hex(random_bytes(4)), 0, 8),
            'email' => $role . '.' . $suffix . '@test.local',
            'mot_de_passe_hash' => password_hash($pin, PASSWORD_BCRYPT),
            'role' => $role,
            'solde' => 0,
            'statut' => 'actif',
            'admin_level' => $role === 'admin' ? 'super' : null,
            'zone' => null,
            'cabine_nom' => $role === 'cabine' ? 'Cabine ' . $suffix : null,
            'commissions_total' => 0,
            'transferts_total' => 0,
            'limite_commandes' => null,
            'tentatives_echouees' => 0,
            'suspendu_auto' => 0,
            'suspendu_by' => null,
            'suspendu_motif' => null,
            'suspendu_jusqu' => null,
            'abonnement' => $role === 'cabine' ? 'Premium' : null,
            'en_pause' => 0,
            'reseaux_actifs' => null,
            'services_actifs' => null,
            'commandes_renvoyees' => 0,
            'remboursements_recus' => 0,
        ];
        $row = array_merge($defaults, $overrides);

        $cols = array_keys($row);
        $placeholders = implode(',', array_fill(0, count($cols), '?'));
        $colList = implode(',', array_map(fn($c) => "`$c`", $cols));
        $pdo->prepare("INSERT INTO profiles ($colList) VALUES ($placeholders)")->execute(array_values($row));

        $stmt = $pdo->prepare('SELECT * FROM profiles WHERE id = ?');
        $stmt->execute([$id]);
        $saved = $stmt->fetch();

        return [
            'profile' => $saved,
            'pin' => $pin,
            'token' => self::mintToken($id, $role),
        ];
    }

    // Émet un jeton de session valide directement en base — même schéma que
    // login.php (token_hash = sha256(token), expire dans 30 jours).
    public static function mintToken(string $profileId, string $role): string
    {
        $token = bin2hex(random_bytes(32));
        self::pdo()->prepare('INSERT INTO sessions (token_hash, profile_id, role, expires_at) VALUES (?, ?, ?, ?)')
            ->execute([hash('sha256', $token), $profileId, $role, date('Y-m-d H:i:s', time() + 2592000)]);
        return $token;
    }

    public static function ping(string $profileId): void
    {
        self::pdo()->prepare('INSERT INTO presence (profile_id, last_seen_at) VALUES (?, NOW())
            ON DUPLICATE KEY UPDATE last_seen_at = NOW()')->execute([$profileId]);
    }

    public static function fetchProfile(string $id): ?array
    {
        $stmt = self::pdo()->prepare('SELECT * FROM profiles WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        return $row === false ? null : $row;
    }

    public static function fetchTransaction(string $id): ?array
    {
        $stmt = self::pdo()->prepare('SELECT * FROM transactions WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        return $row === false ? null : $row;
    }

    // Insère une transaction directement (contourne orders_create.php quand
    // le test porte sur un endpoint EN AVAL de la création : accept/refuse/
    // suspend/réclamation...).
    public static function createTransaction(array $overrides = []): array
    {
        $pdo = self::pdo();
        $id = $overrides['id'] ?? self::uuid4();
        unset($overrides['id']);

        $defaults = [
            'client_id' => null,
            'cabine_id' => null,
            'type' => 'transfert',
            'service' => 'Transfert direct',
            'operateur' => 'Orange',
            'numero_beneficiaire' => '0700000000',
            'montant' => 1000,
            'frais_service' => 15,
            'commission' => 50,
            'statut' => 'en_attente',
        ];
        $row = array_merge($defaults, $overrides);
        $row['id'] = $id;

        $cols = array_keys($row);
        $placeholders = implode(',', array_fill(0, count($cols), '?'));
        $colList = implode(',', array_map(fn($c) => "`$c`", $cols));
        $pdo->prepare("INSERT INTO transactions ($colList) VALUES ($placeholders)")->execute(array_values($row));

        return self::fetchTransaction($id);
    }
}
