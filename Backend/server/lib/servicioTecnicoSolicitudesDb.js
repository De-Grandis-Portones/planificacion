// lib/servicioTecnicoSolicitudesDb.js
//
// Solicitudes de Servicio Técnico (Fase 0 del módulo de Técnica): el paso
// ANTES de generar una orden de producción (public.st_ordenes, ver
// routes/admin/servicioTecnico.js) - acá Diego carga el pedido, con o sin
// NV/NP vinculado, arma historial (admin/técnico) y organiza los viajes.
const { pool } = require('../db');

// Adjuntos en el historial: mismo formato/límites que ya usa el Presupuestador
// para los tickets (cotizador-back/src/technicalConsultsDb.js) - base64 en
// data_url, sin storage externo. Un adjunto por entrada de historial.
const ALLOWED_ATTACHMENT_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime', 'video/webm']);
const VIDEO_ATTACHMENT_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_ATTACHMENT_BYTES = 5 * 1024 * 1024;

function normalizeAttachment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const dataUrl = String(raw.data_url || '').trim();
  if (!dataUrl) return null;
  if (!dataUrl.startsWith('data:')) throw new Error('Adjunto inválido');
  const type = String(raw.type || '').trim().toLowerCase();
  if (!ALLOWED_ATTACHMENT_TYPES.has(type)) throw new Error('El adjunto debe ser una imagen, un PDF o un video');
  const size = Number(raw.size || 0) || 0;
  const maxBytes = VIDEO_ATTACHMENT_TYPES.has(type) ? MAX_VIDEO_ATTACHMENT_BYTES : MAX_ATTACHMENT_BYTES;
  if (size > maxBytes) throw new Error(`El archivo excede el tamaño permitido (máximo ${Math.round(maxBytes / (1024 * 1024))}MB)`);
  return {
    name: String(raw.name || '').trim().slice(0, 200) || 'archivo',
    type,
    size,
    data_url: dataUrl,
    uploaded_at: raw.uploaded_at || new Date().toISOString(),
  };
}

// ===========================================================================
// Info de un NV/NP (para autocompletar al cargar una solicitud, y para
// mostrar como referencia en el detalle - no se duplica todo en la
// solicitud, solo los campos identificatorios que snapshoteamos al vincular).
// Mismo patrón prefijo-agnóstico (^[A-Za-z]* + número) que ya usan
// logisticaMapa.js, routes/external/ia.js y routes/public/portones.js.
// ===========================================================================
async function resolverInfoNv(nv) {
  const nNv = Number(nv);
  if (!Number.isInteger(nNv)) return null;

  const { rows } = await pool.query(
    `
    with base as (
      select p.*, pv.data as pv_data
      from public.portones p
      left join public.preproduccion_valores pv on pv.nv = p.nv and pv.nv_tipo = 'NV'
      where p.nv = $1
      order by p.nlista asc
      limit 1
    )
    select
      b.nv,
      b.sistema,
      to_char(b.fecha_nv,   'YYYY-MM-DD') as fecha_venta,
      to_char(b.fecha_med,  'YYYY-MM-DD') as fecha_medicion,
      to_char(b.fecha_prod, 'YYYY-MM-DD') as fecha_produccion,
      b.despacho as despacho_estado,
      coalesce(b.pv_data->>'Nombre', b.pv_data->>'nombre', sq.cliente_nombre) as nombre_cliente,
      coalesce(b.pv_data->>'RazSoc', b.pv_data->>'Distribuidor', b.pv_data->>'distribuidor') as distribuidor,
      coalesce(b.pv_data->>'Alto', '') as alto,
      coalesce(b.pv_data->>'Ancho', '') as ancho,
      coalesce(sq.maps_url, b.pv_data->>'logistica_maps_url') as maps_url,
      coalesce(sq.telefono, b.pv_data->>'Celular', b.pv_data->>'celular') as telefono,
      sq.direccion
    from base b
    left join lateral (
      select
        q.end_customer->>'name'     as cliente_nombre,
        q.end_customer->>'maps_url' as maps_url,
        q.end_customer->>'phone'    as telefono,
        nullif(trim(both ' - ' from concat_ws(' - ', q.end_customer->>'address', q.end_customer->>'city')), '') as direccion
      from public.presupuestador_quotes q
      where q.quote_kind = 'original'
        and (q.final_sale_order_name  ~ ('^[A-Za-z]*' || b.nv::text || '$')
             or q.odoo_sale_order_name ~ ('^[A-Za-z]*' || b.nv::text || '$'))
      order by q.id desc
      limit 1
    ) sq on true;
    `,
    [nNv]
  );

  return rows[0] || null;
}

// Historial (admin + técnico) de TODAS las solicitudes previas de este NV -
// "a modo de consulta" al cargar una solicitud nueva, para que Diego vea de
// entrada si ya hubo pedidos anteriores sobre el mismo portón antes de
// cargar uno nuevo a ciegas. Un NV puede tener varias solicitudes a lo largo
// del tiempo (una por cada pedido), así que se listan las solicitudes previas
// Y el historial de todas juntas, ordenado por fecha.
async function listHistorialPorNv(nv) {
  const nNv = Number(nv);
  if (!Number.isInteger(nNv)) return { solicitudesPrevias: [], historial: [] };

  const [solicitudesQ, historialQ] = await Promise.all([
    pool.query(
      `select id, descripcion, estado, to_char(created_at, 'YYYY-MM-DD') as fecha
       from public.servicio_tecnico_solicitudes where nv = $1 order by created_at desc;`,
      [nNv]
    ),
    pool.query(
      `select h.id, h.tipo, h.autor, h.texto, h.attachment, h.created_at,
         h.solicitud_id, s.descripcion as solicitud_descripcion
       from public.servicio_tecnico_historial h
       join public.servicio_tecnico_solicitudes s on s.id = h.solicitud_id
       where s.nv = $1
       order by h.created_at asc;`,
      [nNv]
    ),
  ]);

  return { solicitudesPrevias: solicitudesQ.rows, historial: historialQ.rows };
}

