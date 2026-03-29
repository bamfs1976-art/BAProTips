-- ======================================================================
--  BOOKING ANALYTICS PRO — Supabase Schema
--  Project: knodunjnsxelmpziupwk (eu-west-2)
--  URL: https://knodunjnsxelmpziupwk.supabase.co
-- ======================================================================

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ======================================================================
--  1. DAILY TIPS TABLE
-- ======================================================================
create table if not exists daily_tips (
  id            uuid primary key default uuid_generate_v4(),
  tip_id        text unique not null,          -- e.g. "1711234567890_0"
  match         text not null,                 -- "Arsenal vs Chelsea"
  competition   text not null,                 -- "Premier League"
  kickoff       timestamptz not null,
  bet_type      text not null,                 -- "BTTS", "Over 2.5", "1X2", etc.
  selection     text not null,                 -- "Yes", "Home", "Over 2.5"
  confidence    text not null check (confidence in ('Low','Medium','High')),
  rationale     text,
  status        text not null default 'Pending' check (status in ('Pending','Won','Lost','Void')),
  is_acca       boolean not null default false,
  acca_legs     text[] default '{}',           -- array of match strings
  settled_score text,                          -- "2-1"
  generated_at  bigint not null,               -- epoch ms
  settled_at    bigint,                        -- epoch ms
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- Index for fast date lookups
create index if not exists idx_tips_kickoff on daily_tips (kickoff);
create index if not exists idx_tips_status on daily_tips (status);
create index if not exists idx_tips_generated on daily_tips (generated_at);

-- ======================================================================
--  2. TIP STATS TABLE (aggregate performance)
-- ======================================================================
create table if not exists tip_stats (
  id                 uuid primary key default uuid_generate_v4(),
  stats_date         date unique not null default current_date,
  total              int default 0,
  won                int default 0,
  lost               int default 0,
  voided             int default 0,
  win_rate           numeric(5,2) default 0,
  won_this_week      int default 0,
  streak             text default '0',          -- e.g. "3W" or "2L"
  streak_dir         text default '',
  win_rate_by_bet    jsonb default '{}',
  win_rate_by_comp   jsonb default '{}',
  acca_win_rate      numeric(5,2) default 0,
  longest_win        int default 0,
  longest_loss       int default 0,
  updated_at         timestamptz default now()
);

-- ======================================================================
--  3. GENERATION LOG (audit trail)
-- ======================================================================
create table if not exists generation_log (
  id              uuid primary key default uuid_generate_v4(),
  run_type        text not null check (run_type in ('generate','settle','manual_settle')),
  status          text not null check (status in ('success','error','skipped')),
  tips_count      int default 0,
  settled_count   int default 0,
  api_calls_used  int default 0,
  error_message   text,
  duration_ms     int,
  created_at      timestamptz default now()
);

-- ======================================================================
--  4. TRIAL STATUS TABLE
-- ======================================================================
create table if not exists trial_status (
  id              uuid primary key default uuid_generate_v4(),
  feature         text unique not null default 'tips',
  is_active       boolean not null default true,
  started_at      timestamptz default now(),
  expires_at      timestamptz,
  api_calls_today int default 0,
  last_reset      date default current_date,
  notes           text
);

-- Insert default trial row
insert into trial_status (feature, is_active, notes)
values ('tips', true, 'Free tier — 100 API calls/day')
on conflict (feature) do nothing;

-- ======================================================================
--  5. ROW LEVEL SECURITY (RLS)
-- ======================================================================
-- Enable RLS on all tables
alter table daily_tips enable row level security;
alter table tip_stats enable row level security;
alter table generation_log enable row level security;
alter table trial_status enable row level security;

-- Public read access (anon key can read tips and stats)
create policy "Public can read tips"
  on daily_tips for select
  using (true);

create policy "Public can read stats"
  on tip_stats for select
  using (true);

create policy "Public can read trial status"
  on trial_status for select
  using (true);

create policy "Public can read generation log"
  on generation_log for select
  using (true);

-- Service role can do everything (used by Netlify functions)
create policy "Service role full access tips"
  on daily_tips for all
  using (true)
  with check (true);

create policy "Service role full access stats"
  on tip_stats for all
  using (true)
  with check (true);

create policy "Service role full access log"
  on generation_log for all
  using (true)
  with check (true);

create policy "Service role full access trial"
  on trial_status for all
  using (true)
  with check (true);

-- ======================================================================
--  6. UPDATED_AT TRIGGER
-- ======================================================================
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_tips_updated
  before update on daily_tips
  for each row execute function update_updated_at();

create trigger trg_stats_updated
  before update on tip_stats
  for each row execute function update_updated_at();

create trigger trg_trial_updated
  before update on trial_status
  for each row execute function update_updated_at();
