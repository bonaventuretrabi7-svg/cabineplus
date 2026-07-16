-- Vérification identifiant + PIN côté serveur (jamais le mot de passe en
-- clair transmis ailleurs qu'ici). Appelée par l'Edge Function `login`
-- (supabase/functions/login) via service_role, jamais exposée à l'anon key.
-- `identifiant` : email (cabine/admin) ou téléphone (client).
create or replace function verify_login(p_identifiant text, p_pin text, p_role text)
returns profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile profiles;
begin
  select * into v_profile
  from profiles
  where role = p_role
    and (
      (p_role in ('cabine','admin') and lower(email) = lower(trim(p_identifiant)))
      or (p_role = 'client' and telephone = trim(p_identifiant))
    )
  limit 1;

  if v_profile.id is null then
    return null;
  end if;

  if v_profile.mot_de_passe_hash != crypt(p_pin, v_profile.mot_de_passe_hash) then
    return null;
  end if;

  return v_profile;
end;
$$;

-- Hache un PIN/mot de passe en bcrypt — utilisé à la création/mise à jour
-- d'un compte (remplace hashPwd() côté client, désormais trivialement
-- réversible et donc écarté).
create or replace function hash_password(p_pin text)
returns text
language sql
as $$
  select crypt(p_pin, gen_salt('bf'));
$$;

revoke execute on function verify_login(text, text, text) from public, anon, authenticated;
revoke execute on function hash_password(text) from public, anon, authenticated;

-- Changement de PIN/mot de passe (self ou par un admin) — remplace le
-- hashage client-side de l'ancien hashPwd(). N'affecte que profiles ; le
-- compte Supabase Auth "fantôme" associé (voir supabase/functions/login)
-- se resynchronise tout seul à la prochaine tentative de connexion.
create or replace function set_user_password(p_user_id uuid, p_new_pin text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_profile_id() is null then
    raise exception 'Non authentifié.';
  end if;
  if current_profile_id() != p_user_id and current_profile_role() != 'admin' then
    raise exception 'Non autorisé.';
  end if;
  update profiles set mot_de_passe_hash = crypt(p_new_pin, gen_salt('bf')), updated_at = now()
  where id = p_user_id;
end;
$$;

grant execute on function set_user_password(uuid, text) to authenticated;

-- Auto-inscription (client ou cabine, depuis client.html — voir
-- handleClientRegister()/handleCabineRegister() dans js/client.js) : anon ne
-- peut pas insérer directement dans profiles (RLS réservée à l'admin), donc
-- ce chemin passe par une fonction dédiée, security definer, qui applique
-- elle-même la vérification d'unicité téléphone+rôle (remplace le
-- "check puis create" non atomique de l'ancien DB.users.byPhoneAndRole()
-- côté client, désormais aussi une garantie serveur).
create or replace function create_account(
  p_role text, p_nom text, p_prenom text, p_telephone text, p_pin text,
  p_email text default null, p_cabine_nom text default null
) returns profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile profiles;
begin
  if p_role not in ('client', 'cabine') then
    raise exception 'Rôle non autorisé pour une inscription publique.';
  end if;
  if exists (select 1 from profiles where telephone = p_telephone and role = p_role) then
    raise exception 'Ce numéro est déjà utilisé par un autre compte de ce type.';
  end if;
  insert into profiles (role, nom, prenom, telephone, email, mot_de_passe_hash, cabine_nom, solde, statut)
  values (p_role, coalesce(p_nom, ''), coalesce(p_prenom, ''), p_telephone, p_email,
          crypt(p_pin, gen_salt('bf')), p_cabine_nom, 0, 'actif')
  returning * into v_profile;
  return v_profile;
end;
$$;

grant execute on function create_account(text, text, text, text, text, text, text) to anon, authenticated;
