// routes/admin/scheduling.js
//
// Fase 0/1 del motor de reglas de tiempo (ver plan de implementación): CRUD de
// estándares/reglas por etapa + un preview de solo lectura que calcula
// tiempo_efectivo para portones reales y lo compara contra lo ya registrado
// en porton_etapas_tiempos. No escribe en ninguna tabla existente, no cambia
// nada de lo que ve el tablero operador.
const express = require('express');
const { adminAuth } = require('../../middleware/adminAuth');
const { pool } = require('../../db');
const { computeEffectiveMinutes } = require('../../lib/scheduling/rulesEngine');
const { listPortonSchedulingCtxs, listPortonesPendingForRegression, getPortonSchedulingCtx } = require('../../lib/scheduling/portonCtx');
const { computePortonRegression, computeFleetRegression, FLOWS } = require('../../lib/scheduling/regressionEngine');
const { fetchStageResourceMap } = require('../../lib/scheduling/calendar');
const { fetchResourceVariables } = require('../../lib/scheduling/resourceVariables');

const router = express.Router();

function normalizeScopes(scopesRaw) {
  if (Array.isArray(scopesRaw)) return scopesRaw.map((s) => String(s || '').trim()).filter(Boolean);
  if (typeof scopesRaw === 'string') return scopesRaw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  return [];
}
function hasScope(req, scope) {
  const scopes = normalizeScopes(req?.admin?.scopes ?? req?.admin?.scope ?? req?.admin?.permissions ?? []);
  return scopes.includes(scope);
}
function requireScope(scope) {
  return (req, res, next) => {
    if (!hasScope(req, scope)) return res.status(403).json({ error: `Requiere scope ${scope}` });
    return next();
  };
}

// Con path ('/scheduling', ...): ver nota equivalente en admin/prefabricados.js —
// sin path, este gate bloquearía con 403 pedidos de otros módulos admin según
// el orden de montaje en app.js.
router.use('/scheduling', adminAuth, requireScope('scheduling:admin'));

const VALID_LINES = ['portones', 'ipanel'];
function isValidLine(line) {
  return VALID_LINES.includes(String(line || '').trim());
}

const VALID_CATEGORIES = new Set(['intrinseca', 'material', 'humana', 'rotativa', 'tiempo']);
const VALID_OPERATORS = new Set(['=', '!=', '>', '>=', '<', '<=', 'in', 'contains']);
const VALID_EFFECT_TYPES = new Set(['percent', 'fixed_minutes', 'multiplier', 'override']);
const VALID_COMBINE_MODES = new Set(['independent', 'cascade']);

