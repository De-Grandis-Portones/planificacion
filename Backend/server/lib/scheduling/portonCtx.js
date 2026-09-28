// lib/scheduling/portonCtx.js
//
// Arma el mismo contexto plano que ya arma getPortonCtxById (privada, dentro
// de routes/public/qc.js) — fila de portones + preprod_data aplanado +
// *_inicio/*_fin de porton_etapas_tiempos + estado de porton_etapas_estado —
// para poder evaluar reglas de tiempo (evalRule espera este shape).
//
// Es una copia deliberada, no un import de qc.js: qc.js está en el camino
// crítico de cada ▶/⏹ que aprieta un operario, y no queremos que un cambio
// acá (aunque sea de solo lectura) pueda afectar esa ruta. Deduplicar con
// qc.js queda anotado como limpieza opcional para más adelante.
const { pool } = require('../../db');

const PREVIEW_DEFAULT_LIMIT = 50;
const PREVIEW_MAX_LIMIT = 500;

function attachPreprodData(row) {
  const ctx = { ...row };
  try {
    const pre = ctx.preprod_data;
    if (pre && typeof pre === 'object') {
      for (const k of Object.keys(pre)) {
        if (ctx[k] == null) ctx[k] = pre[k];
      }
    }
  } catch {}
  try { delete ctx.preprod_data; } catch {}
  return ctx;
}

// Batch: une *_inicio/*_fin y estado por etapa sobre una lista de contextos ya
// armados (evita N round-trips cuando se arma el preview de varios portones).
async function attachTiemposYEstado(db, ctxRows) {
  if (!ctxRows.length) return ctxRows;
  const ids = ctxRows.map((r) => r.id);

  const [{ rows: tiempos }, { rows: estados }] = await Promise.all([
    db.query(
      `select porton_id, etapa as k, inicio, fin from public.porton_etapas_tiempos where porton_id = any($1);`,
      [ids]
    ),
    db.query(
      `select porton_id, etapa as k, estado from public.porton_etapas_estado where porton_id = any($1);`,
      [ids]
    ),
  ]);

  const tiemposByPorton = new Map();
  for (const r of tiempos) {
    if (!tiemposByPorton.has(r.porton_id)) tiemposByPorton.set(r.porton_id, []);
    tiemposByPorton.get(r.porton_id).push(r);
  }
  const estadosByPorton = new Map();
  for (const r of estados) {
    if (!estadosByPorton.has(r.porton_id)) estadosByPorton.set(r.porton_id, []);
    estadosByPorton.get(r.porton_id).push(r);
  }

  return ctxRows.map((ctx) => {
    const out = { ...ctx };
    for (const r of tiemposByPorton.get(ctx.id) || []) {
      const k = String(r.k || '');
      if (!k) continue;
      out[`${k}_inicio`] = r.inicio ?? null;
      out[`${k}_fin`] = r.fin ?? null;
    }
    for (const r of estadosByPorton.get(ctx.id) || []) {
      const k = String(r.k || '');
      if (!k) continue;
      out[k] = r.estado ?? null;
    }
    return out;
  });
}

async function getPortonSchedulingCtx(db, id) {
  const { rows } = await db.query(
    `
    select p.*, pv.data as preprod_data
    from public.portones p
    left join public.preproduccion_valores pv on pv.nv = p.nv
    where p.id = $1
    limit 1;
    `,
    [id]
  );
  if (!rows.length) return null;
  const [ctx] = await attachTiemposYEstado(db, [attachPreprodData(rows[0])]);
  return ctx || null;
}

// Últimos N portones "normales" (mismo filtro implícito que usa el tablero:
// se excluyen refabricaciones), para el preview de /admin/scheduling.
async function listPortonSchedulingCtxs(db = pool, { limit } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || PREVIEW_DEFAULT_LIMIT, 1), PREVIEW_MAX_LIMIT);
  const { rows } = await db.query(
    `
    select p.*, pv.data as preprod_data
    from public.portones p
    left join public.preproduccion_valores pv on pv.nv = p.nv
    where p.tipo = 'normal'
    order by p.id desc
    limit $1;
    `,
    [n]
  );
  return attachTiemposYEstado(db, rows.map(attachPreprodData));
}

// Portones con fecha límite real y todavía no despachados, para el preview
// de regresión (Fase 2a) — ordenados por urgencia (fecha_plan_entrega más
// próxima primero). A diferencia de listPortonSchedulingCtxs (últimos N por
// id, para el preview de tiempo efectivo de Fase 1), acá el orden importa
// porque representa "qué portón mirar primero".
async function listPortonesPendingForRegression(db = pool, { limit } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || PREVIEW_DEFAULT_LIMIT, 1), PREVIEW_MAX_LIMIT);
  const { rows } = await db.query(
    `
    select p.*, pv.data as preprod_data
    from public.portones p
    left join public.preproduccion_valores pv on pv.nv = p.nv
    where p.tipo = 'normal'
      and p.fecha_plan_entrega is not null
      and not exists (
        select 1 from public.porton_etapas_estado e
        where e.porton_id = p.id and e.etapa = 'despacho'::public.porton_etapa and e.estado = 'Finalizado'
      )
    order by p.fecha_plan_entrega asc, p.id asc
    limit $1;
    `,
    [n]
  );
  return attachTiemposYEstado(db, rows.map(attachPreprodData));
}

module.exports = { getPortonSchedulingCtx, listPortonSchedulingCtxs, listPortonesPendingForRegression };
