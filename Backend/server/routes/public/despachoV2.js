// routes/public/despachoV2.js
//
// /despacho_v2 - versión mobile-first para la cuadrilla, pensada para
// reemplazar en el futuro a /despacho (el tablero de workflow clásico) - por
// ahora conviven, se desarrolla en paralelo (pedido explícito del usuario).
// Login propio (nombre de usuario QC + PIN, no es admin) - cada integrante
// de cuadrilla ve SOLO los viajes de su(s) propia(s) cuadrilla(s).
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { despachoV2Auth, signDespachoV2Token } = require('../../middleware/despachoV2Auth');
const db = require('../../lib/despachoV2Db');
const adjuntosDb = require('../../lib/logisticaAdjuntosDb');
const adjuntosStorage = require('../../lib/logisticaAdjuntosStorage');
const gastosDb = require('../../lib/logisticaGastosDb');
const gastosIa = require('../../lib/logisticaGastosIa');
const medicionMediaDb = require('../../lib/presupuestadorMediaDb');
const checklistDb = require('../../lib/logisticaChecklistDb');

const router = express.Router();

// Aviso automático de WhatsApp a la siguiente parada - pedido explícito del
// usuario. Prender con WHATSAPP_AVISO_HABILITADO=true en el entorno cuando
// se decida activarlo - no hace falta tocar código, solo la env var.
// Mientras se está testeando el flujo (pedido explícito del usuario),
// además hay que setear WHATSAPP_AVISO_TELEFONO_TEST=3572676710 (ver
// enviarAvisoParaParada en lib/despachoV2Db.js) para que TODOS los avisos
// vayan a ese celular de prueba en vez de al cliente real - sacar esa
// segunda env var recién cuando se confirme que el flujo anda bien.
const WHATSAPP_AVISO_HABILITADO = String(process.env.WHATSAPP_AVISO_HABILITADO || '').toLowerCase() === 'true';

// Mismo salt/hash que ya usa el resto del sistema QC (routes/public/qc.js,
// routes/admin/qc.js) - así los PIN que ya tienen cargados los QC users
// sirven acá tal cual, sin duplicar usuarios.
const QC_PIN_SALT = process.env.QC_PIN_SALT || 'dev_change_me_pin_salt';
function hashPin(pin) {
  return crypto.createHmac('sha256', QC_PIN_SALT).update(String(pin)).digest('hex');
}

function asyncRoute(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error('despacho-v2 error:', err);
      res.status(err.status || 400).json({ error: err.message || 'Error inesperado' });
    });
  };
}

// GET /despacho-v2/qc-users - lista para el picker de login (nombre, sin PIN).
router.get('/despacho-v2/qc-users', asyncRoute(async (_req, res) => {
  res.json({ ok: true, usuarios: await db.listQcUsersDeCuadrillas() });
}));

// POST /despacho-v2/login { qc_user_id, pin }
router.post('/despacho-v2/login', asyncRoute(async (req, res) => {
  const qcUserId = Number(req.body?.qc_user_id);
  const pinStr = String(req.body?.pin || '').trim();
  if (!Number.isInteger(qcUserId)) return res.status(400).json({ error: 'Falta elegir el usuario' });
  if (!/^\d{3,10}$/.test(pinStr)) return res.status(400).json({ error: 'PIN inválido (solo numérico)' });

  const user = await db.getQcUser(qcUserId);
  if (!user || !user.is_active || user.pin_hash !== hashPin(pinStr)) {
    return res.status(401).json({ error: 'PIN incorrecto o usuario inactivo' });
  }

  const cuadrillas = await db.cuadrillasDeUsuario(qcUserId);
  if (!cuadrillas.length) return res.status(403).json({ error: 'Este usuario no pertenece a ninguna cuadrilla activa' });

  const token = signDespachoV2Token({ qc_user_id: user.id, name: user.name });
  res.json({ ok: true, token, qc_user: { id: user.id, name: user.name }, cuadrillas });
}));

router.use('/despacho-v2', despachoV2Auth);

