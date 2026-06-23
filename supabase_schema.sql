-- ================================================================
--  TremorLab Supabase Schema (complete)
--  Tables:
--    station_live        one compact live row per ESP32 station
--    station_waveform    waveform samples + per-event wave analysis
--    earthquake_history  permanent confirmed-event history
--
--  This is the full schema, including the original tables/policies
--  plus every column needed to fully populate the dashboard's
--  metrics cards (waveform, timing, simulation, health, false
--  triggers, sensor correlation) instead of showing "Not wired yet"
--  or "Sensor agreement: not available".
--
--  Safe to run on a fresh project, AND safe to re-run on a project
--  that already has the original schema applied -- every statement
--  uses IF NOT EXISTS / OR REPLACE / DROP...IF EXISTS so nothing
--  errors or duplicates.
--
--  Run this in Supabase Dashboard -> SQL Editor.
-- ================================================================

-- ----------------------------------------------------------------
-- STATION_LIVE
-- ----------------------------------------------------------------

create table if not exists public.station_live (
  station_id text primary key,
  updated_at timestamptz not null default now(),
  timestamp_ms bigint not null,
  classification text not null,
  pga_cm_s2 real not null default -1,
  magnitude real not null default -1,
  distance_km real not null default -1,
  confidence real not null default 0,

  adxl345_value real not null default 0,
  adxl345_ratio real not null default 0,
  adxl345_triggered boolean not null default false,

  lis3dh_value real not null default 0,
  lis3dh_ratio real not null default 0,
  lis3dh_triggered boolean not null default false,

  mpu6050_value real not null default 0,
  mpu6050_ratio real not null default 0,
  mpu6050_triggered boolean not null default false,

  p_wave_ms bigint not null default 0,
  s_wave_ms bigint not null default 0,
  p_wave_detected boolean not null default false,
  s_wave_detected boolean not null default false,

  shaker_running boolean not null default false,
  wifi_rssi integer not null default 0,
  free_heap integer not null default 0,
  sample_ms bigint not null default 0
);

-- Timing metrics
alter table public.station_live
  add column if not exists system_uptime_ms bigint not null default 0;

-- Simulation metrics
alter table public.station_live
  add column if not exists simulation_phase text not null default 'Idle',
  add column if not exists motor_pwm_level integer not null default 0,
  add column if not exists simulation_progress real not null default 0;

alter table public.station_live
  drop constraint if exists station_live_simulation_phase_check;

alter table public.station_live
  add constraint station_live_simulation_phase_check
  check (simulation_phase in ('Idle', 'P-Wave', 'Gap', 'S-Wave', 'Surface Wave', 'Decay'));

-- Alert & health metrics
alter table public.station_live
  add column if not exists cpu_load_pct real not null default -1,
  add column if not exists cloud_sync_success_pct real not null default -1,
  add column if not exists battery_voltage real not null default -1;

-- ----------------------------------------------------------------
-- EARTHQUAKE_HISTORY
-- ----------------------------------------------------------------

create table if not exists public.earthquake_history (
  event_id text primary key,
  station_id text not null,
  created_at timestamptz not null default now(),
  timestamp_ms bigint not null,
  classification text not null,
  magnitude real not null default -1,
  distance_km real not null default -1,
  pga_cm_s2 real not null default -1,
  confidence real not null default 0,
  p_wave_ms bigint not null default 0,
  s_wave_ms bigint not null default 0,
  sample_ms bigint not null default 0
);

-- Timing metrics
alter table public.earthquake_history
  add column if not exists event_duration_ms bigint not null default 0;

-- Event statistics: false triggers
alter table public.earthquake_history
  add column if not exists is_false_trigger boolean not null default false;

-- Sensor correlation / detection metrics
--
-- WHY: earthquake_history previously had no STA/LTA columns at all, so
-- once an event aged out of station_live and only existed here, the
-- dashboard's Sensor Agreement and Detection Metrics cards always had
-- -1/no data to work with -- "Sensor agreement: not available" was
-- guaranteed, not just possible. The matching firmware update sends
-- these three values (the ADXL345/LIS3DH/MPU6050 STA/LTA ratios at the
-- moment the event was classified) on every earthquake_history insert.
alter table public.earthquake_history
  add column if not exists adxl345_stalta real not null default -1,
  add column if not exists lis3dh_stalta  real not null default -1,
  add column if not exists mpu6050_stalta real not null default -1;

