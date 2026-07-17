-- Blocage après 3 tentatives incorrectes (Auth.login() dans js/auth.js),
-- porté côté serveur pour que la même règle s'applique quel que soit
-- l'appareil qui tente la connexion (voir supabase/functions/login).
-- Ces deux fonctions ne sont appelées que par l'Edge Function via le
-- client service_role (jamais directement par le navigateur) — révoquées
-- de anon/authenticated comme verify_login().

-- Retrouve un profil par identifiant+rôle SANS vérifier le mot de passe,
-- pour pouvoir inspecter son statut (bloqué ?) avant même de tenter la
-- comparaison — même ordre de vérification que l'ancien code 100% local
-- ("un compte bloqué ne doit plus jamais réévaluer une tentative").
create or replace function find_profile_for_login(p_identifiant text, p_role text)
returns profiles
language sql stable security definer set search_path = public as $$
  select * from profiles
  where role = p_role
    and (
      (p_role in ('cabine','admin') and lower(email) = lower(trim(p_identifiant)))
      or (p_role = 'client' and telephone = trim(p_identifiant))
    )
  limit 1;
$$;

-- Incrémente le compteur d'échecs et bloque le compte au 3e (statut
-- 'bloqué') — retourne le profil à jour pour que l'appelant sache
-- immédiatement si ce dernier échec vient de déclencher le blocage. Le
-- super admin n'est JAMAIS bloqué (même garde-fou que
-- migrateAdminIdentity() côté local, js/db.js) : c'est le seul compte
-- admin possible (aucune auto-inscription admin), un blocage définitif
-- rendrait le panneau admin à jamais inaccessible.
create or replace function register_failed_login(p_profile_id uuid)
returns profiles
language plpgsql security definer set search_path = public as $$
declare v_profile profiles;
begin
  update profiles set
    tentatives_echouees = tentatives_echouees + 1,
    statut = case
      when tentatives_echouees + 1 >= 3 and admin_level != 'super' then 'bloqué'
      else statut
    end
  where id = p_profile_id
  returning * into v_profile;
  return v_profile;
end;
$$;

-- Remet le compteur à zéro après une connexion réussie.
create or replace function reset_login_attempts(p_profile_id uuid)
returns void
language sql security definer set search_path = public as $$
  update profiles set tentatives_echouees = 0 where id = p_profile_id and tentatives_echouees != 0;
$$;

revoke execute on function find_profile_for_login(text, text) from public, anon, authenticated;
revoke execute on function register_failed_login(uuid) from public, anon, authenticated;
revoke execute on function reset_login_attempts(uuid) from public, anon, authenticated;
