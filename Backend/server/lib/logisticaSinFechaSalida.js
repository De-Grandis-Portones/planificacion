// lib/logisticaSinFechaSalida.js
//
// Portones (y demás catálogos de Preproducción: puertas, iPanel, etc.) que
// TODAVÍA no tienen "Fecha Salida" cargada (preproduccion_valores.data.
// fecha_salida_imput vacío) - pedido explícito del usuario para verlos en el
// mapa y decidir con qué prioridad cargarles fecha según dónde están. Mismo
// criterio EXACTO que el filtro "Sin fecha" de la columna "Fecha Salida" en
// /a (Frontend/src/components/PreproduccionValoresTable.jsx):
//   1) excluye NV de la lista de bloqueados (blocked_nvs.txt),
//   2) excluye NV donde TODOS los portones físicos ya tienen la etapa
//      Despacho en "Finalizado" (equivalente al switch "ocultar ya
//      despachados", que en /a está en OFF por default),
//   3) NV con fecha_salida_imput vacío.
// Verificado contra la base real: reproduce 64 NV (el usuario reportó 65
// mirando /a en el momento - diferencia mínima, esperable por el instante
// exacto de carga, no por un criterio distinto).
//
// blocked_nvs.txt es un archivo estático que sirve el FRONTEND (Vercel), no
// existe una copia en este backend (Render) - se trae por HTTP desde la URL
// pública, con cache corto en memoria para no pegarle en cada request ni
// romper el mapa si el frontend está caído en ese momento.
const axios = require('axios');
const { pool } = require('../db');
const { resolveCoordsForNvs } = require('./logisticaMapa');
const { resolveEtapasPorNv, resolveSemanaPrometidaPorNv } = require('./logisticaMapaExtras');
const { sqlInstalacionSigueSalida } = require('./logisticaInstalacionVendida');

const BLOCKED_NV_URL = 'https://planificacion-pi.vercel.app/blocked_nvs.txt';
const BLOCKED_CACHE_MS = 5 * 60 * 1000;
let blockedCache = { at: 0, set: new Set() };

function normalizeNvToken(token) {
  const s = String(token || '').trim();
  if (!s || s.startsWith('#')) return '';
  const m = s.match(/\d+/);
  return m ? m[0] : s;
}

async function getBlockedNvSet() {
  if (Date.now() - blockedCache.at < BLOCKED_CACHE_MS) return blockedCache.set;
  try {
    const { data } = await axios.get(BLOCKED_NV_URL, { timeout: 8000, responseType: 'text' });
    const set = new Set(String(data || '').split(/\s+/).map(normalizeNvToken).filter(Boolean));
    blockedCache = { at: Date.now(), set };
    return set;
  } catch {
    // Si falla la traída (frontend caído, red, etc.), sigue con lo último
    // bueno que tenga en memoria en vez de romper el mapa por esto - peor
    // caso, unos NV bloqueados vuelven a aparecer hasta que se recupere.
    return blockedCache.set;
  }
}

async function listPortonesSinFechaSalida() {
  const blockedNvSet = await getBlockedNvSet();

  const { rows } = await pool.query(
    `
    with despacho_por_unidad as (
      select p.nv, p.id,
        max(case when e.etapa = 'despacho'::public.porton_etapa then e.estado end) as despacho
      from public.portones p
      left join public.porton_etapas_estado e on e.porton_id = p.id
      where p.parent_id is null
      group by p.nv, p.id
    ),
    despacho_todos_finalizados as (
      select nv, bool_and(coalesce(despacho, '') = 'Finalizado') as todos_finalizados
      from despacho_por_unidad
      group by nv
    )
    select pv.nv, pv.nv_tipo,
      coalesce(pv.data->>'Nombre', pv.data->>'nombre', pv.data->>'cliente_nombre') as nombre_pv,
      coalesce(pv.data->>'RazSoc', pv.data->>'distribuidor_nombre') as distribuidor
    from public.preproduccion_valores pv
    left join despacho_todos_finalizados d on d.nv = pv.nv
    where pv.nv is not null
      and nullif(pv.data->>'fecha_salida_imput', '') is null
      and coalesce(d.todos_finalizados, false) = false
    order by pv.nv asc;
    `
  );

  const filtrados = rows.filter((r) => !blockedNvSet.has(String(r.nv)));
  const nvs = filtrados.map((r) => r.nv);

  const [puntos, etapasPorNv, semanaPrometidaPorNv] = await Promise.all([
    resolveCoordsForNvs(nvs),
    resolveEtapasPorNv(nvs),
    resolveSemanaPrometidaPorNv(nvs),
  ]);
  const puntosByNv = new Map(puntos.map((p) => [p.nv, p]));

  return filtrados.map((r) => ({
    nv: r.nv,
    nv_tipo: r.nv_tipo,
    distribuidor: r.distribuidor || null,
    ...(puntosByNv.get(r.nv) || { lat: null, lng: null, source: null, nombre: null, direccion: null, maps_url: null, zona: null }),
    // Si la quote del Presupuestador no tenía nombre (fuera del alcance de
    // resolveCoordsForNvs), cae al que haya cargado logística en /a.
    nombre: puntosByNv.get(r.nv)?.nombre || r.nombre_pv || null,
    etapas: etapasPorNv.get(r.nv) || null,
    semana_prometida: semanaPrometidaPorNv.get(r.nv) || null,
  }));
}

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Carga "Fecha Salida" (mismo campo que /a) para un lote de NV, directo
 * desde el mapa - equivalente a editar esa columna en /a, pero para varios
 * a la vez elegidos por cercanía geográfica. Matchea por (nv, nv_tipo), no
 * solo por nv, para no pisar por accidente otra fila si algún NV tuviera más
 * de una entrada en preproduccion_valores (ej. portón + puerta con el mismo
 * número).
 * @param {Array<{nv:number, nv_tipo:string}>} pares
 * @param {string} fechaISO - 'YYYY-MM-DD'
 * @returns {Promise<{ actualizados:number }>}
 */
async function asignarFechaSalida(pares, fechaISO) {
  if (!FECHA_RE.test(String(fechaISO || ''))) {
    const err = new Error('fecha debe tener formato YYYY-MM-DD');
    err.status = 400;
    throw err;
  }
  const nvs = [];
  const nvTipos = [];
  for (const p of pares || []) {
    const nv = Number(p?.nv);
    const nvTipo = String(p?.nv_tipo || '').trim();
    if (!Number.isInteger(nv) || !nvTipo) continue;
    nvs.push(nv);
    nvTipos.push(nvTipo);
  }
  if (!nvs.length) return { actualizados: 0 };

  const { rowCount } = await pool.query(
    `
    with pares as (
      select unnest($1::int[]) as nv, unnest($2::text[]) as nv_tipo
    )
    update public.preproduccion_valores pv
    set data = coalesce(pv.data, '{}'::jsonb) || jsonb_build_object('fecha_salida_imput', $3::text)
               || ${sqlInstalacionSigueSalida('pv.data', '$3::text')},
        updated_at = now()
    from pares p
    where pv.nv = p.nv and pv.nv_tipo = p.nv_tipo;
    `,
    [nvs, nvTipos, fechaISO]
  );
  return { actualizados: rowCount };
}

module.exports = { listPortonesSinFechaSalida, asignarFechaSalida };
