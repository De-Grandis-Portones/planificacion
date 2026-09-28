// routes/admin/tickets.js — sistema de tickets: cualquier admin logueado
// puede crear tickets, ver/responder los propios, y también ver/responder/
// cerrar cualquier ticket desde /admin/tickets (sin scope propio, igual que
// /admin/indice-programacion: una pantalla admin más, no restringida).
const express = require('express');
const { adminAuth } = require('../../middleware/adminAuth');
const ticketsDb = require('../../lib/ticketsDb');

const router = express.Router();

const ESTADOS_VALIDOS = ['pending', 'in_progress', 'closed'];
// `app_origen` normalmente lo pone el backend ('planificacion', fijo) - un
// admin no puede mandar cualquier string y hacerse pasar por otra app. La
// única excepción es 'tarea': tarjetas que un admin crea directo desde el
// tablero (/admin/tickets-tablero), sin que las mande otra app vía ticket.
const APP_ORIGENES_MANUAL_PERMITIDOS = ['planificacion', 'tarea'];
// Columnas FIJAS del tablero (ver AdminTicketsBoardPage.jsx APP_ORDER) - una
// tarjeta "tarea" también puede vivir en cualquier "apartado" custom que un
// admin haya creado (tabla ticket_board_apartados), por eso la lista final
// de columnas válidas se calcula en runtime con getColumnasValidas().
const COLUMNAS_TABLERO_FIJAS = ['tarea', 'planificacion', 'integrador', 'presupuestador', 'remitos', 'informe-ventas', 'distribuidor'];

async function getColumnasValidas() {
  const apartados = await ticketsDb.listApartados();
  return new Set([...COLUMNAS_TABLERO_FIJAS, ...apartados.map((a) => a.clave)]);
}
const MAX_ADJUNTOS = 5;
// ~15MB de bytes crudos de adjuntos (igual al límite combinado del cliente,
// ver ticketAttachment.js) codificado en base64 (~x1.34). El cliente ya
// valida esto antes de enviar, pero acá no hay que confiar ciegamente en
// eso: es la segunda línea de defensa server-side.
const MAX_ADJUNTOS_DATA_URL_CHARS = 21 * 1024 * 1024;
// El cliente SIEMPRE genera data_url con FileReader.readAsDataURL(), así que
// nunca debería ser otra cosa. Sin este chequeo, alguien podía mandar
// data_url = "https://atacante.com/pixel.gif" (o un data: URI con un mime no
// permitido, ej. text/html) y que se renderizara solo (<img src>) o se
// abriera (openTicketAttachment) al primer admin que mirara el ticket —
// tracking pixel o, peor, un blob text/html ejecutando JS en el origen del
// panel admin (robo de token vía localStorage). Se valida el mime REAL
// embebido en el data: URI, no el campo `type` (que también lo controla
// quien manda el ticket y no tiene por qué coincidir).
const ALLOWED_ADJUNTO_DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp|gif)|application\/pdf|video\/(?:mp4|quicktime|webm));base64,/i;

function normalizeAdjuntos(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_ADJUNTOS).map((a) => ({
    name: String(a?.name || 'adjunto').slice(0, 200),
    type: String(a?.type || 'application/octet-stream').slice(0, 100),
    size: Number(a?.size || 0) || 0,
    data_url: String(a?.data_url || ''),
    uploaded_at: a?.uploaded_at || new Date().toISOString(),
  })).filter((a) => ALLOWED_ADJUNTO_DATA_URL_RE.test(a.data_url));
}

function adjuntosExceedTotal(adjuntos) {
  return adjuntos.reduce((sum, a) => sum + a.data_url.length, 0) > MAX_ADJUNTOS_DATA_URL_CHARS;
}

