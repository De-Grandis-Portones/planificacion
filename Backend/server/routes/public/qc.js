const express = require('express');
const crypto = require('crypto');
const { pool } = require('../../db');
const { STATUS, low, loadStageMap, getNextStages, checkRequirements } = require('../../lib/workflow');
const { esTokenInterno } = require('../../lib/qcTokenInterno');
const { toMmHeuristic } = require('../../lib/logisticaCapacidad');

// Ver mismo sentinel/comentario en portones.js (getPortonShapeById).
const ANCHO_MM_SIN_DATO = 999999;

const router = express.Router();

const PORTON_ETAPAS = new Set([
  'diseno',
  'diseno_piernas',
  'diseno_revestimiento',
  'laser',
  'laser_dintel',
  'laser_hojas',
  'laser_brazos_espada',
  'guillotina',
  'plegadora',
  'armado_marco_piernas',
  'armado_piernas',
  'armado_primario',
  'armado_hojas',
  'inyeccion',
  'revestimiento',
  'pintura',
  'pintura_revestimiento',
  'armado_final',
  'despacho',
  'corte_revest',
  'plegado_revest',
  'corte_dintel',
  'plegado_dintel',
  'armado_dintel',
]);

const IPANEL_ETAPAS = new Set(['diseno', 'guillotina', 'plegado', 'pintura', 'inyeccion', 'despacho']);

const IPANEL_TO_PORTON_STAGE_CANDIDATES = {
  diseno: ['diseno'],
  guillotina: ['guillotina'],
  plegado: ['plegadora', 'plegado_revest'],
  pintura: ['pintura', 'pintura_revestimiento'],
  inyeccion: ['inyeccion'],
  despacho: ['despacho'],
};

// Prefabricados/Servicio Técnico/Orden Externa circulan por las mismas
// secciones físicas que portones (comparten stage_key), así que un scope de
// QC ya otorgado para portones en una sección alcanza también para estas
// líneas en esa misma sección, sin tener que duplicar el alta.
const SHARED_SECTION_LINES = new Set(['servicio_tecnico', 'orden_externa', 'prefabricados', 'refabricado', 'prueba']);

function stageCandidatesForScope(line, stageKey) {
  if (line === 'ipanel') {
    const out = [{ line: 'ipanel', stage_key: stageKey }];
    for (const st of IPANEL_TO_PORTON_STAGE_CANDIDATES[stageKey] || [stageKey]) {
      out.push({ line: 'portones', stage_key: st });
    }
    return out;
  }
  if (SHARED_SECTION_LINES.has(line)) {
    return [{ line, stage_key: stageKey }, { line: 'portones', stage_key: stageKey }];
  }
  return [{ line, stage_key: stageKey }];
}

async function getPortonIdByNv(db, nv) {
  const { rows } = await db.query(
    `select id from public.portones where nv = $1 order by created_at desc, id desc limit 1;`,
    [nv]
  );
  return rows[0]?.id || null;
}

