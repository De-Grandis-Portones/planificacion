const express = require('express');
const { pool } = require('../../db');
const { apiKeyAuth } = require('../../middleware/apiKeyAuth');

const router = express.Router();

router.use(apiKeyAuth);

// Extrae el número entero de strings como "NV3001", "INV3001", "NP3001", "3001", etc.
function extractNvNumber(raw) {
  const s = String(raw || '').trim().replace(/^[A-Za-z]+/, '');
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// SQL base reutilizado en ambas rutas.
// Devuelve la info mapeada al formato del CSV para la IA.
// Sólo retorna portones donde preprod_data->>'permitir_consulta_ia' sea truthy.
const BASE_SQL = `
  SELECT
    p.id                                                                   AS id_porton,
    p.nv,
    p.nlista,
    p.partida,

    -- Nombre del cliente: buscamos en preprod_data y en presupuestador_quotes
    COALESCE(
      pv.data->>'Nombre',
      pv.data->>'nombre',
      pv.data->>'nombre_cliente',
      pv.data->>'NombreCliente',
      sq.cliente_nombre
    )                                                                      AS nombre_cliente,

    -- 'Distribuidor'/'distribuidor' nunca existen como claves reales en los
    -- datos de preproducción (verificado: 0 de 1596) - el campo real es
    -- 'distribuidor_nombre'.
    COALESCE(pv.data->>'distribuidor_nombre', pv.data->>'Distribuidor', pv.data->>'distribuidor') AS distribuidor,

    -- Etapa actual: la más avanzada en el workflow con cualquier estado
    cur.etapa                                                              AS etapa_actual_repo,
    cur.estado                                                             AS estado_etapa_actual,
    CASE
      WHEN cur.etapa = 'diseno'   THEN 'Diseño'
      WHEN cur.etapa = 'despacho' THEN 'Listo para despacho'
      WHEN cur.etapa IS NOT NULL  THEN 'Producción'
      ELSE NULL
    END                                                                    AS etapa_ia,

    -- Fechas (ISO YYYY-MM-DD)
    to_char(p.fecha_nv,            'YYYY-MM-DD')  AS fecha_venta_nv,

    -- Medición: NO se usa p.fecha_med (portones.fecha_med) - probado contra datos
    -- reales, esa columna queda en null en filas de Planta que todavía no
    -- sincronizaron el dato aunque la medición ya esté hecha (mismo problema
    -- documentado en Presupuestador/cotizador-back/src/routes/partner.routes.js,
    -- fetchMeasurementDate, caso real NV 4270). La fuente confiable es
    -- presupuestador_quotes (med.*, ver lateral join abajo).
    COALESCE(med.fecha_realizada, med.fecha_programada)                       AS fecha_medicion,
    CASE
      WHEN med.requires_measurement IS NOT TRUE THEN NULL
      WHEN med.fecha_realizada  IS NOT NULL      THEN 'realizada'
      WHEN med.fecha_programada IS NOT NULL      THEN 'programada'
      ELSE 'pendiente'
    END                                                                      AS estado_medicion,

    to_char(p.fecha_prod,          'YYYY-MM-DD')  AS fecha_produccion,
    to_char(p.fecha_plan,          'YYYY-MM-DD')  AS fecha_despacho_plan,
    -- portones.fecha_plan_entrega no lo carga ningún flujo (siempre NULL,
    -- verificado: 0 de 470) - la fecha estimada real es fecha_plan (Fecha
    -- Salida/Plan), que sí se completa cuando el portón se envía a producción.
    to_char(p.fecha_plan,          'YYYY-MM-DD')  AS fecha_plan_entrega,

    -- Datos del portón
    p.sistema,
    COALESCE(
      pv.data->>'Tipo',
      pv.data->>'tipo',
      pv.data->>'TipoPorton',
      p.tipo
    )                                                                      AS tipo_porton,
    -- 'Color'/'color' cubren la mayoría (formularios nuevos), pero los
    -- formularios viejos guardan el color por partes (Color_Sistema =
    -- estructura, Color_Hoja = hoja) o dentro de las secciones dinámicas.
    COALESCE(
      pv.data->>'Color',
      pv.data->>'color',
      pv.data->>'Color_Sistema',
      pv.data->>'Color_Hoja',
      pv.data->>'section__color_de_estructura_marco',
      pv.data->>'section__color_del_sistema_estructura'
    )                                                                      AS color,
    COALESCE(pv.data->>'Ancho',          pv.data->>'ancho_mm')            AS ancho_mm,
    COALESCE(pv.data->>'Alto',           pv.data->>'alto_mm')             AS alto_mm,
    -- 'Revestimiento'/'revestimiento' sólo cubren ~37% de los NV; el resto
    -- lo guarda en las secciones dinámicas del formulario de medición.
    COALESCE(
      pv.data->>'Revestimiento',
      pv.data->>'revestimiento',
      pv.data->>'section__tipo_de_revestimiento',
      pv.data->>'section__tipo_de_revestimiento_a_colocar',
      pv.data->>'section__tipo_de_revestimiento_exterior',
      pv.data->>'section__tipo_de_revestimiento_interno'
    )                                                                      AS revestimiento,
    -- 'Vendedor'/'vendedor'/'NombreVendedor'/'nombre_vendedor' nunca existen
    -- como claves reales (verificado: 0 de 1596) - los campos reales son
    -- 'vendido_por_nombre' (quien cargó la venta, cubre distribuidores y
    -- vendedores directos) y, más raro, 'vendedor_nombre'.
    COALESCE(
      pv.data->>'vendido_por_nombre',
      pv.data->>'vendedor_nombre',
      pv.data->>'Vendedor',
      pv.data->>'vendedor',
      pv.data->>'NombreVendedor',
      pv.data->>'nombre_vendedor',
      pv.data->>'vendido_por_username'
    )                                                                      AS nombre_vendedor,

    -- Semanas estimadas en formato ISO (YYYY-Www)
    to_char(p.fecha_plan,         'IYYY-"W"IW')  AS semana_entrega_estimada,
    to_char(p.fecha_prod,         'IYYY-"W"IW')  AS semana_produccion_estimada,

    -- Contacto y ubicación
    COALESCE(
      pv.data->>'pq_maps_url',
      pv.data->>'maps_url',
      pv.data->>'MapsUrl'
    )                                                                      AS ubicacion_maps_url,
    COALESCE(
      pv.data->>'pq_phone',
      pv.data->>'phone',
      pv.data->>'Celular',
      pv.data->>'celular',
      pv.data->>'ContactoCliente'
    )                                                                      AS contacto_cliente_cel,

    pv.updated_at                                                          AS preprod_updated_at

  FROM public.portones p

  -- Datos de preproducción (JSON flexible por NV)
  LEFT JOIN public.preproduccion_valores pv
    ON pv.nv = p.nv AND pv.nv_tipo = 'NV'

  -- Nombre del cliente desde presupuestador (fallback). El prefijo de letras
  -- no siempre es "NV" (también NP/INP/INV/ONV/PLNP/PLNV/PNP según el tipo de
  -- orden en Odoo), pero el número siempre coincide con el NV del portón.
  LEFT JOIN LATERAL (
    SELECT q.end_customer->>'name' AS cliente_nombre
    FROM public.presupuestador_quotes q
    WHERE q.quote_kind = 'original'
      AND (
        q.final_sale_order_name  ~ ('^[A-Za-z]*' || p.nv::text || '$')
        OR q.odoo_sale_order_name ~ ('^[A-Za-z]*' || p.nv::text || '$')
      )
    ORDER BY q.id DESC
    LIMIT 1
  ) sq ON TRUE

  -- Medición confiable (ver comentario arriba, en fecha_medicion/estado_medicion).
  LEFT JOIN LATERAL (
    SELECT
      q2.requires_measurement,
      to_char(q2.measurement_at,             'YYYY-MM-DD') AS fecha_realizada,
      to_char(q2.measurement_scheduled_for,   'YYYY-MM-DD') AS fecha_programada
    FROM public.presupuestador_quotes q2
    WHERE q2.quote_kind = 'original'
      AND (
        q2.final_sale_order_name  ~ ('^[A-Za-z]*' || p.nv::text || '$')
        OR q2.odoo_sale_order_name ~ ('^[A-Za-z]*' || p.nv::text || '$')
      )
    ORDER BY q2.id DESC
    LIMIT 1
  ) med ON TRUE

  -- Etapa más avanzada alcanzada en el workflow
  LEFT JOIN LATERAL (
    SELECT e.etapa::text, e.estado::text
    FROM public.porton_etapas_estado e
    WHERE e.porton_id = p.id
    ORDER BY
      CASE e.etapa::text
        WHEN 'despacho'              THEN 16
        WHEN 'armado_final'          THEN 15
        WHEN 'armado_marco_piernas'  THEN 14
        WHEN 'armado_hojas'          THEN 13
        WHEN 'pintura_revestimiento' THEN 12
        WHEN 'pintura'               THEN 11
        WHEN 'revestimiento'         THEN 10
        WHEN 'plegado_revest'        THEN 9
        WHEN 'corte_revest'          THEN 8
        WHEN 'inyeccion'             THEN 7
        WHEN 'armado_primario'       THEN 6
        WHEN 'armado_piernas'        THEN 5
        WHEN 'plegadora'             THEN 4
        WHEN 'guillotina'            THEN 3
        WHEN 'laser'                 THEN 2
        WHEN 'laser_dintel'          THEN 2
        WHEN 'laser_hojas'           THEN 2
        WHEN 'laser_brazos_espada'   THEN 2
        WHEN 'diseno'                THEN 1
        ELSE 0
      END DESC
    LIMIT 1
  ) cur ON TRUE

  -- Filtro: todos habilitados EXCEPTO los que tienen permitir_consulta_ia = false/no/0
  WHERE lower(coalesce(pv.data->>'permitir_consulta_ia', '')) NOT IN ('false', '0', 'no')
`;

// Portón/puerta que todavía no llegó a Planta (public.portones): el caso típico
// es un NV ya generado en el Presupuestador pero con la medición final todavía
// sin aprobar por el cliente, así que nunca se envió a producción. Antes de este
// fallback, BASE_SQL devolvía 0 filas acá y la API respondía 404 "no existe",
// indistinguible de un NV que en verdad no existe. Se restringe a catalog_kind
// porton/puerta porque son los únicos tipos que en algún momento llegan a
// public.portones (iPanel/Otros/Plegados viven en otras tablas, fuera del
// alcance de este endpoint).
async function fetchPendingByNv(nv) {
  const { rows } = await pool.query(
    `
    SELECT
      q.catalog_kind,
      q.end_customer->>'name'                                          AS nombre_cliente,
      to_char(q.created_at, 'YYYY-MM-DD')                               AS fecha_venta_nv,
      q.requires_measurement,
      to_char(q.measurement_at,           'YYYY-MM-DD')                 AS fecha_realizada,
      to_char(q.measurement_scheduled_for,'YYYY-MM-DD')                 AS fecha_programada
    FROM public.presupuestador_quotes q
    WHERE q.quote_kind = 'original'
      AND q.catalog_kind IN ('porton', 'puerta')
      AND (
        q.final_sale_order_name  ~ ('^[A-Za-z]*' || $1::text || '$')
        OR q.odoo_sale_order_name ~ ('^[A-Za-z]*' || $1::text || '$')
      )
    ORDER BY q.id DESC
    LIMIT 1
    `,
    [nv]
  );

  const row = rows[0];
  if (!row) return null;

  const estado_medicion = row.requires_measurement !== true
    ? null
    : row.fecha_realizada ? 'realizada' : row.fecha_programada ? 'programada' : 'pendiente';

  return {
    id_porton: null,
    nv,
    nlista: null,
    partida: null,
    nombre_cliente: row.nombre_cliente,
    distribuidor: null,
    etapa_actual_repo: null,
    estado_etapa_actual: null,
    etapa_ia: 'Pendiente de medición/producción',
    fecha_venta_nv: row.fecha_venta_nv,
    fecha_medicion: row.fecha_realizada || row.fecha_programada || null,
    estado_medicion,
    fecha_produccion: null,
    fecha_despacho_plan: null,
    fecha_plan_entrega: null,
    sistema: null,
    tipo_porton: row.catalog_kind,
    color: null,
    ancho_mm: null,
    alto_mm: null,
    revestimiento: null,
    nombre_vendedor: null,
    semana_entrega_estimada: null,
    semana_produccion_estimada: null,
    ubicacion_maps_url: null,
    contacto_cliente_cel: null,
    preprod_updated_at: null,
    en_planta: false,
  };
}

// ---------------------------------------------------------------------------
// GET /api/ia/portones/buscar?q=<texto>
//
// Búsqueda amplia. Acepta:
//   - Número NV con o sin prefijo (NV3001, INV3001, NP3001, 3001, ...)
//   - Nombre del cliente (parcial, case-insensitive)
//   - Nombre del distribuidor (parcial, case-insensitive)
//
// Devuelve hasta 50 resultados.
// ---------------------------------------------------------------------------
router.get('/api/ia/portones/buscar', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) {
    return res.status(400).json({ error: 'Falta el parámetro q (texto de búsqueda)' });
  }

  try {
    const params = [];
    const conditions = [];

    // Si el texto parece un número (con o sin prefijo de letras), buscar por NV exacto
    const nNum = extractNvNumber(q);
    if (nNum) {
      params.push(nNum);
      conditions.push(`p.nv = $${params.length}`);
    }

    // Búsqueda textual en nombre cliente y distribuidor
    params.push(`%${q}%`);
    const pi = params.length;
    conditions.push(`(
      coalesce(pv.data->>'Nombre',       '') ilike $${pi}
      OR coalesce(pv.data->>'nombre',       '') ilike $${pi}
      OR coalesce(pv.data->>'nombre_cliente','') ilike $${pi}
      OR coalesce(pv.data->>'NombreCliente', '') ilike $${pi}
      OR coalesce(pv.data->>'distribuidor_nombre', '') ilike $${pi}
      OR coalesce(pv.data->>'Distribuidor',  '') ilike $${pi}
      OR coalesce(pv.data->>'distribuidor',  '') ilike $${pi}
      OR coalesce(sq.cliente_nombre,         '') ilike $${pi}
    )`);

    const { rows } = await pool.query(
      `${BASE_SQL} AND (${conditions.join(' OR ')})
       ORDER BY p.nv ASC, p.nlista ASC
       LIMIT 50`,
      params
    );

    const data = rows.map((r) => ({ ...r, en_planta: true }));

    // Si el texto era un NV puntual y no apareció en Planta, puede ser un NV
    // real pendiente de medición/producción (ver fetchPendingByNv) en vez de
    // inexistente.
    if (!data.length && nNum) {
      const pending = await fetchPendingByNv(nNum);
      if (pending) data.push(pending);
    }

    return res.json({
      found: data.length > 0,
      total: data.length,
      data,
    });
  } catch (err) {
    console.error('ia/buscar error:', err);
    return res.status(500).json({ error: 'Error en búsqueda', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/ia/portones/por-nv/:numero
//
// Detalle completo por número de NV.
// Acepta cualquier prefijo: NV3001, NP3001, INV3001, INP3001, ONP3001, 3001, etc.
// Devuelve todos los portones (nlistas) de ese NV.
// ---------------------------------------------------------------------------
router.get('/api/ia/portones/por-nv/:numero', async (req, res) => {
  const nNum = extractNvNumber(req.params.numero);
  if (!nNum) {
    return res.status(400).json({ error: 'Número de NV inválido. Use el número solo o con prefijo (NV3001, INV3001, etc.)' });
  }

  try {
    const { rows } = await pool.query(
      `${BASE_SQL} AND p.nv = $1
       ORDER BY p.nlista ASC`,
      [nNum]
    );

    if (rows.length) {
      return res.json({
        found: true,
        nv: nNum,
        total: rows.length,
        data: rows.map((r) => ({ ...r, en_planta: true })),
      });
    }

    // Todavía no llegó a Planta: puede ser un NV real pendiente de medición o
    // de envío a producción (ver fetchPendingByNv), no necesariamente inexistente.
    const pending = await fetchPendingByNv(nNum);
    if (pending) {
      return res.json({ found: true, nv: nNum, total: 1, data: [pending] });
    }

    return res.status(404).json({
      found: false,
      nv: nNum,
      error: `No se encontró ningún portón con NV ${nNum}, o no tiene habilitada la consulta IA`,
    });
  } catch (err) {
    console.error('ia/por-nv error:', err);
    return res.status(500).json({ error: 'Error consultando portón', detail: err.message });
  }
});

module.exports = router;
