-- Migración: Motor de reglas de tiempo — Fase 2a (calendario laboral + recursos).
-- Correr a mano contra la base (Supabase), igual que migration_scheduling_fase0.sql.
--
-- A propósito NO se agrega al array MIGRATIONS de server/index.js: ese array
-- corre en cada boot y si una sentencia falla el proceso llama process.exit(1),
-- tumbando el servidor entero para todos los operarios.
--
-- Todo esto queda vacío/inerte hasta que se cargue algo a mano (o el código
-- caiga a los defaults: resource_key = stage_key, calendario Lun-Vie 08-18)
-- desde /admin/scheduling (scope 'scheduling:admin'). No cambia ningún
-- comportamiento existente del tablero operador ni de ninguna ruta pública.

begin;

-- Catálogo de recursos (máquinas/sectores). Vacío en Fase 2a: cada etapa usa
-- su propio stage_key como resource_key por default (ver
-- lib/scheduling/calendar.js:getResourceKeyForStage). Fase 3 (recursos
-- compartidos, ej. una sola cortadora para guillotina y corte_revest) solo
-- agrega filas acá y en scheduling_stage_resource, no migra este esquema.
create table if not exists public.scheduling_resource (
  resource_key text primary key,
  label text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Mapeo etapa -> recurso. Vacío en Fase 2a a propósito.
create table if not exists public.scheduling_stage_resource (
  line text not null,
  stage_key text not null,
  resource_key text not null references public.scheduling_resource(resource_key),
  primary key (line, stage_key)
);

-- Plantilla semanal recurrente de horas laborables por recurso. weekday:
-- 0=domingo .. 6=sábado (mismo criterio que Date.getUTCDay() en JS), a
-- propósito, para no introducir un off-by-one al convertir. Varias filas por
-- (resource_key, weekday) permiten turnos partidos (mañana/tarde).
create table if not exists public.scheduling_resource_calendar (
  id bigserial primary key,
  resource_key text not null,
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_time > start_time)
);
create index if not exists idx_scheduling_resource_calendar_lookup
  on public.scheduling_resource_calendar (resource_key, weekday) where enabled = true;

-- Excepciones puntuales: feriados (is_working=false) o turnos especiales de
-- un día concreto (is_working=true + horario propio). resource_key NULL =
-- aplica a todos los recursos (feriado de planta completo).
-- Sin FK a scheduling_resource a propósito: resource_key acá puede ser un
-- resource_key "implícito" (= stage_key, sin fila de catálogo) igual que en
-- scheduling_resource_calendar — exigir la FK rompería el fallback default.
create table if not exists public.scheduling_calendar_exception (
  id bigserial primary key,
  resource_key text,
  exception_date date not null,
  is_working boolean not null default false,
  start_time time,
  end_time time,
  notes text,
  created_at timestamptz not null default now()
);
-- NULL no cuenta como valor igual en un unique() normal de Postgres, así que
-- la unicidad de "un feriado global por fecha" necesita dos índices parciales
-- en vez de un unique(resource_key, exception_date) simple.
create unique index if not exists uq_scheduling_exception_resource
  on public.scheduling_calendar_exception (resource_key, exception_date) where resource_key is not null;
create unique index if not exists uq_scheduling_exception_global
  on public.scheduling_calendar_exception (exception_date) where resource_key is null;

commit;
