// lib/programadoresChatComun.js
//
// Piezas compartidas entre los dos chats de la sección Programadores: el
// grupo general (routes/admin/programadoresChat.js) y el chat de cada
// proyecto (routes/admin/programadoresProyectos.js). Los dos usan las mismas
// reglas de adjuntos, la misma forma de mensaje para el front y el mismo
// canal en tiempo real (GET /admin/programadores/chat/stream).
const { EventEmitter } = require('events');
const multer = require('multer');
const storage = require('./programadoresChatStorage');

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

// Eventos en memoria de este proceso -> canal SSE. Un evento con `para`
// (lista de usernames) solo les llega a esos usuarios: así los mensajes de
// un proyecto no salen del grupo de sus integrantes.
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
// un .xlsx/.zip el navegador lo baja con un nombre reconocible. `prefijo`
// separa carpetas (ej. "proyectos/12") dentro del mismo bucket.
function pathPara(nombre, prefijo = '') {
  const ahora = new Date();
  const mes = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}`;
  const limpio = String(nombre || 'archivo')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(-80) || 'archivo';
  return `${prefijo ? `${prefijo}/` : ''}${mes}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}/${limpio}`;
}

function adjuntosDe(m) {
  return Array.isArray(m?.adjuntos) ? m.adjuntos : [];
}

// Sube los archivos de un POST multipart y devuelve la metadata a guardar.
async function guardarAdjuntos(archivos, prefijo) {
  const adjuntos = [];
  for (const f of archivos) {
    const nombre = f.originalname;
    const path = pathPara(nombre, prefijo);
    const tipo = f.mimetype && f.mimetype !== 'application/octet-stream' ? f.mimetype : 'application/octet-stream';
    await storage.subirArchivo(path, f.buffer, tipo);
    adjuntos.push({ path, nombre, tipo, tamano: f.size });
  }
  return adjuntos;
}

// Forma que ve el front. De un mensaje eliminado no sale ni el texto ni los
// adjuntos (siguen en la base, pero no se muestran a nadie). Cada chat pasa
// cómo leer sus reacciones y sus mensajes citados.
function crearSerializador({ listReacciones, getMensajesPorIds }) {
  return async function serializar(mensajes, extra = {}) {
    if (!mensajes.length) return [];
    const ids = mensajes.map((m) => Number(m.id));
    const citadosIds = [...new Set(mensajes.map((m) => m.responde_a_id).filter(Boolean).map(Number))];
    const [reacciones, citados] = await Promise.all([
      listReacciones(ids),
      getMensajesPorIds(citadosIds),
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
  };
}

module.exports = {
  hasScope,
  requireScope,
  eventos,
  emitir,
  MAX_TEXTO,
  MAX_EMOJI,
  subirArchivos,
  parseId,
  parseFecha,
  usernameDe,
  adjuntosDe,
  guardarAdjuntos,
  crearSerializador,
};
