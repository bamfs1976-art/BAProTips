-- ======================================================================
--  BOOKING ANALYTICS PRO — Migration v2: model-grounded tips
--  Run this once in the Supabase SQL editor (project knodunjnsxelmpziupwk).
--  Adds structured market fields (deterministic settlement), model
--  probabilities, bookmaker odds/edge, and ROI tracking.
--  Safe to re-run: all statements are idempotent.
-- ======================================================================

-- Structured market fields + model/odds data on each tip
alter table daily_tips add column if not exists market       text;            -- '1X2','BTTS','OU','CLEAN_SHEET','WIN_TO_NIL','CORRECT_SCORE','ACCA'
alter table daily_tips add column if not exists pick         text;            -- 'HOME','AWAY','DRAW','YES','NO','OVER','UNDER','2-1',...
alter table daily_tips add column if not exists line         numeric(4,1);    -- e.g. 2.5 for Over/Under
alter table daily_tips add column if not exists model_prob   numeric(6,4);    -- model probability 0-1
alter table daily_tips add column if not exists odds         numeric(8,2);    -- median decimal odds across bookmakers
alter table daily_tips add column if not exists implied_prob numeric(6,4);    -- de-vigged implied probability from odds
alter table daily_tips add column if not exists edge         numeric(6,4);    -- model_prob - implied_prob
alter table daily_tips add column if not exists fixture_id   bigint;          -- API-Football fixture id (cheap settlement lookup)

create index if not exists idx_tips_fixture on daily_tips (fixture_id);

-- ROI tracking on aggregate stats (1-unit flat stakes on priced tips)
alter table tip_stats add column if not exists profit_units numeric(8,2) default 0;  -- cumulative P/L in units
alter table tip_stats add column if not exists roi          numeric(6,2) default 0;  -- profit_units / priced_settled * 100
alter table tip_stats add column if not exists priced_count int default 0;           -- settled tips that had odds attached
