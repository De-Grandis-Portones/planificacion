-- Migración: Motor de reglas de tiempo — Fase 2b (paralelismo por recurso).
-- Correr a mano contra la base (Supabase), igual que las anteriores de scheduling.
--
-- A propósito NO se agrega al array MIGRATIONS de server/index.js (mismo
-- motivo que fase0/fase2a: un fallo ahí tumba el servidor entero al bootear).
--
-- Columna aditiva con default 1 (= sin cambio de comportamiento): un recurso
-- procesa una cosa por vez salvo que alguien cargue explícitamente más de
-- una estación en paralelo.

begin;

alter table public.scheduling_resource
  add column if not exists parallel_capacity integer not null default 1;

alter table public.scheduling_resource
  drop constraint if exists scheduling_resource_parallel_capacity_check;
alter table public.scheduling_resource
  add constraint scheduling_resource_parallel_capacity_check check (parallel_capacity >= 1);

commit;
