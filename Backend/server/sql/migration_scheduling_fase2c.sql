-- Migración: Motor de reglas de tiempo — Fase 2c (Flujo Logística).
-- Correr a mano contra la base (Supabase), igual que las anteriores de scheduling.
--
-- A propósito NO se agrega al array MIGRATIONS de server/index.js, mismo
-- motivo que fase0/2a/2b: un fallo ahí tumba el servidor entero al bootear.
-- Aunque esta sí toca la tabla portones (no una tabla nueva de scheduling_*),
-- se mantiene el mismo patrón de .sql suelto corrido a mano para no romper
-- la convención ya establecida en esta serie de migraciones.
--
-- Columna nueva, nullable, sin default: mientras nadie la cargue, el
-- Flujo Logística usa fecha_plan_entrega (ver
-- lib/scheduling/regressionEngine.js:resolveAnchorDeadline) — "arranca
-- igual a la de Presupuesto, pero editable en Planta". No cambia ningún
-- comportamiento existente: nada del tablero operador lee esta columna.

begin;

alter table public.portones
  add column if not exists fecha_despacho_logistica date;

commit;