create index if not exists earthquake_history_station_created_idx
on public.earthquake_history (station_id, created_at desc);

create index if not exists earthquake_history_false_trigger_idx
on public.earthquake_history (is_false_trigger);

-- ----------------------------------------------------------------
-- STATION_WAVEFORM
-- ----------------------------------------------------------------

create table if not exists public.station_waveform (
  id bigserial primary key,
  station_id text not null,
  created_at timestamptz not null default now(),
  timestamp_ms bigint not null,
  adxl345_value real not null default 0,
  lis3dh_value real not null default 0,
  mpu6050_value real not null default 0,
  verified_value real not null default 0,
  confidence real not null default 0,
  classification text not null default 'Normal'
);

-- Waveform metrics: raw sample arrays, wave markers, amplitude, confidence
alter table public.station_waveform
  add column if not exists event_id text,
  add column if not exists adxl345_samples jsonb,
  add column if not exists lis3dh_samples jsonb,
  add column if not exists mpu6050_samples jsonb,
  add column if not exists unified_samples jsonb,
  add column if not exists sample_rate_hz real not null default 0,
  add column if not exists p_wave_index integer,
  add column if not exists s_wave_index integer,
  add column if not exists surface_wave_index integer,
  add column if not exists peak_amplitude real not null default -1,
  add column if not exists waveform_confidence real not null default -1;

create index if not exists station_waveform_station_created_idx
on public.station_waveform (station_id, created_at desc);

create index if not exists station_waveform_event_idx
on public.station_waveform (event_id);

-- ----------------------------------------------------------------
-- updated_at trigger for station_live
-- ----------------------------------------------------------------

create or replace function public.set_station_live_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists station_live_updated_at on public.station_live;
create trigger station_live_updated_at
before insert or update on public.station_live
for each row execute function public.set_station_live_updated_at();

-- ----------------------------------------------------------------
-- Row level security + anon policies
-- ----------------------------------------------------------------

alter table public.station_live enable row level security;
alter table public.earthquake_history enable row level security;
alter table public.station_waveform enable row level security;

drop policy if exists "station live public read" on public.station_live;
create policy "station live public read"
on public.station_live
for select
to anon
using (true);

drop policy if exists "station live public write" on public.station_live;
create policy "station live public write"
on public.station_live
for all
to anon
using (true)
with check (true);

drop policy if exists "earthquake history public read" on public.earthquake_history;
create policy "earthquake history public read"
on public.earthquake_history
for select
to anon
using (true);

drop policy if exists "earthquake history public insert" on public.earthquake_history;
create policy "earthquake history public insert"
on public.earthquake_history
for insert
to anon
with check (true);

drop policy if exists "station waveform public read" on public.station_waveform;
create policy "station waveform public read"
on public.station_waveform
for select
to anon
using (true);

drop policy if exists "station waveform public insert" on public.station_waveform;
create policy "station waveform public insert"
on public.station_waveform
for insert
to anon
with check (true);

-- ----------------------------------------------------------------
-- Realtime publication
-- ----------------------------------------------------------------

do $$
begin
  begin
    alter publication supabase_realtime add table public.station_live;
  exception when duplicate_object then
    null;
  end;

  begin
    alter publication supabase_realtime add table public.earthquake_history;
  exception when duplicate_object then
    null;
  end;

  begin
    alter publication supabase_realtime add table public.station_waveform;
  exception when duplicate_object then
    null;
  end;
end $$;

-- ================================================================
--  Done. station_live, station_waveform, and earthquake_history now
--  all carry the columns the dashboard reads, including the
--  adxl345_stalta / lis3dh_stalta / mpu6050_stalta columns on
--  earthquake_history that the Sensor Agreement and Detection
--  Metrics cards need once an event ages out of station_live.
--
--  This schema pairs with the updated seismometer_v6.ino (sends the
--  STA/LTA ratios on every confirmed-event upload) and server.py
--  (reads them instead of hardcoding -1 for history rows). Without
--  the firmware update, these three columns will simply stay at
--  their default of -1, which is the correct "no data yet" state,
--  not a bug.
-- ================================================================
