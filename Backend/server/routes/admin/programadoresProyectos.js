// routes/admin/programadoresProyectos.js — Proyectos de la sección
// Programadores (pedido del usuario: "agregar proyectos, que aparezcan como
// tarjetas, con un chat entre los que están trabajando en él y que se sepa
// quién es el encargado"). Mismo scope que el resto de la sección
// (programadores:admin).
//
// - Todos los del scope ven las tarjetas de todos los proyectos y pueden
//   crear proyectos nuevos.
// - Editar o archivar: el encargado o quien lo creó.
// - El chat (leer y escribir) es solo de los integrantes; el encargado
//   siempre es integrante. Un proyecto archivado deja el chat solo lectura.
// - Encargado e integrantes se eligen entre los que tienen el scope (o los
//   que ya estaban en el proyecto aunque después lo hayan perdido).
//
// Tiempo real: los eventos del chat salen por el mismo canal SSE del Chat de
// Programadores (GET /admin/programadores/chat/stream) como
// { tipo: 'proyecto', proyecto_id, evento }, y solo a los integrantes.
const express = require('express');
const { adminAuth } = require('../../middleware/adminAuth');
const proyectosDb = require('../../lib/programadoresProyectosDb');
const { SCOPE, listMiembros } = require('../../lib/programadoresChatDb');
const {
  requireScope, emitir, MAX_TEXTO, MAX_EMOJI, subirArchivos,
  parseId, parseFecha, usernameDe, adjuntosDe, guardarAdjuntos, crearSerializador,
} = require('../../lib/programadoresChatComun');

const router = express.Router();

// Con path: ver nota equivalente en admin/prefabricados.js.
router.use('/programadores/proyectos', adminAuth, requireScope(SCOPE));

const MAX_NOMBRE = 120;
const MAX_DESCRIPCION = 4000;

const serializarMensajes = crearSerializador({
  listReacciones: proyectosDb.listReacciones,
  getMensajesPorIds: proyectosDb.getMensajesPorIds,
});

function esIntegrante(p, username) {
  return (p.integrantes || []).includes(username);
}

function puedeEditar(p, username) {
  return !!username && (p.encargado_username === username || p.creado_por === username);
}

// Forma que ve el front. El encargado va primero en integrantes.
function serializarProyecto(p, username, nombres) {
  const persona = (u) => ({ username: u, name: nombres[u] || null });
  const integrante = esIntegrante(p, username);
  const otros = (p.integrantes || [])
    .filter((u) => u !== p.encargado_username)
    .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
  return {
    id: p.id,
    nombre: p.nombre,
    descripcion: p.descripcion,
    estado: p.estado,
    encargado: persona(p.encargado_username),
    integrantes: [p.encargado_username, ...otros].map(persona),
    creado_por: p.creado_por ? persona(p.creado_por) : null,
    archivado: !!p.archivado_at,
    archivado_at: p.archivado_at,
    created_at: p.created_at,
    updated_at: p.updated_at,
    es_integrante: integrante,
    puede_editar: puedeEditar(p, username),
    no_leidos: integrante ? Number(p.no_leidos || 0) : 0,
    ultimo_mensaje: integrante && p.ultimo_id ? {
      id: Number(p.ultimo_id),
      autor_username: p.ultimo_autor,
      texto: p.ultimo_texto ? String(p.ultimo_texto).slice(0, 200) : null,
      n_adjuntos: Number(p.ultimo_n_adjuntos || 0),
      created_at: p.ultimo_at,
    } : null,
  };
}

async function proyectosParaFront(rows, username) {
  const nombres = await proyectosDb.nombresDe(
    rows.flatMap((p) => [p.encargado_username, p.creado_por, ...(p.integrantes || [])])
  );
  return rows.map((p) => serializarProyecto(p, username, nombres));
}

