<?php
declare(strict_types=1);

// api/retraits_create.php / retraits_list.php / cabine_set_retrait_info.php
// (Phase D) — corrige un bug financier réel : l'ancien flux local
// (confirmProcessRetrait(), js/admin.js) débitait le solde de la cabine
// UNIQUEMENT dans le cache du navigateur admin, jamais côté serveur ; le
// prochain rafraîchissement de la liste des cabines écrasait ce débit
// avec la valeur serveur inchangée. Ces tests vérifient le débit atomique
// réel, ainsi que la persistance et le délai de 24h du moyen de retrait.
final class RetraitsTest extends ApiTestCase
{
    public function testAdminCanProcessWithdrawalDebitsSoldeAndRecordsIt(): void
    {
        $admin = Fixtures::createProfile('admin');
        $cabine = Fixtures::createProfile('cabine', ['solde' => 5000, 'paiement_vers' => 'Orange Money', 'numero_compte' => '0700000000']);

        $res = ApiClient::post('/retraits_create.php', ['cabine_id' => $cabine['profile']['id'], 'montant' => 2000], $admin['token']);
        $this->assertTrue($res->ok(), $res->raw);

        $updated = Fixtures::fetchProfile($cabine['profile']['id']);
        $this->assertSame(3000, (int)$updated['solde'], 'le debit doit etre reellement applique cote serveur');

        $row = Fixtures::pdo()->query("SELECT * FROM retraits WHERE cabine_id = '{$cabine['profile']['id']}'")->fetch();
        $this->assertNotFalse($row);
        $this->assertSame(2000, (int)$row['montant']);
        $this->assertSame('Orange Money', $row['methode_retrait']);
    }

    public function testCannotWithdrawMoreThanAvailableBalance(): void
    {
        $admin = Fixtures::createProfile('admin');
        $cabine = Fixtures::createProfile('cabine', ['solde' => 1000]);

        $res = ApiClient::post('/retraits_create.php', ['cabine_id' => $cabine['profile']['id'], 'montant' => 5000], $admin['token']);
        $this->assertFalse($res->ok());

        $unchanged = Fixtures::fetchProfile($cabine['profile']['id']);
        $this->assertSame(1000, (int)$unchanged['solde'], 'aucun debit partiel ne doit avoir lieu sur un echec');
        $count = (int)Fixtures::pdo()->query("SELECT COUNT(*) FROM retraits WHERE cabine_id = '{$cabine['profile']['id']}'")->fetchColumn();
        $this->assertSame(0, $count);
    }

    public function testRegularCabineCannotProcessWithdrawals(): void
    {
        $cabine = Fixtures::createProfile('cabine', ['solde' => 5000]);
        $other = Fixtures::createProfile('cabine', ['solde' => 1000]);

        $res = ApiClient::post('/retraits_create.php', ['cabine_id' => $other['profile']['id'], 'montant' => 500], $cabine['token']);
        $this->assertSame(403, $res->status);
    }

    public function testCabineSeesOnlyOwnRetraitsAdminSeesAll(): void
    {
        $admin = Fixtures::createProfile('admin');
        $cabineA = Fixtures::createProfile('cabine', ['solde' => 5000]);
        $cabineB = Fixtures::createProfile('cabine', ['solde' => 5000]);

        ApiClient::post('/retraits_create.php', ['cabine_id' => $cabineA['profile']['id'], 'montant' => 1000], $admin['token']);
        ApiClient::post('/retraits_create.php', ['cabine_id' => $cabineB['profile']['id'], 'montant' => 1000], $admin['token']);

        $resA = ApiClient::get('/retraits_list.php', $cabineA['token']);
        $this->assertCount(1, $resA->json['retraits']);

        $resAdmin = ApiClient::get('/retraits_list.php', $admin['token']);
        $this->assertCount(2, $resAdmin->json['retraits']);
    }

    public function testCabineCanSetOwnRetraitInfoOncePerDay(): void
    {
        $cabine = Fixtures::createProfile('cabine');

        $first = ApiClient::post('/cabine_set_retrait_info.php', ['paiement_vers' => 'Orange Money', 'numero_compte' => '0700000000'], $cabine['token']);
        $this->assertTrue($first->ok(), $first->raw);

        $updated = Fixtures::fetchProfile($cabine['profile']['id']);
        $this->assertSame('Orange Money', $updated['paiement_vers']);
        $this->assertSame('0700000000', $updated['numero_compte']);

        // Deuxieme tentative le meme jour -- doit etre bloquee (delai de 24h).
        $second = ApiClient::post('/cabine_set_retrait_info.php', ['paiement_vers' => 'MTN MoMo', 'numero_compte' => '0500000000'], $cabine['token']);
        $this->assertSame(429, $second->status);

        $stillOld = Fixtures::fetchProfile($cabine['profile']['id']);
        $this->assertSame('Orange Money', $stillOld['paiement_vers'], 'le second appel ne doit rien changer pendant le delai');
    }

    public function testAdminCanEditAnyCabineRetraitInfoWithoutCooldown(): void
    {
        $admin = Fixtures::createProfile('admin');
        $cabine = Fixtures::createProfile('cabine', ['paiement_vers' => 'Orange Money', 'numero_compte' => '0700000000', 'retrait_derniere_maj' => date('Y-m-d H:i:s')]);

        $res = ApiClient::post('/cabine_set_retrait_info.php', [
            'paiement_vers' => 'MTN MoMo', 'numero_compte' => '0500000000', 'target_id' => $cabine['profile']['id'],
        ], $admin['token']);
        $this->assertTrue($res->ok(), $res->raw);

        $updated = Fixtures::fetchProfile($cabine['profile']['id']);
        $this->assertSame('MTN MoMo', $updated['paiement_vers']);
    }
}
