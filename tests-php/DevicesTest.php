<?php
declare(strict_types=1);

// api/devices_{touch,list,remove}.php + api/logout.php (Phase G) —
// remplace DB.partnerDevices (js/db.js), jusqu'ici 100% local (un
// appareil connecté depuis un autre poste n'était jamais visible, et
// "Déconnecter" ne faisait rien côté serveur : la session restait valide
// malgré le retrait cosmétique de la liste). Le point le plus important à
// vérifier : devices_remove.php doit RÉELLEMENT invalider la session
// (supprimer sessions.token_hash), pas seulement l'entrée d'affichage.
final class DevicesTest extends ApiTestCase
{
    public function testTouchCreatesThenUpsertsDeviceRecord(): void
    {
        $client = Fixtures::createProfile('client');

        $first = ApiClient::post('/devices_touch.php', ['device_id' => 'dev-abc', 'label' => 'Chrome sur Windows', 'remember' => true], $client['token']);
        $this->assertTrue($first->ok(), $first->raw);

        $count = (int)Fixtures::pdo()->query("SELECT COUNT(*) FROM devices WHERE profile_id = '{$client['profile']['id']}'")->fetchColumn();
        $this->assertSame(1, $count);

        // Deuxieme appel meme device_id -> upsert, pas de doublon.
        $second = ApiClient::post('/devices_touch.php', ['device_id' => 'dev-abc', 'label' => 'Chrome sur Windows', 'remember' => true], $client['token']);
        $this->assertTrue($second->ok());
        $countAfter = (int)Fixtures::pdo()->query("SELECT COUNT(*) FROM devices WHERE profile_id = '{$client['profile']['id']}'")->fetchColumn();
        $this->assertSame(1, $countAfter);

        $row = Fixtures::pdo()->query("SELECT * FROM devices WHERE profile_id = '{$client['profile']['id']}'")->fetch();
        $this->assertSame('Chrome sur Windows', $row['label']);
        $this->assertSame(1, (int)$row['remembered']);
        $this->assertNotEmpty($row['token_hash']);
    }

    public function testListScopedToOwnDevicesForNonAdmin(): void
    {
        $client = Fixtures::createProfile('client');
        $other = Fixtures::createProfile('client');
        ApiClient::post('/devices_touch.php', ['device_id' => 'dev-mine', 'label' => 'Mon appareil'], $client['token']);
        ApiClient::post('/devices_touch.php', ['device_id' => 'dev-other', 'label' => 'Autre appareil'], $other['token']);

        $res = ApiClient::get('/devices_list.php', $client['token']);
        $this->assertCount(1, $res->json['devices']);
        $this->assertSame('Mon appareil', $res->json['devices'][0]['label']);
        $this->assertArrayNotHasKey('token_hash', $res->json['devices'][0]);
    }

    public function testAdminSeesAllDevices(): void
    {
        $client = Fixtures::createProfile('client');
        $cabine = Fixtures::createProfile('cabine');
        $admin = Fixtures::createProfile('admin');
        ApiClient::post('/devices_touch.php', ['device_id' => 'dev-1'], $client['token']);
        ApiClient::post('/devices_touch.php', ['device_id' => 'dev-2'], $cabine['token']);

        $res = ApiClient::get('/devices_list.php', $admin['token']);
        $this->assertCount(2, $res->json['devices']);
    }

    public function testRemoveDeletesDeviceAndReallyInvalidatesTheSession(): void
    {
        $client = Fixtures::createProfile('client');
        ApiClient::post('/devices_touch.php', ['device_id' => 'dev-abc', 'remember' => true], $client['token']);
        $deviceRowId = Fixtures::pdo()->query('SELECT id FROM devices LIMIT 1')->fetchColumn();

        // Confirme que le jeton fonctionne encore avant la revocation.
        $before = ApiClient::get('/devices_list.php', $client['token']);
        $this->assertSame(200, $before->status);

        $res = ApiClient::post('/devices_remove.php', ['id' => $deviceRowId], $client['token']);
        $this->assertTrue($res->ok(), $res->raw);

        $deviceCount = (int)Fixtures::pdo()->query("SELECT COUNT(*) FROM devices WHERE id = '$deviceRowId'")->fetchColumn();
        $this->assertSame(0, $deviceCount);

        // Le jeton qui avait servi a "toucher" cet appareil doit maintenant
        // etre reellement invalide -- pas seulement retire de la liste.
        $after = ApiClient::get('/devices_list.php', $client['token']);
        $this->assertSame(401, $after->status, 'la session correspondante doit avoir ete revoquee cote serveur');
    }

    public function testCannotRemoveAnotherAccountsDevice(): void
    {
        $client = Fixtures::createProfile('client');
        $other = Fixtures::createProfile('client');
        ApiClient::post('/devices_touch.php', ['device_id' => 'dev-other'], $other['token']);
        $deviceRowId = Fixtures::pdo()->query('SELECT id FROM devices LIMIT 1')->fetchColumn();

        $res = ApiClient::post('/devices_remove.php', ['id' => $deviceRowId], $client['token']);
        $this->assertSame(403, $res->status);

        $stillThere = (int)Fixtures::pdo()->query("SELECT COUNT(*) FROM devices WHERE id = '$deviceRowId'")->fetchColumn();
        $this->assertSame(1, $stillThere);
    }

    public function testAdminCanRemoveAnyAccountsDevice(): void
    {
        $cabine = Fixtures::createProfile('cabine');
        $admin = Fixtures::createProfile('admin');
        ApiClient::post('/devices_touch.php', ['device_id' => 'dev-cab'], $cabine['token']);
        $deviceRowId = Fixtures::pdo()->query('SELECT id FROM devices LIMIT 1')->fetchColumn();

        $res = ApiClient::post('/devices_remove.php', ['id' => $deviceRowId], $admin['token']);
        $this->assertTrue($res->ok(), $res->raw);
    }

    public function testLogoutAlsoDeletesTheDeviceRecord(): void
    {
        $client = Fixtures::createProfile('client');
        ApiClient::post('/devices_touch.php', ['device_id' => 'dev-abc'], $client['token']);
        $this->assertSame(1, (int)Fixtures::pdo()->query('SELECT COUNT(*) FROM devices')->fetchColumn());

        $res = ApiClient::post('/logout.php', [], $client['token']);
        $this->assertTrue($res->ok(), $res->raw);

        $this->assertSame(0, (int)Fixtures::pdo()->query('SELECT COUNT(*) FROM devices')->fetchColumn());
        $this->assertSame(0, (int)Fixtures::pdo()->query('SELECT COUNT(*) FROM sessions')->fetchColumn());
    }
}
