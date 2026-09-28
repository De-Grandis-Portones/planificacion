-- Migración: Motor de reglas de tiempo por etapa — Fase 0 (infraestructura).
-- Correr a mano contra la base (Supabase), igual que el resto de server/sql/*.sql.
--
-- A propósito NO se agrega al array MIGRATIONS de server/index.js: ese array
-- corre en cada boot y si una sentencia falla el proceso llama process.exit(1),
-- tumbando el servidor entero para todos los operarios. La convención real
-- para features grandes y nuevas (prefabricados, servicio técnico, insumos)
-- es un .sql suelto acá, corrido a mano — se sigue ese mismo patrón.
--
-- Todo lo que crea este archivo queda vacío/inerte hasta que alguien cargue
-- algo a mano desde /admin/scheduling (protegido por el scope nuevo
-- 'scheduling:admin', que nadie tiene todavía) o cambie el modo de una línea
-- en scheduling_line_mode (que hoy nada lee). No cambia ningún comportamiento
-- existente del tablero operador ni de ninguna ruta pública.

begin;

-- Interruptor de modo por línea: legacy (default, comportamiento de hoy) |
-- shadow (se calcula, visible solo en /admin/scheduling) | live (empieza a
-- alimentar algo real — ver Fase 4 del plan). El rollback de cualquier corte
-- en falso es un UPDATE de esta tabla, sin redeploy.
create table if not exists public.scheduling_line_mode (
  line text primary key,
  mode text not null default 'legacy' check (mode in ('legacy', 'shadow', 'live')),
  updated_at timestamptz not null default now()
);

-- Tiempo estándar por etapa, medido sobre un perfil de referencia completo.
-- stage_key guarda el mismo valor que workflow_stage.status_col
-- (= porton_etapas_tiempos.etapa / porton_etapas_estado.etapa para line='portones'),
-- no workflow_stage.key a secas — es lo que permite comparar tiempo calculado
-- vs. tiempo real sin joins indirectos.
create table if not exists public.scheduling_stage_standard (
  line text not null,
  stage_key text not null,
  standard_minutes numeric not null default 0,
  reference_profile_json jsonb,
  notes text,
  updated_at timestamptz not null default now(),
  primary key (line, stage_key)
);

-- Reglas de desvío por etapa. field/operator/value tienen deliberadamente el
-- mismo shape {field, op, value} que ya usa workflow_edge.condition_json, para
-- poder pasarlas tal cual a evalRule() de lib/workflow.js sin traducir nada.
create table if not exists public.scheduling_time_rule (
  id bigserial primary key,
  line text not null,
  stage_key text not null,
  category text not null check (category in ('intrinseca', 'material', 'humana', 'rotativa', 'tiempo')),
  field text not null,
  operator text not null check (operator in ('=', '!=', '>', '>=', '<', '<=', 'in', 'contains')),
  value jsonb,
  effect_type text not null check (effect_type in ('percent', 'fixed_minutes', 'multiplier', 'override')),
  effect_value numeric not null default 0,
  combine_mode text not null default 'independent' check (combine_mode in ('independent', 'cascade')),
  sequence_order integer,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_scheduling_time_rule_line_stage
  on public.scheduling_time_rule (line, stage_key)
  where enabled = true;

commit;
