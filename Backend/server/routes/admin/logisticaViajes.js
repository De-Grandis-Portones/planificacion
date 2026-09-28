// routes/admin/logisticaViajes.js
//
// Logística de Viajes: pantalla nueva (linkeada desde /a) para armar viajes
// (fecha + zona + cuadrilla + vehículo) por semana y repartir en ellos los
// portones con despacho/instalación de esa semana. Ver server/lib/logisticaViajesDb.js
// para el detalle de las queries.
const express = require('express');
const multer = require('multer');
const { adminAuth } = require('../../middleware/adminAuth');
const db = require('../../lib/logisticaViajesDb');
const { resolveCoordsForNvs, getSemanaMapa } = require('../../lib/logisticaMapa');
const { getIaConfig, updateIaConfig } = require('../../lib/logisticaIaConfig');
const { recomendarViaje, planificarRutas } = require('../../lib/logisticaIaRecomendacion');
const { listarPortonesSinViajeConUbicacion } = require('../../lib/logisticaIaContexto');
const { getPromesaConfig, updatePromesaConfig } = require('../../lib/logisticaPromesaConfig');
const { getSemanaPromesaMapa } = require('../../lib/logisticaPromesaMapa');
const { buildMensajeViaje } = require('../../lib/logisticaMensajeViaje');
const { resolveEtapasPorNv, resolveSemanaPrometidaPorNv, resolveSemanaRealPorNv } = require('../../lib/logisticaMapaExtras');
const { listPortonesSinFechaSalida, asignarFechaSalida } = require('../../lib/logisticaSinFechaSalida');
const { sincronizarZonasViaje, listZonasViaje, setZonaHabilitada } = require('../../lib/logisticaRutaZonas');
const { sincronizarRutaReal } = require('../../lib/logisticaRuteo');
const {
  listPuntosExtra, crearPuntoExtra, updatePuntoExtra, deletePuntoExtra,
  listParadasExtraViaje, asignarParadaExtra, desasignarParadaExtra, updateParadaExtraViaje,
} = require('../../lib/logisticaParadasExtra');
const gastosDb = require('../../lib/logisticaGastosDb');
const adjuntosStorage = require('../../lib/logisticaAdjuntosStorage');
const whatsapp = require('../../lib/logisticaWhatsapp');
const despachoV2Db = require('../../lib/despachoV2Db');
const checklistDb = require('../../lib/logisticaChecklistDb');

// Zonas del corredor + ruta real por calle comparten el mismo trigger
// (cualquier cambio de paradas/orden de un viaje) - se disparan juntas.
async function sincronizarRuta(viajeId) {
  await Promise.all([sincronizarZonasViaje(viajeId), sincronizarRutaReal(viajeId)]);
}

// Zonas que cada viaje de la semana atraviesa (no solo la parada, todo el
// corredor - ver logisticaRutaZonas.js) + paradas que no son un portón (ej.
// alojamiento - logisticaParadasExtra.js). Se agrega acá, a nivel ruta, para
// no crear otro ciclo de require entre logisticaViajesDb.js/logisticaMapa.js
// (logisticaRutaZonas.js depende de logisticaMapa.js, que depende de
// logisticaViajesDb.js).
async function conDetallesViajes(detalle) {
  if (!detalle?.viajes?.length) return detalle;
  const viajes = await Promise.all(detalle.viajes.map(async (v) => ({
    ...v,
    zonas: await listZonasViaje(v.id),
    paradas_extra: await listParadasExtraViaje(v.id),
  })));
  return { ...detalle, viajes };
}

// Le suma a cada item {nv,...} su barrita de etapas de producción (diseño/
// pintura/armado final) - común a los 3 mapas (sin filtro, semana real,
// semana prometida).
async function conEtapas(items) {
  const etapasPorNv = await resolveEtapasPorNv(items.map((it) => it.nv));
  return items.map((it) => ({ ...it, etapas: etapasPorNv.get(it.nv) || null }));
}

const router = express.Router();

