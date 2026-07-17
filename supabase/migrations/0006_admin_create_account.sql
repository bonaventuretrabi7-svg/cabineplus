-- Création de compte PAR L'ADMINISTRATION (cabine approuvée depuis une
-- candidature, compte admin "simple" ajouté par le super admin — voir
-- finishCreateUser()/handleApprovePartnerApp() dans js/admin.js). Distincte
-- de create_account() (0002_auth.sql, accordée à anon pour l'auto-
-- inscription publique client/cabine) : celle-ci exige une session
-- authentifiée avec le rôle admin (voir current_profile_role(),
-- 0001_init.sql), et autorise en plus le rôle 'admin', jamais permis en
-- auto-inscription.
--
-- Nécessite que le navigateur de l'admin détienne une session Supabase Auth
-- réelle au moment de l'appel — voir le mode "silent" de
-- supabase/functions/login (établi automatiquement après toute connexion
-- admin réussie, même via le chemin local rapide, voir Auth.login() dans
-- js/auth.js).
create or replace function admin_create_account(
  p_role text, p_nom text, p_prenom text, p_telephone text, p_pin text,
  p_email text default null, p_cabine_nom text default null, p_admin_level text default null
) returns profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile profiles;
begin
  if current_profile_role() != 'admin' then
    raise exception 'Non autorisé.';
  end if;
  if p_role not in ('client', 'cabine', 'admin') then
    raise exception 'Rôle invalide.';
  end if;
  if p_telephone is not null and p_telephone != '' and exists (
    select 1 from profiles where telephone = p_telephone and role = p_role
  ) then
    raise exception 'Ce numéro est déjà utilisé par un autre compte de ce type.';
  end if;
  if p_email is not null and p_email != '' and exists (
    select 1 from profiles where lower(email) = lower(p_email) and role = p_role
  ) then
    raise exception 'Cet email est déjà utilisé par un autre compte.';
  end if;
  insert into profiles (role, nom, prenom, telephone, email, mot_de_passe_hash, cabine_nom, admin_level, solde, statut)
  values (p_role, coalesce(p_nom, ''), coalesce(p_prenom, ''), p_telephone, p_email,
          crypt(p_pin, gen_salt('bf')), p_cabine_nom, p_admin_level, 0, 'actif')
  returning * into v_profile;
  return v_profile;
end;
$$;

revoke execute on function admin_create_account(text, text, text, text, text, text, text, text) from public, anon;
grant execute on function admin_create_account(text, text, text, text, text, text, text, text) to authenticated;