// POST /admin/tickets — crear un ticket
router.post('/tickets', adminAuth, async (req, res) => {
  try {
    const categoria = String(req.body?.categoria || '').trim();
    const mensaje = String(req.body?.mensaje || '').trim();
    const rutaOrigen = req.body?.rutaOrigen ? String(req.body.rutaOrigen) : null;
    if (!categoria) return res.status(400).json({ error: 'Falta la categoría' });
    if (!mensaje) return res.status(400).json({ error: 'Falta el mensaje' });
    const adjuntos = normalizeAdjuntos(req.body?.adjuntos);
    if (adjuntosExceedTotal(adjuntos)) {
      return res.status(400).json({ error: 'Los adjuntos superan el tamaño total permitido.' });
    }
    const appOrigenReq = String(req.body?.appOrigen || '').trim();
    const appOrigen = APP_ORIGENES_MANUAL_PERMITIDOS.includes(appOrigenReq) ? appOrigenReq : 'planificacion';
    // boardColumn solo importa para 'tarea' (en qué columna/apartado se creó
    // la tarjeta) - se valida contra las columnas que existen HOY (fijas +
    // apartados custom), si no llega ninguna válida cae en 'tarea'.
    let boardColumn = null;
    if (appOrigen === 'tarea') {
      const columnasValidas = await getColumnasValidas();
      const boardColumnReq = String(req.body?.boardColumn || '').trim();
      boardColumn = columnasValidas.has(boardColumnReq) ? boardColumnReq : 'tarea';
    }

    const ticket = await ticketsDb.createTicket({
      categoria,
      mensaje,
      rutaOrigen,
      creadoPorId: req.admin?.sub || null,
      creadoPorUsername: req.admin?.username || null,
      appOrigen,
      boardColumn,
      adjuntos,
    });
    return res.json({ ok: true, ticket });
  } catch (err) {
    console.error('tickets create error:', err);
    return res.status(500).json({ error: 'Error creando el ticket', detail: err.message });
  }
});

// GET /admin/tickets/mine — mis tickets (van antes de /:id para que Express
// no confunda "mine" con un id).
router.get('/tickets/mine', adminAuth, async (req, res) => {
  try {
    const userId = req.admin?.sub || null;
    const tickets = await ticketsDb.listMyTickets(userId);
    return res.json({ ok: true, tickets });
  } catch (err) {
    console.error('tickets mine list error:', err);
    return res.status(500).json({ error: 'Error listando tus tickets', detail: err.message });
  }
});

// GET /admin/tickets/mine/:id — detalle de un ticket propio
router.get('/tickets/mine/:id', adminAuth, async (req, res) => {
  try {
    const userId = req.admin?.sub || null;
    const ticket = await ticketsDb.getTicketForOwner(Number(req.params.id), userId);
    if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
    return res.json({ ok: true, ticket });
  } catch (err) {
    console.error('tickets mine detail error:', err);
    return res.status(500).json({ error: 'Error obteniendo el ticket', detail: err.message });
  }
});

// POST /admin/tickets/mine/:id/messages — agregar un mensaje a un ticket propio
router.post('/tickets/mine/:id/messages', adminAuth, async (req, res) => {
  try {
    const userId = req.admin?.sub || null;
    const ticket = await ticketsDb.getTicketForOwner(Number(req.params.id), userId);
    if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
    const mensaje = String(req.body?.mensaje || '').trim();
    if (!mensaje) return res.status(400).json({ error: 'Falta el mensaje' });
    const nuevo = await ticketsDb.addMessage(ticket.id, {
      autorId: userId,
      autorUsername: req.admin?.username || null,
      esAdmin: false,
      mensaje,
    });
    return res.json({ ok: true, mensaje: nuevo });
  } catch (err) {
    console.error('tickets mine message error:', err);
    return res.status(500).json({ error: 'Error agregando el mensaje', detail: err.message });
  }
});