const PREPROD_SCOPES = ['preproduccion:full', 'preproduccion:admin', 'preproduccion:comercial_view'];

function normalizeScopes(scopesRaw) {
  if (Array.isArray(scopesRaw)) return scopesRaw.map((s) => String(s || '').trim()).filter(Boolean);
  if (typeof scopesRaw === 'string') return scopesRaw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  return [];
}

function scopesOf(req) {
  return normalizeScopes(req?.admin?.scopes ?? req?.admin?.scope ?? req?.admin?.permissions ?? []);
}

// Lectura: cualquiera de los 3 scopes de Preproducción (igual que /a y que
// logistica-consultas). Escritura (crear/editar viajes, asignar portones,
// cerrar/reabrir semana, tocar config): solo preproduccion:full, el mismo
// scope que hoy es el único habilitado para tocar fecha_salida/fecha_llegada
// en /a.
function requirePreproduccionAccess(req, res, next) {
  if (!PREPROD_SCOPES.some((s) => scopesOf(req).includes(s))) {
    return res.status(403).json({ error: 'Requiere permisos de Preproducción' });
  }
  return next();
}

function requireFullAccess(req, res, next) {
  if (!scopesOf(req).includes('preproduccion:full')) {
    return res.status(403).json({ error: 'Requiere permisos completos de Preproducción (Logística)' });
  }
  return next();
}

router.use('/logistica', adminAuth, requirePreproduccionAccess);

function asyncRoute(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error('logistica-viajes error:', err);
      const status = err.status || 400;
      res.status(status).json({ error: err.message || 'Error inesperado' });
    });
  };
}

// ===== Config =====
router.get('/logistica/config', asyncRoute(async (_req, res) => {
  res.json({ ok: true, config: await db.getConfig() });
}));

// ===== Mapa (puntos de portones por NV, para "Ver mapa" por semana/viaje) =====
// Solo lectura: alcanza con cualquiera de los 3 scopes de Preproducción.
router.get('/logistica/mapa', asyncRoute(async (req, res) => {
  const nvs = String(req.query?.nvs || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Number.isInteger)
    .slice(0, 200); // cap defensivo
  res.json({ ok: true, puntos: await resolveCoordsForNvs(nvs) });
}));

// Detalle de una semana + ubicación/zona por item - para el mapa de
// Planificación de Fechas filtrado por semana (a diferencia de
// portones-sin-viaje, acá se ven TAMBIÉN los que ya tienen viaje, con su
// ruta, para poder consultar/ajustar sin perder el contexto geográfico).
router.get('/logistica/semana/:semana/mapa', asyncRoute(async (req, res) => {
  const detalle = await getSemanaMapa(req.params.semana);
  const [items, semanaPrometidaPorNv, detalleConZonas] = await Promise.all([
    conEtapas(detalle.items),
    resolveSemanaPrometidaPorNv(detalle.items.map((it) => it.nv)),
    conDetallesViajes(detalle),
  ]);
  const itemsFinal = items.map((it) => ({ ...it, semana_prometida: semanaPrometidaPorNv.get(it.nv) || null }));
  res.json({ ok: true, detalle: { ...detalleConZonas, items: itemsFinal } });
}));

// ===== Semana prometida (producción reservada por el Presupuestador + margen configurable) =====
router.get('/logistica/promesa-config', asyncRoute(async (_req, res) => {
  res.json({ ok: true, config: await getPromesaConfig() });
}));
router.patch('/logistica/promesa-config', requireFullAccess, asyncRoute(async (req, res) => {
  res.json({ ok: true, config: await updatePromesaConfig(req.body || {}) });
}));
router.get('/logistica/semana/:semana/mapa-promesa', asyncRoute(async (req, res) => {
  const data = await getSemanaPromesaMapa(req.params.semana);
  const [items, semanaRealPorNv] = await Promise.all([
    conEtapas(data.items),
    resolveSemanaRealPorNv(data.items.map((it) => it.nv)),
  ]);
  const itemsFinal = items.map((it) => ({ ...it, semana_real: semanaRealPorNv.get(it.nv) || null }));
  res.json({ ok: true, ...data, items: itemsFinal });
}));