// Valida el body de crear/editar. Devuelve { campos } o { error }.
async function leerCampos(body, actual) {
  const nombre = String(body?.nombre ?? '').trim();
  if (!nombre) return { error: 'Falta el nombre del proyecto' };
  if (nombre.length > MAX_NOMBRE) return { error: `El nombre puede tener hasta ${MAX_NOMBRE} caracteres` };
  const descripcion = String(body?.descripcion ?? '').trim();
  if (descripcion.length > MAX_DESCRIPCION) return { error: `La descripción puede tener hasta ${MAX_DESCRIPCION} caracteres` };
  const estado = String(body?.estado || actual?.estado || 'en_curso');
  if (!proyectosDb.ESTADOS.includes(estado)) return { error: 'Estado inválido' };
  const encargado = String(body?.encargado || '').trim();
  if (!encargado) return { error: 'Elegí quién es el encargado del proyecto' };
  const elegidos = Array.isArray(body?.integrantes) ? body.integrantes.map((u) => String(u || '').trim()).filter(Boolean) : [];

  const candidatos = new Set((await listMiembros()).map((m) => m.username));
  const yaEstaban = new Set(actual?.integrantes || []);
  const integrantes = [...new Set([encargado, ...elegidos])];
  const invalido = integrantes.find((u) => !candidatos.has(u) && !yaEstaban.has(u));
  if (invalido) return { error: `${invalido} no tiene acceso a la sección Programadores` };

  return { campos: { nombre, descripcion: descripcion || null, estado, encargado, integrantes } };
}

// Aviso a todas las pestañas de la sección de que cambió la lista (las
// tarjetas se recargan). Sin datos del proyecto: solo el id.
function avisarCambioProyecto(id) {
  emitir({ tipo: 'proyectos', proyecto_id: id });
}

// Integrantes en la forma que usa el chat (encabezado, @menciones, tildes).
function miembrosDe(p, nombres) {
  return (p.integrantes || [])
    .map((u) => ({ username: u, name: nombres[u] || null }))
    .sort((a, b) => a.username.localeCompare(b.username, 'es', { sensitivity: 'base' }));
}

function emitirChat(p, evento) {
  emitir({ tipo: 'proyecto', para: p.integrantes || [], proyecto_id: p.id, proyecto_nombre: p.nombre, evento });
}

// Carga el proyecto de :id. Con `soloIntegrantes`, además corta con 403 si
// el que pide no es integrante (todo lo del chat).
async function cargarProyecto(req, res, { soloIntegrantes = false } = {}) {
  const id = parseId(req.params.id);
  const p = id == null ? null : await proyectosDb.getProyecto(id);
  if (!p) {
    res.status(404).json({ error: 'Proyecto no encontrado' });
    return null;
  }
  if (soloIntegrantes && !esIntegrante(p, usernameDe(req))) {
    res.status(403).json({ error: 'El chat es solo para los integrantes del proyecto' });
    return null;
  }
  return p;
}

function chatSoloLectura(p, res) {
  if (!p.archivado_at) return false;
  res.status(400).json({ error: 'El proyecto está archivado: su chat queda solo para leer' });
  return true;
}

// GET /admin/programadores/proyectos?archivados=1 — tarjetas + quiénes se
// pueden elegir como encargado/integrantes.
router.get('/programadores/proyectos', async (req, res) => {
  try {
    const username = usernameDe(req);
    const archivados = req.query.archivados === '1' || req.query.archivados === 'true';
    const [rows, usuarios] = await Promise.all([
      proyectosDb.listProyectos(username, { archivados }),
      listMiembros(),
    ]);
    return res.json({ ok: true, proyectos: await proyectosParaFront(rows, username), usuarios });
  } catch (err) {
    console.error('programadores proyectos list error:', err);
    return res.status(500).json({ error: 'Error cargando los proyectos', detail: err.message });
  }
});

// GET /admin/programadores/proyectos/no-leidos — { count } para el badge del menú.
router.get('/programadores/proyectos/no-leidos', async (req, res) => {
  try {
    const username = usernameDe(req);
    if (!username) return res.status(401).json({ error: 'Sesión sin usuario' });
    return res.json({ ok: true, count: await proyectosDb.contarNoLeidos(username) });
  } catch (err) {
    console.error('programadores proyectos no-leidos error:', err);
    return res.status(500).json({ error: 'Error contando no leídos', detail: err.message });
  }
});

