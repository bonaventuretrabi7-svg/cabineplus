<?php
declare(strict_types=1);

// api/reset_requests_{create,list,apply,refuse}.php (Phase E) — remplace
// le flux 100% local (ResetRequests, js/client.js + lecture localStorage
// directe, js/admin.js). Le nouveau PIN est haché IMMÉDIATEMENT à la
// création, jamais stocké/transmis en clair.
final class ResetRequestsTest extends ApiTestCase
{
    public function testClientCanRequestResetByPhoneAndAdminCanApplyIt(): void
    {
        $client = Fixtures::createProfile('client', ['pin' => '1111']);
        $admin = Fixtures::createProfile('admin');

        $create = ApiClient::post('/reset_requests_create.php', [
            'role' => 'client', 'identifiant' => $client['profile']['telephone'], 'nouveau_mot_de_passe' => '9999',
        ]);
        $this->assertTrue($create->ok(), $create->raw);

        // Le hash n'est jamais renvoyé dans la liste.
        $list = ApiClient::get('/reset_requests_list.php', $admin['token']);
        $this->assertCount(1, $list->json['resetRequests']);
        $this->assertArrayNotHasKey('nouveau_mot_de_passe_hash', $list->json['resetRequests'][0]);
        $requestId = $list->json['resetRequests'][0]['id'];

        $apply = ApiClient::post('/reset_requests_apply.php', ['request_id' => $requestId], $admin['token']);
        $this->assertTrue($apply->ok(), $apply->raw);

        // L'ancien PIN ne fonctionne plus, le nouveau oui.
        $oldLogin = ApiClient::post('/login.php', ['identifiant' => $client['profile']['telephone'], 'pin' => '1111', 'role' => 'client'], null);
        $this->assertSame(401, $oldLogin->status);
        $newLogin = ApiClient::post('/login.php', ['identifiant' => $client['profile']['telephone'], 'pin' => '9999', 'role' => 'client'], null);
        $this->assertSame(200, $newLogin->status);
    }

    public function testCabineRequestByEmailWorks(): void
    {
        $cabine = Fixtures::createProfile('cabine', ['pin' => '1111']);
        $admin = Fixtures::createProfile('admin');

        $create = ApiClient::post('/reset_requests_create.php', [
            'role' => 'cabine', 'identifiant' => $cabine['profile']['email'], 'nouveau_mot_de_passe' => '2222',
        ]);
        $this->assertTrue($create->ok(), $create->raw);

        $list = ApiClient::get('/reset_requests_list.php', $admin['token']);
        $this->assertSame('cabine', $list->json['resetRequests'][0]['role']);
        // Le telephone du compte est conserve pour le contact WhatsApp, meme si
        // l'identifiant de connexion/reinitialisation etait l'email.
        $this->assertSame($cabine['profile']['telephone'], $list->json['resetRequests'][0]['telephone']);
    }

    public function testCannotRequestResetForSuperAdmin(): void
    {
        $super = Fixtures::createProfile('admin', ['admin_level' => 'super', 'pin' => '1973']);

        $res = ApiClient::post('/reset_requests_create.php', [
            'role' => 'admin', 'identifiant' => $super['profile']['email'], 'nouveau_mot_de_passe' => '2222',
        ]);
        $this->assertFalse($res->ok());
    }

    public function testCannotRequestTwiceWhilePending(): void
    {
        $client = Fixtures::createProfile('client');
        $body = ['role' => 'client', 'identifiant' => $client['profile']['telephone'], 'nouveau_mot_de_passe' => '9999'];

        $first = ApiClient::post('/reset_requests_create.php', $body);
        $this->assertTrue($first->ok());
        $second = ApiClient::post('/reset_requests_create.php', $body);
        $this->assertFalse($second->ok());
    }

    public function testRegularAdminCannotSeeOrApplyAdminRoleRequests(): void
    {
        $regularAdmin = Fixtures::createProfile('admin', ['admin_level' => 'standard']);
        $targetAdmin = Fixtures::createProfile('admin', ['admin_level' => 'standard']);

        ApiClient::post('/reset_requests_create.php', [
            'role' => 'admin', 'identifiant' => $targetAdmin['profile']['email'], 'nouveau_mot_de_passe' => '2222',
        ]);

        $list = ApiClient::get('/reset_requests_list.php', $regularAdmin['token']);
        $this->assertCount(0, $list->json['resetRequests'], 'un admin simple ne doit jamais voir une demande liee a un compte admin');

        // Meme en connaissant l'id directement, l'application doit rester bloquee.
        $rawId = Fixtures::pdo()->query('SELECT id FROM reset_requests LIMIT 1')->fetchColumn();
        $apply = ApiClient::post('/reset_requests_apply.php', ['request_id' => $rawId], $regularAdmin['token']);
        $this->assertSame(403, $apply->status);
    }

    public function testSuperAdminCanSeeAndApplyAdminRoleRequests(): void
    {
        $superAdmin = Fixtures::createProfile('admin', ['admin_level' => 'super']);
        $targetAdmin = Fixtures::createProfile('admin', ['admin_level' => 'standard', 'pin' => '1111']);

        ApiClient::post('/reset_requests_create.php', [
            'role' => 'admin', 'identifiant' => $targetAdmin['profile']['email'], 'nouveau_mot_de_passe' => '2222',
        ]);

        $list = ApiClient::get('/reset_requests_list.php', $superAdmin['token']);
        $this->assertCount(1, $list->json['resetRequests']);

        $apply = ApiClient::post('/reset_requests_apply.php', ['request_id' => $list->json['resetRequests'][0]['id']], $superAdmin['token']);
        $this->assertTrue($apply->ok(), $apply->raw);
    }

    public function testRefuseMarksRequestAsRefusedWithoutChangingPassword(): void
    {
        $client = Fixtures::createProfile('client', ['pin' => '1111']);
        $admin = Fixtures::createProfile('admin');

        ApiClient::post('/reset_requests_create.php', [
            'role' => 'client', 'identifiant' => $client['profile']['telephone'], 'nouveau_mot_de_passe' => '9999',
        ]);
        $requestId = Fixtures::pdo()->query('SELECT id FROM reset_requests LIMIT 1')->fetchColumn();

        $res = ApiClient::post('/reset_requests_refuse.php', ['request_id' => $requestId], $admin['token']);
        $this->assertTrue($res->ok());

        $statut = Fixtures::pdo()->query("SELECT statut FROM reset_requests WHERE id = '$requestId'")->fetchColumn();
        $this->assertSame('refusé', $statut);

        $stillOldPin = ApiClient::post('/login.php', ['identifiant' => $client['profile']['telephone'], 'pin' => '1111', 'role' => 'client'], null);
        $this->assertSame(200, $stillOldPin->status);
    }
}