router.post('/logistica/zonas', requireFullAccess, asyncRoute(async (req, res) => {
  res.json({ ok: true, zona: await db.createZona(req.body || {}) });
}));
router.patch('/logistica/zonas/:id', requireFullAccess, asyncRoute(async (req, res) => {
  res.json({ ok: true, zona: await db.updateZona(req.params.id, req.body || {}) });
}));
router.delete('/logistica/zonas/:id', requireFullAccess, asyncRoute(async (req, res) => {
  await db.deleteZona(req.params.id);
  res.json({ ok: true });
}));

router.post('/logistica/vehiculos', requireFullAccess, asyncRoute(async (req, res) => {
  res.json({ ok: true, vehiculo: await db.createVehiculo(req.body || {}) });
}));
router.patch('/logistica/vehiculos/:id', requireFullAccess, asyncRoute(async (req, res) => {
  res.json({ ok: true, vehiculo: await db.updateVehiculo(req.params.id, req.body || {}) });
}));
router.delete('/logistica/vehiculos/:id', requireFullAccess, asyncRoute(async (req, res) => {
  await db.deleteVehiculo(req.params.id);
  res.json({ ok: true });
}));

router.post('/logistica/cuadrillas', requireFullAccess, asyncRoute(async (req, res) => {
  res.json({ ok: true, cuadrilla: await db.createCuadrilla(req.body || {}) });
}));
router.patch('/logistica/cuadrillas/:id', requireFullAccess, asyncRoute(async (req, res) => {
  res.json({ ok: true, cuadrilla: await db.updateCuadrilla(req.params.id, req.body || {}) });
}));
router.delete('/logistica/cuadrillas/:id', requireFullAccess, asyncRoute(async (req, res) => {
  await db.deleteCuadrilla(req.params.id);
  res.json({ ok: true });
}));
router.put('/logistica/cuadrillas/:id/miembros', requireFullAccess, asyncRoute(async (req, res) => {
  res.json({ ok: true, cuadrilla: await db.setCuadrillaMiembros(req.params.id, req.body?.qc_user_ids) });
}));

// ===== CheckList de arranque de viaje (panel de configuración) =====
router.post('/logistica/checklist-items', requireFullAccess, asyncRoute(async (req, res) => {
  res.json({ ok: true, item: await checklistDb.crearChecklistItem(req.body || {}) });
}));
router.patch('/logistica/checklist-items/:id', requireFullAccess, asyncRoute(async (req, res) => {
  res.json({ ok: true, item: await checklistDb.actualizarChecklistItem(req.params.id, req.body || {}) });
}));
router.delete('/logistica/checklist-items/:id', requireFullAccess, asyncRoute(async (req, res) => {
  await checklistDb.borrarChecklistItem(req.params.id);
  res.json({ ok: true });
}));

router.post('/logistica/reglas-capacidad', requireFullAccess, asyncRoute(async (req, res) => {
  res.json({ ok: true, regla: await db.createReglaCapacidad(req.body || {}) });
}));
router.patch('/logistica/reglas-capacidad/:id', requireFullAccess, asyncRoute(async (req, res) => {
  res.json({ ok: true, regla: await db.updateReglaCapacidad(req.params.id, req.body || {}) });
}));
router.delete('/logistica/reglas-capacidad/:id', requireFullAccess, asyncRoute(async (req, res) => {
  await db.deleteReglaCapacidad(req.params.id);
  res.json({ ok: true });
}));