function validateRulePayload(r) {
  const stageKey = String(r?.stage_key || '').trim();
  const category = String(r?.category || '').trim();
  const field = String(r?.field || '').trim();
  const operator = String(r?.operator || '').trim();
  const effectType = String(r?.effect_type || '').trim();
  const combineMode = String(r?.combine_mode || 'independent').trim() || 'independent';

  if (!stageKey) return 'stage_key es requerido';
  if (!VALID_CATEGORIES.has(category)) return `category inválida: ${category}`;
  if (!field) return 'field es requerido';
  if (!VALID_OPERATORS.has(operator)) return `operator inválido: ${operator}`;
  if (!VALID_EFFECT_TYPES.has(effectType)) return `effect_type inválido: ${effectType}`;
  if (!VALID_COMBINE_MODES.has(combineMode)) return `combine_mode inválido: ${combineMode}`;
  if (combineMode === 'cascade' && !Number.isFinite(Number(r?.sequence_order))) {
    return 'sequence_order es requerido cuando combine_mode = cascade';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Estándares por etapa
// ---------------------------------------------------------------------------

router.get('/scheduling/standard', async (req, res) => {
  try {
    const line = String(req.query.line || '').trim();
    if (!isValidLine(line)) return res.status(400).json({ error: 'line debe ser portones o ipanel' });

    const { rows } = await pool.query(
      `
      select line, stage_key, standard_minutes, reference_profile_json, notes, updated_at
      from public.scheduling_stage_standard
      where line = $1
      order by stage_key asc;
      `,
      [line]
    );
    return res.json({ ok: true, standards: rows });
  } catch (err) {
    console.error('get scheduling standard error:', err);
    return res.status(500).json({ error: 'Error leyendo estándares', detail: err.message });
  }
});

router.put('/scheduling/standard', async (req, res) => {
  const line = String(req.query.line || '').trim();
  if (!isValidLine(line)) return res.status(400).json({ error: 'line debe ser portones o ipanel' });

  const standards = Array.isArray(req.body?.standards) ? req.body.standards : [];
  for (const s of standards) {
    if (!s?.stage_key) return res.status(400).json({ error: 'Cada estándar necesita stage_key' });
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`delete from public.scheduling_stage_standard where line = $1;`, [line]);

    for (const s of standards) {
      await client.query(
        `
        insert into public.scheduling_stage_standard
          (line, stage_key, standard_minutes, reference_profile_json, notes, updated_at)
        values ($1, $2, $3, $4::jsonb, $5, now());
        `,
        [
          line,
          String(s.stage_key).trim(),
          Number.isFinite(Number(s.standard_minutes)) ? Number(s.standard_minutes) : 0,
          s.reference_profile_json ? JSON.stringify(s.reference_profile_json) : null,
          s.notes == null ? null : String(s.notes),
        ]
      );
    }

    await client.query('commit');
    return res.json({ ok: true, count: standards.length });
  } catch (err) {
    await client.query('rollback');
    console.error('save scheduling standard error:', err);
    return res.status(500).json({ error: 'Error guardando estándares', detail: err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Reglas de desvío
// ---------------------------------------------------------------------------

router.get('/scheduling/rules', async (req, res) => {
  try {
    const line = String(req.query.line || '').trim();
    if (!isValidLine(line)) return res.status(400).json({ error: 'line debe ser portones o ipanel' });

    const { rows } = await pool.query(
      `
      select id, line, stage_key, category, field, operator, value, effect_type, effect_value,
             combine_mode, sequence_order, enabled, created_at, updated_at
      from public.scheduling_time_rule
      where line = $1
      order by stage_key asc, combine_mode asc, sequence_order asc nulls last, id asc;
      `,
      [line]
    );
    return res.json({ ok: true, rules: rows });
  } catch (err) {
    console.error('get scheduling rules error:', err);
    return res.status(500).json({ error: 'Error leyendo reglas', detail: err.message });
  }
});

router.put('/scheduling/rules', async (req, res) => {
  const line = String(req.query.line || '').trim();
  if (!isValidLine(line)) return res.status(400).json({ error: 'line debe ser portones o ipanel' });

  const rules = Array.isArray(req.body?.rules) ? req.body.rules : [];
  for (const r of rules) {
    const problem = validateRulePayload(r);
    if (problem) return res.status(400).json({ error: problem });
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`delete from public.scheduling_time_rule where line = $1;`, [line]);

    for (const r of rules) {
      await client.query(
        `
        insert into public.scheduling_time_rule
          (line, stage_key, category, field, operator, value, effect_type, effect_value,
           combine_mode, sequence_order, enabled, updated_at)
        values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11, now());
        `,
        [
          line,
          String(r.stage_key).trim(),
          String(r.category).trim(),
          String(r.field).trim(),
          String(r.operator).trim(),
          JSON.stringify(r.value ?? null),
          String(r.effect_type).trim(),
          Number.isFinite(Number(r.effect_value)) ? Number(r.effect_value) : 0,
          String(r.combine_mode || 'independent').trim() || 'independent',
          r.sequence_order == null ? null : Number(r.sequence_order),
          r.enabled !== false,
        ]
      );
    }

    await client.query('commit');
    return res.json({ ok: true, count: rules.length });
  } catch (err) {
    await client.query('rollback');
    console.error('save scheduling rules error:', err);
    return res.status(500).json({ error: 'Error guardando reglas', detail: err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Fase 3: recursos físicos compartidos entre etapas.
//
// scheduling_resource es el catálogo (global, no por línea) y
// scheduling_stage_resource es el mapeo etapa->recurso (por línea, ver
// migration_scheduling_fase2a.sql). Sin fila de mapeo, una etapa sigue
// cayendo a resource_key = stage_key (getResourceKeyForStage en
// lib/scheduling/calendar.js) — o sea, agrupar dos etapas bajo un mismo
// recurso es pura carga de datos, cero cambio de código en el motor de
// regresión (ya soporta N:1 etapa->recurso desde Fase 2a/2b).
//
// El catálogo NO usa el patrón delete-all-then-reinsert que sí usan
// standard/rules/calendar más arriba: scheduling_stage_resource tiene FK a
// scheduling_resource(resource_key), así que borrar y recrear el catálogo
// completo rompería esa referencia apenas hubiera algo mapeado. Se maneja
// como upsert por fila + borrado individual (que la FK bloquea sola si el
// recurso todavía está en uso, con un 409 explícito en vez de un 500 crudo).
// ---------------------------------------------------------------------------

router.get('/scheduling/resources', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `select resource_key, label, enabled, parallel_capacity, created_at, updated_at
       from public.scheduling_resource
       order by resource_key asc;`
    );
    return res.json({ ok: true, resources: rows });
  } catch (err) {
    console.error('get scheduling resources error:', err);
    return res.status(500).json({ error: 'Error leyendo recursos', detail: err.message });
  }
});

router.post('/scheduling/resources', async (req, res) => {
  const resourceKey = String(req.body?.resource_key || '').trim();
  if (!resourceKey) return res.status(400).json({ error: 'resource_key es requerido' });
  const parallelCapacity = Number.isFinite(Number(req.body?.parallel_capacity)) ? Math.max(1, Math.trunc(Number(req.body.parallel_capacity))) : 1;

  try {
    const { rows } = await pool.query(
      `
      insert into public.scheduling_resource (resource_key, label, enabled, parallel_capacity, updated_at)
      values ($1, $2, $3, $4, now())
      on conflict (resource_key) do update
        set label = excluded.label,
            enabled = excluded.enabled,
            parallel_capacity = excluded.parallel_capacity,
            updated_at = now()
      returning resource_key, label, enabled, parallel_capacity, created_at, updated_at;
      `,
      [resourceKey, req.body?.label == null ? null : String(req.body.label), req.body?.enabled !== false, parallelCapacity]
    );
    return res.json({ ok: true, resource: rows[0] });
  } catch (err) {
    console.error('upsert scheduling resource error:', err);
    return res.status(500).json({ error: 'Error guardando recurso', detail: err.message });
  }
});

router.delete('/scheduling/resources/:resource_key', async (req, res) => {
  const resourceKey = String(req.params.resource_key || '').trim();
  if (!resourceKey) return res.status(400).json({ error: 'resource_key es requerido' });

  try {
    const { rowCount } = await pool.query(`delete from public.scheduling_resource where resource_key = $1;`, [resourceKey]);
    if (!rowCount) return res.status(404).json({ error: 'Recurso no encontrado' });
    return res.json({ ok: true });
  } catch (err) {
    // FK de scheduling_stage_resource: no se puede borrar un recurso todavía
    // mapeado desde alguna etapa — hay que desmapear esas etapas primero.
    if (err.code === '23503') {
      return res.status(409).json({ error: 'No se puede borrar: todavía hay etapas mapeadas a este recurso.', detail: err.message });
    }
    console.error('delete scheduling resource error:', err);
    return res.status(500).json({ error: 'Error borrando recurso', detail: err.message });
  }
});

router.get('/scheduling/stage-resource', async (req, res) => {
  try {
    const line = String(req.query.line || '').trim();
    if (!isValidLine(line)) return res.status(400).json({ error: 'line debe ser portones o ipanel' });

    const { rows } = await pool.query(
      `select line, stage_key, resource_key from public.scheduling_stage_resource where line = $1 order by stage_key asc;`,
      [line]
    );
    return res.json({ ok: true, mappings: rows });
  } catch (err) {
    console.error('get scheduling stage-resource error:', err);
    return res.status(500).json({ error: 'Error leyendo el mapeo etapa-recurso', detail: err.message });
  }
});

router.put('/scheduling/stage-resource', async (req, res) => {
  const line = String(req.query.line || '').trim();
  if (!isValidLine(line)) return res.status(400).json({ error: 'line debe ser portones o ipanel' });

  const mappings = Array.isArray(req.body?.mappings) ? req.body.mappings : [];
  for (const m of mappings) {
    if (!m?.stage_key || !m?.resource_key) return res.status(400).json({ error: 'Cada mapeo necesita stage_key y resource_key' });
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`delete from public.scheduling_stage_resource where line = $1;`, [line]);

    for (const m of mappings) {
      await client.query(
        `insert into public.scheduling_stage_resource (line, stage_key, resource_key) values ($1, $2, $3);`,
        [line, String(m.stage_key).trim(), String(m.resource_key).trim()]
      );
    }

    await client.query('commit');
    return res.json({ ok: true, count: mappings.length });
  } catch (err) {
    await client.query('rollback');
    // FK a scheduling_resource: alguno de los resource_key pedidos no existe
    // en el catálogo todavía — hay que darlo de alta primero (POST /scheduling/resources).
    if (err.code === '23503') {
      return res.status(409).json({ error: 'Alguno de los resource_key no existe en el catálogo de recursos.', detail: err.message });
    }
    console.error('save scheduling stage-resource error:', err);
    return res.status(500).json({ error: 'Error guardando el mapeo etapa-recurso', detail: err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Fase 3b: variables de recurso — atributos más o menos permanentes de una
// sección/máquina (ej. plegadora.nivel_personal="junior"), no del portón ni
// de un día puntual (para eso ya existe /scheduling/calendar/exceptions).
// Se mezclan al ctx de evaluación de cada etapa según a qué resource_key
// esté mapeada — ver computeBackwardPass en regressionEngine.js. resource_key
// no tiene FK a propósito (puede ser uno "implícito" = stage_key, igual que
// el calendario), así que no hace falta darlo de alta en el catálogo antes.
// ---------------------------------------------------------------------------

router.get('/scheduling/resource-variables', async (req, res) => {
  try {
    const resourceKey = req.query.resource_key != null ? String(req.query.resource_key).trim() : null;
    const { rows } = await pool.query(
      resourceKey
        ? `select resource_key, key, value, label, notes, updated_at from public.scheduling_resource_variable where resource_key = $1 order by key asc;`
        : `select resource_key, key, value, label, notes, updated_at from public.scheduling_resource_variable order by resource_key asc, key asc;`,
      resourceKey ? [resourceKey] : []
    );
    return res.json({ ok: true, variables: rows });
  } catch (err) {
    console.error('get scheduling resource-variables error:', err);
    return res.status(500).json({ error: 'Error leyendo variables de recurso', detail: err.message });
  }
});

router.put('/scheduling/resource-variables', async (req, res) => {
  const resourceKey = String(req.query.resource_key || '').trim();
  if (!resourceKey) return res.status(400).json({ error: 'resource_key es requerido' });

  const variables = Array.isArray(req.body?.variables) ? req.body.variables : [];
  for (const v of variables) {
    if (!v?.key) return res.status(400).json({ error: 'Cada variable necesita key' });
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`delete from public.scheduling_resource_variable where resource_key = $1;`, [resourceKey]);

    for (const v of variables) {
      await client.query(
        `insert into public.scheduling_resource_variable (resource_key, key, value, label, notes, updated_at)
         values ($1, $2, $3::jsonb, $4, $5, now());`,
        [resourceKey, String(v.key).trim(), JSON.stringify(v.value ?? null), v.label || null, v.notes || null]
      );
    }

    await client.query('commit');
    return res.json({ ok: true, count: variables.length });
  } catch (err) {
    await client.query('rollback');
    console.error('save scheduling resource-variables error:', err);
    return res.status(500).json({ error: 'Error guardando variables de recurso', detail: err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Preview: tiempo_efectivo calculado vs. tiempo real ya registrado
// ---------------------------------------------------------------------------

// Compartido entre /scheduling/preview y /scheduling/regression/preview.
async function loadStandardsAndRulesMaps(line) {
  const [{ rows: standards }, { rows: rules }] = await Promise.all([
    pool.query(
      `select stage_key, standard_minutes from public.scheduling_stage_standard where line = $1;`,
      [line]
    ),
    pool.query(
      `select id, stage_key, category, field, operator, value, effect_type, effect_value,
              combine_mode, sequence_order, enabled
       from public.scheduling_time_rule
       where line = $1 and enabled = true;`,
      [line]
    ),
  ]);

  const standardByStage = new Map(standards.map((s) => [s.stage_key, Number(s.standard_minutes) || 0]));
  const rulesByStage = new Map();
  for (const r of rules) {
    if (!rulesByStage.has(r.stage_key)) rulesByStage.set(r.stage_key, []);
    rulesByStage.get(r.stage_key).push(r);
  }
  return { standardByStage, rulesByStage };
}

router.get('/scheduling/preview', async (req, res) => {
  try {
    const line = String(req.query.line || '').trim();
    if (line !== 'portones') {
      return res.status(400).json({ error: 'El preview de Fase 1 solo soporta line=portones por ahora' });
    }

    const { standardByStage, rulesByStage } = await loadStandardsAndRulesMaps(line);

    if (!standardByStage.size) {
      return res.json({ ok: true, portones: [], warning: 'No hay estándares cargados todavía para esta línea.' });
    }

    const ctxs = await listPortonSchedulingCtxs(pool, { limit: req.query.limit });
    // Variables de recurso (Fase 3b): mismo criterio que computeBackwardPass
    // — se mezclan al ctx solo para evaluar las reglas de la etapa mapeada a
    // ese resource_key, no a todo el portón.
    const [stageResourceMap, resourceVariables] = await Promise.all([
      fetchStageResourceMap(line, pool),
      fetchResourceVariables(pool),
    ]);

    const portones = ctxs.map((ctx) => {
      const stages = [];
      for (const [stageKey, standardMinutes] of standardByStage.entries()) {
        const resourceKey = stageResourceMap.get(stageKey) || stageKey;
        const resourceVars = resourceVariables.get(resourceKey);
        const result = computeEffectiveMinutes({
          standardMinutes,
          rules: rulesByStage.get(stageKey) || [],
          ctx: resourceVars ? { ...ctx, ...resourceVars } : ctx,
        });

        const inicio = ctx[`${stageKey}_inicio`] ?? null;
        const fin = ctx[`${stageKey}_fin`] ?? null;
        let realMinutes = null;
        if (inicio && fin) {
          const diffMs = new Date(fin).getTime() - new Date(inicio).getTime();
          if (Number.isFinite(diffMs) && diffMs >= 0) realMinutes = Math.round((diffMs / 60000) * 100) / 100;
        }

        stages.push({
          stage_key: stageKey,
          ...result,
          real_minutes: realMinutes,
          delta_vs_real: realMinutes == null ? null : Math.round((result.effective_minutes - realMinutes) * 100) / 100,
        });
      }

      return {
        id: ctx.id,
        nv: ctx.nv,
        sistema: ctx.sistema,
        stages,
      };
    });

    return res.json({ ok: true, portones });
  } catch (err) {
    console.error('get scheduling preview error:', err);
    return res.status(500).json({ error: 'Error calculando preview', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Regresión (Fase 2a): backward-pass desde fecha_plan_entrega, capacidad
// infinita. Solo lectura — no escribe en portones ni en ninguna tabla
// existente.
// ---------------------------------------------------------------------------

router.get('/scheduling/regression/preview', async (req, res) => {
  try {
    const line = String(req.query.line || '').trim();
    if (line !== 'portones') {
      return res.status(400).json({ error: 'La regresión de Fase 2a solo soporta line=portones por ahora' });
    }

    const { standardByStage, rulesByStage } = await loadStandardsAndRulesMaps(line);

    // Fase 2c: mismo cálculo, distinta fecha ancla. 'presupuesto'
    // (fecha_plan_entrega, la que llega del Presupuestador) es el default;
    // 'logistica' usa fecha_despacho_logistica si está cargada.
    const flow = String(req.query.flow || FLOWS.PRESUPUESTO).trim();
    if (!Object.values(FLOWS).includes(flow)) {
      return res.status(400).json({ error: `flow debe ser ${Object.values(FLOWS).join(' o ')}` });
    }

    // portones.id es UUID, no numérico — un solo portón siempre se calcula
    // aislado (capacidad infinita), es la herramienta de depuración de
    // ruta/reglas de un portón puntual, sin importar el modo flota/aislado.
    const portonId = req.query.porton_id != null ? String(req.query.porton_id).trim() : null;

    if (portonId) {
      const ctx = await getPortonSchedulingCtx(pool, portonId);
      if (!ctx) return res.status(404).json({ error: 'Portón no encontrado' });

      const result = await computePortonRegression({ line, ctx, standardByStage, rulesByStage, db: pool, flow });
      return res.json({ ok: true, mode: 'isolated', id: ctx.id, nv: ctx.nv, sistema: ctx.sistema, ...result });
    }

    const mode = String(req.query.mode || 'fleet').trim();
    if (!['fleet', 'isolated'].includes(mode)) {
      return res.status(400).json({ error: 'mode debe ser fleet o isolated' });
    }

    const ctxs = await listPortonesPendingForRegression(pool, { limit: req.query.limit });

    if (mode === 'isolated') {
      // Cada portón calculado por separado, capacidad infinita — el
      // comportamiento original de Fase 2a, sin competencia entre portones.
      // Queda como comparación/depuración frente al modo flota.
      const portones = [];
      for (const ctx of ctxs) {
        try {
          const result = await computePortonRegression({ line, ctx, standardByStage, rulesByStage, db: pool, flow });
          portones.push({ id: ctx.id, nv: ctx.nv, sistema: ctx.sistema, ...result });
        } catch (err) {
          portones.push({ id: ctx.id, nv: ctx.nv, ok: false, error: err.message });
        }
      }
      return res.json({ ok: true, mode: 'isolated', flow, portones });
    }

    const fleetResult = await computeFleetRegression({ line, ctxs, standardByStage, rulesByStage, db: pool, flow });
    return res.json({ ok: true, ...fleetResult });
  } catch (err) {
    console.error('get scheduling regression preview error:', err);
    return res.status(500).json({ error: 'Error calculando la regresión', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Calendario laboral por recurso (categoría "Tiempo"). Vacío = usa el
// fallback Lun-Vie 08:00-18:00 (ver lib/scheduling/calendar.js).
// ---------------------------------------------------------------------------

router.get('/scheduling/calendar', async (req, res) => {
  try {
    const resourceKey = String(req.query.resource_key || '').trim();
    if (!resourceKey) return res.status(400).json({ error: 'resource_key es requerido' });

    const { rows } = await pool.query(
      `select id, resource_key, weekday, start_time, end_time, enabled
       from public.scheduling_resource_calendar
       where resource_key = $1
       order by weekday asc, start_time asc;`,
      [resourceKey]
    );
    return res.json({ ok: true, shifts: rows });
  } catch (err) {
    console.error('get scheduling calendar error:', err);
    return res.status(500).json({ error: 'Error leyendo calendario', detail: err.message });
  }
});

router.put('/scheduling/calendar', async (req, res) => {
  const resourceKey = String(req.query.resource_key || '').trim();
  if (!resourceKey) return res.status(400).json({ error: 'resource_key es requerido' });

  const shifts = Array.isArray(req.body?.shifts) ? req.body.shifts : [];
  for (const s of shifts) {
    const weekday = Number(s?.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return res.status(400).json({ error: `weekday inválido: ${s?.weekday}` });
    }
    if (!s?.start_time || !s?.end_time) {
      return res.status(400).json({ error: 'Cada turno necesita start_time y end_time' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`delete from public.scheduling_resource_calendar where resource_key = $1;`, [resourceKey]);

    for (const s of shifts) {
      await client.query(
        `insert into public.scheduling_resource_calendar (resource_key, weekday, start_time, end_time, enabled)
         values ($1, $2, $3, $4, $5);`,
        [resourceKey, Number(s.weekday), s.start_time, s.end_time, s.enabled !== false]
      );
    }

    await client.query('commit');
    return res.json({ ok: true, count: shifts.length });
  } catch (err) {
    await client.query('rollback');
    console.error('save scheduling calendar error:', err);
    return res.status(500).json({ error: 'Error guardando calendario', detail: err.message });
  } finally {
    client.release();
  }
});

router.get('/scheduling/calendar/exceptions', async (req, res) => {
  try {
    const resourceKey = req.query.resource_key != null ? String(req.query.resource_key).trim() : null;
    const { rows } = await pool.query(
      resourceKey
        ? `select id, resource_key, to_char(exception_date, 'YYYY-MM-DD') as exception_date, is_working, start_time, end_time, notes
           from public.scheduling_calendar_exception where resource_key = $1 order by exception_date asc;`
        : `select id, resource_key, to_char(exception_date, 'YYYY-MM-DD') as exception_date, is_working, start_time, end_time, notes
           from public.scheduling_calendar_exception where resource_key is null order by exception_date asc;`,
      resourceKey ? [resourceKey] : []
    );
    return res.json({ ok: true, exceptions: rows });
  } catch (err) {
    console.error('get scheduling calendar exceptions error:', err);
    return res.status(500).json({ error: 'Error leyendo excepciones', detail: err.message });
  }
});

router.put('/scheduling/calendar/exceptions', async (req, res) => {
  const resourceKey = req.query.resource_key != null ? String(req.query.resource_key).trim() : null;
  const exceptions = Array.isArray(req.body?.exceptions) ? req.body.exceptions : [];
  for (const e of exceptions) {
    if (!e?.exception_date) return res.status(400).json({ error: 'Cada excepción necesita exception_date' });
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      resourceKey
        ? `delete from public.scheduling_calendar_exception where resource_key = $1;`
        : `delete from public.scheduling_calendar_exception where resource_key is null;`,
      resourceKey ? [resourceKey] : []
    );

    for (const e of exceptions) {
      await client.query(
        `insert into public.scheduling_calendar_exception (resource_key, exception_date, is_working, start_time, end_time, notes)
         values ($1, $2, $3, $4, $5, $6);`,
        [resourceKey, e.exception_date, Boolean(e.is_working), e.start_time || null, e.end_time || null, e.notes || null]
      );
    }

    await client.query('commit');
    return res.json({ ok: true, count: exceptions.length });
  } catch (err) {
    await client.query('rollback');
    console.error('save scheduling calendar exceptions error:', err);
    return res.status(500).json({ error: 'Error guardando excepciones', detail: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