// Chequeo de ownership repetido en varias rutas: el viaje tiene que ser de
// alguna cuadrilla del usuario logueado. Devuelve el viaje si está OK, o
// manda la respuesta de error y devuelve null (el caller corta ahí).
async function requireViajeDeMiCuadrilla(req, res, viajeId) {
  const viaje = await db.getViajeCuadrilla(viajeId);
  if (!viaje) { res.status(404).json({ error: 'Viaje no encontrado' }); return null; }
  const cuadrillas = await db.cuadrillasDeUsuario(req.despachoUser.qc_user_id);
  if (!cuadrillas.some((c) => c.id === viaje.cuadrilla_id)) {
    res.status(403).json({ error: 'Este viaje no es de tu cuadrilla' });
    return null;
  }
  return viaje;
}

// GET /despacho-v2/viajes?rango=10d|todos
router.get('/despacho-v2/viajes', asyncRoute(async (req, res) => {
  const cuadrillas = await db.cuadrillasDeUsuario(req.despachoUser.qc_user_id);
  const cuadrillaIds = cuadrillas.map((c) => c.id);
  const soloProximos10 = String(req.query?.rango || '10d') !== 'todos';
  const viajes = await db.listViajesDeCuadrillas(cuadrillaIds, { soloProximos10 });
  res.json({ ok: true, cuadrillas, viajes });
}));

// GET /despacho-v2/checklist/:tipo - ítems activos configurados para ese
// tipo (solo_despacho | con_instalacion), lo que la cuadrilla tilda antes de
// poder arrancar el viaje (pedido explícito del usuario).
router.get('/despacho-v2/checklist/:tipo', asyncRoute(async (req, res) => {
  res.json({ ok: true, items: await checklistDb.listChecklistItemsActivos(req.params.tipo) });
}));

// POST /despacho-v2/viajes/:id/marcar-salida - botón Play. Si el viaje
// todavía no arrancó, exige el checklist configurado para su tipo (todos
// los ítems activos en checklist_item_ids) ANTES de asentar la salida -
// pedido explícito del usuario: sin completarlo no se habilita el viaje. Se
// revalida acá contra lo que está configurado ahora mismo (no se confía en
// la lista que ya vio el frontend). Si el viaje ya había arrancado (re-toque
// del botón, ya sin efecto), no vuelve a exigirlo.
// Si el aviso automático de WhatsApp está habilitado, dispara (sin bloquear
// la respuesta - el collage de fotos puede tardar unos segundos) el de la
// PRIMERA parada-portón de la ruta: el primer mensaje sale solo apenas la
// cuadrilla arranca, sin pedirle confirmación.
router.post('/despacho-v2/viajes/:id/marcar-salida', asyncRoute(async (req, res) => {
  const viaje = await requireViajeDeMiCuadrilla(req, res, req.params.id);
  if (!viaje) return;

  if (!viaje.hora_salida_real) {
    await checklistDb.confirmarChecklistViaje({
      viajeId: req.params.id,
      tipo: String(req.body?.checklist_tipo || '').trim(),
      itemIds: Array.isArray(req.body?.checklist_item_ids) ? req.body.checklist_item_ids : [],
      confirmadoPor: req.despachoUser.name,
    });
  }

  const hora_salida_real = await db.marcarSalidaReal(req.params.id);
  if (WHATSAPP_AVISO_HABILITADO) {
    db.avisarPrimeraParada({ viajeId: req.params.id, enviadoPor: req.despachoUser.name })
      .catch((e) => console.error('No se pudo enviar el primer aviso de WhatsApp:', e.message));
  }
  res.json({ ok: true, hora_salida_real });
}));

// POST /despacho-v2/viajes/:id/marcar-llegada - "Finalizar viaje": pedido
// explícito del usuario, cierra el rango de fechas válido para los gastos
// de la rendición - sin esto, logística no puede aprobarla.
router.post('/despacho-v2/viajes/:id/marcar-llegada', asyncRoute(async (req, res) => {
  if (!(await requireViajeDeMiCuadrilla(req, res, req.params.id))) return;
  const hora_llegada_real = await db.marcarLlegadaReal(req.params.id);
  res.json({ ok: true, hora_llegada_real });
}));

// GET /despacho-v2/viajes/:id/paradas - botón de tres líneas.
router.get('/despacho-v2/viajes/:id/paradas', asyncRoute(async (req, res) => {
  if (!(await requireViajeDeMiCuadrilla(req, res, req.params.id))) return;
  res.json({ ok: true, paradas: await db.listParadasDeViaje(req.params.id) });
}));