// ===== Motor de logística IA (Fase 1): config editable + recomendación =====
router.get('/logistica/ia/config', asyncRoute(async (_req, res) => {
  res.json({ ok: true, config: await getIaConfig() });
}));
router.patch('/logistica/ia/config', requireFullAccess, asyncRoute(async (req, res) => {
  res.json({ ok: true, config: await updateIaConfig(req.body || {}) });
}));
// Portones con despacho/instalación pendiente (cualquier semana) y sin viaje
// asignado todavía, con ubicación+zona resuelta - para el mapa de selección
// de "Generar viaje con IA" en Planificación de Fechas.
router.get('/logistica/portones-sin-viaje', asyncRoute(async (_req, res) => {
  const pendientes = await listarPortonesSinViajeConUbicacion();
  const [items, semanaPrometidaPorNv] = await Promise.all([
    conEtapas(pendientes),
    resolveSemanaPrometidaPorNv(pendientes.map((it) => it.nv)),
  ]);
  const itemsFinal = items.map((it) => ({ ...it, semana_prometida: semanaPrometidaPorNv.get(it.nv) || null }));
  res.json({ ok: true, items: itemsFinal });
}));

// NV (portones/puertas/iPanel) sin "Fecha Salida" cargada todavía en /a -
// mismo criterio EXACTO que el filtro "Sin fecha" de esa columna ahí (ver
// lib/logisticaSinFechaSalida.js). Vista de solo consulta: sin fecha no hay
// con qué agrupar en un viaje, es para decidir prioridad de carga por
// cercanía geográfica.
router.get('/logistica/sin-fecha-salida', asyncRoute(async (_req, res) => {
  const items = await listPortonesSinFechaSalida();
  res.json({ ok: true, items });
}));

// Carga "Fecha Salida" para un lote de NV elegidos en el mapa - mismo campo
// que /a, pero de a varios a la vez agrupados por cercanía geográfica.
router.patch('/logistica/sin-fecha-salida/asignar', requireFullAccess, asyncRoute(async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const fecha = req.body?.fecha;
  const resultado = await asignarFechaSalida(items, fecha);
  res.json({ ok: true, ...resultado });
}));

router.post('/logistica/ia/recomendar-viaje', requireFullAccess, asyncRoute(async (req, res) => {
  const nvs = Array.isArray(req.body?.nvs)
    ? req.body.nvs.map((n) => Number(n)).filter(Number.isInteger).slice(0, 30)
    : [];
  res.json({ ok: true, ...(await recomendarViaje(nvs)) });
}));

// Planificación proactiva: mira TODOS los portones sin viaje, los agrupa por
// zona, y le pide a la IA que proponga qué viajes armar en cada zona (no
// requiere selección manual previa).
router.post('/logistica/ia/planificar', requireFullAccess, asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await planificarRutas()) });
}));

// ===== Zonificación geográfica (referencias por zona, para clasificar portones por ubicación) =====
router.post('/logistica/zona-referencias', requireFullAccess, asyncRoute(async (req, res) => {
  res.json({ ok: true, referencia: await db.createZonaReferencia(req.body || {}) });
}));
router.delete('/logistica/zona-referencias/:id', requireFullAccess, asyncRoute(async (req, res) => {
  await db.deleteZonaReferencia(req.params.id);
  res.json({ ok: true });
}));

// ===== Reglas de envío (días mínimos antes de poder despachar) =====
router.post('/logistica/reglas-envio', requireFullAccess, asyncRoute(async (req, res) => {
  res.json({ ok: true, regla: await db.createReglaEnvio(req.body || {}) });
}));
router.patch('/logistica/reglas-envio/:id', requireFullAccess, asyncRoute(async (req, res) => {
  res.json({ ok: true, regla: await db.updateReglaEnvio(req.params.id, req.body || {}) });
}));
router.delete('/logistica/reglas-envio/:id', requireFullAccess, asyncRoute(async (req, res) => {
  await db.deleteReglaEnvio(req.params.id);
  res.json({ ok: true });
}));

// ===== Semanas / viajes / asignaciones =====
router.get('/logistica/semanas', asyncRoute(async (_req, res) => {
  res.json({ ok: true, semanas: await db.getSemanas() });
}));

router.get('/logistica/semanas/:semana', asyncRoute(async (req, res) => {
  res.json({ ok: true, detalle: await conDetallesViajes(await db.getSemanaDetalle(req.params.semana)) });
}));

