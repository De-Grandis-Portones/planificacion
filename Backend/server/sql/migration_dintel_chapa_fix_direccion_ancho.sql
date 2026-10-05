-- Corrección de dirección sobre migration_dintel_chapa_corte_plegado_armado.sql
-- (ya corrida en producción): la condición de ancho había quedado invertida.
--
-- Regla correcta, confirmada con el usuario: portones con ancho > 3500mm
-- siguen por Laser Dintel (como siempre); <=3500mm van por el camino nuevo
-- en chapa (Corte Dintel -> Plegado Dintel -> Armado Dintel).
--
-- De paso, el default de ancho_mm_normalizado cuando no hay dato de ancho
-- (ver Backend/server/routes/public/portones.js y qc.js) pasa de 0 a un
-- sentinel > 3500 (ANCHO_MM_SIN_DATO): ante falta de dato, el ruteo tiene que
-- mantener el comportamiento histórico (Laser Dintel sin condición), no caer
-- por error en el camino nuevo sin confirmar que de verdad corresponde.

UPDATE public.workflow_edge
   SET condition_json = '{"all":[{"field":"ancho_mm_normalizado","op":">","value":3500}],"any":[]}'::jsonb
 WHERE line = 'portones' AND from_key = 'diseno' AND to_key = 'laser_dintel';

UPDATE public.workflow_edge
   SET condition_json = '{"all":[{"field":"ancho_mm_normalizado","op":"<=","value":3500}],"any":[]}'::jsonb
 WHERE line = 'portones' AND from_key = 'diseno' AND to_key = 'corte_dintel';
