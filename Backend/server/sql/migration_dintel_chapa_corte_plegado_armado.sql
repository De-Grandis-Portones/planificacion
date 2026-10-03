-- Portones con ancho > 3500mm: el laser NO corta el dintel (es demasiado ancho
-- para el tubo), se hace en chapa en su lugar - 3 secciones físicas nuevas en
-- paralelo a Laser Dintel, que habilitan Armado marcos piernas igual que éste:
--   corte_dintel   (sección Corte,         igual que guillotina/corte_revest)
--   plegado_dintel (sección Plegado,       igual que plegadora/plegado_revest)
--   armado_dintel  (sección Prefabricados, igual que armado_piernas)
--
-- Ruteo automático Laser Dintel vs. Corte Dintel según ancho: se agrega un
-- campo calculado ancho_mm_normalizado (ver toMmHeuristic en
-- Backend/server/lib/logisticaCapacidad.js, usado en portones.js/qc.js) que
-- resuelve el ancho a mm sin importar si el formulario lo cargó en mm o en
-- metros - y si no hay dato, default 0 (no ancho => sigue el camino de
-- siempre por Laser Dintel, nunca se bloquea por falta de dato).
--
-- 'laser_dintel' NO se toca/deshabilita (sigue siendo el camino normal,
-- <=3500mm): esto es un camino ALTERNATIVO en paralelo, no un split como el
-- de Laser (Dintel/Hojas/Brazos y Espada).
--
-- Armado marcos piernas: su requisito ALL(laser_dintel) pasa a ser
-- ANY_GROUP(laser_dintel, armado_dintel) - alcanza con que se haya hecho por
-- CUALQUIERA de los 2 caminos. Además (pedido aparte, nada que ver con el
-- ancho) se agrega ALL(armado_hojas): ahora primero se arma la hoja, se
-- verifican las medidas reales, y recién así se ajusta y arma el marco de
-- piernas - por eso no puede arrancar antes de que la hoja esté Finalizada.
--
-- IMPORTANTE: los 3 ALTER TYPE deben ejecutarse fuera de cualquier transacción
-- explícita (Postgres no permite usar un valor de enum recién agregado dentro
-- de la misma transacción en la que se agregó) - correr este archivo tal cual
-- con psql (autocommit por sentencia), no envuelto en BEGIN/COMMIT a mano.
--
-- Etapas 100% nuevas (no son split de una existente): a diferencia de la
-- migración de Laser, acá NO hace falta backfill de porton_etapas_estado/
-- tiempos ni copiar qc_motive/qc_user_scope - no hay historial previo que
-- migrar. Los motivos de QC y los scopes de usuario para estas 3 secciones
-- se cargan a mano después desde /admin/qc (mismo criterio que Diseño
-- Piernas/Diseño Revestimiento).

-- 1) Nuevos valores del enum porton_etapa
ALTER TYPE public.porton_etapa ADD VALUE IF NOT EXISTS 'corte_dintel';
ALTER TYPE public.porton_etapa ADD VALUE IF NOT EXISTS 'plegado_dintel';
ALTER TYPE public.porton_etapa ADD VALUE IF NOT EXISTS 'armado_dintel';

-- 2) Altas en workflow_stage (línea portones)
INSERT INTO public.workflow_stage (line, key, label, status_col, start_col, end_col, enabled)
VALUES
  ('portones', 'corte_dintel', 'Corte Dintel', 'corte_dintel', 'corte_dintel_inicio', 'corte_dintel_fin', true),
  ('portones', 'plegado_dintel', 'Plegado Dintel', 'plegado_dintel', 'plegado_dintel_inicio', 'plegado_dintel_fin', true),
  ('portones', 'armado_dintel', 'Armado Dintel', 'armado_dintel', 'armado_dintel_inicio', 'armado_dintel_fin', true)
ON CONFLICT (line, key) DO NOTHING;

