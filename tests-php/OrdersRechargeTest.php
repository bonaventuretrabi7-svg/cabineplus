<?php
declare(strict_types=1);

// api/orders_recharge.php — recharge de portefeuille (simulée). La ligne
// `transactions` créée pour un client stockait jusqu'ici le texte
// technique fixe "Auto recharge" pour operateur ET numero_beneficiaire,
// sans expliquer de qui il s'agissait dans les tableaux admin/cabine —
// stocke désormais le réseau réel (déduit du préfixe, phoneNetwork(),
// bootstrap.php) et le numéro du client qui se recharge lui-même.
final class OrdersRechargeTest extends ApiTestCase
{
    public function testSelfRechargeStoresOwnNetworkAndPhoneAsBeneficiary(): void
    {
        $client = Fixtures::createProfile('client', ['telephone' => '0700000001', 'solde' => 0]); // Orange

        $res = ApiClient::post('/orders_recharge.php', ['montant' => 5000], $client['token']);
        $this->assertTrue($res->ok(), $res->raw);

        $txn = Fixtures::pdo()->query("SELECT operateur, numero_beneficiaire FROM transactions WHERE client_id = '{$client['profile']['id']}' AND type = 'recharge'")->fetch();
        $this->assertSame('Orange', $txn['operateur']);
        $this->assertSame('0700000001', $txn['numero_beneficiaire']);

        $after = Fixtures::fetchProfile($client['profile']['id']);
        $this->assertSame(5000, (int)$after['solde']);
    }

    public function testSelfRechargeDetectsMtnNetwork(): void
    {
        $client = Fixtures::createProfile('client', ['telephone' => '0500000002']); // MTN

        $res = ApiClient::post('/orders_recharge.php', ['montant' => 2000], $client['token']);
        $this->assertTrue($res->ok(), $res->raw);

        $txn = Fixtures::pdo()->query("SELECT operateur FROM transactions WHERE client_id = '{$client['profile']['id']}' AND type = 'recharge'")->fetch();
        $this->assertSame('MTN', $txn['operateur']);
    }
}
