// lib/ticketsDb.js — capa de datos del sistema de tickets: un admin logueado
// crea un ticket (categoría + texto libre) y puede ver/responder los propios;
// cualquier admin logueado ve/responde/cierra todos desde /admin/tickets.
const { pool } = require('../db');

// Las consultas de LISTADO (varias filas, para pintar una tabla/lista) NO
// traen `adjuntos` a propósito: esa columna puede pesar varios MB por fila
// (adjuntos en base64, hasta ~15MB combinados por ticket) y la lista solo
// necesita estos campos. El detalle de un ticket puntual (getTicketForOwner/
// getTicketAdmin) sí trae todo con `select *`. Sin este recorte, cada poll
// del badge de "no leídos"/pendientes (cada 60s por pestaña abierta) y cada
// carga de /admin/tickets bajaban el base64 de TODOS los adjuntos de TODOS
// los tickets solo para mostrar categoría/estado/fecha.
const TICKET_LIST_COLUMNS = `
  id, categoria, mensaje, estado, creado_por_id, creado_por_username,
  ruta_origen, app_origen, board_column, en_progreso_por, created_at, updated_at
`;

async function createTicket({ categoria, mensaje, rutaOrigen, creadoPorId, creadoPorUsername, appOrigen, boardColumn, adjuntos }) {
  const appOrigenFinal = appOrigen || 'planificacion';
  // Una tarjeta "tarea" arranca viéndose en la columna donde se creó (la
  // propia "Tareas" o cualquier apartado custom - ver "+ Crear tarea" en
  // cada columna manual); si no llega ninguna, cae en 'tarea' por defecto.
  // Cualquier ticket real (mandado por otra app) no usa board_column, se
  // pinta siempre por su app_origen fijo. Ver migración tickets_board_column.
  // El caller (routes/admin/tickets.js) ya validó que boardColumn sea una
  // columna existente antes de llegar acá.
  const boardColumnFinal = appOrigenFinal === 'tarea' ? (boardColumn || 'tarea') : null;
  const { rows } = await pool.query(
    `
    insert into public.tickets (categoria, mensaje, ruta_origen, creado_por_id, creado_por_username, app_origen, board_column, adjuntos)
    values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    returning *;
    `,
    [
      categoria,
      mensaje,
      rutaOrigen || null,
      creadoPorId || null,
      creadoPorUsername || null,
      appOrigenFinal,
      boardColumnFinal,
      JSON.stringify(Array.isArray(adjuntos) ? adjuntos : []),
    ]
  );
  return rows[0];
}

async function listMyTickets(userId) {
  const { rows } = await pool.query(
    `select ${TICKET_LIST_COLUMNS} from public.tickets where creado_por_id = $1 order by created_at desc;`,
    [userId]
  );
  return rows;
}

async function listAllTickets({ estado, categoria, appOrigen } = {}) {
  const conditions = [];
  const params = [];
  if (estado) {
    params.push(estado);
    conditions.push(`estado = $${params.length}`);
  }
  if (categoria) {
    params.push(categoria);
    conditions.push(`categoria = $${params.length}`);
  }
  if (appOrigen) {
    params.push(appOrigen);
    conditions.push(`app_origen = $${params.length}`);
  }
  const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
  const { rows } = await pool.query(
    `select ${TICKET_LIST_COLUMNS} from public.tickets ${where} order by created_at desc;`,
    params
  );
  return rows;
}

async function listMessages(ticketId) {
  const { rows } = await pool.query(
    `select * from public.ticket_mensajes where ticket_id = $1 order by created_at asc;`,
    [ticketId]
  );
  return rows;
}

async function getTicketForOwner(id, userId) {
  const { rows } = await pool.query(
    `select * from public.tickets where id = $1 and creado_por_id = $2;`,
    [id, userId]
  );
  const ticket = rows[0];
  if (!ticket) return null;
  const mensajes = await listMessages(id);
  return { ...ticket, mensajes };
}

async function getTicketAdmin(id) {
  const { rows } = await pool.query(`select * from public.tickets where id = $1;`, [id]);
  const ticket = rows[0];
  if (!ticket) return null;
  const mensajes = await listMessages(id);
  return { ...ticket, mensajes };
}

async function addMessage(ticketId, { autorId, autorUsername, esAdmin, mensaje }) {
  const { rows } = await pool.query(
    `
    insert into public.ticket_mensajes (ticket_id, autor_id, autor_username, es_admin, mensaje)
    values ($1, $2, $3, $4, $5)
    returning *;
    `,
    [ticketId, autorId || null, autorUsername || null, !!esAdmin, mensaje]
  );
  await pool.query(`update public.tickets set updated_at = now() where id = $1;`, [ticketId]);
  return rows[0];
}

// `actorUsername` es quien está haciendo el cambio (req.admin.username) -
// solo importa para "En curso": ahí queda registrado como "quién lo está
// trabajando ahora" (se pisa cada vez que alguien lo pone en curso, incluso
// si ya estaba en curso por otra persona - "tomar" el ticket). Al volver a
// "Pendiente" se limpia (nadie lo está trabajando ya); al cerrarlo se deja
// como estaba (queda como "quién lo resolvió").
async function setEstado(id, estado, actorUsername) {
  if (estado === 'in_progress') {
    const { rows } = await pool.query(
      `update public.tickets set estado = $2, en_progreso_por = $3, updated_at = now() where id = $1 returning *;`,
      [id, estado, actorUsername || null]
    );
    return rows[0];
  }
  if (estado === 'pending') {
    const { rows } = await pool.query(
      `update public.tickets set estado = $2, en_progreso_por = null, updated_at = now() where id = $1 returning *;`,
      [id, estado]
    );
    return rows[0];
  }
  const { rows } = await pool.query(
    `update public.tickets set estado = $2, updated_at = now() where id = $1 returning *;`,
    [id, estado]
  );
  return rows[0];
}

