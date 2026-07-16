-- KBINE PLUS — schéma Postgres initial (migration LocalStorage -> Supabase)
-- Reprend les noms de champs déjà utilisés par js/db.js pour minimiser les
-- changements côté application. uuid + timestamptz remplacent les anciens
-- ids "Date.now()+random" et dates ISO en chaîne.

create extension if not exists pgcrypto;

-- ── profiles (ex DB.users) ──────────────────────────────────────────
create table profiles (
  id                 uuid primary key default gen_random_uuid(),
  auth_user_id       uuid unique references auth.users(id) on delete set null,
  nom                text not null default '',
  prenom             text not null default '',
  telephone          text,
  email              text,
  mot_de_passe_hash  text not null,
  role               text not null check (role in ('client','cabine','admin')),
  solde              bigint not null default 0,
  statut             text not null default 'actif',
  admin_level        text,
  permissions        jsonb,
  zone               text,
  cabine_nom         text,
  commissions_total  bigint default 0,
  transferts_total   bigint default 0,
  limite_commandes   integer,
  en_pause           boolean default false,
  reseaux_actifs     jsonb,
  services_actifs    jsonb,
  date_creation      timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index profiles_telephone_role_idx on profiles (telephone, role) where telephone is not null;
create index profiles_role_idx on profiles (role);

-- ── transactions ─────────────────────────────────────────────────────
create table transactions (
  id                   uuid primary key default gen_random_uuid(),
  client_id            uuid references profiles(id),
  cabine_id            uuid references profiles(id),
  type                 text,
  operateur            text,
  service              text,
  numero_beneficiaire  text,
  moyen_paiement       text,
  numero_paiement      text,
  montant              bigint not null,
  frais_service        bigint not null default 0,
  commission           bigint not null default 0,
  statut               text not null default 'en_attente',
  notes                text,
  details              jsonb,
  date                 timestamptz not null default now(),
  date_assignation     timestamptz
);
create index transactions_client_idx on transactions (client_id);
create index transactions_cabine_idx on transactions (cabine_id);
create index transactions_statut_idx on transactions (statut);

-- ── notifications ────────────────────────────────────────────────────
create table notifications (
  id              uuid primary key default gen_random_uuid(),
  utilisateur_id  uuid not null references profiles(id) on delete cascade,
  message         text not null,
  lu              boolean not null default false,
  type            text not null default 'info',
  date            timestamptz not null default now()
);
create index notifications_user_idx on notifications (utilisateur_id);

-- ── commissions ──────────────────────────────────────────────────────
create table commissions (
  id           uuid primary key default gen_random_uuid(),
  label        text,
  pourcentage  numeric not null default 5,
  montant_min  bigint default 0,
  montant_max  bigint default 99999,
  actif        boolean not null default true,
  date         timestamptz not null default now()
);

-- ── settings (une seule ligne, une colonne par section) ─────────────
create table settings (
  id                  boolean primary key default true check (id),
  platform_name       text not null default 'KBINE PLUS',
  currency            text not null default 'FCFA',
  commission_rate     numeric not null default 5,
  min_transfer        bigint not null default 500,
  max_transfer        bigint not null default 100000,
  recharge_min        bigint not null default 1000,
  maintenance         jsonb not null default '{}',
  assistance          jsonb not null default '{}',
  assistant_cabine    jsonb not null default '{}',
  assistant_client    jsonb not null default '{}',
  ussd_templates      jsonb not null default '{}',
  admin_schedules     jsonb not null default '[]',
  updated_at          timestamptz not null default now()
);
insert into settings (id) values (true);

-- ── reclamations + fil de discussion ─────────────────────────────────
create table reclamations (
  id              uuid primary key default gen_random_uuid(),
  transaction_id  uuid references transactions(id),
  client_id       uuid references profiles(id),
  cabine_id       uuid references profiles(id),
  motif           text,
  statut          text not null default 'en_attente',
  screenshot_url  text,
  relances_apres_preuve integer not null default 0,
  date_created    timestamptz not null default now(),
  date_resolved   timestamptz
);
create index reclamations_cabine_idx on reclamations (cabine_id);
create index reclamations_client_idx on reclamations (client_id);

create table reclamation_messages (
  id              uuid primary key default gen_random_uuid(),
  reclamation_id  uuid not null references reclamations(id) on delete cascade,
  sender          text not null,
  type            text not null default 'texte',
  texte           text,
  screenshot_url  text,
  date            timestamptz not null default now()
);
create index reclamation_messages_recla_idx on reclamation_messages (reclamation_id);

-- ── retraits (commission cabiniste) ──────────────────────────────────
create table retraits (
  id               uuid primary key default gen_random_uuid(),
  cabine_id        uuid not null references profiles(id),
  montant          bigint not null,
  methode_retrait  text not null,
  statut           text not null default 'en_attente',
  date             timestamptz not null default now()
);
create index retraits_cabine_idx on retraits (cabine_id);

-- ── retards (historique) ─────────────────────────────────────────────
create table retards (
  id                        uuid primary key default gen_random_uuid(),
  cabine_id                 uuid not null references profiles(id),
  transaction_id            uuid references transactions(id),
  reassigned_to_cabine_id   uuid references profiles(id),
  triggered_suspension      boolean not null default false,
  date                      timestamptz not null default now()
);
create index retards_cabine_idx on retards (cabine_id);

-- ── renvois manuels (cabine_refusals) ─────────────────────────────────
create table cabine_refusals (
  id         uuid primary key default gen_random_uuid(),
  cabine_id  uuid not null references profiles(id),
  date       timestamptz not null default now()
);
create index cabine_refusals_cabine_idx on cabine_refusals (cabine_id);

-- ── transferts cabine-à-cabine ────────────────────────────────────────
create table transferts_cabine (
  id               uuid primary key default gen_random_uuid(),
  from_cabine_id   uuid not null references profiles(id),
  to_cabine_id     uuid not null references profiles(id),
  montant          bigint not null,
  frais            bigint not null default 0,
  date             timestamptz not null default now()
);
create index transferts_cabine_from_idx on transferts_cabine (from_cabine_id);
create index transferts_cabine_to_idx on transferts_cabine (to_cabine_id);

-- ── refund_requests ───────────────────────────────────────────────────
create table refund_requests (
  id              uuid primary key default gen_random_uuid(),
  reclamation_id  uuid references reclamations(id),
  transaction_id  uuid references transactions(id),
  cabine_id       uuid references profiles(id),
  client_id       uuid references profiles(id),
  motif           text,
  statut          text not null default 'en_attente',
  processed_by    uuid references profiles(id),
  date_created    timestamptz not null default now(),
  date_traitement timestamptz
);
create index refund_requests_cabine_idx on refund_requests (cabine_id);

-- ── logs (access / permission / maintenance) ─────────────────────────
create table access_logs (
  id              uuid primary key default gen_random_uuid(),
  admin_id        uuid references profiles(id),
  admin_name      text,
  target_user_id  uuid references profiles(id),
  target_role     text,
  target_name     text,
  date            timestamptz not null default now()
);

create table permission_logs (
  id           uuid primary key default gen_random_uuid(),
  admin_id     uuid references profiles(id),
  admin_name   text,
  cabine_id    uuid references profiles(id),
  cabine_name  text,
  service      text,
  active       boolean,
  date         timestamptz not null default now()
);
create index permission_logs_cabine_idx on permission_logs (cabine_id);

create table maintenance_logs (
  id          uuid primary key default gen_random_uuid(),
  admin_id    uuid references profiles(id),
  admin_name  text,
  action      text,
  key         text,
  active      boolean,
  service     text,
  message     text,
  date        timestamptz not null default now()
);

-- ── resubscriptions ───────────────────────────────────────────────────
create table resubscriptions (
  id         uuid primary key default gen_random_uuid(),
  cabine_id  uuid not null references profiles(id),
  formule    text not null,
  prix       bigint not null,
  date       timestamptz not null default now()
);

-- ── favoris (numéros client) ──────────────────────────────────────────
create table favoris (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references profiles(id) on delete cascade,
  nom            text default '',
  numero         text not null,
  date_creation  timestamptz not null default now()
);
create index favoris_client_idx on favoris (client_id);

-- ── forfaits (catalogue Orange/MTN/Moov) ──────────────────────────────
create table forfaits (
  id             text primary key,
  operateur      text not null,
  categorie      text not null,
  sous_categorie text,
  nom            text not null,
  detail         text,
  duree          text,
  prix           bigint not null,
  ussd_template  text,
  verified       boolean not null default true
);

-- ── partner_devices (limite 2 appareils, remember-me) ────────────────
create table partner_devices (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references profiles(id) on delete cascade,
  device_id       text not null,
  label           text,
  remember_token  text,
  created_at      timestamptz not null default now(),
  last_seen       timestamptz not null default now(),
  expires_at      timestamptz
);
create index partner_devices_user_idx on partner_devices (user_id);

-- ── reset_requests (mot de passe oublié) ──────────────────────────────
create table reset_requests (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid references profiles(id),
  telephone             text,
  nom                   text,
  role                  text,
  nouveau_mot_de_passe  text,
  statut                text not null default 'en_attente',
  date                  timestamptz not null default now()
);

-- ── partner_applications (candidatures cabine) ────────────────────────
create table partner_applications (
  id           uuid primary key default gen_random_uuid(),
  prenom       text,
  nom          text,
  email        text,
  telephone    text,
  whatsapp     text,
  cabine_nom   text,
  docs         jsonb,
  statut       text not null default 'en_attente',
  date         timestamptz not null default now()
);

alter table profiles enable row level security;
alter table transactions enable row level security;
alter table notifications enable row level security;
alter table commissions enable row level security;
alter table settings enable row level security;
alter table reclamations enable row level security;
alter table reclamation_messages enable row level security;
alter table retraits enable row level security;
alter table retards enable row level security;
alter table cabine_refusals enable row level security;
alter table transferts_cabine enable row level security;
alter table refund_requests enable row level security;
alter table access_logs enable row level security;
alter table permission_logs enable row level security;
alter table maintenance_logs enable row level security;
alter table resubscriptions enable row level security;
alter table favoris enable row level security;
alter table forfaits enable row level security;
alter table partner_devices enable row level security;
alter table reset_requests enable row level security;
alter table partner_applications enable row level security;

-- Helper : rôle + id profil de l'utilisateur Supabase Auth courant.
create or replace function current_profile_id() returns uuid
language sql stable as $$
  select id from profiles where auth_user_id = auth.uid()
$$;

create or replace function current_profile_role() returns text
language sql stable as $$
  select role from profiles where auth_user_id = auth.uid()
$$;

-- profiles : chacun lit/modifie sa propre ligne ; l'admin lit/modifie tout.
create policy profiles_select_self on profiles for select
  using (auth_user_id = auth.uid() or current_profile_role() = 'admin');
create policy profiles_update_self on profiles for update
  using (auth_user_id = auth.uid() or current_profile_role() = 'admin');
create policy profiles_admin_all on profiles for insert
  with check (current_profile_role() = 'admin');
create policy profiles_admin_delete on profiles for delete
  using (current_profile_role() = 'admin');

-- transactions : client propriétaire, cabine assignée, admin.
create policy transactions_select on transactions for select
  using (client_id = current_profile_id() or cabine_id = current_profile_id() or current_profile_role() = 'admin');
create policy transactions_insert on transactions for insert
  with check (client_id = current_profile_id() or current_profile_role() = 'admin');
create policy transactions_update on transactions for update
  using (client_id = current_profile_id() or cabine_id = current_profile_id() or current_profile_role() = 'admin');

-- notifications : uniquement les siennes.
create policy notifications_select on notifications for select
  using (utilisateur_id = current_profile_id() or current_profile_role() = 'admin');
create policy notifications_update on notifications for update
  using (utilisateur_id = current_profile_id() or current_profile_role() = 'admin');
create policy notifications_insert on notifications for insert
  with check (current_profile_role() in ('admin','cabine') or true);

-- settings : lecture par tous les rôles authentifiés, écriture admin seul.
create policy settings_select on settings for select using (true);
create policy settings_update on settings for update
  using (current_profile_role() = 'admin');

-- favoris : propriétaire uniquement.
create policy favoris_all on favoris for all
  using (client_id = current_profile_id())
  with check (client_id = current_profile_id());

-- forfaits : lecture publique (catalogue), écriture admin seul.
create policy forfaits_select on forfaits for select using (true);
create policy forfaits_write on forfaits for insert with check (current_profile_role() = 'admin');
create policy forfaits_update on forfaits for update using (current_profile_role() = 'admin');
create policy forfaits_delete on forfaits for delete using (current_profile_role() = 'admin');

-- reclamations / refund_requests / retraits / retards / transferts_cabine /
-- resubscriptions / partner_devices : cabine + client concernés, admin large.
create policy reclamations_select on reclamations for select
  using (client_id = current_profile_id() or cabine_id = current_profile_id() or current_profile_role() = 'admin');
create policy reclamations_write on reclamations for insert
  with check (client_id = current_profile_id() or current_profile_role() = 'admin');
create policy reclamations_update on reclamations for update
  using (client_id = current_profile_id() or cabine_id = current_profile_id() or current_profile_role() = 'admin');

create policy reclamation_messages_select on reclamation_messages for select
  using (exists (select 1 from reclamations r where r.id = reclamation_id
    and (r.client_id = current_profile_id() or r.cabine_id = current_profile_id() or current_profile_role() = 'admin')));
create policy reclamation_messages_insert on reclamation_messages for insert
  with check (exists (select 1 from reclamations r where r.id = reclamation_id
    and (r.client_id = current_profile_id() or r.cabine_id = current_profile_id() or current_profile_role() = 'admin')));

create policy retraits_select on retraits for select
  using (cabine_id = current_profile_id() or current_profile_role() = 'admin');
create policy retraits_insert on retraits for insert
  with check (cabine_id = current_profile_id() or current_profile_role() = 'admin');

create policy retards_select on retards for select
  using (cabine_id = current_profile_id() or current_profile_role() = 'admin');

create policy cabine_refusals_select on cabine_refusals for select
  using (cabine_id = current_profile_id() or current_profile_role() = 'admin');

create policy transferts_cabine_select on transferts_cabine for select
  using (from_cabine_id = current_profile_id() or to_cabine_id = current_profile_id() or current_profile_role() = 'admin');
create policy transferts_cabine_insert on transferts_cabine for insert
  with check (from_cabine_id = current_profile_id() or current_profile_role() = 'admin');

create policy refund_requests_select on refund_requests for select
  using (cabine_id = current_profile_id() or client_id = current_profile_id() or current_profile_role() = 'admin');
create policy refund_requests_insert on refund_requests for insert
  with check (cabine_id = current_profile_id() or current_profile_role() = 'admin');
create policy refund_requests_update on refund_requests for update
  using (current_profile_role() = 'admin');

create policy resubscriptions_select on resubscriptions for select
  using (cabine_id = current_profile_id() or current_profile_role() = 'admin');
create policy resubscriptions_insert on resubscriptions for insert
  with check (cabine_id = current_profile_id() or current_profile_role() = 'admin');

create policy partner_devices_self on partner_devices for all
  using (user_id = current_profile_id() or current_profile_role() = 'admin')
  with check (user_id = current_profile_id() or current_profile_role() = 'admin');

-- Logs + commissions : lecture/écriture admin seul (super/simple filtré côté app).
create policy access_logs_admin on access_logs for all
  using (current_profile_role() = 'admin') with check (current_profile_role() = 'admin');
create policy permission_logs_admin on permission_logs for all
  using (current_profile_role() = 'admin') with check (current_profile_role() = 'admin');
create policy maintenance_logs_admin on maintenance_logs for all
  using (current_profile_role() = 'admin') with check (current_profile_role() = 'admin');
create policy commissions_admin on commissions for all
  using (current_profile_role() = 'admin') with check (current_profile_role() = 'admin');

-- reset_requests / partner_applications : création publique (pas encore de
-- compte / pas encore connecté), lecture/traitement admin seul.
create policy reset_requests_insert on reset_requests for insert with check (true);
create policy reset_requests_admin_select on reset_requests for select using (current_profile_role() = 'admin');
create policy reset_requests_admin_update on reset_requests for update using (current_profile_role() = 'admin');

create policy partner_applications_insert on partner_applications for insert with check (true);
create policy partner_applications_admin_select on partner_applications for select using (current_profile_role() = 'admin');
create policy partner_applications_admin_update on partner_applications for update using (current_profile_role() = 'admin');