// GET /despacho-v2/nv/:nv - detalle completo al tocar un NV.
router.get('/despacho-v2/nv/:nv', asyncRoute(async (req, res) => {
  const detalle = await db.getNvDetalle(req.params.nv);
  if (!detalle) return res.status(400).json({ error: 'NV inválido' });
  res.json({ ok: true, nv: detalle });
}));

// GET /despacho-v2/nv/:nv/adjuntos - "los archivos adjuntados a la NV (lo
// que vimos antes)": mismo storage/tabla del feature de Adjuntos, expuesto
// acá para el login de cuadrilla (que no tiene token de admin). Solo
// lectura por ahora.
router.get('/despacho-v2/nv/:nv/adjuntos', asyncRoute(async (req, res) => {
  const rows = await adjuntosDb.listAdjuntos({ nv: Number(req.params.nv) });
  const conUrl = await Promise.all(rows.map(async (r) => ({ ...r, url: await adjuntosStorage.urlFirmada(r.storage_path) })));
  res.json({ ok: true, adjuntos: conUrl });
}));

// GET /despacho-v2/nv/:nv/medicion-media - fotos/videos que el vendedor
// adjuntó al tomar la medición en el Presupuestador (pedido explícito del
// usuario) - listado liviano, sin el archivo en sí (ver el endpoint de
// abajo para pedir uno puntual al tocarlo).
router.get('/despacho-v2/nv/:nv/medicion-media', asyncRoute(async (req, res) => {
  res.json({ ok: true, media: await medicionMediaDb.listMedicionMedia(req.params.nv) });
}));

// GET /despacho-v2/nv/:nv/medicion-media/:index - el archivo puntual (data
// URL base64, tal cual lo guardó el Presupuestador - no hay Storage/URL
// firmada para esto).
router.get('/despacho-v2/nv/:nv/medicion-media/:index', asyncRoute(async (req, res) => {
  const item = await medicionMediaDb.getMedicionMediaItem(req.params.nv, req.params.index);
  if (!item) return res.status(404).json({ error: 'No se encontró ese archivo' });
  res.json({ ok: true, item });
}));

// POST /despacho-v2/viajes/:id/nv/:nv/marcar-entregado { tipo, pin? } -
// cierre OFICIAL real (despacho: mismo PIN/QC que /despacho; instalación:
// pone fecha_llegada_imput como ya hace /a, sin PIN porque no hay ninguno
// hoy para ese campo). Devuelve la SIGUIENTE parada de la ruta para que el
// frontend le pregunte al usuario "¿la ruta sigue así?" ANTES de mandar
// nada - no manda el WhatsApp acá todavía (ver /avisar-siguiente).
router.post('/despacho-v2/viajes/:id/nv/:nv/marcar-entregado', asyncRoute(async (req, res) => {
  if (!(await requireViajeDeMiCuadrilla(req, res, req.params.id))) return;
  const tipo = String(req.body?.tipo || '').trim();
  await db.marcarEntregado({ nv: req.params.nv, tipo, pin: req.body?.pin });
  const siguiente = WHATSAPP_AVISO_HABILITADO ? await db.siguienteParadaPorton(req.params.id, req.params.nv) : null;
  res.json({ ok: true, siguienteParada: siguiente, whatsappAvisoHabilitado: WHATSAPP_AVISO_HABILITADO });
}));

// POST /despacho-v2/viajes/:id/nv/:nv/avisar-siguiente - se llama SOLO
// después de que el usuario confirmó que la ruta sigue igual. Recalcula la
// siguiente parada de nuevo acá (no confía en lo que ya vio el frontend,
// por si cambió algo en el medio) y manda el WhatsApp.
router.post('/despacho-v2/viajes/:id/nv/:nv/avisar-siguiente', asyncRoute(async (req, res) => {
  if (!WHATSAPP_AVISO_HABILITADO) return res.status(403).json({ ok: false, error: 'Aviso automático de WhatsApp deshabilitado en este entorno' });
  if (!(await requireViajeDeMiCuadrilla(req, res, req.params.id))) return;
  const resultado = await db.avisarSiguienteParada({
    viajeId: req.params.id, nvOrigen: req.params.nv, enviadoPor: req.despachoUser.name,
  });
  res.json({ ok: resultado.ok, ...resultado });
}));

