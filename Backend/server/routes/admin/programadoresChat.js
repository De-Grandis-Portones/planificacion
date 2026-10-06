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
const express = require('express');
const { adminAuth } = require('../../middleware/adminAuth');
const chatDb = require('../../lib/programadoresChatDb');
const {
  requireScope, eventos, emitir, MAX_TEXTO, MAX_EMOJI, subirArchivos,
  parseId, parseFecha, usernameDe, adjuntosDe, guardarAdjuntos, crearSerializador,
} = require('../../lib/programadoresChatComun');

const router = express.Router();

// Con path: ver nota equivalente en admin/prefabricados.js.
router.use('/programadores/chat', adminAuth, requireScope(chatDb.SCOPE));

const serializar = crearSerializador({
  listReacciones: chatDb.listReacciones,
  getMensajesPorIds: chatDb.getMensajesPorIds,
});

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

    const adjuntos = await guardarAdjuntos(archivos);

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
// Por este mismo canal llegan también los eventos de los chats de proyectos
// (tipo 'proyecto', ver admin/programadoresProyectos.js), solo a quienes
// figuran en su `para`.
router.get('/programadores/chat/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const username = usernameDe(req);
  const enviar = ({ para, ...ev }) => {
    if (para && !para.includes(username)) return;
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
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