async function getPortonCtxById(db, id) {
  const pQ = await db.query(
    `
    select p.*, pv.data as preprod_data
    from public.portones p
    left join public.preproduccion_valores pv on pv.nv = p.nv
    where p.id = $1
    limit 1;
    `,
    [id]
  );
  if (!pQ.rows.length) return null;

  const ctx = { ...pQ.rows[0] };
  try {
    const pre = ctx.preprod_data;
    if (pre && typeof pre === 'object') {
      for (const k of Object.keys(pre)) {
        if (ctx[k] == null) ctx[k] = pre[k];
      }
    }
  } catch {}
  try { delete ctx.preprod_data; } catch {}

  // Ver mismo cálculo/comentario en getPortonShapeById (portones.js): ancho
  // normalizado a mm para la condición de ruteo Laser Dintel vs. Corte/
  // Plegado/Armado Dintel. Sin dato, default ANCHO_MM_SIN_DATO (mantiene el
  // camino de siempre, Laser Dintel).
  const anchoRaw = ctx.Ancho ?? ctx.ancho ?? ctx.Puerta_Ancho ?? ctx.puerta_ancho;
  ctx.ancho_mm_normalizado = toMmHeuristic(anchoRaw) ?? ANCHO_MM_SIN_DATO;

  const tQ = await db.query(
    `select etapa as k, inicio, fin from public.porton_etapas_tiempos where porton_id = $1;`,
    [id]
  );
  for (const r of tQ.rows) {
    const k = String(r?.k || '');
    if (!k) continue;
    ctx[`${k}_inicio`] = r.inicio ?? null;
    ctx[`${k}_fin`] = r.fin ?? null;
  }

  const eQ = await db.query(
    `select etapa as k, estado from public.porton_etapas_estado where porton_id = $1;`,
    [id]
  );
  for (const r of eQ.rows) {
    const k = String(r?.k || '');
    if (!k) continue;
    ctx[k] = r.estado ?? null;
  }

  return ctx;
}

async function getIpanelByNv(db, nv) {
  const { rows } = await db.query(
    `select * from public.ipanel where nv = $1 order by created_at desc, id desc limit 1;`,
    [nv]
  );
  return rows[0] || null;
}

// Prefabricados: item_id del QC es el "numero" (secuencia propia, único por pedido).
async function getPrefabOrdenByNumero(db, numero) {
  const { rows } = await db.query(
    `
    select o.id, t.workflow_stages
    from public.prefabricado_ordenes o
    join public.prefabricado_tipos t on t.id = o.tipo_id
    where o.numero = $1
    limit 1;
    `,
    [numero]
  );
  return rows[0] || null;
}

// Servicio Técnico: item_id del QC es el NV del portón (no hay secuencia propia).
// Si hay más de una orden ST para el mismo NV, se toma la más reciente
// (mismo criterio que ya usa getPortonIdByNv para NVs duplicados).
async function getStOrdenByNv(db, nv) {
  const { rows } = await db.query(
    `select id, workflow_stages from public.st_ordenes where nv = $1 and tipo = 'ST' order by created_at desc, id desc limit 1;`,
    [nv]
  );
  return rows[0] || null;
}

// Refabricado: mismo criterio que ST (item_id = nv), pero tipo distinto -
// necesita su propio lookup para no confundirse con una orden ST del mismo NV.
async function getRefabricadoOrdenByNv(db, nv) {
  const { rows } = await db.query(
    `select id, workflow_stages from public.st_ordenes where nv = $1 and tipo = 'REFAB' order by created_at desc, id desc limit 1;`,
    [nv]
  );
  return rows[0] || null;
}

// Orden Externa: item_id del QC es el "numero" (secuencia propia oe_seq, sin NV).
async function getOrdenExternaByNumero(db, numero) {
  const { rows } = await db.query(
    `select id, workflow_stages from public.st_ordenes where numero = $1 and tipo = 'OE' limit 1;`,
    [numero]
  );
  return rows[0] || null;
}

// Prueba Laser: mismo criterio que OE (item_id = numero, sin NV), pero línea
// propia para no colisionar con OE si algún día comparten numero (ver
// migration_st_ordenes_tipo_prueba.sql).
async function getPruebaOrdenByNumero(db, numero) {
  const { rows } = await db.query(
    `select id, workflow_stages from public.st_ordenes where numero = $1 and tipo = 'PRUEBA' limit 1;`,
    [numero]
  );
  return rows[0] || null;
}

const QC_PIN_SALT = process.env.QC_PIN_SALT || 'dev_change_me_pin_salt';

function hashPin(pin) {
  return crypto.createHmac('sha256', QC_PIN_SALT).update(String(pin)).digest('hex');
}

