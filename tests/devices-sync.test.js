'use strict';
// DB.partnerDevices.{syncSelf,refresh,allFromServer,revoke} (js/db.js) —
// Phase G (mise en conformité temps réel). Ces tests vérifient le
// transport, pas les règles métier (déjà couvertes côté PHP,
// tests-php/DevicesTest.php) — en particulier que syncSelf() reste un
// simple miroir best-effort qui ne perturbe jamais la logique locale
// "rester connecté" déjà en place (register/touch/findByToken).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDb } = require('./helpers/loadDb');

test('partnerDevices.syncSelf() : transporte deviceId/label/remember vers le serveur', async () => {
  let sent = null;
  const { DB } = loadDb({
    online: true,
    serverDevicesTouch: async (payload) => { sent = payload; return { ok: true, id: 'row1' }; },
  });
  DB.init();
  await DB.partnerDevices.syncSelf('dev-abc', 'Chrome sur Windows', true);
  assert.equal(sent.deviceId, 'dev-abc');
  assert.equal(sent.label, 'Chrome sur Windows');
  assert.equal(sent.remember, true);
});

test('partnerDevices.syncSelf() hors ligne : ne tente jamais le réseau', async () => {
  let called = false;
  const { DB } = loadDb({
    online: false,
    serverDevicesTouch: async () => { called = true; return { ok: true, id: 'row1' }; },
  });
  DB.init();
  await DB.partnerDevices.syncSelf('dev-abc', 'Label', false);
  assert.equal(called, false);
});

test('partnerDevices.refresh() : remplace le cache serveur local (distinct du cache "rester connecté")', async () => {
  const { DB } = loadDb({
    online: true,
    serverDevicesList: async () => ({ ok: true, devices: [
      { id: 'row1', profile_id: 'u1', device_id: 'dev-abc', label: 'Chrome', remembered: 1, last_seen_at: new Date().toISOString() },
    ] }),
  });
  DB.init();
  await DB.partnerDevices.refresh();
  assert.equal(DB.partnerDevices.allFromServer().length, 1);
  // Le cache local "rester connecté" (register/touch/findByToken) reste
  // un objet totalement séparé, jamais écrasé par refresh().
  assert.equal(DB.partnerDevices.all().length, 0);
});

test('partnerDevices.revoke() : succès -> rafraîchit le cache serveur', async () => {
  const { DB } = loadDb({
    online: true,
    serverDevicesRemove: async () => ({ ok: true }),
    serverDevicesList: async () => ({ ok: true, devices: [] }),
  });
  DB.init();
  const res = await DB.partnerDevices.revoke('row1');
  assert.equal(res.ok, true);
});

test('partnerDevices.revoke() : échec serveur -> erreur renvoyée', async () => {
  const { DB } = loadDb({
    online: true,
    serverDevicesRemove: async () => ({ ok: false, error: 'Vous ne pouvez déconnecter que vos propres appareils.' }),
  });
  DB.init();
  const res = await DB.partnerDevices.revoke('row1');
  assert.equal(res.ok, false);
});
