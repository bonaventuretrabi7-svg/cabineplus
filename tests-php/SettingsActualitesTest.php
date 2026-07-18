<?php
declare(strict_types=1);

// api/settings_get.php / settings_update.php — colonne actualites
// (Phase I, dernière phase) : remplace le bandeau Football/Politique codé
// en dur (sans rapport avec KBINE PLUS) par des annonces gérées par
// l'administration, même patron que maintenance/assistance déjà en place.
final class SettingsActualitesTest extends ApiTestCase
{
    public function testGetSettingsReturnsNullActualitesByDefault(): void
    {
        $res = ApiClient::get('/settings_get.php', null);
        $this->assertSame(200, $res->status);
        $this->assertArrayHasKey('actualites', $res->json['settings']);
        $this->assertNull($res->json['settings']['actualites']);
    }

    public function testAdminCanPublishAndReadBackActualites(): void
    {
        $admin = Fixtures::createProfile('admin');
        $items = [
            ['id' => 'actu_1', 'titre' => 'Nouveau service', 'message' => 'Détails', 'date' => '2026-01-01T10:00:00.000Z'],
        ];

        $update = ApiClient::post('/settings_update.php', ['actualites' => $items], $admin['token']);
        $this->assertSame(200, $update->status);
        $this->assertCount(1, $update->json['settings']['actualites']);
        $this->assertSame('Nouveau service', $update->json['settings']['actualites'][0]['titre']);

        // Lecture publique independante round-trip correctement.
        $get = ApiClient::get('/settings_get.php', null);
        $this->assertCount(1, $get->json['settings']['actualites']);
    }

    public function testNonAdminCannotUpdateSettings(): void
    {
        $client = Fixtures::createProfile('client');
        $res = ApiClient::post('/settings_update.php', ['actualites' => []], $client['token']);
        $this->assertSame(403, $res->status);
    }

    public function testUpdateWithoutAuthFails(): void
    {
        $res = ApiClient::post('/settings_update.php', ['actualites' => []], null);
        $this->assertSame(401, $res->status);
    }
}
