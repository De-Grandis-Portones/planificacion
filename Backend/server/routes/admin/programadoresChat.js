// routes/admin/programadoresChat.js — Chat de Programadores: un único grupo
// tipo WhatsApp (texto, emojis, imágenes y archivos, respuestas citando,
// reacciones, editar/eliminar), solo para el scope programadores:admin,
// igual que el resto de la sección "Programadores" del menú.
//
// Tiempo real: GET /programadores/chat/stream es un canal SSE por el que se
// empuja cada novedad (mensaje nuevo, cambio, lectura) apenas pasa. Los
// eventos salen de un EventEmitter en memoria de este proceso; el front
// igual hace un polling de respaldo (más espaciado) por si el canal se
// corta o el backend llegara a correr en más de una instancia.
const { EventEmitter } = require('events');
const express = require('express');
const multer = require('multer');
const { adminAuth } = require('../../middleware/adminAuth');
const chatDb = require('../../lib/programadoresChatDb');
const storage = require('../../lib/programadoresChatStorage');

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

// Con path: ver nota equivalente en admin/prefabricados.js.
router.use('/programadores/chat', adminAuth, requireScope(chatDb.SCOPE));

const eventos = new EventEmitter();
eventos.setMaxListeners(0); // un listener por pestaña conectada
function emitir(evento) {
  eventos.emit('evento', evento);
}

const MAX_TEXTO = 4000;
const MAX_ARCHIVOS = 5;
const MAX_EMOJI = 16; // un emoji con modificadores (tono de piel, ZWJ) ocupa varios code units
// Por extensión y no por MIME: el navegador manda '' o
// application/octet-stream para varios de estos (.sql, .log, .md...).
const EXTENSIONES = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'heic',
  'pdf', 'txt', 'log', 'md', 'csv', 'json', 'xml', 'sql',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'zip', 'rar', '7z',
  'mp4', 'webm', 'mov', 'mp3', 'ogg', 'wav', 'm4a',
]);