// Para despacho-v2: ¿este NV tiene una solicitud de ST todavía sin resolver?
// (cualquier estado menos 'resuelto'/'cancelado'). Se usa para mostrar en la
// ficha que la instalación quedó cerrada "con un problema reportado" en vez
// de simplemente desaparecer - ver MarcarEntregadoSection en DespachoV2Page.
async function getSolicitudAbiertaPorNv(nv) {
  const nNv = Number(nv);
  if (!Number.isInteger(nNv)) return null;
  const { rows } = await pool.query(
    `select id, descripcion, estado, created_at
     from public.servicio_tecnico_solicitudes
     where nv = $1 and estado not in ('resuelto', 'cancelado')
     order by created_at desc
     limit 1;`,
    [nNv]
  );
  return rows[0] || null;
}

// ===========================================================================
// CRUD de solicitudes
// ===========================================================================

const SOLICITUD_COLS = `
  id, nv, nombre_cliente, distribuidor, direccion, maps_url, telefono,
  to_char(fecha_venta, 'YYYY-MM-DD') as fecha_venta,
  to_char(fecha_programada, 'YYYY-MM-DD') as fecha_programada,
  descripcion, estado, creado_por, created_at, updated_at
`;

async function listSolicitudes({ estado } = {}) {
  const params = [];
  let where = '';
  if (estado) { params.push(estado); where = `where estado = $${params.length}`; }
  const { rows } = await pool.query(
    `select ${SOLICITUD_COLS} from public.servicio_tecnico_solicitudes ${where} order by created_at desc;`,
    params
  );
  return rows;
}

async function getSolicitud(id) {
  const { rows } = await pool.query(
    `select ${SOLICITUD_COLS} from public.servicio_tecnico_solicitudes where id = $1;`,
    [Number(id)]
  );
  if (!rows.length) return null;
  const historial = await pool.query(
    `select id, tipo, autor, texto, attachment, created_at from public.servicio_tecnico_historial where solicitud_id = $1 order by created_at asc;`,
    [Number(id)]
  );
  return { ...rows[0], historial: historial.rows };
}

async function createSolicitud({ nv, nombre_cliente, distribuidor, direccion, maps_url, telefono, descripcion, creado_por }) {
  const descripcionStr = String(descripcion || '').trim();
  if (!descripcionStr) throw new Error('Falta la descripción');

  let nvNum = null;
  let datosNv = null;
  if (nv !== undefined && nv !== null && String(nv).trim() !== '') {
    nvNum = Number(nv);
    if (!Number.isInteger(nvNum)) throw new Error('nv inválido');
    datosNv = await resolverInfoNv(nvNum);
  }

  const { rows } = await pool.query(
    `insert into public.servicio_tecnico_solicitudes
       (nv, nombre_cliente, distribuidor, direccion, maps_url, telefono, fecha_venta, descripcion, estado, creado_por)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'pendiente', $9)
     returning ${SOLICITUD_COLS};`,
    [
      nvNum,
      nombre_cliente || datosNv?.nombre_cliente || null,
      distribuidor || datosNv?.distribuidor || null,
      direccion || datosNv?.direccion || null,
      maps_url || datosNv?.maps_url || null,
      telefono || datosNv?.telefono || null,
      datosNv?.fecha_venta || null,
      descripcionStr,
      creado_por || null,
    ]
  );
  return rows[0];
}

async function updateSolicitud(id, patch) {
  const fields = ['nombre_cliente', 'distribuidor', 'direccion', 'maps_url', 'telefono', 'descripcion', 'estado', 'fecha_programada'];
  const sets = [];
  const params = [Number(id)];
  for (const f of fields) {
    if (patch[f] === undefined) continue;
    params.push(patch[f]);
    sets.push(`${f} = $${params.length}`);
  }
  if (!sets.length) throw new Error('Nada para actualizar');
  sets.push('updated_at = now()');
  const { rows, rowCount } = await pool.query(
    `update public.servicio_tecnico_solicitudes set ${sets.join(', ')} where id = $1 returning ${SOLICITUD_COLS};`,
    params
  );
  if (!rowCount) throw new Error('Solicitud no encontrada');
  return rows[0];
}

async function deleteSolicitud(id) {
  await pool.query(`delete from public.servicio_tecnico_solicitudes where id = $1;`, [Number(id)]);
}

async function agregarHistorial(solicitudId, { tipo, autor, texto, attachment }) {
  const tipoStr = String(tipo || '').trim();
  if (!['admin', 'tecnico'].includes(tipoStr)) throw new Error("tipo debe ser 'admin' o 'tecnico'");
  const textoStr = String(texto || '').trim();
  if (!textoStr) throw new Error('Falta el texto');
  const cleanAttachment = normalizeAttachment(attachment);
  const { rows } = await pool.query(
    `insert into public.servicio_tecnico_historial (solicitud_id, tipo, autor, texto, attachment)
     values ($1, $2, $3, $4, $5)
     returning id, tipo, autor, texto, attachment, created_at;`,
    [Number(solicitudId), tipoStr, autor || null, textoStr, cleanAttachment ? JSON.stringify(cleanAttachment) : null]
  );
  return rows[0];
}

module.exports = {
  resolverInfoNv, listHistorialPorNv, getSolicitudAbiertaPorNv,
  listSolicitudes, getSolicitud, createSolicitud, updateSolicitud, deleteSolicitud,
  agregarHistorial,
};