-- 3) Edges: diseno se bifurca por ancho_mm_normalizado; el camino nuevo
--    encadena corte -> plegado -> armado -> armado_marco_piernas (misma
--    condición de Sistema que ya tenía laser_dintel -> armado_marco_piernas).
UPDATE public.workflow_edge
   SET condition_json = '{"all":[{"field":"ancho_mm_normalizado","op":"<=","value":3500}],"any":[]}'::jsonb
 WHERE line = 'portones' AND from_key = 'diseno' AND to_key = 'laser_dintel';

INSERT INTO public.workflow_edge (line, from_key, to_key, priority, enabled, condition_json)
SELECT * FROM (VALUES
  ('portones', 'diseno', 'corte_dintel', 43, true,
    '{"all":[{"field":"ancho_mm_normalizado","op":">","value":3500}],"any":[]}'::jsonb),
  ('portones', 'corte_dintel', 'plegado_dintel', 100, true, null::jsonb),
  ('portones', 'plegado_dintel', 'armado_dintel', 100, true, null::jsonb),
  ('portones', 'armado_dintel', 'armado_marco_piernas', 101, true,
    '{"all":[],"any":[{"op":"contains","field":"Sistema","value":"PVC"},{"op":"contains","field":"Sistema","value":"ACERO"}]}'::jsonb)
) AS v(line, from_key, to_key, priority, enabled, condition_json)
WHERE NOT EXISTS (
  SELECT 1 FROM public.workflow_edge e
  WHERE e.line = v.line AND e.from_key = v.from_key AND e.to_key = v.to_key
);

-- 4) Requirements de la cadena nueva (igual patrón que guillotina->plegadora
--    ->armado_piernas).
INSERT INTO public.workflow_requirement (line, stage_key, type, group_id, required_key)
SELECT 'portones', 'plegado_dintel', 'ALL', null, 'corte_dintel'
WHERE NOT EXISTS (
  SELECT 1 FROM public.workflow_requirement
  WHERE line = 'portones' AND stage_key = 'plegado_dintel' AND required_key = 'corte_dintel'
);

INSERT INTO public.workflow_requirement (line, stage_key, type, group_id, required_key)
SELECT 'portones', 'armado_dintel', 'ALL', null, 'plegado_dintel'
WHERE NOT EXISTS (
  SELECT 1 FROM public.workflow_requirement
  WHERE line = 'portones' AND stage_key = 'armado_dintel' AND required_key = 'plegado_dintel'
);

-- 5) armado_marco_piernas: ALL(laser_dintel) -> ANY_GROUP(laser_dintel,
--    armado_dintel) (group_id 1, libre para este stage_key - no tenía
--    ningún ANY_GROUP todavía).
UPDATE public.workflow_requirement
   SET type = 'ANY_GROUP', group_id = 1
 WHERE line = 'portones' AND stage_key = 'armado_marco_piernas'
   AND type = 'ALL' AND required_key = 'laser_dintel';

INSERT INTO public.workflow_requirement (line, stage_key, type, group_id, required_key)
SELECT 'portones', 'armado_marco_piernas', 'ANY_GROUP', 1, 'armado_dintel'
WHERE NOT EXISTS (
  SELECT 1 FROM public.workflow_requirement
  WHERE line = 'portones' AND stage_key = 'armado_marco_piernas'
    AND type = 'ANY_GROUP' AND group_id = 1 AND required_key = 'armado_dintel'
);

-- 6) Pedido aparte (no depende del ancho): armado_marco_piernas ahora
--    también requiere ALL(armado_hojas) - ver comentario arriba.
INSERT INTO public.workflow_requirement (line, stage_key, type, group_id, required_key)
SELECT 'portones', 'armado_marco_piernas', 'ALL', null, 'armado_hojas'
WHERE NOT EXISTS (
  SELECT 1 FROM public.workflow_requirement
  WHERE line = 'portones' AND stage_key = 'armado_marco_piernas'
    AND type = 'ALL' AND required_key = 'armado_hojas'
);

-- 7) Insumos: las secciones de pedidos "corte"/"plegado"/"prefabricados" (por
--    ruta /corte, /plegado, /prefabricados) ahora también se autorizan vía
--    scope de portones en corte_dintel/plegado_dintel/armado_dintel (ver
--    Backend/server/routes/public/insumos.js, cambio de código en paralelo).
