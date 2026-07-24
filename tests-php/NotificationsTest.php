<?php
declare(strict_types=1);

// api/notifications_list.php / notifications_mark_read.php /
// notifications_mark_all_read.php (Phase C) — la table `notifications`
// est déjà peuplée depuis la Phase 4 par createNotification()
// (api/bootstrap.php), appelée par la quasi-totalité des endpoints
// métier ; ces tests couvrent uniquement la lecture/mise à jour
// nouvellement ajoutées.
final class NotificationsTest extends ApiTestCase
{
    private function insertNotif(string $userId, string $message, bool $lu = false): string
    {
        $id = bin2hex(random_bytes(16));
        Fixtures::pdo()->prepare('INSERT INTO notifications (id, utilisateur_id, message, lu, date, type) VALUES (?, ?, ?, ?, NOW(), \'info\')')
            ->execute([$id, $userId, $message, $lu ? 1 : 0]);
        return $id;
    }

    public function testListReturnsOnlyOwnNotifications(): void
    {
        $client = Fixtures::createProfile('client');
        $other = Fixtures::createProfile('client');
        $this->insertNotif($client['profile']['id'], 'Pour moi');
        $this->insertNotif($other['profile']['id'], 'Pas pour moi');

        $res = ApiClient::get('/notifications_list.php', $client['token']);
        $this->assertSame(200, $res->status);
        $this->assertCount(1, $res->json['notifications']);
        $this->assertSame('Pour moi', $res->json['notifications'][0]['message']);
    }

    public function testMarkReadOnlyAffectsOwnNotification(): void
    {
        $client = Fixtures::createProfile('client');
        $other = Fixtures::createProfile('client');
        $myNotifId = $this->insertNotif($client['profile']['id'], 'À moi');
        $otherNotifId = $this->insertNotif($other['profile']['id'], 'Pas à moi');

        $res = ApiClient::post('/notifications_mark_read.php', ['notification_id' => $myNotifId], $client['token']);
        $this->assertTrue($res->ok());

        // Tente de marquer la notification d'un AUTRE compte — ne doit rien changer.
        ApiClient::post('/notifications_mark_read.php', ['notification_id' => $otherNotifId], $client['token']);

        $mine = Fixtures::pdo()->query("SELECT lu FROM notifications WHERE id = '$myNotifId'")->fetchColumn();
        $theirs = Fixtures::pdo()->query("SELECT lu FROM notifications WHERE id = '$otherNotifId'")->fetchColumn();
        $this->assertSame(1, (int)$mine);
        $this->assertSame(0, (int)$theirs, 'la notification du compte tiers ne doit jamais être modifiable par un autre appelant');
    }

    public function testMarkAllReadOnlyAffectsCallersNotifications(): void
    {
        $client = Fixtures::createProfile('client');
        $other = Fixtures::createProfile('client');
        $this->insertNotif($client['profile']['id'], 'A');
        $this->insertNotif($client['profile']['id'], 'B');
        $this->insertNotif($other['profile']['id'], 'C');

        $res = ApiClient::post('/notifications_mark_all_read.php', [], $client['token']);
        $this->assertTrue($res->ok());

        $unreadMine = (int)Fixtures::pdo()->query("SELECT COUNT(*) FROM notifications WHERE utilisateur_id = '{$client['profile']['id']}' AND lu = 0")->fetchColumn();
        $unreadTheirs = (int)Fixtures::pdo()->query("SELECT COUNT(*) FROM notifications WHERE utilisateur_id = '{$other['profile']['id']}' AND lu = 0")->fetchColumn();
        $this->assertSame(0, $unreadMine);
        $this->assertSame(1, $unreadTheirs);
    }

    public function testEndpointsRequireAuth(): void
    {
        $this->assertSame(401, ApiClient::get('/notifications_list.php', null)->status);
    }

    // Un client ne doit recevoir QUE 4 catégories de notifications (sa
    // commande en cours, sa commande terminée, un transfert client-à-client
    // envoyé ou reçu) — voir CLIENT_NOTIFICATION_TYPES/createNotification(),
    // api/bootstrap.php. Tout le reste (remboursement ici) ne doit jamais
    // lui être créé, même si l'action elle-même réussit normalement.
    public function testClientNeverReceivesNonWhitelistedNotificationTypes(): void
    {
        $client = Fixtures::createProfile('client');
        $admin  = Fixtures::createProfile('admin');
        $txn = Fixtures::createTransaction(['client_id' => $client['profile']['id'], 'statut' => 'en_attente']);

        $res = ApiClient::post('/orders_refund.php', ['transaction_id' => $txn['id']], $admin['token']);
        $this->assertTrue($res->ok(), $res->raw);

        $count = (int)Fixtures::pdo()->query("SELECT COUNT(*) FROM notifications WHERE utilisateur_id = '{$client['profile']['id']}'")->fetchColumn();
        $this->assertSame(0, $count, 'un remboursement ne fait pas partie des 4 catégories autorisées pour un client');
    }