function isValidLine(line) {
  return ['portones', 'ipanel', 'prefabricados', 'servicio_tecnico', 'orden_externa', 'refabricado', 'prueba'].includes(line);
}
function isValidQcStatus(s) {
  return ['APROBADO', 'OBSERVADO', 'RECHAZADO'].includes(s);
}
function isValidKind(k) {
  return ['OBSERVADO', 'RECHAZADO'].includes(k);
}

async function userHasStageScope(db, userId, line, stageKey) {
  const candidates = stageCandidatesForScope(line, stageKey);
  for (const c of candidates) {
    const { rows } = await db.query(
      `
      select 1
      from public.qc_user_scope
      where user_id = $1 and line = $2 and stage_key = $3 and enabled = true
      limit 1;
      `,
      [userId, c.line, c.stage_key]
    );
    if (rows.length) return true;
  }
  return false;
}

async function resolveMotive(db, { line, qcStatus, stageKey, motiveId }) {
  const mid = Number(motiveId);
  if (!Number.isInteger(mid)) return null;

  const candidates = stageCandidatesForScope(line, stageKey);
  for (const c of candidates) {
    const { rows } = await db.query(
      `
      select id, line, kind, stage_key, label
      from public.qc_motive
      where id = $1
        and enabled = true
        and line = $2
        and kind = $3
        and (stage_key is null or stage_key = $4)
      limit 1;
      `,
      [mid, c.line, qcStatus, c.stage_key]
    );
    if (rows.length) return rows[0];
  }
  return null;
}

router.get('/qc/motives', async (req, res) => {
  try {
    const line = String(req.query.line || '').trim();
    const kind = String(req.query.kind || '').trim().toUpperCase();
    const stage = req.query.stage == null ? null : String(req.query.stage).trim();

    if (!isValidLine(line)) return res.status(400).json({ error: 'line invalida' });
    if (!isValidKind(kind)) return res.status(400).json({ error: 'kind invalido' });

    if (line !== 'ipanel') {
      const { rows } = await pool.query(
        `
        select id, line, kind, stage_key, label, priority
        from public.qc_motive
        where enabled = true
          and line = $1
          and kind = $2
          and (stage_key is null or stage_key = $3)
        order by priority asc, id asc;
        `,
        [line, kind, stage]
      );
      return res.json(rows);
    }

    const candidates = stageCandidatesForScope(line, stage);
    const rowsOut = [];
    const seen = new Set();
    for (const c of candidates) {
      const { rows } = await pool.query(
        `
        select id, line, kind, stage_key, label, priority
        from public.qc_motive
        where enabled = true
          and line = $1
          and kind = $2
          and (stage_key is null or stage_key = $3)
        order by priority asc, id asc;
        `,
        [c.line, kind, c.stage_key]
      );
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        rowsOut.push(r);
      }
    }
    return res.json(rowsOut);
  } catch (err) {
    console.error('qc motives error:', err);
    return res.status(500).json({ error: 'Error leyendo motivos', detail: err.message });
  }
});

router.get('/qc/history/:line/:itemId', async (req, res) => {
  try {
    const line = String(req.params.line || '').trim();
    const itemId = Number(req.params.itemId);

    if (!isValidLine(line)) return res.status(400).json({ error: 'line invalida' });
    if (!Number.isInteger(itemId)) return res.status(400).json({ error: 'itemId invalido' });

    const { rows } = await pool.query(
      `
      select
        e.id,
        e.stage_key,
        e.qc_status,
        e.note,
        e.created_at,
        u.id as user_id,
        u.name as user_name,
        u.is_global as user_is_global,
        m.id as motive_id,
        m.label as motive_label
      from public.qc_event e
      join public.qc_users u on u.id = e.by_user_id
      left join public.qc_motive m on m.id = e.motive_id
      where e.line = $1 and e.item_id = $2
      order by e.created_at desc;
      `,
      [line, itemId]
    );

    return res.json(rows);
  } catch (err) {
    console.error('qc history error:', err);
    return res.status(500).json({ error: 'Error leyendo historial QC', detail: err.message });
  }
});

