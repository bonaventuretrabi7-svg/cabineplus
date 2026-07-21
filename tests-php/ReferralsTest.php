<?php
declare(strict_types=1);

// api/create_account.php (parrain_telephone) + creditReferralRewardIfFirstOrder()
// (api/orders_common.php, appelée depuis orders_accept.php) +
// api/referrals_summary.php (Phase H) — le parrainage n'était même pas
// implémenté en local (compteurs figés à 0, aucune règle nulle part).
// Règle validée : 50 F crédités au parrain dès la 1re commande terminée
// du filleul (montant déjà annoncé dans l'UI existante, "+50 F par ami
// inscrit").
final class ReferralsTest extends ApiTestCase
{
    public function testCreateAccountWithValidReferrerLinksTheAccounts(): void
    {
        $referrer = Fixtures::createProfile('client', ['telephone' => '0700000001']);

        $res = ApiClient::post('/create_account.php', [
            'role' => 'client', 'prenom' => 'Filleul', 'telephone' => '0700000002', 'pin' => '1234', 'parrain_telephone' => '0700000001',
        ]);
        $this->assertTrue(isset($res->json['profile']));

        $row = Fixtures::pdo()->query("SELECT * FROM referrals WHERE referrer_id = '{$referrer['profile']['id']}'")->fetch();
        $this->assertNotFalse($row);
        $this->assertSame(50, (int)$row['reward_montant']);
        $this->assertSame(0, (int)$row['reward_verse']);
    }

    public function testCreateAccountWithUnknownReferrerJustSkipsSilently(): void
    {
        $res = ApiClient::post('/create_account.php', [
            'role' => 'client', 'prenom' => 'Filleul', 'telephone' => '0700000002', 'pin' => '1234', 'parrain_telephone' => '0799999999',
        ]);
        $this->assertTrue(isset($res->json['profile']), 'la creation du compte ne doit jamais echouer a cause d\'un code parrain invalide');
        $count = (int)Fixtures::pdo()->query('SELECT COUNT(*) FROM referrals')->fetchColumn();
        $this->assertSame(0, $count);
    }

    public function testSelfReferralIsIgnored(): void
    {
        ApiClient::post('/create_account.php', [
            'role' => 'client', 'prenom' => 'Filleul', 'telephone' => '0700000001', 'pin' => '1234', 'parrain_telephone' => '0700000001',
        ]);
        $count = (int)Fixtures::pdo()->query('SELECT COUNT(*) FROM referrals')->fetchColumn();
        $this->assertSame(0, $count);
    }

    public function testReferrerIsCreditedOnReferredClientsFirstCompletedOrder(): void
    {
        $referrer = Fixtures::createProfile('client', ['telephone' => '0700000001', 'solde' => 0]);
        ApiClient::post('/create_account.php', [
            'role' => 'client', 'prenom' => 'Filleul', 'telephone' => '0700000002', 'pin' => '1234', 'parrain_telephone' => '0700000001',
        ]);
        $referredLogin = ApiClient::post('/login.php', ['identifiant' => '0700000002', 'pin' => '1234', 'role' => 'client'], null);
        $referredToken = $referredLogin->json['token'];
        $referredId = $referredLogin->json['profile']['id'];

        // Credite le filleul pour qu'il puisse transferer.
        Fixtures::pdo()->prepare('UPDATE profiles SET solde = 5000 WHERE id = ?')->execute([$referredId]);

        $cabine = Fixtures::createProfile('cabine');
        Fixtures::ping($cabine['profile']['id']);

        $order = ApiClient::post('/orders_create.php', [
            'operateur' => 'Orange', 'numero_beneficiaire' => '0700000000', 'montant' => 1000,
        ], $referredToken);
        $this->assertTrue($order->ok(), $order->raw);
        $txnId = $order->json['transaction']['id'];

        $accept = ApiClient::post('/orders_accept.php', ['transaction_id' => $txnId], $cabine['token']);
        $this->assertTrue($accept->ok(), $accept->raw);

        $referrerAfter = Fixtures::fetchProfile($referrer['profile']['id']);
        $this->assertSame(50, (int)$referrerAfter['solde'], 'le parrain doit avoir recu exactement 50 F');

        $refRow = Fixtures::pdo()->query("SELECT reward_verse FROM referrals WHERE referred_id = '$referredId'")->fetch();
        $this->assertSame(1, (int)$refRow['reward_verse']);
    }

    public function testSecondCompletedOrderDoesNotCreditAgain(): void
    {
        $referrer = Fixtures::createProfile('client', ['telephone' => '0700000001', 'solde' => 0]);
        ApiClient::post('/create_account.php', [
            'role' => 'client', 'prenom' => 'Filleul', 'telephone' => '0700000002', 'pin' => '1234', 'parrain_telephone' => '0700000001',
        ]);
        $referredLogin = ApiClient::post('/login.php', ['identifiant' => '0700000002', 'pin' => '1234', 'role' => 'client'], null);
        $referredToken = $referredLogin->json['token'];
        $referredId = $referredLogin->json['profile']['id'];
        Fixtures::pdo()->prepare('UPDATE profiles SET solde = 10000 WHERE id = ?')->execute([$referredId]);

        $cabine = Fixtures::createProfile('cabine');
        Fixtures::ping($cabine['profile']['id']);

        foreach ([1000, 1000] as $montant) {
            $order = ApiClient::post('/orders_create.php', ['operateur' => 'Orange', 'numero_beneficiaire' => '0700000000', 'montant' => $montant], $referredToken);
            ApiClient::post('/orders_accept.php', ['transaction_id' => $order->json['transaction']['id']], $cabine['token']);
        }

        $referrerAfter = Fixtures::fetchProfile($referrer['profile']['id']);
        $this->assertSame(50, (int)$referrerAfter['solde'], 'un seul versement, jamais un par commande');
    }

    public function testReferralsSummaryReturnsCountAndTotal(): void
    {
        $referrer = Fixtures::createProfile('client', ['telephone' => '0700000001']);
        ApiClient::post('/create_account.php', ['role' => 'client', 'prenom' => 'Filleul', 'telephone' => '0700000002', 'pin' => '1234', 'parrain_telephone' => '0700000001']);
        ApiClient::post('/create_account.php', ['role' => 'client', 'prenom' => 'Filleul', 'telephone' => '0700000003', 'pin' => '1234', 'parrain_telephone' => '0700000001']);

        $res = ApiClient::get('/referrals_summary.php', $referrer['token']);
        $this->assertTrue($res->ok());
        $this->assertSame(2, $res->json['count']);
        $this->assertSame(0, $res->json['total'], 'aucune recompense versee tant qu\'aucun filleul n\'a termine de commande');
    }
}