router.post('/logistica/semanas/:semana/viajes', requireFullAccess, asyncRoute(async (req, res) => {
  res.json({ ok: true, detalle: await conDetallesViajes(await db.crearViaje(req.params.semana, req.body || {})) });
}));

router.patch('/logistica/viajes/:id', requireFullAccess, asyncRoute(async (req, res) => {
  res.json({ ok: true, detalle: await conDetallesViajes(await db.patchViaje(req.params.id, req.body || {})) });
}));

router.delete('/logistica/viajes/:id', requireFullAccess, asyncRoute(async (req, res) => {
  res.json({ ok: true, detalle: await conDetallesViajes(await db.borrarViaje(req.params.id)) });
}));

router.post('/logistica/viajes/:id/portones', requireFullAccess, asyncRoute(async (req, res) => {
  const detalle = await db.asignarPorton(req.params.id, req.body || {});
  await sincronizarRuta(req.params.id);
  // OJO: `detalle` es de ANTES de sincronizarRuta - trae ruta_real desactualizado
  // (un paso atrás). Se vuelve a leer fresco después de sincronizar, no se
  // reusa el que ya teníamos (confirmado con datos reales: sin este re-fetch
  // el ruta_real que ve el frontend queda un paso atrás del que hay en la base).
  res.json({ ok: true, detalle: await conDetallesViajes(await db.getSemanaDetalle(detalle.semana)) });
}));

router.delete('/logistica/viajes/:id/portones/:porton_id', requireFullAccess, asyncRoute(async (req, res) => {
  const detalle = await db.desasignarPorton(req.params.id, req.params.porton_id, req.query?.tipo);
  await sincronizarRuta(req.params.id);
  res.json({ ok: true, detalle: await conDetallesViajes(await db.getSemanaDetalle(detalle.semana)) });
}));

// Reordenar los portones DENTRO de un viaje (orden de ruta: primero el que
// queda arriba). Body: { items: [{ porton_id, tipo }, ...] } en el orden final.
router.put('/logistica/viajes/:id/orden', requireFullAccess, asyncRoute(async (req, res) => {
  const detalle = await db.reordenarViaje(req.params.id, req.body?.items);
  // El orden cambia la forma del corredor (los tramos entre paradas
  // consecutivas son otros) - las zonas que atraviesa pueden cambiar aunque
  // las paradas sean las mismas.
  await sincronizarRuta(req.params.id);
  res.json({ ok: true, detalle: await conDetallesViajes(await db.getSemanaDetalle(detalle.semana)) });
}));

// ===== Paradas extra (catálogo reutilizable, ej. "Hotel San Vicente" para
// alojamiento de la cuadrilla) - lectura: cualquiera de los 3 scopes;
// escritura: preproduccion:full, igual que el resto de la config. =====
router.get('/logistica/puntos-extra', asyncRoute(async (_req, res) => {
  res.json({ ok: true, puntos: await listPuntosExtra() });
}));
router.post('/logistica/puntos-extra', requireFullAccess, asyncRoute(async (req, res) => {
  res.json({ ok: true, punto: await crearPuntoExtra(req.body || {}) });
}));
router.patch('/logistica/puntos-extra/:id', requireFullAccess, asyncRoute(async (req, res) => {
  res.json({ ok: true, punto: await updatePuntoExtra(req.params.id, req.body || {}) });
}));
router.delete('/logistica/puntos-extra/:id', requireFullAccess, asyncRoute(async (req, res) => {
  await deletePuntoExtra(req.params.id);
  res.json({ ok: true });
}));

// Plantillas de mensaje de WhatsApp Business ya cargadas en Meta - solo
// lectura, para verlas desde acá en vez de entrar a WhatsApp Manager.
router.get('/logistica/whatsapp-templates', asyncRoute(async (_req, res) => {
  res.json({ ok: true, templates: await whatsapp.listarTemplates() });
}));

