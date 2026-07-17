-- Compte super-admin (application en production — aucun compte de
-- démonstration) : seul moyen de démarrer, les comptes cabine/client se
-- créent ensuite normalement depuis l'app ou depuis le panneau admin.
-- Note : auth_user_id reste NULL ici — il est renseigné automatiquement à
-- la première connexion réussie (voir supabase/functions/login), qui crée
-- le compte Supabase Auth correspondant à la volée.

insert into profiles (nom, prenom, telephone, email, mot_de_passe_hash, role, solde, statut, admin_level, zone, date_creation) values
  ('TRA BI', 'BONAVENTURE VANIE HOLLAND', '0789794720', 'bonaventuretrab7@gmail.com', hash_password('1973'), 'admin', 0, 'actif', 'super', 'Abidjan', '2024-01-01T00:00:00Z');

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
