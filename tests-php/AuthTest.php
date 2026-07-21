<?php
declare(strict_types=1);

// api/login.php / api/create_account.php — 3 tentatives de PIN incorrectes
// bloque le compte (sauf super admin, jamais bloqué), et l'auto-inscription
// publique refuse les doublons téléphone+rôle.
final class AuthTest extends ApiTestCase
{
    public function testCorrectPinReturnsTokenAndNeverLeaksPasswordHash(): void
    {
        $client = Fixtures::createProfile('client', ['pin' => '4242']);

        $res = ApiClient::post('/login.php', [
            'identifiant' => $client['profile']['telephone'],
            'pin' => '4242',
            'role' => 'client',
        ]);

        $this->assertSame(200, $res->status);
        $this->assertArrayHasKey('token', $res->json);
        $this->assertArrayNotHasKey('mot_de_passe_hash', $res->json['profile']);
    }

    public function testThreeWrongPinAttemptsBlocksAccount(): void
    {
        $client = Fixtures::createProfile('client', ['pin' => '4242']);
        $tel = $client['profile']['telephone'];

        for ($i = 0; $i < 3; $i++) {
            $res = ApiClient::post('/login.php', ['identifiant' => $tel, 'pin' => '0000', 'role' => 'client']);
            $this->assertSame(401, $res->status);
        }

        $blocked = Fixtures::fetchProfile($client['profile']['id']);
        $this->assertSame('bloqué', $blocked['statut']);

        // Même le BON PIN échoue désormais.
        $res = ApiClient::post('/login.php', ['identifiant' => $tel, 'pin' => '4242', 'role' => 'client']);
        $this->assertSame(403, $res->status);
    }

    public function testSuccessfulLoginResetsFailedAttemptsCounter(): void
    {
        $client = Fixtures::createProfile('client', ['pin' => '4242']);
        $tel = $client['profile']['telephone'];

        ApiClient::post('/login.php', ['identifiant' => $tel, 'pin' => '0000', 'role' => 'client']);
        ApiClient::post('/login.php', ['identifiant' => $tel, 'pin' => '0000', 'role' => 'client']);
        $res = ApiClient::post('/login.php', ['identifiant' => $tel, 'pin' => '4242', 'role' => 'client']);
        $this->assertSame(200, $res->status);

        $updated = Fixtures::fetchProfile($client['profile']['id']);
        $this->assertSame(0, (int)$updated['tentatives_echouees']);
    }

    public function testSuperAdminIsNeverBlockedByFailedAttempts(): void
    {
        $admin = Fixtures::createProfile('admin', ['admin_level' => 'super', 'pin' => '1973']);
        $email = $admin['profile']['email'];

        for ($i = 0; $i < 5; $i++) {
            ApiClient::post('/login.php', ['identifiant' => $email, 'pin' => 'wrong', 'role' => 'admin']);
        }

        $stillActive = Fixtures::fetchProfile($admin['profile']['id']);
        $this->assertSame('actif', $stillActive['statut']);

        $res = ApiClient::post('/login.php', ['identifiant' => $email, 'pin' => '1973', 'role' => 'admin']);
        $this->assertSame(200, $res->status);
    }

    public function testCreateAccountRejectsDuplicatePhoneForSameRole(): void
    {
        $existing = Fixtures::createProfile('client');

        $res = ApiClient::post('/create_account.php', [
            'role' => 'client', 'nom' => 'Test', 'prenom' => 'Doublon',
            'telephone' => $existing['profile']['telephone'], 'pin' => '1234',
        ]);

        $this->assertFalse($res->ok());
        $count = (int)Fixtures::pdo()->query("SELECT COUNT(*) FROM profiles WHERE telephone = '{$existing['profile']['telephone']}'")->fetchColumn();
        $this->assertSame(1, $count);
    }

    public function testCreateAccountRejectsAdminRole(): void
    {
        $res = ApiClient::post('/create_account.php', [
            'role' => 'admin', 'nom' => 'Test', 'prenom' => 'Intrus',
            'telephone' => '0788889999', 'pin' => '1234',
        ]);
        $this->assertFalse($res->ok());
    }

    // Le surnom est désormais obligatoire à l'inscription client (voir
    // handleAuthGateRegister(), js/client.js) — affiché ensuite à chaque
    // connexion (showLoginSuccess()/clientDisplayName()). La cabine a son
    // propre parcours d'inscription (prg-*, index.html), non concerné.
    public function testCreateAccountRequiresSurnomForClientRole(): void
    {
        $res = ApiClient::post('/create_account.php', [
            'role' => 'client', 'telephone' => '0788880000', 'pin' => '1234',
        ]);
        $this->assertFalse($res->ok());
        $count = (int)Fixtures::pdo()->query("SELECT COUNT(*) FROM profiles WHERE telephone = '0788880000'")->fetchColumn();
        $this->assertSame(0, $count, 'aucun compte client ne doit être créé sans surnom');
    }

    public function testEndpointsRejectMissingOrInvalidToken(): void
    {
        $res = ApiClient::post('/orders_create.php', ['operateur' => 'Orange', 'numero_beneficiaire' => '0700000000', 'montant' => 1000]);
        $this->assertSame(401, $res->status);

        $res2 = ApiClient::post('/orders_create.php', ['operateur' => 'Orange', 'numero_beneficiaire' => '0700000000', 'montant' => 1000], 'jeton-invalide');
        $this->assertSame(401, $res2->status);
    }
}
