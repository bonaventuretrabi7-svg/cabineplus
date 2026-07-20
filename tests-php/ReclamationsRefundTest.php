<?php
declare(strict_types=1);

// Flux complet Phase 5 : réclamation client -> demande de remboursement
// cabine (reclamations_request_refund.php) -> validation admin
// (orders_process_refund.php, qui réutilise refundTransactionEffect() —
// api/orders_common.php) — vérifie l'effet financier réel (pénalité de 60 F,
// planchers GREATEST(0, ...)) plutôt que le simple code retour.
final class ReclamationsRefundTest extends ApiTestCase
{
    public function testFullRefundFlowAppliesPenaltyAndFloors(): void
    {
        $client = Fixtures::createProfile('client');
        $cabine = Fixtures::createProfile('cabine');
        $admin = Fixtures::createProfile('admin');

        $txn = Fixtures::createTransaction([
            'client_id' => $client['profile']['id'],
            'cabine_id' => $cabine['profile']['id'],
            'montant' => 2000,
            'commission' => 100,
            'statut' => 'terminé',
        ]);
        // La cabine a déjà été créditée à l'acceptation (simulée directement ici).
        Fixtures::pdo()->prepare('UPDATE profiles SET solde = 100, commissions_total = 100, transferts_total = 1 WHERE id = ?')
            ->execute([$cabine['profile']['id']]);

        $recla = ApiClient::post('/reclamations_create.php', [
            'transaction_id' => $txn['id'],
            'motif' => 'Le bénéficiaire n\'a rien reçu',
        ], $client['token']);
        $this->assertTrue($recla->ok(), $recla->raw);
        $reclaId = $recla->json['reclamation']['id'];

        $refundReq = ApiClient::post('/reclamations_request_refund.php', ['reclamation_id' => $reclaId], $cabine['token']);
        $this->assertTrue($refundReq->ok(), $refundReq->raw);

        $requestRow = Fixtures::pdo()->query("SELECT * FROM refund_requests WHERE reclamation_id = '$reclaId'")->fetch();
        $this->assertNotFalse($requestRow);
        $this->assertSame('en_attente', $requestRow['statut']);

        $process = ApiClient::post('/orders_process_refund.php', ['request_id' => $requestRow['id']], $admin['token']);
        $this->assertTrue($process->ok(), $process->raw);

        $updatedTxn = Fixtures::fetchTransaction($txn['id']);
        $this->assertSame('remboursé', $updatedTxn['statut']);

        $updatedClient = Fixtures::fetchProfile($client['profile']['id']);
        $this->assertSame(2000 + 15, (int)$updatedClient['solde'], 'remboursement intégral : montant + frais de service (15 F)');

        $updatedCabine = Fixtures::fetchProfile($cabine['profile']['id']);
        // solde: 100 - (montant 2000 + pénalité 60) = -1960 — la commission
        // n'est plus débitée ici (elle n'a jamais été créditée au solde réel
        // à l'acceptation, voir orders_accept.php / refundTransactionEffect()).
        $this->assertSame(100 - (2000 + 60), (int)$updatedCabine['solde']);
        $this->assertSame(0, (int)$updatedCabine['commissions_total'], 'GREATEST(0, ...) : ne doit jamais passer sous zéro');
        $this->assertSame(0, (int)$updatedCabine['transferts_total']);
        $this->assertSame(1, (int)$updatedCabine['remboursements_recus']);

        $updatedRecla = Fixtures::pdo()->query("SELECT statut FROM reclamations WHERE id = '$reclaId'")->fetchColumn();
        $this->assertSame('remboursée', $updatedRecla);

        $updatedRequest = Fixtures::pdo()->query("SELECT statut, processed_by FROM refund_requests WHERE id = '{$requestRow['id']}'")->fetch();
        $this->assertSame('traité', $updatedRequest['statut']);
        $this->assertSame($admin['profile']['id'], $updatedRequest['processed_by']);

        // Sanction tracée (retraits, type=sanction) pour l'historique cabine.
        $sanctionCount = (int)Fixtures::pdo()->query("SELECT COUNT(*) FROM retraits WHERE cabine_id = '{$cabine['profile']['id']}' AND type = 'sanction'")->fetchColumn();
        $this->assertSame(1, $sanctionCount);
    }

    public function testCannotCreateTwoReclamationsForSameTransaction(): void
    {
        $client = Fixtures::createProfile('client');
        $txn = Fixtures::createTransaction(['client_id' => $client['profile']['id']]);

        $first = ApiClient::post('/reclamations_create.php', ['transaction_id' => $txn['id'], 'motif' => 'Problème'], $client['token']);
        $this->assertTrue($first->ok());

        $second = ApiClient::post('/reclamations_create.php', ['transaction_id' => $txn['id'], 'motif' => 'Encore'], $client['token']);
        $this->assertFalse($second->ok());
    }

    public function testCannotCreateReclamationForSomeoneElsesTransaction(): void
    {
        $client = Fixtures::createProfile('client');
        $outsider = Fixtures::createProfile('client');
        $txn = Fixtures::createTransaction(['client_id' => $client['profile']['id']]);

        $res = ApiClient::post('/reclamations_create.php', ['transaction_id' => $txn['id'], 'motif' => 'Problème'], $outsider['token']);
        $this->assertSame(403, $res->status);
    }

    public function testRequestRefundOnUnfinishedTransactionIsRejectedAndReclamationStaysUnclaimed(): void
    {
        $client = Fixtures::createProfile('client');
        $cabine = Fixtures::createProfile('cabine');
        $txn = Fixtures::createTransaction([
            'client_id' => $client['profile']['id'],
            'cabine_id' => $cabine['profile']['id'],
            'statut' => 'en_attente', // pas encore terminé
        ]);

        $recla = ApiClient::post('/reclamations_create.php', ['transaction_id' => $txn['id'], 'motif' => 'Problème'], $client['token']);
        $reclaId = $recla->json['reclamation']['id'];

        $res = ApiClient::post('/reclamations_request_refund.php', ['reclamation_id' => $reclaId], $cabine['token']);
        $this->assertFalse($res->ok());

        // La transition d'état doit avoir été annulée (voir commentaire du
        // endpoint : "Annule la transition ci-dessus").
        $updatedRecla = Fixtures::pdo()->query("SELECT statut FROM reclamations WHERE id = '$reclaId'")->fetchColumn();
        $this->assertSame('en_attente', $updatedRecla, 'doit revenir à en_attente, pas rester bloquée sur remboursement_demande');
    }
}
