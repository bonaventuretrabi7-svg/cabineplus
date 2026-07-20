<?php
declare(strict_types=1);

// api/orders_delete.php — suppression définitive réservée au super admin,
// autorisée même pour une commande 'terminé' (choix explicite de
// l'administration — la commission créditée et le débit client ne sont pas
// annulés, seule la trace de la commande disparaît ; orders_refund.php reste
// le moyen d'annuler réellement les effets financiers avant suppression),
// cascade sur réclamation/messages/demande de remboursement/retards pour ne
// laisser aucune référence orpheline.
final class OrdersDeleteTest extends ApiTestCase
{
    public function testSuperAdminCanDeletePendingTransaction(): void
    {
        $superAdmin = Fixtures::createProfile('admin', ['admin_level' => 'super']);
        $txn = Fixtures::createTransaction(['statut' => 'en_attente']);

        $res = ApiClient::post('/orders_delete.php', ['transaction_id' => $txn['id']], $superAdmin['token']);
        $this->assertTrue($res->ok(), $res->raw);
        $this->assertNull(Fixtures::fetchTransaction($txn['id']));
    }

    public function testSuperAdminCanDeleteSuspendedOrRefundedTransaction(): void
    {
        $superAdmin = Fixtures::createProfile('admin', ['admin_level' => 'super']);
        $suspendue = Fixtures::createTransaction(['statut' => 'suspendue']);
        $rembourse = Fixtures::createTransaction(['statut' => 'remboursé']);

        $res1 = ApiClient::post('/orders_delete.php', ['transaction_id' => $suspendue['id']], $superAdmin['token']);
        $this->assertTrue($res1->ok(), $res1->raw);
        $res2 = ApiClient::post('/orders_delete.php', ['transaction_id' => $rembourse['id']], $superAdmin['token']);
        $this->assertTrue($res2->ok(), $res2->raw);
    }

    public function testSuperAdminCanDeleteCompletedTransactionDirectly(): void
    {
        $superAdmin = Fixtures::createProfile('admin', ['admin_level' => 'super']);
        $txn = Fixtures::createTransaction(['statut' => 'terminé']);

        $res = ApiClient::post('/orders_delete.php', ['transaction_id' => $txn['id']], $superAdmin['token']);
        $this->assertTrue($res->ok(), $res->raw);
        $this->assertNull(Fixtures::fetchTransaction($txn['id']));
    }

    public function testRegularAdminCannotDeleteTransaction(): void
    {
        $regularAdmin = Fixtures::createProfile('admin', ['admin_level' => 'standard']);
        $txn = Fixtures::createTransaction(['statut' => 'en_attente']);

        $res = ApiClient::post('/orders_delete.php', ['transaction_id' => $txn['id']], $regularAdmin['token']);
        $this->assertSame(403, $res->status);
        $this->assertNotNull(Fixtures::fetchTransaction($txn['id']));
    }

    public function testDeletingUnknownTransactionFails(): void
    {
        $superAdmin = Fixtures::createProfile('admin', ['admin_level' => 'super']);

        $res = ApiClient::post('/orders_delete.php', ['transaction_id' => 'id-inexistant'], $superAdmin['token']);
        $this->assertSame(404, $res->status);
    }

    public function testDeleteCascadesToReclamationMessagesAndRefundRequest(): void
    {
        $superAdmin = Fixtures::createProfile('admin', ['admin_level' => 'super']);
        $client = Fixtures::createProfile('client');
        $cabine = Fixtures::createProfile('cabine');
        // Statut suspendue (supprimable) mais avec une réclamation déjà
        // déposée pendant qu'elle était encore en_attente/terminé.
        $txn = Fixtures::createTransaction([
            'statut' => 'suspendue',
            'client_id' => $client['profile']['id'],
            'cabine_id' => $cabine['profile']['id'],
        ]);

        $recla = ApiClient::post('/reclamations_create.php', ['transaction_id' => $txn['id'], 'motif' => 'Problème'], $client['token']);
        $this->assertTrue($recla->ok(), $recla->raw);
        $reclaId = $recla->json['reclamation']['id'];

        $res = ApiClient::post('/orders_delete.php', ['transaction_id' => $txn['id']], $superAdmin['token']);
        $this->assertTrue($res->ok(), $res->raw);

        $reclaCount = (int)Fixtures::pdo()->query("SELECT COUNT(*) FROM reclamations WHERE id = '$reclaId'")->fetchColumn();
        $this->assertSame(0, $reclaCount, 'la réclamation liée doit disparaître avec la commande');
        $msgCount = (int)Fixtures::pdo()->query("SELECT COUNT(*) FROM reclamation_messages WHERE reclamation_id = '$reclaId'")->fetchColumn();
        $this->assertSame(0, $msgCount, 'ses messages ne doivent pas rester orphelins');
    }
}