// GET /despacho-v2/viajes/:id/nv/:nv/paradas-restantes - para el picker de
// "la ruta cambió, ¿cuál sigue?": todas las paradas-portón que venían
// DESPUÉS de `nv` en el orden original (mismo criterio que
// siguienteParadaPorton, por posición en la ruta - no hay forma de saber
// acá cuáles ya se entregaron de verdad, solo cuáles no se habían pasado
// todavía en el plan).
router.get('/despacho-v2/viajes/:id/nv/:nv/paradas-restantes', asyncRoute(async (req, res) => {
  if (!(await requireViajeDeMiCuadrilla(req, res, req.params.id))) return;
  const paradas = await db.listParadasDeViaje(req.params.id);
  const idx = paradas.findIndex((p) => p.tipo === 'porton' && p.nv === Number(req.params.nv));
  const restantes = idx === -1 ? [] : paradas.slice(idx + 1).filter((p) => p.tipo === 'porton');
  res.json({ ok: true, restantes });
}));

// POST /despacho-v2/viajes/:id/nv/:nvOrigen/avisar-parada/:nvDestino - la
// ruta cambió y el usuario eligió a mano cuál es la próxima parada a
// entregar (pedido explícito del usuario) - manda el aviso para ESA parada
// puntual, no la que seguía en el orden original.
router.post('/despacho-v2/viajes/:id/nv/:nvOrigen/avisar-parada/:nvDestino', asyncRoute(async (req, res) => {
  if (!WHATSAPP_AVISO_HABILITADO) return res.status(403).json({ ok: false, error: 'Aviso automático de WhatsApp deshabilitado en este entorno' });
  if (!(await requireViajeDeMiCuadrilla(req, res, req.params.id))) return;
  const resultado = await db.avisarParadaElegida({
    viajeId: req.params.id, nvOrigen: req.params.nvOrigen, nvDestino: req.params.nvDestino, enviadoPor: req.despachoUser.name,
  });
  res.json({ ok: resultado.ok, ...resultado });
}));

// ===========================================================================
// Gastos del viaje ("rendición de gastos") - pedido explícito del usuario:
// fecha + motivo + monto + foto/PDF del ticket. Se comparte entre toda la
// cuadrilla del viaje (cualquiera de sus integrantes puede cargar/ver/borrar
// los gastos, no solo quien los subió).
// ===========================================================================
const GASTO_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']);
const GASTO_MAX_BYTES = 15 * 1024 * 1024;
const uploadGasto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: GASTO_MAX_BYTES },
  fileFilter: (req, file, cb) => {
    if (!GASTO_MIME.has(file.mimetype)) return cb(new Error('Tiene que ser una foto (jpg/png/webp/heic) o un PDF'));
    cb(null, true);
  },
});
function extensionDeGasto(nombreOriginal, mime) {
  const porNombre = String(nombreOriginal || '').split('.').pop();
  if (porNombre && porNombre.length <= 5 && /^[a-zA-Z0-9]+$/.test(porNombre)) return porNombre.toLowerCase();
  const porMime = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf' };
  return porMime[mime] || 'bin';
}

router.get('/despacho-v2/viajes/:id/gastos', asyncRoute(async (req, res) => {
  if (!(await requireViajeDeMiCuadrilla(req, res, req.params.id))) return;
  const rows = await gastosDb.listGastosDeViaje(req.params.id);
  const conUrl = await Promise.all(rows.map(async (r) => ({ ...r, url: await adjuntosStorage.urlFirmada(r.storage_path) })));
  res.json({ ok: true, gastos: conUrl });
}));

