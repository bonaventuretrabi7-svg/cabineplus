// Edge Function `login` — pont entre l'authentification "identifiant + PIN
// à 4 chiffres" telle qu'affichée à l'écran (inchangée pour l'utilisateur)
// et une vraie session Supabase Auth exploitable ensuite par le front pour
// toutes les requêtes (RLS basé sur auth.uid()).
//
// Étapes :
//  1. verify_login() (SQL, security definer) vérifie identifiant+PIN contre
//     profiles.mot_de_passe_hash — jamais le PIN en clair ailleurs qu'ici.
//  2. Un utilisateur Supabase Auth "fantôme" est créé au premier login
//     (email synthétique <profile.id>@auth.kbineplus.internal, mot de passe
//     = le PIN), pour pouvoir ensuite émettre une session standard.
//  3. Si le PIN a changé côté profiles depuis la dernière connexion (auth
//     user désynchronisé), son mot de passe Supabase Auth est resynchronisé
//     automatiquement avant de réessayer — aucune action manuelle requise
//     ailleurs dans l'app à chaque changement de mot de passe.
//
// Déploiement : `supabase functions deploy login` (clé service_role
// nécessaire en variable d'environnement du projet — jamais exposée au front).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function authEmailFor(profileId: string) {
  return `${profileId}@auth.kbineplus.internal`;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Méthode non autorisée.' }), { status: 405 });
  }

  let body: { identifiant?: string; pin?: string; role?: string; silent?: boolean };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Requête invalide.' }), { status: 400 });
  }

  const { identifiant, pin, role, silent } = body;
  if (!identifiant || !pin || !role) {
    return new Response(JSON.stringify({ error: 'Identifiant, PIN et rôle requis.' }), { status: 400 });
  }

  // Mode silencieux : établit (ou rafraîchit) une session Supabase Auth en
  // arrière-plan pour un appareil déjà connecté avec succès en LOCAL (voir
  // Auth.login() dans js/auth.js) — nécessaire pour que les actions
  // authentifiées côté serveur (ex. admin_create_account, RLS sur profiles)
  // fonctionnent même quand le mot de passe local suffisait déjà, sans quoi
  // un appareil qui ne s'est jamais trompé n'obtiendrait jamais de session
  // serveur. AUCUN effet de bord sur le compteur de tentatives : un échec ici
  // (ex. mot de passe changé ailleurs depuis) ne doit jamais faire progresser
  // vers un blocage — seule une tentative de connexion explicite le peut.
  let profile;
  if (silent) {
    const { data, error } = await admin
      .rpc('verify_login', { p_identifiant: identifiant, p_pin: pin, p_role: role })
      .single();
    if (error || !data) {
      return new Response(JSON.stringify({ error: 'Session non établie.' }), { status: 401 });
    }
    profile = data;
  } else {
    // Statut vérifié AVANT même la comparaison du PIN — un compte bloqué ne
    // doit plus jamais réévaluer une tentative (même règle que l'ancienne
    // vérification 100% locale, voir Auth.login() dans js/auth.js).
    const { data: existing } = await admin
      .rpc('find_profile_for_login', { p_identifiant: identifiant, p_role: role })
      .single();

    if (!existing) {
      return new Response(JSON.stringify({ error: 'Compte introuvable.' }), { status: 401 });
    }
    if (existing.statut === 'bloqué') {
      return new Response(JSON.stringify({
        error: "Compte bloqué après 3 tentatives incorrectes. Contactez l'administration pour le débloquer.",
      }), { status: 403 });
    }

    const { data: verified, error: verifyError } = await admin
      .rpc('verify_login', { p_identifiant: identifiant, p_pin: pin, p_role: role })
      .single();

    if (verifyError || !verified) {
      const { data: updated } = await admin
        .rpc('register_failed_login', { p_profile_id: existing.id })
        .single();
      const blocked = updated?.statut === 'bloqué';
      return new Response(JSON.stringify({
        error: blocked
          ? "Compte bloqué après 3 tentatives incorrectes. Contactez l'administration pour le débloquer."
          : 'Identifiant ou PIN incorrect.',
      }), { status: 401 });
    }
    profile = verified;

    if (profile.tentatives_echouees) {
      await admin.rpc('reset_login_attempts', { p_profile_id: profile.id });
    }
  }

  const authEmail = authEmailFor(profile.id);
  const anon = createClient(SUPABASE_URL, ANON_KEY);

  if (!profile.auth_user_id) {
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: authEmail,
      password: pin,
      email_confirm: true,
    });
    if (createError || !created.user) {
      return new Response(JSON.stringify({ error: "Échec de création de la session." }), { status: 500 });
    }
    await admin.from('profiles').update({ auth_user_id: created.user.id }).eq('id', profile.id);
  }

  let { data: signIn, error: signInError } = await anon.auth.signInWithPassword({
    email: authEmail,
    password: pin,
  });

  // PIN changé côté profiles depuis la dernière connexion : l'utilisateur
  // Supabase Auth fantôme est resynchronisé puis on réessaie une seule fois.
  if (signInError) {
    const { data: refetched } = await admin.from('profiles').select('auth_user_id').eq('id', profile.id).single();
    const authUserId = refetched?.auth_user_id;
    if (authUserId) {
      await admin.auth.admin.updateUserById(authUserId, { password: pin });
      ({ data: signIn, error: signInError } = await anon.auth.signInWithPassword({ email: authEmail, password: pin }));
    }
  }

  if (signInError || !signIn.session) {
    return new Response(JSON.stringify({ error: "Échec de création de la session." }), { status: 500 });
  }

  return new Response(JSON.stringify({ session: signIn.session, profile }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