router.post('/qc/authorize', async (req, res) => {
  const { line, item_id, stage_key, qc_status, motive_id, note, pin } = req.body || {};
  // Llamada interna del propio backend (despacho v2): identifica al usuario
  // por id, ya logueado con su PIN. Ver lib/qcTokenInterno.js.
  const qcUserIdInterno = esTokenInterno(req.get('x-qc-interno')) ? Number(req.body?.qc_user_id) : null;
  const esInterno = Number.isInteger(qcUserIdInterno);

  const nItemId = Number(item_id);
  const stageKey = String(stage_key || '').trim();
  const qcStatus = String(qc_status || '').trim().toUpperCase();
  const pinStr = String(pin || '').trim();
  const lineStr = String(line || '').trim();

  if (!isValidLine(lineStr)) return res.status(400).json({ error: 'line invalida' });
  if (!Number.isInteger(nItemId)) return res.status(400).json({ error: 'item_id invalido' });
  if (!stageKey) return res.status(400).json({ error: 'stage_key requerido' });
  if (!isValidQcStatus(qcStatus)) return res.status(400).json({ error: 'qc_status invalido' });
  if (!esInterno && !/^\d{3,10}$/.test(pinStr)) return res.status(400).json({ error: 'PIN invalido (solo numerico)' });

  const client = await pool.connect();
  try {
    await client.query('begin');

    const uQ = esInterno
      ? await client.query(
        `select id, name, is_global, is_active from public.qc_users where id = $1 limit 1;`,
        [qcUserIdInterno]
      )
      : await client.query(
        `select id, name, is_global, is_active from public.qc_users where pin_hash = $1 limit 1;`,
        [hashPin(pinStr)]
      );

    const user = uQ.rows[0];
    if (!user || !user.is_active) {
      await client.query('rollback');
      return res.status(401).json({ error: 'PIN incorrecto o usuario inactivo' });
    }

    const lastQ = await client.query(
      `select qc_status from public.qc_event where line = $1 and item_id = $2 order by created_at desc limit 1;`,
      [lineStr, nItemId]
    );
    const lastStatus = lastQ.rows[0]?.qc_status || null;

    if (lastStatus === 'RECHAZADO' && qcStatus !== 'RECHAZADO' && !user.is_global) {
      await client.query('rollback');
      return res.status(403).json({ error: 'Solo un usuario GLOBAL puede destrabar un RECHAZADO' });
    }

    if (!user.is_global) {
      const hasScope = await userHasStageScope(client, user.id, lineStr, stageKey);
      if (!hasScope) {
        await client.query('rollback');
        return res.status(403).json({ error: 'Usuario sin permiso para esa seccion' });
      }
    }

    let motiveId = null;
    if (qcStatus === 'OBSERVADO' || qcStatus === 'RECHAZADO') {
      const motive = await resolveMotive(client, { line: lineStr, qcStatus, stageKey, motiveId: motive_id });
      if (!motive) {
        await client.query('rollback');
        return res.status(400).json({ error: 'motive_id invalido para esa linea/estado/etapa' });
      }
      motiveId = motive.id;
    }

    const ins = await client.query(
      `
      insert into public.qc_event(line, item_id, stage_key, qc_status, motive_id, note, by_user_id)
      values ($1,$2,$3,$4,$5,$6,$7)
      returning *;
      `,
      [lineStr, nItemId, stageKey, qcStatus, motiveId, note ?? null, user.id]
    );

    if (qcStatus !== 'RECHAZADO') {
      const stageMap = await loadStageMap(lineStr);
      const stRow = stageMap.get(stageKey);
      const statusCol = String(stRow?.status_col || stageKey || '').trim();
      if (!statusCol) {
        await client.query('rollback');
        return res.status(400).json({ error: 'stage_key invalida para workflow' });
      }

      if (lineStr === 'portones') {
        const portonId = await getPortonIdByNv(client, nItemId);
        if (!portonId) {
          await client.query('rollback');
          return res.status(404).json({ error: 'Porton no encontrado para ese NV' });
        }

        const ctx = await getPortonCtxById(client, portonId);
        if (!ctx) {
          await client.query('rollback');
          return res.status(404).json({ error: 'Porton no encontrado' });
        }

        const finCol = `${statusCol}_fin`;
        const isFinal = low(ctx?.[statusCol]) === low(STATUS.FINALIZADO);
        const hasFin = Boolean(ctx?.[finCol]);
        if (!isFinal && !hasFin) {
          await client.query('rollback');
          return res.status(409).json({ error: `La etapa ${statusCol} debe estar FINALIZADO antes de completar QC` });
        }

        const nextKeys = await getNextStages('portones', stageKey, ctx);
        for (const nk of nextKeys || []) {
          const ns = stageMap.get(nk);
          if (!ns) continue;
          const nextStageCol = String(ns.status_col || '').trim();
          if (!PORTON_ETAPAS.has(nextStageCol)) continue;

          // Gate: si el siguiente stage es despacho, verificar que el portón
          // no tenga eventos OBSERVADO o RECHAZADO. Si los tiene, queda retenido
          // hasta que la página de revisión lo apruebe (revision_ok).
          if (nextStageCol === 'despacho') {
            const obsQ = await client.query(
              `SELECT 1 FROM public.qc_event
               WHERE line = 'portones' AND item_id = $1
               AND qc_status IN ('OBSERVADO', 'RECHAZADO')
               LIMIT 1`,
              [nItemId]
            );
            if (obsQ.rows.length > 0) continue;
          }

          const req = await checkRequirements('portones', nextStageCol, ctx);
          if (!req?.ok) continue;

          await client.query(
            `
            insert into public.porton_etapas_estado(porton_id, etapa, estado)
            values ($1, $2::public.porton_etapa, $3)
            on conflict (porton_id, etapa)
            do update set estado = coalesce(public.porton_etapas_estado.estado, excluded.estado);
            `,
            [portonId, nextStageCol, STATUS.PENDIENTE]
          );
        }
      } else if (lineStr === 'ipanel') {
        const ip = await getIpanelByNv(client, nItemId);
        if (!ip?.id) {
          await client.query('rollback');
          return res.status(404).json({ error: 'iPanel no encontrado para ese NV' });
        }

        const st = low(ip?.[statusCol]);
        if (st !== low(STATUS.FINALIZADO)) {
          await client.query('rollback');
          return res.status(409).json({ error: `La etapa ${statusCol} debe estar FINALIZADO antes de completar QC` });
        }

        const nextKeys = await getNextStages('ipanel', stageKey, ip);
        for (const nk of nextKeys || []) {
          const ns = stageMap.get(nk);
          if (!ns) continue;
          const nextStageCol = String(ns.status_col || '').trim();
          if (!IPANEL_ETAPAS.has(nextStageCol)) continue;

          await client.query(
            `update public.ipanel set ${nextStageCol} = coalesce(${nextStageCol}, $2) where id = $1;`,
            [ip.id, STATUS.PENDIENTE]
          );
        }
      } else if (lineStr === 'prefabricados') {
        const orden = await getPrefabOrdenByNumero(client, nItemId);
        if (!orden) {
          await client.query('rollback');
          return res.status(404).json({ error: 'Pedido de prefabricado no encontrado para ese número' });
        }

        const estQ = await client.query(
          `select estado from public.prefabricado_orden_etapas_estado where orden_id = $1 and etapa = $2;`,
          [orden.id, statusCol]
        );
        if (low(estQ.rows[0]?.estado) !== low(STATUS.FINALIZADO)) {
          await client.query('rollback');
          return res.status(409).json({ error: `La etapa ${statusCol} debe estar FINALIZADO antes de completar QC` });
        }

        const stages = Array.isArray(orden.workflow_stages) ? orden.workflow_stages : [];
        const nextStage = stages[stages.indexOf(statusCol) + 1];
        if (nextStage) {
          await client.query(
            `
            insert into public.prefabricado_orden_etapas_estado(orden_id, etapa, estado)
            values ($1, $2, $3)
            on conflict (orden_id, etapa) do nothing;
            `,
            [orden.id, nextStage, STATUS.PENDIENTE]
          );
        }
      } else if (lineStr === 'servicio_tecnico') {
        const orden = await getStOrdenByNv(client, nItemId);
        if (!orden) {
          await client.query('rollback');
          return res.status(404).json({ error: 'Orden de servicio técnico no encontrada para ese NV' });
        }

        const estQ = await client.query(
          `select estado from public.st_orden_etapas_estado where orden_id = $1 and etapa = $2;`,
          [orden.id, statusCol]
        );
        if (low(estQ.rows[0]?.estado) !== low(STATUS.FINALIZADO)) {
          await client.query('rollback');
          return res.status(409).json({ error: `La etapa ${statusCol} debe estar FINALIZADO antes de completar QC` });
        }

        const stages = Array.isArray(orden.workflow_stages) ? orden.workflow_stages : [];
        const nextStage = stages[stages.indexOf(statusCol) + 1];
        if (nextStage) {
          await client.query(
            `
            insert into public.st_orden_etapas_estado(orden_id, etapa, estado)
            values ($1, $2, $3)
            on conflict (orden_id, etapa) do nothing;
            `,
            [orden.id, nextStage, STATUS.PENDIENTE]
          );
        }
      } else if (lineStr === 'orden_externa') {
        const orden = await getOrdenExternaByNumero(client, nItemId);
        if (!orden) {
          await client.query('rollback');
          return res.status(404).json({ error: 'Orden externa no encontrada para ese número' });
        }

        const estQ = await client.query(
          `select estado from public.st_orden_etapas_estado where orden_id = $1 and etapa = $2;`,
          [orden.id, statusCol]
        );
        if (low(estQ.rows[0]?.estado) !== low(STATUS.FINALIZADO)) {
          await client.query('rollback');
          return res.status(409).json({ error: `La etapa ${statusCol} debe estar FINALIZADO antes de completar QC` });
        }

        const stages = Array.isArray(orden.workflow_stages) ? orden.workflow_stages : [];
        const nextStage = stages[stages.indexOf(statusCol) + 1];
        if (nextStage) {
          await client.query(
            `
            insert into public.st_orden_etapas_estado(orden_id, etapa, estado)
            values ($1, $2, $3)
            on conflict (orden_id, etapa) do nothing;
            `,
            [orden.id, nextStage, STATUS.PENDIENTE]
          );
        }
      } else if (lineStr === 'prueba') {
        const orden = await getPruebaOrdenByNumero(client, nItemId);
        if (!orden) {
          await client.query('rollback');
          return res.status(404).json({ error: 'Prueba de Laser no encontrada para ese número' });
        }

        const estQ = await client.query(
          `select estado from public.st_orden_etapas_estado where orden_id = $1 and etapa = $2;`,
          [orden.id, statusCol]
        );
        if (low(estQ.rows[0]?.estado) !== low(STATUS.FINALIZADO)) {
          await client.query('rollback');
          return res.status(409).json({ error: `La etapa ${statusCol} debe estar FINALIZADO antes de completar QC` });
        }

        const stages = Array.isArray(orden.workflow_stages) ? orden.workflow_stages : [];
        const nextStage = stages[stages.indexOf(statusCol) + 1];
        if (nextStage) {
          await client.query(
            `
            insert into public.st_orden_etapas_estado(orden_id, etapa, estado)
            values ($1, $2, $3)
            on conflict (orden_id, etapa) do nothing;
            `,
            [orden.id, nextStage, STATUS.PENDIENTE]
          );
        }
      } else if (lineStr === 'refabricado') {
        const orden = await getRefabricadoOrdenByNv(client, nItemId);
        if (!orden) {
          await client.query('rollback');
          return res.status(404).json({ error: 'Orden de refabricado no encontrada para ese NV' });
        }

        const estQ = await client.query(
          `select estado from public.st_orden_etapas_estado where orden_id = $1 and etapa = $2;`,
          [orden.id, statusCol]
        );
        if (low(estQ.rows[0]?.estado) !== low(STATUS.FINALIZADO)) {
          await client.query('rollback');
          return res.status(409).json({ error: `La etapa ${statusCol} debe estar FINALIZADO antes de completar QC` });
        }

        const stages = Array.isArray(orden.workflow_stages) ? orden.workflow_stages : [];
        const nextStage = stages[stages.indexOf(statusCol) + 1];
        if (nextStage) {
          await client.query(
            `
            insert into public.st_orden_etapas_estado(orden_id, etapa, estado)
            values ($1, $2, $3)
            on conflict (orden_id, etapa) do nothing;
            `,
            [orden.id, nextStage, STATUS.PENDIENTE]
          );
        }
      }
    }

    await client.query('commit');

    return res.json({
      ok: true,
      qc: ins.rows[0],
      user: { id: user.id, name: user.name, is_global: user.is_global },
    });
  } catch (err) {
    await client.query('rollback');
    console.error('qc authorize error:', err);
    return res.status(500).json({ error: 'Error autorizando QC', detail: err.message });
  } finally {
    client.release();
  }
});

