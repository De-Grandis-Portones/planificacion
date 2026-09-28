// lib/presupuestadorMediaDb.js
//
// Fotos/videos que el vendedor adjuntó al tomar la MEDICIÓN en el
// Presupuestador (measurement_media, jsonb en presupuestador_quotes) -
// pedido explícito del usuario: la cuadrilla de /despacho_v2 los tiene que
// ver en el detalle del portón. Presupuestador y Planificacion Planta
// comparten la MISMA base de datos (Supabase, mismo proyecto) - se consulta
// esa tabla directo, sin API intermedia.
//
// presupuestador_quotes no tiene columna `nv` - el número vive adentro de
// final_sale_order_name/odoo_sale_order_name con distintos prefijos de
// letras (NV/NP/INP/INV/ONV/PLNP/PLNV/PNP...). Mismo patrón de match que ya
// usa routes/public/portones.js.
//
// Cada elemento de measurement_media es
// { name, type, size, data_url, uploaded_at, uploaded_by_user_id, uploaded_by_username }
// - el archivo entero vive en base64 adentro de data_url (sin Storage/URL
// firmada de por medio, hasta 30MB por video). No hay id estable por ítem
// (el array se pisa entero en cada guardado) - se usa la posición (index)
// como identificador dentro de esa consulta puntual.
const { pool } = require('../db');

async function getQuoteIdMedicionPorNv(nv) {
  const { rows } = await pool.query(
    `select q.id
       from public.presupuestador_quotes q
      where q.quote_kind = 'original'
        and (
          q.final_sale_order_name ~ ('^[A-Za-z]*' || $1::text || '$')
          or q.odoo_sale_order_name ~ ('^[A-Za-z]*' || $1::text || '$')
        )
      order by q.id desc
      limit 1;`,
    [String(Number(nv))]
  );
  return rows[0]?.id || null;
}

// Lista liviana (sin data_url - puede pesar decenas de MB) para mostrar el
// listado en el detalle del portón. El archivo en sí se pide aparte, al
// tocarlo (ver getMedicionMediaItem).
async function listMedicionMedia(nv) {
  const quoteId = await getQuoteIdMedicionPorNv(nv);
  if (!quoteId) return [];
  const { rows } = await pool.query(
    `select (t.idx - 1) as index,
            t.elem->>'name' as nombre_archivo,
            t.elem->>'type' as tipo_mime,
            (t.elem->>'size')::bigint as tamano_bytes,
            t.elem->>'uploaded_at' as subido_en,
            t.elem->>'uploaded_by_username' as subido_por
       from public.presupuestador_quotes q
       cross join lateral jsonb_array_elements(coalesce(q.measurement_media, '[]'::jsonb)) with ordinality as t(elem, idx)
      where q.id = $1
      order by t.idx asc;`,
    [quoteId]
  );
  return rows;
}

// El archivo puntual (data_url base64) - se pide solo al tocar un ítem de
// la lista, no en el listado general. Postgres arma el data_url tal cual lo
// guardó el Presupuestador, no hace falta decodificar nada acá.
async function getMedicionMediaItem(nv, index) {
  const quoteId = await getQuoteIdMedicionPorNv(nv);
  if (!quoteId) return null;
  const { rows } = await pool.query(
    `select t.elem->>'name' as nombre_archivo,
            t.elem->>'type' as tipo_mime,
            t.elem->>'data_url' as data_url
       from public.presupuestador_quotes q
       cross join lateral jsonb_array_elements(coalesce(q.measurement_media, '[]'::jsonb)) with ordinality as t(elem, idx)
      where q.id = $1 and t.idx = $2::int;`,
    [quoteId, Number(index) + 1]
  );
  return rows[0] || null;
}

module.exports = { listMedicionMedia, getMedicionMediaItem };