    public function testClientReceivesOrderPendingThenOrderCompletedNotifications(): void
    {
        $client = Fixtures::createProfile('client', ['solde' => 10000]);
        $cabine = Fixtures::createProfile('cabine');
        Fixtures::ping($cabine['profile']['id']);

        $order = ApiClient::post('/orders_create.php', [
            'operateur' => 'Orange', 'numero_beneficiaire' => '0700000000', 'montant' => 1000,
        ], $client['token']);
        $this->assertTrue($order->ok(), $order->raw);
        $txnId = $order->json['transaction']['id'];

        $pending = Fixtures::pdo()->query("SELECT type FROM notifications WHERE utilisateur_id = '{$client['profile']['id']}'")->fetchAll();
        $this->assertSame(['order_pending'], array_column($pending, 'type'));

        $accept = ApiClient::post('/orders_accept.php', ['transaction_id' => $txnId], $cabine['token']);
        $this->assertTrue($accept->ok(), $accept->raw);

        $types = array_column(Fixtures::pdo()->query("SELECT type FROM notifications WHERE utilisateur_id = '{$client['profile']['id']}' ORDER BY date")->fetchAll(), 'type');
        $this->assertSame(['order_pending', 'order_completed'], $types);
    }

    public function testClientTransferNotifiesBothSenderAndReceiver(): void
    {
        $sender   = Fixtures::createProfile('client', ['solde' => 5000, 'telephone' => '0700000001']);
        $receiver = Fixtures::createProfile('client', ['telephone' => '0700000002']);

        $res = ApiClient::post('/client_transfer.php', [
            'to_phone' => $receiver['profile']['telephone'], 'montant' => 1000,
        ], $sender['token']);
        $this->assertTrue($res->ok(), $res->raw);

        $senderTypes   = array_column(Fixtures::pdo()->query("SELECT type FROM notifications WHERE utilisateur_id = '{$sender['profile']['id']}'")->fetchAll(), 'type');
        $receiverTypes = array_column(Fixtures::pdo()->query("SELECT type FROM notifications WHERE utilisateur_id = '{$receiver['profile']['id']}'")->fetchAll(), 'type');
        $this->assertSame(['transfer_sent'], $senderTypes, "l'expéditeur doit être notifié du transfert qu'il vient d'effectuer");
        $this->assertSame(['transfer_received'], $receiverTypes);
    }

    // Chaque ligne `transactions` d'un transfert client-à-client stocke le
    // réseau réel (déduit du préfixe) de SON PROPRE numero_beneficiaire —
    // jamais le texte technique "send-client" (voir phoneNetwork(),
    // api/bootstrap.php) — la ligne "envoi" affiche donc le réseau du
    // destinataire, la ligne "réception" celui de l'envoyeur.
    public function testClientTransferStoresRealNetworkPerRow(): void
    {
        $sender   = Fixtures::createProfile('client', ['solde' => 5000, 'telephone' => '0700000001']); // Orange
        $receiver = Fixtures::createProfile('client', ['telephone' => '0500000002']); // MTN

        $res = ApiClient::post('/client_transfer.php', [
            'to_phone' => $receiver['profile']['telephone'], 'montant' => 1000,
        ], $sender['token']);
        $this->assertTrue($res->ok(), $res->raw);

        $envoi = Fixtures::pdo()->query("SELECT operateur FROM transactions WHERE client_id = '{$sender['profile']['id']}' AND type = 'transfert_client_envoi'")->fetch();
        $reception = Fixtures::pdo()->query("SELECT operateur FROM transactions WHERE client_id = '{$receiver['profile']['id']}' AND type = 'transfert_client_reception'")->fetch();

        $this->assertSame('MTN', $envoi['operateur'], 'la ligne "envoi" affiche le réseau du destinataire');
        $this->assertSame('Orange', $reception['operateur'], 'la ligne "réception" affiche le réseau de l\'envoyeur');
    }

    public function testClientReceivesReclamationPendingThenCompletedNotifications(): void
    {
        $client = Fixtures::createProfile('client');
        $cabine = Fixtures::createProfile('cabine');
        $txn = Fixtures::createTransaction(['client_id' => $client['profile']['id'], 'cabine_id' => $cabine['profile']['id'], 'statut' => 'terminé']);

        $recla = ApiClient::post('/reclamations_create.php', [
            'transaction_id' => $txn['id'], 'motif' => 'Le bénéficiaire n\'a rien reçu',
        ], $client['token']);
        $this->assertTrue($recla->ok(), $recla->raw);
        $reclaId = $recla->json['reclamation']['id'];

        $pending = array_column(Fixtures::pdo()->query("SELECT type FROM notifications WHERE utilisateur_id = '{$client['profile']['id']}'")->fetchAll(), 'type');
        $this->assertSame(['reclamation_pending'], $pending);

        $resolve = ApiClient::post('/reclamations_resolve.php', [
            'reclamation_id' => $reclaId, 'screenshot' => 'data:image/png;base64,abc',
        ], $cabine['token']);
        $this->assertTrue($resolve->ok(), $resolve->raw);

        $types = array_column(Fixtures::pdo()->query("SELECT type FROM notifications WHERE utilisateur_id = '{$client['profile']['id']}' ORDER BY date")->fetchAll(), 'type');
        $this->assertSame(['reclamation_pending', 'reclamation_completed'], $types);
    }
}
