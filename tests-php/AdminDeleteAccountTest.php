<?php
declare(strict_types=1);

// api/admin_delete_account.php — remplace deleteUser() (js/admin.js), qui
// ne supprimait jusqu'ici que le cache LOCAL de l'admin (DB.users.delete()),
// jamais rien côté serveur. Action la plus destructrice de toute l'app :
// ces tests couvrent en priorité les garde-fous (auto-suppression, super
// admin protégé, restriction super admin) et l'exhaustivité de la
// cascade (aucune ligne orpheline dans aucune table liée).
final class AdminDeleteAccountTest extends ApiTestCase
{
    public function testSuperAdminCanDeleteAClientAccount(): void
    {
        $super = Fixtures::createProfile('admin', ['admin_level' => 'super']);
        $client = Fixtures::createProfile('client');

        $res = ApiClient::post('/admin_delete_account.php', ['id' => $client['profile']['id']], $super['token']);
        $this->assertTrue($res->ok(), $res->raw);
        $this->assertNull(Fixtures::fetchProfile($client['profile']['id']));
    }

    public function testCannotDeleteOwnAccount(): void
    {
        $super = Fixtures::createProfile('admin', ['admin_level' => 'super']);
        $res = ApiClient::post('/admin_delete_account.php', ['id' => $super['profile']['id']], $super['token']);
        $this->assertFalse($res->ok());
        $this->assertNotNull(Fixtures::fetchProfile($super['profile']['id']));
    }

    public function testCannotDeleteAnySuperAdminAccountEvenByAnotherSuperAdmin(): void
    {
        $superA = Fixtures::createProfile('admin', ['admin_level' => 'super']);
        $superB = Fixtures::createProfile('admin', ['admin_level' => 'super']);

        $res = ApiClient::post('/admin_delete_account.php', ['id' => $superB['profile']['id']], $superA['token']);
        $this->assertFalse($res->ok());
        $this->assertNotNull(Fixtures::fetchProfile($superB['profile']['id']));
    }

    public function testRegularAdminCannotDeleteAnyAccount(): void
    {
        $regularAdmin = Fixtures::createProfile('admin', ['admin_level' => 'standard']);
        $client = Fixtures::createProfile('client');

        $res = ApiClient::post('/admin_delete_account.php', ['id' => $client['profile']['id']], $regularAdmin['token']);
        $this->assertSame(403, $res->status);
        $this->assertNotNull(Fixtures::fetchProfile($client['profile']['id']));
    }

    public function testDeletingUnknownAccountFails(): void
    {
        $super = Fixtures::createProfile('admin', ['admin_level' => 'super']);
        $res = ApiClient::post('/admin_delete_account.php', ['id' => 'id-inexistant'], $super['token']);
        $this->assertSame(404, $res->status);
    }