router.post('/qc/summary', async (req, res) => {
  try {
    const line = String(req.body?.line || '').trim();
    const stageKey = req.body?.stage_key == null || req.body?.stage_key === '' ? null : String(req.body.stage_key).trim();
    const itemIds = Array.isArray(req.body?.item_ids)
      ? req.body.item_ids.map((n) => Number(n)).filter((n) => Number.isInteger(n))
      : [];

    if (!isValidLine(line)) return res.status(400).json({ error: 'line invalida' });
    if (!itemIds.length) return res.json({ ok: true, items: {} });

    const latestQ = await pool.query(
      `
      with ranked as (
        select item_id, stage_key, qc_status, created_at,
          row_number() over (partition by item_id, stage_key order by created_at desc) as rn
        from public.qc_event
        where line = $1
          and item_id = any($2::int8[])
          and ($3::text is null or stage_key = $3::text)
      )
      select item_id, stage_key, qc_status
      from ranked
      where rn = 1;
      `,
      [line, itemIds, stageKey]
    );

    const obsQ = await pool.query(
      `
      select item_id, bool_or(upper(qc_status) = 'OBSERVADO') as has_obs
      from public.qc_event
      where line = $1 and item_id = any($2::int8[])
      group by item_id;
      `,
      [line, itemIds]
    );

    const hasObsById = new Map(obsQ.rows.map((r) => [Number(r.item_id), Boolean(r.has_obs)]));
    const items = {};
    for (const id of itemIds) items[String(id)] = { has_obs: hasObsById.get(id) || false, latest_by_stage: {} };

    for (const r of latestQ.rows) {
      const id = Number(r.item_id);
      const st = String(r.stage_key || '').trim();
      const qc = String(r.qc_status || '').trim().toUpperCase();
      if (!Number.isInteger(id) || !st) continue;
      const key = String(id);
      if (!items[key]) items[key] = { has_obs: hasObsById.get(id) || false, latest_by_stage: {} };
      items[key].latest_by_stage[st] = qc;
      if (qc === 'OBSERVADO') items[key].has_obs = true;
    }

    return res.json({ ok: true, items });
  } catch (err) {
    console.error('qc summary error:', err);
    return res.status(500).json({ error: 'Error leyendo resumen QC', detail: err.message });
  }
});

module.exports = router;
