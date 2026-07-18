'use strict';
// DB.referrals.{count,total,refresh} (js/db.js) — Phase H (mise en
// conformité temps réel). Transport uniquement — la règle de versement
// (50 F à la 1re commande terminée du filleul) est déjà couverte côté
// PHP (tests-php/ReferralsTest.php).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDb } = require('./helpers/loadDb');

test('referrals.refresh() : remplace count/total depuis le serveur', async () => {
  const { DB } = loadDb({
    online: true,
    serverReferralsSummary: async () => ({ ok: true, count: 3, total: 100 }),
  });
  DB.init();
  assert.equal(DB.referrals.count(), 0);
  assert.equal(DB.referrals.total(), 0);
  await DB.referrals.refresh();
  assert.equal(DB.referrals.count(), 3);
  assert.equal(DB.referrals.total(), 100);
});

test('referrals.refresh() hors ligne : ne tente jamais le réseau, garde le cache', async () => {
  let called = false;
  const { DB } = loadDb({
    online: false,
    serverReferralsSummary: async () => { called = true; return { ok: true, count: 5, total: 250 }; },
  });
  DB.init();
  await DB.referrals.refresh();
  assert.equal(called, false);
  assert.equal(DB.referrals.count(), 0);
});
