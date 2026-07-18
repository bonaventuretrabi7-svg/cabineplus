<?php
declare(strict_types=1);

// api/partner_applications_{create,list,validate,refuse}.php (Phase F) —
// remplace le flux 100% local (Applications, js/client.js + lecture
// localStorage directe, js/admin.js). Le PIN choisi est haché
// IMMÉDIATEMENT à la création, jamais stocké/transmis en clair ; la
// validation crée le compte cabine directement avec ce hash.
final class PartnerApplicationsTest extends ApiTestCase
{
    private function validPayload(array $overrides = []): array
    {
        return array_merge([
            'prenom' => 'Jean', 'nom' => 'Kouassi', 'email' => 'jean.kouassi@gmail.com',
            'telephone' => '0700000001', 'whatsapp' => '0700000001', 'cabine_nom' => 'Cabine Jean',
            'pin' => '1234', 'photo' => 'data:image/png;base64,abc', 'code_qr' => 'data:image/png;base64,def',
            'motivation' => 'Motivé', 'abonnement' => 'Premium', 'paiement_abo' => 'Orange Money',
            'paiement_vers' => 'Orange Money', 'numero_compte' => '0700000001', 'experience' => 'Débutant',
            'puces' => ['orange' => 1, 'mtn' => 0, 'moov' => 0],
        ], $overrides);
    }

    public function testCreateThenAdminCanValidateAndAccountWorks(): void
    {
        $admin = Fixtures::createProfile('admin');

        $create = ApiClient::post('/partner_applications_create.php', $this->validPayload());
        $this->assertTrue($create->ok(), $create->raw);

        $list = ApiClient::get('/partner_applications_list.php', $admin['token']);
        $this->assertCount(1, $list->json['applications']);
        $this->assertArrayNotHasKey('mot_de_passe_hash', $list->json['applications'][0]);
        $appId = $list->json['applications'][0]['id'];

        $validate = ApiClient::post('/partner_applications_validate.php', ['application_id' => $appId], $admin['token']);
        $this->assertTrue($validate->ok(), $validate->raw);
        $this->assertNotEmpty($validate->json['cabineId']);

        // Le compte cree doit vraiment fonctionner (login reel avec le PIN choisi).
        $login = ApiClient::post('/login.php', ['identifiant' => 'jean.kouassi@gmail.com', 'pin' => '1234', 'role' => 'cabine'], null);
        $this->assertSame(200, $login->status);
        $this->assertSame('Cabine Jean', $login->json['profile']['cabine_nom']);
        $this->assertSame('0700000001', $login->json['profile']['whatsapp']);
    }

    public function testRejectsNonGmailEmail(): void
    {
        $res = ApiClient::post('/partner_applications_create.php', $this->validPayload(['email' => 'jean@yahoo.com']));
        $this->assertFalse($res->ok());
    }

    public function testRejectsInvalidPin(): void
    {
        $res = ApiClient::post('/partner_applications_create.php', $this->validPayload(['pin' => 'abcd']));
        $this->assertFalse($res->ok());
    }

    public function testCannotValidateTwice(): void
    {
        $admin = Fixtures::createProfile('admin');
        ApiClient::post('/partner_applications_create.php', $this->validPayload());
        $appId = Fixtures::pdo()->query('SELECT id FROM partner_applications LIMIT 1')->fetchColumn();

        $first = ApiClient::post('/partner_applications_validate.php', ['application_id' => $appId], $admin['token']);
        $this->assertTrue($first->ok());
        $second = ApiClient::post('/partner_applications_validate.php', ['application_id' => $appId], $admin['token']);
        $this->assertFalse($second->ok());

        $cabineCount = (int)Fixtures::pdo()->query("SELECT COUNT(*) FROM profiles WHERE role = 'cabine'")->fetchColumn();
        $this->assertSame(1, $cabineCount, 'un seul compte doit avoir ete cree malgre la 2e tentative');
    }

    public function testCannotValidateIfPhoneAlreadyUsedByAnotherCabine(): void
    {
        $admin = Fixtures::createProfile('admin');
        Fixtures::createProfile('cabine', ['telephone' => '0700000001']);
        ApiClient::post('/partner_applications_create.php', $this->validPayload());
        $appId = Fixtures::pdo()->query('SELECT id FROM partner_applications LIMIT 1')->fetchColumn();

        $res = ApiClient::post('/partner_applications_validate.php', ['application_id' => $appId], $admin['token']);
        $this->assertFalse($res->ok());
    }

    public function testRefuseMarksApplicationWithoutCreatingAccount(): void
    {
        $admin = Fixtures::createProfile('admin');
        ApiClient::post('/partner_applications_create.php', $this->validPayload());
        $appId = Fixtures::pdo()->query('SELECT id FROM partner_applications LIMIT 1')->fetchColumn();

        $res = ApiClient::post('/partner_applications_refuse.php', ['application_id' => $appId], $admin['token']);
        $this->assertTrue($res->ok());

        $statut = Fixtures::pdo()->query("SELECT statut FROM partner_applications WHERE id = '$appId'")->fetchColumn();
        $this->assertSame('refusée', $statut);
        $cabineCount = (int)Fixtures::pdo()->query("SELECT COUNT(*) FROM profiles WHERE role = 'cabine'")->fetchColumn();
        $this->assertSame(0, $cabineCount);
    }

    public function testNonAdminCannotListOrValidate(): void
    {
        $client = Fixtures::createProfile('client');
        $this->assertSame(401, ApiClient::get('/partner_applications_list.php', null)->status);
        $this->assertSame(403, ApiClient::get('/partner_applications_list.php', $client['token'])->status);
    }
}
