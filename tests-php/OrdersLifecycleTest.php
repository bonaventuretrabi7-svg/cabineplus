<?php
declare(strict_types=1);

// Cœur du moteur de commandes (api/orders_create.php, orders_accept.php,
// orders_refuse.php, orders_reassign.php, orders_common.php) — cible en
// priorité la faille de concurrence historique que toute la migration Phase
// 4 avait pour but de corriger (voir CHANGELOG des commits "coeur du moteur
// de commandes cote serveur") : une cabine ne doit jamais pouvoir agir sur
// la commande d'une autre, et un double appel ne doit jamais créditer deux
// fois la même commission.
final class OrdersLifecycleTest extends ApiTestCase
{
    public function testCreateTransferDebitsClientAndAssignsOnlineCabine(): void
    {
        $client = Fixtures::createProfile('client', ['solde' => 10000]);
        $cabine = Fixtures::createProfile('cabine');
        Fixtures::ping($cabine['profile']['id']);

        $res = ApiClient::post('/orders_create.php', [
            'operateur' => 'Orange',
            'numero_beneficiaire' => '0700000000',
            'montant' => 1000,
        ], $client['token']);

        $this->assertTrue($res->ok(), $res->raw);
        $this->assertSame('en_attente', $res->json['transaction']['statut']);
        $this->assertSame($cabine['profile']['id'], $res->json['transaction']['cabine_id'], 'seule cabine active -> attribution initiale immédiate');

        $updatedClient = Fixtures::fetchProfile($client['profile']['id']);
        $this->assertSame(10000 - 1000 - 15, (int)$updatedClient['solde'], 'débit = montant + 15 F de frais de service');
    }

    public function testCreateTransferRejectsInsufficientBalanceWithoutSideEffects(): void
    {
        $client = Fixtures::createProfile('client', ['solde' => 100]);

        $res = ApiClient::post('/orders_create.php', [
            'operateur' => 'Orange',
            'numero_beneficiaire' => '0700000000',
            'montant' => 1000,
        ], $client['token']);

        $this->assertSame(400, $res->status);
        $this->assertFalse(isset($res->json['ok']) && $res->json['ok'] === true);

        $updatedClient = Fixtures::fetchProfile($client['profile']['id']);
        $this->assertSame(100, (int)$updatedClient['solde'], 'le solde ne doit pas bouger sur un échec');

        $count = (int)Fixtures::pdo()->query('SELECT COUNT(*) FROM transactions')->fetchColumn();
        $this->assertSame(0, $count, 'aucune commande ne doit être créée sur un débit refusé');
    }

    public function testAcceptCreditsCommissionExactlyOnce(): void
    {
        $client = Fixtures::createProfile('client');
        $cabine = Fixtures::createProfile('cabine');
        $txn = Fixtures::createTransaction([
            'client_id' => $client['profile']['id'],
            'cabine_id' => $cabine['profile']['id'],
            'montant' => 2000,
            'commission' => 100,
        ]);

        $res = ApiClient::post('/orders_accept.php', ['transaction_id' => $txn['id']], $cabine['token']);
        $this->assertTrue($res->ok(), $res->raw);

        $updatedCabine = Fixtures::fetchProfile($cabine['profile']['id']);
        $this->assertSame(0, (int)$updatedCabine['solde'], 'la commission ne doit plus être créditée au solde réel');
        $this->assertSame(100, (int)$updatedCabine['commissions_total'], 'pas de double comptage (voir bug historique corrigé)');
        $this->assertSame(1, (int)$updatedCabine['transferts_total']);

        $updatedTxn = Fixtures::fetchTransaction($txn['id']);
        $this->assertSame('terminé', $updatedTxn['statut']);
    }

    public function testAcceptingAlreadyAcceptedTransactionFails409WithoutDoubleCredit(): void
    {
        $client = Fixtures::createProfile('client');
        $cabine = Fixtures::createProfile('cabine');
        $txn = Fixtures::createTransaction([
            'client_id' => $client['profile']['id'],
            'cabine_id' => $cabine['profile']['id'],
            'montant' => 2000,
            'commission' => 100,
        ]);

        $first = ApiClient::post('/orders_accept.php', ['transaction_id' => $txn['id']], $cabine['token']);
        $this->assertTrue($first->ok());

        $second = ApiClient::post('/orders_accept.php', ['transaction_id' => $txn['id']], $cabine['token']);
        $this->assertSame(409, $second->status);

        $updatedCabine = Fixtures::fetchProfile($cabine['profile']['id']);
        $this->assertSame(100, (int)$updatedCabine['commissions_total'], 'le second appel ne doit rien créditer de plus');
        $this->assertSame(1, (int)$updatedCabine['transferts_total']);
    }