// POST /admin/programadores/proyectos — { nombre, descripcion, estado, encargado, integrantes[] }
router.post('/programadores/proyectos', async (req, res) => {
  try {
    const username = usernameDe(req);
    if (!username) return res.status(401).json({ error: 'Sesión sin usuario' });
    const { campos, error } = await leerCampos(req.body);
    if (error) return res.status(400).json({ error });
    const creado = await proyectosDb.crearProyecto({ ...campos, creadoPor: username });
    const [proyecto] = await proyectosParaFront([creado], username);
    avisarCambioProyecto(creado.id);
    return res.json({ ok: true, proyecto });
  } catch (err) {
    console.error('programadores proyectos create error:', err);
    return res.status(500).json({ error: 'Error creando el proyecto', detail: err.message });
  }
});

// GET /admin/programadores/proyectos/:id
router.get('/programadores/proyectos/:id', async (req, res) => {
  try {
    const p = await cargarProyecto(req, res);
    if (!p) return undefined;
    const [proyecto] = await proyectosParaFront([p], usernameDe(req));
    return res.json({ ok: true, proyecto, usuarios: await listMiembros() });
  } catch (err) {
    console.error('programadores proyectos get error:', err);
    return res.status(500).json({ error: 'Error cargando el proyecto', detail: err.message });
  }
});

// PUT /admin/programadores/proyectos/:id — mismos campos que el POST.
router.put('/programadores/proyectos/:id', async (req, res) => {
  try {
    const username = usernameDe(req);
    const p = await cargarProyecto(req, res);
    if (!p) return undefined;
    if (!puedeEditar(p, username)) return res.status(403).json({ error: 'Solo el encargado o quien creó el proyecto pueden editarlo' });
    const { campos, error } = await leerCampos(req.body, p);
    if (error) return res.status(400).json({ error });
    const antes = new Set(p.integrantes || []);
    const nuevos = campos.integrantes.filter((u) => !antes.has(u));
    const actualizado = await proyectosDb.actualizarProyecto(p.id, campos, nuevos);
    if (!actualizado) return res.status(404).json({ error: 'Proyecto no encontrado' });
    const [proyecto] = await proyectosParaFront([actualizado], username);
    avisarCambioProyecto(p.id);
    // El encabezado del chat abierto se entera al toque de quién entró/salió.
    const nombres = Object.fromEntries(proyecto.integrantes.filter((u) => u.name).map((u) => [u.username, u.name]));
    emitirChat(actualizado, { tipo: 'miembros', miembros: miembrosDe(actualizado, nombres) });
    return res.json({ ok: true, proyecto });
  } catch (err) {
    console.error('programadores proyectos update error:', err);
    return res.status(500).json({ error: 'Error guardando el proyecto', detail: err.message });
  }
});