// DELETE /admin/tickets/mine/:id — anular (= borrar) un ticket propio,
// autoservicio, no hace falta que intervenga soporte. Solo si todavía no
// está "closed" (ya resuelto por soporte, eso queda como historial).
router.delete('/tickets/mine/:id', adminAuth, async (req, res) => {
  try {
    const userId = req.admin?.sub || null;
    const borrado = await ticketsDb.deleteOwnTicket(Number(req.params.id), userId);
    if (!borrado) {
      return res.status(404).json({ error: 'Ticket no encontrado o ya no se puede anular' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('tickets mine delete error:', err);
    return res.status(500).json({ error: 'Error anulando el ticket', detail: err.message });
  }
});

// ---- Pantalla admin /admin/tickets: cualquier admin logueado gestiona todos ----

// GET /admin/tickets — listar todos, filtro opcional ?estado=&categoria=
router.get('/tickets', adminAuth, async (req, res) => {
  try {
    const estado = req.query.estado ? String(req.query.estado) : undefined;
    const categoria = req.query.categoria ? String(req.query.categoria) : undefined;
    const appOrigen = req.query.app ? String(req.query.app) : undefined;
    const tickets = await ticketsDb.listAllTickets({ estado, categoria, appOrigen });
    return res.json({ ok: true, tickets });
  } catch (err) {
    console.error('tickets admin list error:', err);
    return res.status(500).json({ error: 'Error listando tickets', detail: err.message });
  }
});

// GET /admin/tickets/apartados — listar los apartados custom del tablero
// (van antes de /:id para que Express no confunda "apartados" con un id).
router.get('/tickets/apartados', adminAuth, async (req, res) => {
  try {
    const apartados = await ticketsDb.listApartados();
    return res.json({ ok: true, apartados });
  } catch (err) {
    console.error('tickets apartados list error:', err);
    return res.status(500).json({ error: 'Error listando los apartados', detail: err.message });
  }
});

// POST /admin/tickets/apartados — crear un apartado custom (columna extra
// del tablero, ver "+ Nuevo apartado" en AdminTicketsBoardPage.jsx)
router.post('/tickets/apartados', adminAuth, async (req, res) => {
  try {
    const nombre = String(req.body?.nombre || '').trim().slice(0, 60);
    if (!nombre) return res.status(400).json({ error: 'Falta el nombre del apartado' });
    const apartado = await ticketsDb.createApartado(nombre);
    return res.json({ ok: true, apartado });
  } catch (err) {
    console.error('tickets apartados create error:', err);
    return res.status(500).json({ error: 'Error creando el apartado', detail: err.message });
  }
});

// DELETE /admin/tickets/apartados/:clave — borrar un apartado custom. Los
// fijos (una por app real + "Tareas") no pasan por acá - no tienen ninguna
// fila en ticket_board_apartados, así que esto nunca los toca.
router.delete('/tickets/apartados/:clave', adminAuth, async (req, res) => {
  try {
    const borrado = await ticketsDb.deleteApartado(String(req.params.clave));
    if (!borrado) {
      return res.status(404).json({ error: 'Apartado no encontrado' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('tickets apartados delete error:', err);
    return res.status(500).json({ error: 'Error borrando el apartado', detail: err.message });
  }
});

// GET /admin/tickets/:id — detalle de cualquier ticket
router.get('/tickets/:id', adminAuth, async (req, res) => {
  try {
    const ticket = await ticketsDb.getTicketAdmin(Number(req.params.id));
    if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
    return res.json({ ok: true, ticket });
  } catch (err) {
    console.error('tickets admin detail error:', err);
    return res.status(500).json({ error: 'Error obteniendo el ticket', detail: err.message });
  }
});

// POST /admin/tickets/:id/messages — responder
router.post('/tickets/:id/messages', adminAuth, async (req, res) => {
  try {
    const ticket = await ticketsDb.getTicketAdmin(Number(req.params.id));
    if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
    const mensaje = String(req.body?.mensaje || '').trim();
    if (!mensaje) return res.status(400).json({ error: 'Falta el mensaje' });
    const nuevo = await ticketsDb.addMessage(ticket.id, {
      autorId: req.admin?.sub || null,
      autorUsername: req.admin?.username || null,
      esAdmin: true,
      mensaje,
    });
    return res.json({ ok: true, mensaje: nuevo });
  } catch (err) {
    console.error('tickets admin message error:', err);
    return res.status(500).json({ error: 'Error agregando el mensaje', detail: err.message });
  }
});

// PATCH /admin/tickets/:id/status — cambiar estado
router.patch('/tickets/:id/status', adminAuth, async (req, res) => {
  try {
    const estado = String(req.body?.estado || '').trim();
    if (!ESTADOS_VALIDOS.includes(estado)) {
      return res.status(400).json({ error: `Estado inválido. Debe ser uno de: ${ESTADOS_VALIDOS.join(', ')}` });
    }
    const ticket = await ticketsDb.setEstado(Number(req.params.id), estado, req.admin?.username || null);
    if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
    return res.json({ ok: true, ticket });
  } catch (err) {
    console.error('tickets admin status error:', err);
    return res.status(500).json({ error: 'Error actualizando el estado', detail: err.message });
  }
});

// PATCH /admin/tickets/:id/asignado — "Asignarme"/"Tomar" (accion:'asignar',
// default) o "Quitarme" (accion:'liberar'). Un click directo en el modal
// (ver AdminTicketDetailModal.jsx) para dejar constancia de quién está
// trabajando en un ticket/tarea, en CUALQUIER estado - no hace falta pasar
// por "En curso" (que también lo pisa automáticamente, ver PATCH .../status
// más abajo, pero esto da un control explícito además de ese efecto
// automático).
router.patch('/tickets/:id/asignado', adminAuth, async (req, res) => {
  try {
    const accion = String(req.body?.accion || 'asignar').trim();
    const valor = accion === 'liberar' ? null : (req.admin?.username || null);
    const ticket = await ticketsDb.setEnProgresoPor(Number(req.params.id), valor);
    if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
    return res.json({ ok: true, ticket });
  } catch (err) {
    console.error('tickets admin asignado error:', err);
    return res.status(500).json({ error: 'Error asignando el ticket', detail: err.message });
  }
});

// PATCH /admin/tickets/:id/board-column — mover una tarjeta "tarea" a otra
// columna del tablero (ver AdminTicketsBoardPage.jsx). Solo aplica a
// tarjetas creadas a mano (app_origen='tarea') - un ticket real de otra app
// no se puede reasignar de columna, setBoardColumn no toca esas filas.
router.patch('/tickets/:id/board-column', adminAuth, async (req, res) => {
  try {
    const columna = String(req.body?.column || '').trim();
    const columnasValidas = await getColumnasValidas();
    if (!columnasValidas.has(columna)) {
      return res.status(400).json({ error: `Columna inválida. Debe ser una de: ${[...columnasValidas].join(', ')}` });
    }
    const ticket = await ticketsDb.setBoardColumn(Number(req.params.id), columna);
    if (!ticket) {
      return res.status(404).json({ error: 'Tarea no encontrada (o no es una tarjeta de tipo tarea)' });
    }
    return res.json({ ok: true, ticket });
  } catch (err) {
    console.error('tickets admin board-column error:', err);
    return res.status(500).json({ error: 'Error moviendo la tarea', detail: err.message });
  }
});

// DELETE /admin/tickets/:id — borrar un ticket, a mano, sea cual sea su
// estado (pendiente/en curso/cerrado o una tarea) - a pedido explícito del
// usuario, ver el comentario en ticketsDb.deleteTicketAdmin.
router.delete('/tickets/:id', adminAuth, async (req, res) => {
  try {
    const borrado = await ticketsDb.deleteTicketAdmin(Number(req.params.id));
    if (!borrado) {
      return res.status(404).json({ error: 'Ticket no encontrado' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('tickets admin delete error:', err);
    return res.status(500).json({ error: 'Error borrando el ticket', detail: err.message });
  }
});

module.exports = router;
