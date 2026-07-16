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

  let body: { identifiant?: string; pin?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Requête invalide.' }), { status: 400 });
  }

  const { identifiant, pin, role } = body;
  if (!identifiant || !pin || !role) {
    return new Response(JSON.stringify({ error: 'Identifiant, PIN et rôle requis.' }), { status: 400 });
  }

  const { data: profile, error: verifyError } = await admin
    .rpc('verify_login', { p_identifiant: identifiant, p_pin: pin, p_role: role })
    .single();

  if (verifyError || !profile) {
    return new Response(JSON.stringify({ error: 'Identifiant ou PIN incorrect.' }), { status: 401 });
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