// Sube la foto/PDF PRIMERO - pedido explícito del usuario: la IA lo lee y
// completa fecha/motivo/monto/tipo de comprobante (chequeando la fecha
// contra el rango real del viaje, hora_salida_real -> hora_llegada_real).
// Si algo no se pudo leer con confianza, ese campo queda en
// campos_inciertos (editable acá mismo con el PATCH de abajo) - pero
// SIEMPRE que haya campos_inciertos el gasto queda en estado_revision =
// 'revisar', aunque la cuadrilla lo corrija después: logística lo tiene
// que ver resaltado igual.
router.post('/despacho-v2/viajes/:id/gastos', uploadGasto.single('archivo'), asyncRoute(async (req, res) => {
  const viaje = await requireViajeDeMiCuadrilla(req, res, req.params.id);
  if (!viaje) return;
  if (!req.file) throw new Error('Falta la foto o el PDF del ticket');

  const path = `gasto-viaje-${req.params.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extensionDeGasto(req.file.originalname, req.file.mimetype)}`;
  await adjuntosStorage.subirArchivo(path, req.file.buffer, req.file.mimetype);

  const analisis = await gastosIa.analizarGasto({
    buffer: req.file.buffer, mimeType: req.file.mimetype,
    horaSalidaReal: viaje.hora_salida_real, horaLlegadaReal: viaje.hora_llegada_real,
  });

  const gasto = await gastosDb.crearGasto({
    viaje_id: req.params.id,
    fecha: analisis.fecha, motivo: analisis.motivo, monto: analisis.monto,
    storage_path: path, nombre_archivo: req.file.originalname, tipo_mime: req.file.mimetype,
    cargado_por: req.despachoUser.name,
    tipo_comprobante: analisis.tipo_comprobante, medio_pago: analisis.medio_pago,
    estado_revision: analisis.estado_revision, detalle_revision: analisis.detalle_revision,
    campos_inciertos: analisis.campos_inciertos,
  });
  res.json({ ok: true, gasto: { ...gasto, url: await adjuntosStorage.urlFirmada(path) } });
}));

// Corrección a mano de un campo que la IA no pudo leer bien (o cualquier
// otro) - pedido explícito del usuario. No cambia estado_revision: sigue
// resaltado para logística aunque se corrija acá.
router.patch('/despacho-v2/viajes/:id/gastos/:gastoId', asyncRoute(async (req, res) => {
  if (!(await requireViajeDeMiCuadrilla(req, res, req.params.id))) return;
  const gastoExistente = await gastosDb.getGasto(req.params.gastoId);
  if (!gastoExistente || Number(gastoExistente.viaje_id) !== Number(req.params.id)) return res.status(404).json({ error: 'Gasto no encontrado' });

  const patch = {};
  if (req.body?.fecha !== undefined) patch.fecha = String(req.body.fecha).slice(0, 10);
  if (req.body?.motivo !== undefined) patch.motivo = String(req.body.motivo).trim();
  if (req.body?.monto !== undefined) patch.monto = Number(req.body.monto);
  if (req.body?.tipo_comprobante !== undefined) patch.tipo_comprobante = String(req.body.tipo_comprobante).trim();
  if (req.body?.medio_pago !== undefined) patch.medio_pago = String(req.body.medio_pago).trim();

  const gasto = await gastosDb.actualizarGasto(req.params.gastoId, patch);
  res.json({ ok: true, gasto: { ...gasto, url: await adjuntosStorage.urlFirmada(gasto.storage_path) } });
}));

router.delete('/despacho-v2/viajes/:id/gastos/:gastoId', asyncRoute(async (req, res) => {
  if (!(await requireViajeDeMiCuadrilla(req, res, req.params.id))) return;
  const gasto = await gastosDb.getGasto(req.params.gastoId);
  if (!gasto || Number(gasto.viaje_id) !== Number(req.params.id)) return res.status(404).json({ error: 'Gasto no encontrado' });
  const path = await gastosDb.borrarGasto(req.params.gastoId);
  if (path) await adjuntosStorage.borrarArchivo(path).catch(() => {});
  res.json({ ok: true });
}));

// Multer manda sus propios errores (tamaño/tipo) antes de llegar a
// asyncRoute (los tira en el middleware de upload, no en un handler async) -
// sin esto quedaban como error 500 genérico en vez del mensaje claro (mismo
// mecanismo que routes/admin/logisticaAdjuntos.js).
router.use('/despacho-v2/viajes', (err, req, res, next) => {
  if (err instanceof multer.MulterError || err) {
    return res.status(400).json({ error: err.message || 'No se pudo subir el archivo' });
  }
  return next(err);
});

// POST /despacho-v2/nv/:nv/st { descripcion, attachment? } - botón ST/PV.
router.post('/despacho-v2/nv/:nv/st', asyncRoute(async (req, res) => {
  const solicitud = await db.crearSolicitudSt({
    nv: req.params.nv,
    descripcion: req.body?.descripcion,
    attachment: req.body?.attachment || null,
    creadoPor: req.despachoUser.name,
  });
  res.json({ ok: true, solicitud });
}));

module.exports = router;
