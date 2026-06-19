-- ================================================================
--  TremorLab Supabase Schema
--  Tables:
--    station_live        one compact live row per ESP32 station
--    station_waveform    compact remote waveform samples
--    earthquake_history  permanent confirmed-event history
--
--  Run this in Supabase Dashboard -> SQL Editor.
-- ================================================================

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

create index if not exists earthquake_history_station_created_idx
on public.earthquake_history (station_id, created_at desc);

create index if not exists station_waveform_station_created_idx
on public.station_waveform (station_id, created_at desc);

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