// ===== Bandeja de WhatsApp (chat) - lectura para cualquiera de los 3
// scopes, igual que el resto de la config; mandar un mensaje requiere
// preproduccion:full (misma regla que crear/editar viajes). =====
router.get('/logistica/whatsapp/conversaciones', asyncRoute(async (_req, res) => {
  res.json({ ok: true, conversaciones: await whatsapp.listarConversaciones() });
}));
router.get('/logistica/whatsapp/conversaciones/:telefono/mensajes', asyncRoute(async (req, res) => {
  const [mensajes, nombreCliente, estado] = await Promise.all([
    whatsapp.listarMensajes(req.params.telefono),
    whatsapp.nombreClientePorTelefono(req.params.telefono).catch(() => null),
    whatsapp.estadoConversacion(req.params.telefono),
  ]);
  res.json({ ok: true, mensajes, nombreCliente, ...estado });
}));
router.post('/logistica/whatsapp/conversaciones/:telefono/mensajes', requireFullAccess, asyncRoute(async (req, res) => {
  const texto = String(req.body?.texto || '').trim();
  if (!texto) return res.status(400).json({ error: 'Falta el texto del mensaje' });
  const resultado = await whatsapp.enviarTextoLibre({ telefono: req.params.telefono, texto, enviadoPor: req.admin?.username || null });
  if (!resultado.ok) return res.status(400).json({ error: resultado.error, detalle: resultado.detalle });
  res.json({ ok: true, mensaje: resultado.mensaje });
}));
router.patch('/logistica/whatsapp/conversaciones/:telefono/nombre', requireFullAccess, asyncRoute(async (req, res) => {
  const nombre = await whatsapp.setNombreContacto(req.params.telefono, req.body?.nombre, req.admin?.username || null);
  res.json({ ok: true, nombre });
}));
router.post('/logistica/whatsapp/conversaciones/:telefono/template-simple', requireFullAccess, asyncRoute(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const language = String(req.body?.language || '').trim();
  if (!name || !language) return res.status(400).json({ error: 'Falta name/language de la plantilla' });
  const resultado = await whatsapp.enviarTemplateSimple({ telefono: req.params.telefono, templateName: name, language, enviadoPor: req.admin?.username || null });
  if (!resultado.ok) return res.status(400).json({ error: resultado.error, detalle: resultado.detalle });
  res.json({ ok: true, mensaje: resultado.mensaje });
}));

// Imagen/video/audio/documento adjuntado desde el chat - mismos formatos que
// soporta WhatsApp para cada tipo (Meta rechaza lo que no soporte, el error
// se propaga tal cual).
const WA_MIME_TIPO = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image',
  'video/mp4': 'video', 'video/3gpp': 'video',
  'audio/aac': 'audio', 'audio/mp4': 'audio', 'audio/mpeg': 'audio', 'audio/amr': 'audio', 'audio/ogg': 'audio',
  // webm/wav: nunca los acepta la API de WhatsApp directamente, pero son lo
  // que graba el micrófono del navegador (MediaRecorder) - se transcodean a
  // ogg/opus en logisticaWhatsapp.js#enviarMedia antes de mandar.
  'audio/webm': 'audio', 'audio/wav': 'audio', 'audio/x-wav': 'audio',
  'application/pdf': 'document', 'application/msword': 'document', 'text/plain': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'document',
};
// El navegador manda el mimetype del archivo/blob tal cual (ej. audio grabado
// con MediaRecorder llega como "audio/webm;codecs=opus", con el codec pegado)
// - se compara solo por la parte antes del ";".
function tipoBaseDeArchivo(mimetype) {
  return WA_MIME_TIPO[String(mimetype || '').split(';')[0].trim()];
}
const uploadChatMedia = multer({
  storage: multer.memoryStorage(),
  // 50MB: el techo real es el del bucket de Storage (mismo límite del plan
  // de Supabase); WhatsApp además tiene sus propios límites por tipo
  // (16MB imagen/audio/video, 100MB documento) que Meta rechaza en el
  // momento de mandar si se pasa.
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!tipoBaseDeArchivo(file.mimetype)) return cb(new Error(`Tipo de archivo no soportado por WhatsApp: ${file.mimetype}`));
    cb(null, true);
  },
});
router.post('/logistica/whatsapp/conversaciones/:telefono/media', requireFullAccess, uploadChatMedia.single('archivo'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo' });
  const tipo = tipoBaseDeArchivo(req.file.mimetype);
  const resultado = await whatsapp.enviarMedia({
    telefono: req.params.telefono, tipo, buffer: req.file.buffer, mimeType: req.file.mimetype,
    caption: req.body?.caption || null, enviadoPor: req.admin?.username || null,
  });
  if (!resultado.ok) return res.status(400).json({ error: resultado.error, detalle: resultado.detalle });
  res.json({ ok: true, mensaje: resultado.mensaje });
}));