function extensionDe(nombre) {
  const m = String(nombre || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

const upload = multer({
  storage: multer.memoryStorage(),
  // Default de multer es latin1: rompe los acentos del nombre original.
  defParamCharset: 'utf8',
  limits: { fileSize: storage.MAX_BYTES, files: MAX_ARCHIVOS },
  fileFilter: (req, file, cb) => {
    if (!EXTENSIONES.has(extensionDe(file.originalname))) {
      return cb(new Error(`Tipo de archivo no permitido: ${file.originalname}`));
    }
    return cb(null, true);
  },
});

// Los errores de multer (archivo muy grande, demasiados archivos, tipo no
// permitido) como 400 con mensaje, no el 500 HTML por defecto de express.
function subirArchivos(req, res, next) {
  upload.array('archivos', MAX_ARCHIVOS)(req, res, (err) => {
    if (!err) return next();
    let error = err.message || 'Error subiendo los archivos';
    if (err.code === 'LIMIT_FILE_SIZE') error = `Cada archivo puede pesar hasta ${storage.MAX_BYTES / (1024 * 1024)} MB`;
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') error = `Máximo ${MAX_ARCHIVOS} archivos por mensaje`;
    return res.status(400).json({ error });
  });
}

function parseId(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function parseFecha(raw) {
  if (!raw) return null;
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function usernameDe(req) {
  return String(req.admin?.username || '').trim();
}

// El path en Storage termina en el nombre original (saneado), así al abrir
// un .xlsx/.zip el navegador lo baja con un nombre reconocible.
function pathPara(nombre) {
  const ahora = new Date();
  const mes = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}`;
  const limpio = String(nombre || 'archivo')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(-80) || 'archivo';
  return `${mes}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}/${limpio}`;
}

function adjuntosDe(m) {
  return Array.isArray(m?.adjuntos) ? m.adjuntos : [];
}

// Forma que ve el front. De un mensaje eliminado no sale ni el texto ni los
// adjuntos (siguen en la base, pero no se muestran a nadie).
async function serializar(mensajes, extra = {}) {
  if (!mensajes.length) return [];
  const ids = mensajes.map((m) => Number(m.id));
  const citadosIds = [...new Set(mensajes.map((m) => m.responde_a_id).filter(Boolean).map(Number))];
  const [reacciones, citados] = await Promise.all([
    chatDb.listReacciones(ids),
    chatDb.getMensajesPorIds(citadosIds),
  ]);
  const citadosPorId = new Map(citados.map((c) => [Number(c.id), c]));
  const paths = mensajes.filter((m) => !m.eliminado_at).flatMap((m) => adjuntosDe(m).map((a) => a.path));
  const urls = await storage.urlsFirmadas(paths);

  return mensajes.map((m) => {
    const eliminado = !!m.eliminado_at;
    const c = m.responde_a_id ? citadosPorId.get(Number(m.responde_a_id)) : null;
    const reaccionesDe = reacciones
      .filter((r) => r.mensaje_id === Number(m.id))
      .map((r) => ({ emoji: r.emoji, usernames: r.usernames }))
      .sort((a, b) => b.usernames.length - a.usernames.length);
    return {
      id: Number(m.id),
      autor_username: m.autor_username,
      texto: eliminado ? null : m.texto,
      created_at: m.created_at,
      editado_at: eliminado ? null : m.editado_at,
      eliminado,
      adjuntos: eliminado ? [] : adjuntosDe(m).map((a) => ({
        nombre: a.nombre,
        tipo: a.tipo,
        tamano: a.tamano,
        url: urls[a.path] || null,
      })),
      responde_a: c ? {
        id: Number(c.id),
        autor_username: c.autor_username,
        eliminado: !!c.eliminado_at,
        texto: c.eliminado_at ? null : String(c.texto || '').slice(0, 300),
        adjunto: c.eliminado_at || !adjuntosDe(c).length ? null : { nombre: adjuntosDe(c)[0].nombre, tipo: adjuntosDe(c)[0].tipo },
        n_adjuntos: c.eliminado_at ? 0 : adjuntosDe(c).length,
      } : null,
      reacciones: eliminado ? [] : reaccionesDe,
      ...extra,
    };
  });
}

// GET /admin/programadores/chat/mensajes?despues_de=ID[&cambios_desde=ISO] | ?antes_de=ID
router.get('/programadores/chat/mensajes', async (req, res) => {
  try {
    const despuesDe = parseId(req.query.despues_de);
    const antesDe = parseId(req.query.antes_de);
    const cambiosDesde = parseFecha(req.query.cambios_desde);
    const [{ mensajes, hayMas, ahora }, lecturas, miembros] = await Promise.all([
      chatDb.listMensajes({ despuesDe, antesDe, cambiosDesde }),
      chatDb.listLecturas(),
      chatDb.listMiembros(),
    ]);
    return res.json({ ok: true, mensajes: await serializar(mensajes), hayMas, ahora, lecturas, miembros });
  } catch (err) {
    console.error('programadores chat list error:', err);
    return res.status(500).json({ error: 'Error cargando el chat', detail: err.message });
  }
});

// POST /admin/programadores/chat/mensajes — multipart: texto, archivos[],
// responde_a_id, cliente_id (id temporal del front: vuelve en la respuesta y
// en el evento, para que el front reemplace su burbuja "enviando").
router.post('/programadores/chat/mensajes', subirArchivos, async (req, res) => {
  try {
    const username = usernameDe(req);
    if (!username) return res.status(401).json({ error: 'Sesión sin usuario' });

    const texto = String(req.body?.texto || '').trim();
    const archivos = Array.isArray(req.files) ? req.files : [];
    const clienteId = req.body?.cliente_id ? String(req.body.cliente_id).slice(0, 80) : null;
    if (!texto && !archivos.length) return res.status(400).json({ error: 'El mensaje está vacío' });
    if (texto.length > MAX_TEXTO) return res.status(400).json({ error: `El mensaje puede tener hasta ${MAX_TEXTO} caracteres` });

    let respondeAId = null;
    if (req.body?.responde_a_id) {
      respondeAId = parseId(req.body.responde_a_id);
      if (respondeAId == null || !(await chatDb.getMensaje(respondeAId))) {
        return res.status(400).json({ error: 'El mensaje al que respondés no existe' });
      }
    }

    const adjuntos = [];
    for (const f of archivos) {
      const nombre = f.originalname;
      const path = pathPara(nombre);
      const tipo = f.mimetype && f.mimetype !== 'application/octet-stream' ? f.mimetype : 'application/octet-stream';
      await storage.subirArchivo(path, f.buffer, tipo);
      adjuntos.push({ path, nombre, tipo, tamano: f.size });
    }

    const creado = await chatDb.createMensaje({
      autorId: req.admin?.sub || null,
      autorUsername: username,
      texto,
      adjuntos,
      respondeAId,
    });
    // El que escribe ya "leyó" hasta su propio mensaje.
    const ultimoLeido = await chatDb.marcarLeido(username, Number(creado.id));
    const [mensaje] = await serializar([creado], clienteId ? { cliente_id: clienteId } : {});
    emitir({ tipo: 'mensaje', mensaje });
    emitir({ tipo: 'lectura', username, ultimo_leido_id: ultimoLeido });
    return res.json({ ok: true, mensaje });
  } catch (err) {
    console.error('programadores chat send error:', err);
    return res.status(500).json({ error: err.message || 'Error enviando el mensaje' });
  }
});

// Carga el mensaje y verifica que sea del que pide (editar/eliminar).
async function mensajePropio(req, res) {
  const id = parseId(req.params.id);
  const m = id == null ? null : await chatDb.getMensaje(id);
  if (!m) {
    res.status(404).json({ error: 'Mensaje no encontrado' });
    return null;
  }
  if (m.autor_username !== usernameDe(req)) {
    res.status(403).json({ error: 'Solo podés modificar tus propios mensajes' });
    return null;
  }
  return m;
}

// PUT /admin/programadores/chat/mensajes/:id — { texto }
router.put('/programadores/chat/mensajes/:id', async (req, res) => {
  try {
    const m = await mensajePropio(req, res);
    if (!m) return undefined;
    if (m.eliminado_at) return res.status(400).json({ error: 'El mensaje está eliminado' });
    const texto = String(req.body?.texto || '').trim();
    if (!texto && !adjuntosDe(m).length) return res.status(400).json({ error: 'El mensaje no puede quedar vacío' });
    if (texto.length > MAX_TEXTO) return res.status(400).json({ error: `El mensaje puede tener hasta ${MAX_TEXTO} caracteres` });
    if (texto === String(m.texto || '')) {
      const [mensaje] = await serializar([m]);
      return res.json({ ok: true, mensaje });
    }
    const editado = await chatDb.editarMensaje(m.id, texto);
    if (!editado) return res.status(400).json({ error: 'El mensaje está eliminado' }); // se eliminó justo en el medio
    const [mensaje] = await serializar([editado]);
    emitir({ tipo: 'cambio', mensaje });
    return res.json({ ok: true, mensaje });
  } catch (err) {
    console.error('programadores chat edit error:', err);
    return res.status(500).json({ error: 'Error editando el mensaje', detail: err.message });
  }
});

// DELETE /admin/programadores/chat/mensajes/:id — borrado lógico.
router.delete('/programadores/chat/mensajes/:id', async (req, res) => {
  try {
    const m = await mensajePropio(req, res);
    if (!m) return undefined;
    const eliminado = await chatDb.eliminarMensaje(m.id);
    const [mensaje] = await serializar([eliminado]);
    emitir({ tipo: 'cambio', mensaje });
    return res.json({ ok: true, mensaje });
  } catch (err) {
    console.error('programadores chat delete error:', err);
    return res.status(500).json({ error: 'Error eliminando el mensaje', detail: err.message });
  }
});

// PUT /admin/programadores/chat/mensajes/:id/reaccion — { emoji } (null/'' la quita)
router.put('/programadores/chat/mensajes/:id/reaccion', async (req, res) => {
  try {
    const username = usernameDe(req);
    if (!username) return res.status(401).json({ error: 'Sesión sin usuario' });
    const id = parseId(req.params.id);
    const m = id == null ? null : await chatDb.getMensaje(id);
    if (!m) return res.status(404).json({ error: 'Mensaje no encontrado' });
    if (m.eliminado_at) return res.status(400).json({ error: 'El mensaje está eliminado' });
    const emoji = req.body?.emoji ? String(req.body.emoji).trim() : '';
    if (emoji.length > MAX_EMOJI || /[\s<>]/.test(emoji)) return res.status(400).json({ error: 'Reacción inválida' });
    const actualizado = await chatDb.setReaccion(m.id, username, emoji || null);
    const [mensaje] = await serializar([actualizado]);
    emitir({ tipo: 'cambio', mensaje });
    return res.json({ ok: true, mensaje });
  } catch (err) {
    console.error('programadores chat reaccion error:', err);
    return res.status(500).json({ error: 'Error guardando la reacción', detail: err.message });
  }
});

// POST /admin/programadores/chat/leido — { hasta_id }
router.post('/programadores/chat/leido', async (req, res) => {
  try {
    const username = usernameDe(req);
    const hastaId = parseId(req.body?.hasta_id);
    if (!username) return res.status(401).json({ error: 'Sesión sin usuario' });
    if (hastaId == null) return res.status(400).json({ error: 'hasta_id inválido' });
    const ultimoLeido = await chatDb.marcarLeido(username, hastaId);
    emitir({ tipo: 'lectura', username, ultimo_leido_id: ultimoLeido });
    return res.json({ ok: true });
  } catch (err) {
    console.error('programadores chat leido error:', err);
    return res.status(500).json({ error: 'Error marcando como leído', detail: err.message });
  }
});

// GET /admin/programadores/chat/no-leidos — { count, ultimo } para el badge
// del menú/encabezado y el aviso con la pestaña en segundo plano.
router.get('/programadores/chat/no-leidos', async (req, res) => {
  try {
    const username = usernameDe(req);
    if (!username) return res.status(401).json({ error: 'Sesión sin usuario' });
    const { count, ultimo } = await chatDb.contarNoLeidos(username);
    return res.json({ ok: true, count, ultimo });
  } catch (err) {
    console.error('programadores chat no-leidos error:', err);
    return res.status(500).json({ error: 'Error contando no leídos', detail: err.message });
  }
});

// GET /admin/programadores/chat/stream — SSE. El front lo abre con fetch
// (EventSource no deja mandar el header Authorization y el token no tiene
// que ir en la URL: morgan loguea las URLs).
router.get('/programadores/chat/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const enviar = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  enviar({ tipo: 'hola' });
  eventos.on('evento', enviar);
  // Comentario cada 25s para que ningún proxy corte la conexión por inactiva.
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  // El canal no sobrevive al token: al vencer se corta y el front, al
  // reconectar, recibe el 401 como cualquier otro pedido.
  const msToken = req.admin?.exp ? req.admin.exp * 1000 - Date.now() : 0;
  const corte = msToken > 0 ? setTimeout(() => res.end(), msToken) : null;
  req.on('close', () => {
    eventos.off('evento', enviar);
    clearInterval(ping);
    if (corte) clearTimeout(corte);
  });
});

module.exports = router;
