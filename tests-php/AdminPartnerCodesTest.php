<?php
declare(strict_types=1);

// api/admin_partner_codes_report.php + api/admin_partner_code_detail.php —
// rapport "Code partenaire" (admin) : agrège les deux flux de parrainage
// existants (referrals pour client->client, partner_applications.
// parrain_telephone pour client->candidature partenaire), avec le rôle de
// chaque personne inscrite (client/partenaire) et le nombre devenu
// partenaire validé ("souscrit").
final class AdminPartnerCodesTest extends ApiTestCase
{
    private function partnerPayload(array $overrides = []): array
    {
        return array_merge([
            'prenom' => 'Jean', 'nom' => 'Kouassi', 'email' => 'jean.kouassi@gmail.com',
            'telephone' => '0700000002', 'whatsapp' => '0700000002', 'cabine_nom' => 'Cabine Jean',
            'pin' => '1234', 'photo' => 'data:image/png;base64,abc', 'code_qr' => 'data:image/png;base64,def',
            'motivation' => 'Motivé', 'abonnement' => 'Premium', 'paiement_abo' => 'Orange Money',
            'paiement_vers' => 'Orange Money', 'numero_compte' => '0700000002', 'experience' => 'Débutant',
            'puces' => ['orange' => 1, 'mtn' => 0, 'moov' => 0],
        ], $overrides);
    }

    public function testReportRejectsNonAdmin(): void
    {
        $client = Fixtures::createProfile('client');
        $this->assertSame(401, ApiClient::post('/admin_partner_codes_report.php', [], null)->status);
        $this->assertSame(403, ApiClient::post('/admin_partner_codes_report.php', [], $client['token'])->status);
    }

    public function testReportAggregatesBothReferralFlowsForSameCode(): void
    {
        $admin = Fixtures::createProfile('admin');
        $referrer = Fixtures::createProfile('client', ['telephone' => '0700000001']);

        // Filleul client (flux referrals, 25 F).
        ApiClient::post('/create_account.php', [
            'role' => 'client', 'prenom' => 'Filleul', 'telephone' => '0700000009', 'pin' => '1234',
            'parrain_telephone' => '0700000001',
        ]);

        // Candidature partenaire parrainée, validée (flux
        // partner_applications, 1 000 F, compte comme "souscrit").
        ApiClient::post('/partner_applications_create.php', $this->partnerPayload(['parrain_telephone' => '0700000001']));
        $appId = Fixtures::pdo()->query("SELECT id FROM partner_applications WHERE telephone = '0700000002'")->fetchColumn();
        $validate = ApiClient::post('/partner_applications_validate.php', ['application_id' => $appId], $admin['token']);
        $this->assertTrue($validate->ok(), $validate->raw);

        $res = ApiClient::post('/admin_partner_codes_report.php', [], $admin['token']);
        $this->assertTrue($res->ok(), $res->raw);
        $row = null;
        foreach ($res->json['codes'] as $c) { if ($c['telephone'] === '0700000001') $row = $c; }
        $this->assertNotNull($row, 'le code du parrain doit apparaître dans le rapport');
        $this->assertSame('KP0700000001', $row['code']);
        $this->assertSame(2, $row['total_inscrits'], '1 filleul client + 1 candidature partenaire');
        $this->assertSame(1, $row['total_souscrits'], 'seule la candidature validée compte comme souscrite');
    }

    public function testReportTodayColumnsOnlyCountTodaysActivity(): void
    {
        $admin = Fixtures::createProfile('admin');
        Fixtures::createProfile('client', ['telephone' => '0700000001']);
        ApiClient::post('/create_account.php', [
            'role' => 'client', 'prenom' => 'Filleul', 'telephone' => '0700000009', 'pin' => '1234',
            'parrain_telephone' => '0700000001',
        ]);

        $todayRes = ApiClient::post('/admin_partner_codes_report.php', ['date' => date('Y-m-d')], $admin['token']);
        $pastRes  = ApiClient::post('/admin_partner_codes_report.php', ['date' => '2000-01-01'], $admin['token']);

        $todayRow = null; foreach ($todayRes->json['codes'] as $c) { if ($c['telephone'] === '0700000001') $todayRow = $c; }
        $pastRow  = null; foreach ($pastRes->json['codes']  as $c) { if ($c['telephone'] === '0700000001') $pastRow  = $c; }

        $this->assertSame(1, $todayRow['jour_inscrits']);
        $this->assertSame(0, $pastRow['jour_inscrits'], 'aucune inscription un jour où rien ne s\'est passé');
        // Le total, lui, ne depend jamais de la date choisie.
        $this->assertSame(1, $pastRow['total_inscrits']);
    }

    public function testReportSurnomSearchFindsClientEvenWithoutActivity(): void
    {
        $admin = Fixtures::createProfile('admin');
        Fixtures::createProfile('client', ['prenom' => 'Aya Sans Activite']);

        $res = ApiClient::post('/admin_partner_codes_report.php', ['surnom' => 'Aya Sans'], $admin['token']);
        $this->assertTrue($res->ok(), $res->raw);
        $this->assertCount(1, $res->json['codes']);
        $this->assertSame(0, $res->json['codes'][0]['total_inscrits']);
    }

    public function testReportHidesInactiveClientsWithoutSearch(): void
    {
        $admin = Fixtures::createProfile('admin');
        Fixtures::createProfile('client', ['prenom' => 'JamaisUtilise']);

        $res = ApiClient::post('/admin_partner_codes_report.php', [], $admin['token']);
        $this->assertTrue($res->ok(), $res->raw);
        foreach ($res->json['codes'] as $c) {
            $this->assertNotSame('JamaisUtilise', $c['prenom'], 'un client jamais utilisé comme parrain ne doit pas polluer la vue par défaut');
        }
    }

    public function testDetailListsEachPersonWithRoleAndStatus(): void
    {
        $admin = Fixtures::createProfile('admin');
        Fixtures::createProfile('client', ['telephone' => '0700000001']);
        ApiClient::post('/create_account.php', [
            'role' => 'client', 'prenom' => 'Filleul', 'telephone' => '0700000009', 'pin' => '1234',
            'parrain_telephone' => '0700000001',
        ]);
        ApiClient::post('/partner_applications_create.php', $this->partnerPayload(['parrain_telephone' => '0700000001']));

        $res = ApiClient::post('/admin_partner_code_detail.php', ['telephone' => '0700000001'], $admin['token']);
        $this->assertTrue($res->ok(), $res->raw);
        $this->assertCount(2, $res->json['people']);

        $roles = array_column($res->json['people'], 'role');
        sort($roles);
        $this->assertSame(['client', 'partenaire'], $roles);
    }
}