// PUT /admin/programadores/proyectos/:id/archivo — { archivado: true|false }
router.put('/programadores/proyectos/:id/archivo', async (req, res) => {
  try {
    const username = usernameDe(req);
    const p = await cargarProyecto(req, res);
    if (!p) return undefined;
    if (!puedeEditar(p, username)) return res.status(403).json({ error: 'Solo el encargado o quien creó el proyecto pueden archivarlo' });
    const actualizado = await proyectosDb.setArchivado(p.id, !!req.body?.archivado);
    const [proyecto] = await proyectosParaFront([actualizado], username);
    avisarCambioProyecto(p.id);
    return res.json({ ok: true, proyecto });
  } catch (err) {
    console.error('programadores proyectos archivo error:', err);
    return res.status(500).json({ error: 'Error archivando el proyecto', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Chat del proyecto: mismas rutas y forma de respuesta que el Chat de
// Programadores, para que el front use el mismo componente (ChatSala).
// ---------------------------------------------------------------------------

// GET /admin/programadores/proyectos/:id/mensajes?despues_de=ID[&cambios_desde=ISO] | ?antes_de=ID
router.get('/programadores/proyectos/:id/mensajes', async (req, res) => {
  try {
    const p = await cargarProyecto(req, res, { soloIntegrantes: true });
    if (!p) return undefined;
    const despuesDe = parseId(req.query.despues_de);
    const antesDe = parseId(req.query.antes_de);
    const cambiosDesde = parseFecha(req.query.cambios_desde);
    const [{ mensajes, hayMas, ahora }, lecturas, nombres] = await Promise.all([
      proyectosDb.listMensajes(p.id, { despuesDe, antesDe, cambiosDesde }),
      proyectosDb.listLecturas(p.id),
      proyectosDb.nombresDe(p.integrantes),
    ]);
    return res.json({ ok: true, mensajes: await serializarMensajes(mensajes), hayMas, ahora, lecturas, miembros: miembrosDe(p, nombres) });
  } catch (err) {
    console.error('programadores proyectos chat list error:', err);
    return res.status(500).json({ error: 'Error cargando el chat', detail: err.message });
  }
});

// POST /admin/programadores/proyectos/:id/mensajes — multipart: texto,
// archivos[], responde_a_id, cliente_id.
router.post('/programadores/proyectos/:id/mensajes', subirArchivos, async (req, res) => {
  try {
    const username = usernameDe(req);
    if (!username) return res.status(401).json({ error: 'Sesión sin usuario' });
    const p = await cargarProyecto(req, res, { soloIntegrantes: true });
    if (!p || chatSoloLectura(p, res)) return undefined;

    const texto = String(req.body?.texto || '').trim();
    const archivos = Array.isArray(req.files) ? req.files : [];
    const clienteId = req.body?.cliente_id ? String(req.body.cliente_id).slice(0, 80) : null;
    if (!texto && !archivos.length) return res.status(400).json({ error: 'El mensaje está vacío' });
    if (texto.length > MAX_TEXTO) return res.status(400).json({ error: `El mensaje puede tener hasta ${MAX_TEXTO} caracteres` });

    let respondeAId = null;
    if (req.body?.responde_a_id) {
      respondeAId = parseId(req.body.responde_a_id);
      if (respondeAId == null || !(await proyectosDb.getMensaje(p.id, respondeAId))) {
        return res.status(400).json({ error: 'El mensaje al que respondés no existe' });
      }
    }

    const adjuntos = await guardarAdjuntos(archivos, `proyectos/${p.id}`);
    const creado = await proyectosDb.createMensaje({
      proyectoId: p.id,
      autorId: req.admin?.sub || null,
      autorUsername: username,
      texto,
      adjuntos,
      respondeAId,
    });
    // El que escribe ya "leyó" hasta su propio mensaje.
    const ultimoLeido = await proyectosDb.marcarLeido(p.id, username, Number(creado.id));
    const [mensaje] = await serializarMensajes([creado], clienteId ? { cliente_id: clienteId } : {});
    emitirChat(p, { tipo: 'mensaje', mensaje });
    emitirChat(p, { tipo: 'lectura', username, ultimo_leido_id: ultimoLeido });
    return res.json({ ok: true, mensaje });
  } catch (err) {
    console.error('programadores proyectos chat send error:', err);
    return res.status(500).json({ error: err.message || 'Error enviando el mensaje' });
  }
});

// Proyecto (integrante, no archivado) + mensaje de :mid dentro de él.
async function cargarMensaje(req, res) {
  const p = await cargarProyecto(req, res, { soloIntegrantes: true });
  if (!p || chatSoloLectura(p, res)) return null;
  const mid = parseId(req.params.mid);
  const m = mid == null ? null : await proyectosDb.getMensaje(p.id, mid);
  if (!m) {
    res.status(404).json({ error: 'Mensaje no encontrado' });
    return null;
  }
  return { p, m };
}

async function cargarMensajePropio(req, res) {
  const r = await cargarMensaje(req, res);
  if (!r) return null;
  if (r.m.autor_username !== usernameDe(req)) {
    res.status(403).json({ error: 'Solo podés modificar tus propios mensajes' });
    return null;
  }
  return r;
}

// PUT /admin/programadores/proyectos/:id/mensajes/:mid — { texto }
router.put('/programadores/proyectos/:id/mensajes/:mid', async (req, res) => {
  try {
    const r = await cargarMensajePropio(req, res);
    if (!r) return undefined;
    const { p, m } = r;
    if (m.eliminado_at) return res.status(400).json({ error: 'El mensaje está eliminado' });
    const texto = String(req.body?.texto || '').trim();
    if (!texto && !adjuntosDe(m).length) return res.status(400).json({ error: 'El mensaje no puede quedar vacío' });
    if (texto.length > MAX_TEXTO) return res.status(400).json({ error: `El mensaje puede tener hasta ${MAX_TEXTO} caracteres` });
    if (texto === String(m.texto || '')) {
      const [mensaje] = await serializarMensajes([m]);
      return res.json({ ok: true, mensaje });
    }
    const editado = await proyectosDb.editarMensaje(m.id, texto);
    if (!editado) return res.status(400).json({ error: 'El mensaje está eliminado' });
    const [mensaje] = await serializarMensajes([editado]);
    emitirChat(p, { tipo: 'cambio', mensaje });
    return res.json({ ok: true, mensaje });
  } catch (err) {
    console.error('programadores proyectos chat edit error:', err);
    return res.status(500).json({ error: 'Error editando el mensaje', detail: err.message });
  }
});

// DELETE /admin/programadores/proyectos/:id/mensajes/:mid — borrado lógico.
router.delete('/programadores/proyectos/:id/mensajes/:mid', async (req, res) => {
  try {
    const r = await cargarMensajePropio(req, res);
    if (!r) return undefined;
    const eliminado = await proyectosDb.eliminarMensaje(r.m.id);
    const [mensaje] = await serializarMensajes([eliminado]);
    emitirChat(r.p, { tipo: 'cambio', mensaje });
    return res.json({ ok: true, mensaje });
  } catch (err) {
    console.error('programadores proyectos chat delete error:', err);
    return res.status(500).json({ error: 'Error eliminando el mensaje', detail: err.message });
  }
});

// PUT /admin/programadores/proyectos/:id/mensajes/:mid/reaccion — { emoji } (null/'' la quita)
router.put('/programadores/proyectos/:id/mensajes/:mid/reaccion', async (req, res) => {
  try {
    const username = usernameDe(req);
    if (!username) return res.status(401).json({ error: 'Sesión sin usuario' });
    const r = await cargarMensaje(req, res);
    if (!r) return undefined;
    if (r.m.eliminado_at) return res.status(400).json({ error: 'El mensaje está eliminado' });
    const emoji = req.body?.emoji ? String(req.body.emoji).trim() : '';
    if (emoji.length > MAX_EMOJI || /[\s<>]/.test(emoji)) return res.status(400).json({ error: 'Reacción inválida' });
    const actualizado = await proyectosDb.setReaccion(r.m.id, username, emoji || null);
    const [mensaje] = await serializarMensajes([actualizado]);
    emitirChat(r.p, { tipo: 'cambio', mensaje });
    return res.json({ ok: true, mensaje });
  } catch (err) {
    console.error('programadores proyectos chat reaccion error:', err);
    return res.status(500).json({ error: 'Error guardando la reacción', detail: err.message });
  }
});

// POST /admin/programadores/proyectos/:id/leido — { hasta_id }
router.post('/programadores/proyectos/:id/leido', async (req, res) => {
  try {
    const username = usernameDe(req);
    if (!username) return res.status(401).json({ error: 'Sesión sin usuario' });
    const hastaId = parseId(req.body?.hasta_id);
    if (hastaId == null) return res.status(400).json({ error: 'hasta_id inválido' });
    const p = await cargarProyecto(req, res, { soloIntegrantes: true });
    if (!p) return undefined;
    const ultimoLeido = await proyectosDb.marcarLeido(p.id, username, hastaId);
    emitirChat(p, { tipo: 'lectura', username, ultimo_leido_id: ultimoLeido });
    return res.json({ ok: true });
  } catch (err) {
    console.error('programadores proyectos chat leido error:', err);
    return res.status(500).json({ error: 'Error marcando como leído', detail: err.message });
  }
});

module.exports = router;
