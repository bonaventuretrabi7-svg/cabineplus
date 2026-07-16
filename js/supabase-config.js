/* ================================================================
   KBINE PLUS | Configuration Supabase
   ================================================================
   Renseigner ces deux valeurs depuis Project Settings > API du
   tableau de bord Supabase. L'anon key est publique par conception
   (elle est envoyée à chaque navigateur) — ne JAMAIS y mettre la clé
   service_role, qui doit rester uniquement côté Edge Functions. */
const SUPABASE_CONFIG = {
  url: 'https://VOTRE-PROJET.supabase.co',
  anonKey: 'VOTRE-ANON-KEY',
};