// Asigna/saca una parada extra (del catálogo) a un viaje - se trata como un
// portón más para la ruta: entra en la misma secuencia de `orden`, cuenta
// para la detección de zonas del corredor, y aparece en el mensaje.
router.post('/logistica/viajes/:id/paradas-extra', requireFullAccess, asyncRoute(async (req, res) => {
  await asignarParadaExtra(req.params.id, req.body?.punto_extra_id);
  await sincronizarRuta(req.params.id);
  const semana = await db.getViajeSemana(req.params.id);
  res.json({ ok: true, detalle: await conDetallesViajes(await db.getSemanaDetalle(semana)) });
}));
router.delete('/logistica/viajes/:id/paradas-extra/:punto_extra_id', requireFullAccess, asyncRoute(async (req, res) => {
  await desasignarParadaExtra(req.params.id, req.params.punto_extra_id);
  await sincronizarRuta(req.params.id);
  const semana = await db.getViajeSemana(req.params.id);
  res.json({ ok: true, detalle: await conDetallesViajes(await db.getSemanaDetalle(semana)) });
}));

// Horario propio de una parada extra ya asignada - duracion_minutos (una
// parada normal, ej. "retirar un cobro" = 15 min) y/o hora_salida_siguiente
// (solo paradas de descanso/hospedaje - la ruta retoma desde ese horario al
// día siguiente). No dispara sincronizarRuta: no cambia geometría/zonas,
// solo el horario estimado que calcula el frontend.
router.patch('/logistica/viajes/:id/paradas-extra/:punto_extra_id', requireFullAccess, asyncRoute(async (req, res) => {
  await updateParadaExtraViaje(req.params.id, req.params.punto_extra_id, req.body || {});
  const semana = await db.getViajeSemana(req.params.id);
  res.json({ ok: true, detalle: await conDetallesViajes(await db.getSemanaDetalle(semana)) });
}));

// Habilita/deshabilita una zona detectada para un viaje (queda guardado
// para una integración futura con el Presupuestador - por ahora es solo
// informativo). No requiere semana abierta: es un dato posterior a la
// ruta, tiene sentido seguir tocándolo incluso con el viaje ya en curso.
router.patch('/logistica/viajes/:id/zonas/:zona_id', requireFullAccess, asyncRoute(async (req, res) => {
  await setZonaHabilitada(req.params.id, req.params.zona_id, req.body?.habilitada);
  const semana = await db.getViajeSemana(req.params.id);
  res.json({ ok: true, detalle: await conDetallesViajes(await db.getSemanaDetalle(semana)) });
}));

// Recalcula a mano zonas + ruta real de un viaje - normalmente se dispara
// solo con un cambio de paradas/orden, pero hay casos que no lo disparan
// (ej. redibujar una zona DESPUÉS de crear el viaje, o cargarle recién el
// link de Google Maps a un NV que antes no tenía ubicación resuelta).
router.post('/logistica/viajes/:id/recalcular-ruta', requireFullAccess, asyncRoute(async (req, res) => {
  await sincronizarRuta(req.params.id);
  const semana = await db.getViajeSemana(req.params.id);
  res.json({ ok: true, detalle: await conDetallesViajes(await db.getSemanaDetalle(semana)) });
}));