    public function testCabineCannotAcceptAnotherCabinesTransaction(): void
    {
        $client = Fixtures::createProfile('client');
        $owner = Fixtures::createProfile('cabine');
        $intruder = Fixtures::createProfile('cabine');
        $txn = Fixtures::createTransaction([
            'client_id' => $client['profile']['id'],
            'cabine_id' => $owner['profile']['id'],
        ]);

        $res = ApiClient::post('/orders_accept.php', ['transaction_id' => $txn['id']], $intruder['token']);
        $this->assertSame(409, $res->status);

        $updatedTxn = Fixtures::fetchTransaction($txn['id']);
        $this->assertSame('en_attente', $updatedTxn['statut'], 'la commande de la cabine propriétaire ne doit pas être altérée');

        $updatedIntruder = Fixtures::fetchProfile($intruder['profile']['id']);
        $this->assertSame(0, (int)$updatedIntruder['solde'], 'la cabine intruse ne doit rien recevoir');
    }

    public function testRefuseReassignsToAnotherOnlineEligibleCabine(): void
    {
        $client = Fixtures::createProfile('client');
        $cabineA = Fixtures::createProfile('cabine');
        $cabineB = Fixtures::createProfile('cabine');
        Fixtures::ping($cabineA['profile']['id']);
        Fixtures::ping($cabineB['profile']['id']);
        $txn = Fixtures::createTransaction([
            'client_id' => $client['profile']['id'],
            'cabine_id' => $cabineA['profile']['id'],
        ]);

        $res = ApiClient::post('/orders_refuse.php', ['transaction_id' => $txn['id'], 'motif' => 'indisponible'], $cabineA['token']);
        $this->assertTrue($res->ok(), $res->raw);
        $this->assertSame($cabineB['profile']['id'], $res->json['reassignedTo']);

        $updatedTxn = Fixtures::fetchTransaction($txn['id']);
        $this->assertSame($cabineB['profile']['id'], $updatedTxn['cabine_id']);
        $this->assertSame('en_attente', $updatedTxn['statut']);
    }

    public function testRefuseWithNoOtherCabineOnlineLeavesTransactionUnassigned(): void
    {
        $client = Fixtures::createProfile('client');
        $cabineA = Fixtures::createProfile('cabine');
        Fixtures::ping($cabineA['profile']['id']);
        $txn = Fixtures::createTransaction([
            'client_id' => $client['profile']['id'],
            'cabine_id' => $cabineA['profile']['id'],
        ]);

        $res = ApiClient::post('/orders_refuse.php', ['transaction_id' => $txn['id'], 'motif' => 'indisponible'], $cabineA['token']);
        $this->assertTrue($res->ok());
        $this->assertNull($res->json['reassignedTo']);

        $updatedTxn = Fixtures::fetchTransaction($txn['id']);
        $this->assertNull($updatedTxn['cabine_id']);
        $this->assertSame('en_attente', $updatedTxn['statut']);
    }

    public function testAdminReassignRespectsCabineOrderLimit(): void
    {
        $client = Fixtures::createProfile('client');
        $cabineFull = Fixtures::createProfile('cabine', ['limite_commandes' => 1]);
        Fixtures::createTransaction(['client_id' => $client['profile']['id'], 'cabine_id' => $cabineFull['profile']['id']]); // occupe déjà le quota
        $target = Fixtures::createTransaction(['client_id' => $client['profile']['id'], 'cabine_id' => null]);
        $admin = Fixtures::createProfile('admin');

        $res = ApiClient::post('/orders_reassign.php', [
            'transaction_ids' => [$target['id']],
            'cabine_id' => $cabineFull['profile']['id'],
        ], $admin['token']);

        $this->assertTrue($res->ok());
        $this->assertSame(0, $res->json['okCount']);
        $this->assertSame(1, $res->json['failCount']);

        $updatedTarget = Fixtures::fetchTransaction($target['id']);
        $this->assertNull($updatedTarget['cabine_id'], 'la limite de commandes doit bloquer la réassignation');
    }
}