    public function testDeletingCabineCascadesEverythingWithNoOrphanRows(): void
    {
        $super = Fixtures::createProfile('admin', ['admin_level' => 'super']);
        $client = Fixtures::createProfile('client');
        $cabine = Fixtures::createProfile('cabine');
        $otherCabine = Fixtures::createProfile('cabine');
        $pdo = Fixtures::pdo();

        // Une commande, une reclamation + message, une demande de
        // remboursement, un retrait, un retard, un renvoi, un transfert
        // cabine-a-cabine, un reabonnement, une notification, une session,
        // un appareil, une presence -- tout ce qui peut referencer cette
        // cabine.
        $txn = Fixtures::createTransaction(['client_id' => $client['profile']['id'], 'cabine_id' => $cabine['profile']['id'], 'statut' => 'terminé']);
        $reclaId = bin2hex(random_bytes(16));
        $pdo->prepare('INSERT INTO reclamations (id, transaction_id, client_id, cabine_id, motif, statut, date_created) VALUES (?, ?, ?, ?, \'motif\', \'en_attente\', NOW())')
            ->execute([$reclaId, $txn['id'], $client['profile']['id'], $cabine['profile']['id']]);
        $pdo->prepare('INSERT INTO reclamation_messages (id, reclamation_id, sender, type, texte, date) VALUES (UUID(), ?, \'client\', \'texte\', \'msg\', NOW())')
            ->execute([$reclaId]);
        $pdo->prepare('INSERT INTO refund_requests (id, reclamation_id, transaction_id, cabine_id, client_id, statut, date_created) VALUES (UUID(), ?, ?, ?, ?, \'en_attente\', NOW())')
            ->execute([$reclaId, $txn['id'], $cabine['profile']['id'], $client['profile']['id']]);
        $pdo->prepare('INSERT INTO retraits (id, cabine_id, montant, statut, date) VALUES (UUID(), ?, 1000, \'terminé\', NOW())')->execute([$cabine['profile']['id']]);
        $pdo->prepare('INSERT INTO retards (id, transaction_id, cabine_id, date) VALUES (UUID(), ?, ?, NOW())')->execute([$txn['id'], $cabine['profile']['id']]);
        $pdo->prepare('INSERT INTO cabine_refusals (id, cabine_id, date) VALUES (UUID(), ?, NOW())')->execute([$cabine['profile']['id']]);
        $pdo->prepare('INSERT INTO transferts_cabine (id, from_cabine_id, to_cabine_id, montant, frais, date) VALUES (UUID(), ?, ?, 500, 150, NOW())')->execute([$cabine['profile']['id'], $otherCabine['profile']['id']]);
        $pdo->prepare('INSERT INTO resubscriptions (id, cabine_id, formule, prix, date) VALUES (UUID(), ?, \'Premium\', 10000, NOW())')->execute([$cabine['profile']['id']]);
        $pdo->prepare('INSERT INTO suspension_logs (id, cabine_id, motif, date_debut) VALUES (UUID(), ?, \'motif\', NOW())')->execute([$cabine['profile']['id']]);
        $pdo->prepare('INSERT INTO notifications (id, utilisateur_id, message, date, type) VALUES (UUID(), ?, \'msg\', NOW(), \'info\')')->execute([$cabine['profile']['id']]);
        $pdo->prepare('INSERT INTO sessions (token_hash, profile_id, role, expires_at) VALUES (UUID(), ?, \'cabine\', DATE_ADD(NOW(), INTERVAL 1 DAY))')->execute([$cabine['profile']['id']]);
        $pdo->prepare('INSERT INTO devices (id, profile_id, device_id, last_seen_at) VALUES (UUID(), ?, UUID(), NOW())')->execute([$cabine['profile']['id']]);
        $pdo->prepare('INSERT INTO presence (profile_id, last_seen_at) VALUES (?, NOW())')->execute([$cabine['profile']['id']]);

        $res = ApiClient::post('/admin_delete_account.php', ['id' => $cabine['profile']['id']], $super['token']);
        $this->assertTrue($res->ok(), $res->raw);

        $cabineId = $cabine['profile']['id'];
        $this->assertNull(Fixtures::fetchProfile($cabineId));
        $this->assertSame(0, (int)$pdo->query("SELECT COUNT(*) FROM transactions WHERE cabine_id = '$cabineId'")->fetchColumn());
        $this->assertSame(0, (int)$pdo->query("SELECT COUNT(*) FROM reclamations WHERE cabine_id = '$cabineId'")->fetchColumn());
        $this->assertSame(0, (int)$pdo->query("SELECT COUNT(*) FROM reclamation_messages WHERE reclamation_id = '$reclaId'")->fetchColumn());
        $this->assertSame(0, (int)$pdo->query("SELECT COUNT(*) FROM refund_requests WHERE cabine_id = '$cabineId'")->fetchColumn());
        $this->assertSame(0, (int)$pdo->query("SELECT COUNT(*) FROM retraits WHERE cabine_id = '$cabineId'")->fetchColumn());
        $this->assertSame(0, (int)$pdo->query("SELECT COUNT(*) FROM retards WHERE cabine_id = '$cabineId'")->fetchColumn());
        $this->assertSame(0, (int)$pdo->query("SELECT COUNT(*) FROM cabine_refusals WHERE cabine_id = '$cabineId'")->fetchColumn());
        $this->assertSame(0, (int)$pdo->query("SELECT COUNT(*) FROM transferts_cabine WHERE from_cabine_id = '$cabineId' OR to_cabine_id = '$cabineId'")->fetchColumn());
        $this->assertSame(0, (int)$pdo->query("SELECT COUNT(*) FROM resubscriptions WHERE cabine_id = '$cabineId'")->fetchColumn());
        $this->assertSame(0, (int)$pdo->query("SELECT COUNT(*) FROM suspension_logs WHERE cabine_id = '$cabineId'")->fetchColumn());
        $this->assertSame(0, (int)$pdo->query("SELECT COUNT(*) FROM notifications WHERE utilisateur_id = '$cabineId'")->fetchColumn());
        $this->assertSame(0, (int)$pdo->query("SELECT COUNT(*) FROM sessions WHERE profile_id = '$cabineId'")->fetchColumn());
        $this->assertSame(0, (int)$pdo->query("SELECT COUNT(*) FROM devices WHERE profile_id = '$cabineId'")->fetchColumn());
        $this->assertSame(0, (int)$pdo->query("SELECT COUNT(*) FROM presence WHERE profile_id = '$cabineId'")->fetchColumn());

        // La cabine tierce (destinataire du transfert) ne doit surtout pas
        // avoir ete touchee.
        $this->assertNotNull(Fixtures::fetchProfile($otherCabine['profile']['id']));
    }

    public function testDeletingClientRemovesReferralsAndFavoris(): void
    {
        $super = Fixtures::createProfile('admin', ['admin_level' => 'super']);
        $referrer = Fixtures::createProfile('client');
        $referred = Fixtures::createProfile('client');
        $pdo = Fixtures::pdo();
        $pdo->prepare('INSERT INTO referrals (id, referrer_id, referred_id, reward_montant, reward_verse, date) VALUES (UUID(), ?, ?, 50, 0, NOW())')
            ->execute([$referrer['profile']['id'], $referred['profile']['id']]);
        $pdo->prepare('INSERT INTO favoris (id, client_id, nom, numero, date_creation) VALUES (UUID(), ?, \'Maman\', \'0700000000\', NOW())')
            ->execute([$referred['profile']['id']]);

        $res = ApiClient::post('/admin_delete_account.php', ['id' => $referred['profile']['id']], $super['token']);
        $this->assertTrue($res->ok(), $res->raw);

        $referredId = $referred['profile']['id'];
        $this->assertSame(0, (int)$pdo->query("SELECT COUNT(*) FROM referrals WHERE referred_id = '$referredId'")->fetchColumn());
        $this->assertSame(0, (int)$pdo->query("SELECT COUNT(*) FROM favoris WHERE client_id = '$referredId'")->fetchColumn());
        // Le parrain, lui, doit rester intact.
        $this->assertNotNull(Fixtures::fetchProfile($referrer['profile']['id']));
    }
}
