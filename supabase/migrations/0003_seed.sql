-- Comptes de démonstration (mêmes identifiants que l'ancien seed()
-- localStorage de js/db.js) — permet de valider la connexion Lot 1 avec
-- exactement les mêmes identifiants qu'avant la migration.
-- Note : auth_user_id reste NULL ici — il est renseigné automatiquement à
-- la première connexion réussie de chacun (voir supabase/functions/login),
-- qui crée le compte Supabase Auth correspondant à la volée.

insert into profiles (nom, prenom, telephone, email, mot_de_passe_hash, role, solde, statut, admin_level, zone, date_creation) values
  ('TRA BI', 'BONAVENTURE VANIE HOLLAND', '0789794720', 'bonaventuretrab7@gmail.com', hash_password('1973'), 'admin', 0, 'actif', 'super', 'Abidjan', '2024-01-01T00:00:00Z');

insert into profiles (nom, prenom, telephone, email, mot_de_passe_hash, role, solde, statut, zone, cabine_nom, commissions_total, transferts_total, date_creation) values
  ('KONÉ', 'Aminata', '0705123456', 'cabine1@gmail.com', hash_password('1234'), 'cabine', 185000, 'actif', 'Cocody',  'KBINE Plus Cocody',  23500, 187, '2024-01-15T09:00:00Z'),
  ('TRAORÉ', 'Moussa', '0103789012', 'cabine2@gmail.com', hash_password('1234'), 'cabine', 92000,  'actif', 'Yopougon','KBINE Plus Yopougon', 11200, 98,  '2024-02-01T10:30:00Z'),
  ('OUATTARA', 'Fatoumata', '0759345678', 'cabine3@gmail.com', hash_password('1234'), 'cabine', 43000, 'inactif', 'Abobo', 'KBINE Plus Abobo', 5800, 52, '2024-03-10T08:00:00Z');

insert into profiles (nom, prenom, telephone, email, mot_de_passe_hash, role, solde, statut, date_creation) values
  ('COULIBALY', 'Jean-Baptiste', '0504112233', 'client@cabineplus.ci', hash_password('1234'),        'client', 47500, 'actif',    '2024-02-10T11:00:00Z'),
  ('BAMBA',     'Mariam',        '0717223344', 'mariam@example.ci',    hash_password('Client@2024'), 'client', 12000, 'actif',    '2024-02-20T14:00:00Z'),
  ('N''GUESSAN','Koffi',         '0585334455', 'koffi@example.ci',     hash_password('Client@2024'), 'client', 5000,  'suspendu', '2024-03-05T16:00:00Z'),
  ('DIABATÉ',   'Aïcha',         '0102445566', 'aicha@example.ci',     hash_password('Client@2024'), 'client', 78200, 'actif',    '2024-04-01T09:30:00Z'),
  ('YAO',       'Serge',         '0768556677', 'serge@example.ci',     hash_password('Client@2024'), 'client', 3500,  'actif',    '2024-04-15T12:00:00Z');

update settings set
  maintenance = '{
    "global":   { "enabled": false, "message": "" },
    "services": { "recharger": false, "depenses": false, "transferer": false, "historique": false, "facture": false, "recharge_uv": false, "exchange": false },
    "networks": { "Orange": false, "MTN": false, "Moov": false },
    "networksByService": {
      "exchange": { "Orange": false, "MTN": false, "Moov": false },
      "recharge": { "Orange": false, "MTN": false, "Moov": false, "Wave": false }
    },
    "factureServices": {
      "cie_prepaye": { "blocked": false, "message": "" },
      "cie_facture": { "blocked": false, "message": "" },
      "sodeci":      { "blocked": false, "message": "" },
      "canal_plus":  { "blocked": false, "message": "" },
      "canalbox":    { "blocked": false, "message": "" },
      "sotra":       { "blocked": false, "message": "" }
    }
  }'::jsonb,
  assistance = '{ "whatsapp": [], "email": "", "facebook": "", "snapchat": "" }'::jsonb,
  assistant_cabine = '{ "whatsapp": [] }'::jsonb,
  assistant_client = '{ "whatsapp": [], "schedule": [] }'::jsonb,
  ussd_templates = '{ "mtn": "*133*6*2*{numero_destinataire}#", "moov_marchand": "*155*6*2*{numero_destinataire}#" }'::jsonb
where id = true;
