-- Migración: Variables de recurso (atributos de sección/máquina, no del
-- portón) — Fase 3b del motor de reglas de tiempo.
-- Correr a mano contra la base (Supabase), igual que el resto de server/sql/*.sql.
--
-- Ej: plegadora.nivel_personal = "junior", guillotina.maquina = "vieja" —
-- variables más o menos permanentes de UNA sección/máquina (no de un día
-- puntual — para eso ya existe scheduling_calendar_exception). Se suman al
-- contexto de evaluación SOLO de las etapas mapeadas a ese resource_key
-- (ver computeBackwardPass en regressionEngine.js), así una regla "humana"
-- puede referenciarlas como field igual que cualquier propiedad del portón.
--
-- Vacía hasta que se cargue algo a mano desde /admin/scheduling (scope
-- 'scheduling:admin'). No cambia ningún comportamiento existente — un
-- resource_key sin filas acá simplemente no aporta variables extra al ctx.

begin;

-- Sin FK a scheduling_resource a propósito, mismo criterio que
-- scheduling_resource_calendar: resource_key acá puede ser un resource_key
-- "implícito" (= stage_key, sin fila de catálogo).
create table if not exists public.scheduling_resource_variable (
  resource_key text not null,
  key text not null,
  value jsonb not null,
  label text,
  notes text,
  updated_at timestamptz not null default now(),
  primary key (resource_key, key)
);

commit;