// Mueve una tarjeta "tarea" a otra columna del tablero. A propósito NO
// reasigna app_origen (queda fijo en 'tarea' para siempre) - solo el WHERE
// app_origen='tarea' importa acá: un ticket real (de otra app) nunca puede
// moverse de columna por este camino, solo tiene el flujo existente
// (Cerrados / reabrir a su propia columna vía setEstado).
async function setBoardColumn(id, boardColumn) {
  const { rows } = await pool.query(
    `update public.tickets set board_column = $2, updated_at = now() where id = $1 and app_origen = 'tarea' returning *;`,
    [id, boardColumn]
  );
  return rows[0] || null;
}

// Anular el propio ticket: BORRA la fila (a pedido explícito del usuario -
// "de qué sirve tenerlo" - no es un soft-delete/estado). Solo quien lo creó,
// y solo si no está "closed" (ya resuelto por soporte - borrar después de
// eso no tiene sentido, ahí sí queda como historial). No hace falta ser
// admin, es autoservicio. `ticket_mensajes` tiene ON DELETE CASCADE, así
// que las respuestas del ticket se borran solas con esto.
async function deleteOwnTicket(id, userId) {
  const { rows } = await pool.query(
    `delete from public.tickets where id = $1 and creado_por_id = $2 and estado != 'closed' returning id;`,
    [id, userId]
  );
  return rows[0] || null;
}

// Borrar un ticket, a mano, desde el panel admin. Cualquier admin (no hace
// falta ser quien lo creó, a diferencia de deleteOwnTicket). Sea cual sea su
// estado (pendiente/en curso/cerrado) - a pedido explícito del usuario, que
// ya conocía la alternativa de dejarlo limitado a solo cerrados/tareas y
// prefirió esto. `ticket_mensajes.ticket_id` tiene ON DELETE CASCADE (ver la
// migración de esa tabla en index.js), así que sus respuestas se borran solas.
async function deleteTicketAdmin(id) {
  const { rows } = await pool.query(
    `delete from public.tickets where id = $1 returning id;`,
    [id]
  );
  return rows[0] || null;
}

// "Apartados": columnas EXTRA del tablero que un admin crea a mano ("+ Nuevo
// apartado" en AdminTicketsBoardPage.jsx), además de las fijas (una por app
// + "Tareas" + "Cerrados"). `clave` es lo que se guarda en
// tickets.board_column para ubicar ahí una tarjeta "tarea"; se deriva del id
// (vía nextval/currval sobre la misma secuencia, en un solo INSERT) para que
// dos altas concurrentes nunca puedan chocar - no hace falta un valor
// temporario compartido que sí podría colisionar.
async function listApartados() {
  const { rows } = await pool.query(
    `select clave, nombre, created_at from public.ticket_board_apartados order by created_at asc;`
  );
  return rows;
}

async function createApartado(nombre) {
  const { rows } = await pool.query(
    `
    insert into public.ticket_board_apartados (id, clave, nombre)
    values (
      nextval('public.ticket_board_apartados_id_seq'),
      'apartado_' || currval('public.ticket_board_apartados_id_seq'),
      $1
    )
    returning clave, nombre, created_at;
    `,
    [nombre]
  );
  return rows[0];
}

// "Asignarme"/"Tomar"/"Quitarme" (botón directo en el modal, ver
// AdminTicketDetailModal.jsx) - a diferencia de lo que hace setEstado, esto
// SIEMPRE deja poner o quitar quién está trabajando en un ticket/tarea, sin
// importar en qué estado esté (no hace falta que esté "En curso"). `valor`
// null lo libera.
async function setEnProgresoPor(id, valor) {
  const { rows } = await pool.query(
    `update public.tickets set en_progreso_por = $2, updated_at = now() where id = $1 returning *;`,
    [id, valor]
  );
  return rows[0] || null;
}

// Borrar un apartado custom. Las tarjetas "tarea" que estaban viviendo ahí
// NO se borran ni quedan huérfanas - vuelven a la columna "Tareas" (el
// fallback de siempre, mismo criterio que columnaActualDe en el frontend),
// así nunca "desaparecen" del tablero por borrar el apartado donde estaban.
// Transacción porque son dos escrituras relacionadas (mover las tarjetas y
// después borrar la fila) que tienen que aplicarse juntas o ninguna.
async function deleteApartado(clave) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `update public.tickets set board_column = 'tarea', updated_at = now() where board_column = $1 and app_origen = 'tarea';`,
      [clave]
    );
    const { rows } = await client.query(
      `delete from public.ticket_board_apartados where clave = $1 returning clave;`,
      [clave]
    );
    await client.query('COMMIT');
    return rows[0] || null;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  createTicket,
  listMyTickets,
  listAllTickets,
  getTicketForOwner,
  getTicketAdmin,
  addMessage,
  setEstado,
  setEnProgresoPor,
  setBoardColumn,
  deleteOwnTicket,
  deleteTicketAdmin,
  listApartados,
  createApartado,
  deleteApartado,
};