// Mensaje de texto (borrador) para mandarle a la cuadrilla - solo lectura,
// no modifica nada, alcanza con cualquiera de los 3 scopes de Preproducción.
router.get('/logistica/viajes/:id/mensaje', asyncRoute(async (req, res) => {
  res.json({ ok: true, texto: await buildMensajeViaje(req.params.id) });
}));

// Modo de pruebas: manda el mismo aviso "en camino" (collage de fotos +
// plantilla) que se dispara solo al avisar la próxima parada, pero a un
// teléfono cualquiera que se pase por body en vez del cliente real - pedido
// explícito del usuario para poder ver cómo salen las fotos/collage antes
// de que se dispare en producción.
router.post('/logistica/viajes/:id/probar-aviso-whatsapp', requireFullAccess, asyncRoute(async (req, res) => {
  const telefono = String(req.body?.telefono || '').trim();
  if (!telefono) return res.status(400).json({ error: 'Falta el teléfono de prueba' });
  const datos = await despachoV2Db.datosParaAviso(req.params.id);
  if (!datos) return res.status(404).json({ error: 'Viaje no encontrado' });
  const resultado = await whatsapp.enviarAvisoEnCamino({
    telefono,
    nombreCliente: String(req.body?.nombreCliente || 'Cliente de prueba').trim(),
    horasTexto: String(req.body?.horasTexto || 'poco tiempo').trim(),
    cuadrillaTexto: datos.cuadrillaTexto,
    vehiculoNombre: datos.vehiculoNombre,
    fotosMiembros: datos.fotosMiembros,
    fotoVehiculo: datos.fotoVehiculo,
  });
  if (!resultado.ok) return res.status(400).json({ error: resultado.error, detalle: resultado.detalle });
  res.json({ ok: true, wa_message_id: resultado.wa_message_id });
}));

router.post('/logistica/semanas/:semana/cerrar', requireFullAccess, asyncRoute(async (req, res) => {
  const cerradaBy = req?.admin?.username || req?.admin?.name || null;
  res.json({ ok: true, detalle: await db.cerrarSemana(req.params.semana, cerradaBy) });
}));

router.post('/logistica/semanas/:semana/reabrir', requireFullAccess, asyncRoute(async (req, res) => {
  res.json({ ok: true, detalle: await db.reabrirSemana(req.params.semana) });
}));

// ===========================================================================
// Rendiciones de gastos (consulta) - pedido explícito del usuario: una fila
// por viaje con gastos cargados (ver GastosSheet en DespachoV2Page.jsx),
// entrar a cada una para ver el detalle con sus tickets adjuntos y el
// total. Solo lectura, alcanza con cualquiera de los 3 scopes de
// Preproducción. La auditoría ("ya fue controlada") queda para una vuelta
// futura, pedido explícito del usuario.
router.get('/logistica/rendiciones', asyncRoute(async (_req, res) => {
  res.json({ ok: true, rendiciones: await gastosDb.listRendiciones() });
}));

router.get('/logistica/rendiciones/:viajeId', asyncRoute(async (req, res) => {
  const detalle = await gastosDb.getRendicionDetalle(req.params.viajeId);
  if (!detalle) return res.status(404).json({ error: 'Viaje no encontrado' });
  const gastosConUrl = await Promise.all(
    detalle.gastos.map(async (g) => ({ ...g, url: await adjuntosStorage.urlFirmada(g.storage_path) }))
  );
  res.json({ ok: true, detalle: { ...detalle, gastos: gastosConUrl } });
}));

// "Ok" final de logística sobre la rendición completa - pedido explícito
// del usuario: bloqueado (409) hasta que el viaje esté finalizado
// (hora_llegada_real). Requiere preproduccion:full, igual que el resto de
// las acciones que dejan constancia de quién autorizó algo.
router.post('/logistica/rendiciones/:viajeId/aprobar', requireFullAccess, asyncRoute(async (req, res) => {
  const resultado = await gastosDb.aprobarRendicion(req.params.viajeId, req.admin?.username || null);
  res.json({ ok: true, ...resultado });
}));

module.exports = router;
