// lib/reunionesDb.js
//
// Reuniones y Tareas (/admin/reuniones): agenda compartida entre admins para
// cargar fecha/hora de reuniones propias. Sin invitados/RSVP (no se pidió) -
// un espacio compartido, cualquier admin ve/crea/edita/borra cualquier
// reunión, mismo criterio "sin scope propio" que ya usa /admin/tickets.
const { pool } = require('../db');

const REUNION_COLS = `
  id, titulo, descripcion,
  to_char(fecha, 'YYYY-MM-DD') as fecha,
  to_char(hora_inicio, 'HH24:MI') as hora_inicio,
  to_char(hora_fin, 'HH24:MI') as hora_fin,
  enlace, creado_por, created_at, updated_at
`;

// Rango [desde, hasta] inclusive - pensado para traer un mes de calendario a
// la vez. Sin filtro, trae todo (volumen bajo, no hace falta paginar hoy).
async function listReuniones({ desde, hasta } = {}) {
  const params = [];
  const where = [];
  if (desde) { params.push(desde); where.push(`fecha >= $${params.length}`); }
  if (hasta) { params.push(hasta); where.push(`fecha <= $${params.length}`); }
  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const { rows } = await pool.query(
    `select ${REUNION_COLS} from public.reuniones ${whereSql} order by fecha asc, hora_inicio asc;`,
    params
  );
  return rows;
}

async function getReunion(id) {
  const nId = Number(id);
  if (!Number.isInteger(nId)) return null;
  const { rows } = await pool.query(`select ${REUNION_COLS} from public.reuniones where id = $1;`, [nId]);
  return rows[0] || null;
}

async function createReunion({ titulo, descripcion, fecha, horaInicio, horaFin, enlace, creadoPor }) {
  const { rows } = await pool.query(
    `insert into public.reuniones (titulo, descripcion, fecha, hora_inicio, hora_fin, enlace, creado_por)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning ${REUNION_COLS};`,
    [titulo, descripcion || null, fecha, horaInicio, horaFin || null, enlace || null, creadoPor || null]
  );
  return rows[0];
}

async function updateReunion(id, { titulo, descripcion, fecha, horaInicio, horaFin, enlace }) {
  const nId = Number(id);
  if (!Number.isInteger(nId)) return null;
  const { rows } = await pool.query(
    `update public.reuniones
        set titulo = $2, descripcion = $3, fecha = $4, hora_inicio = $5, hora_fin = $6, enlace = $7, updated_at = now()
      where id = $1
      returning ${REUNION_COLS};`,
    [nId, titulo, descripcion || null, fecha, horaInicio, horaFin || null, enlace || null]
  );
  return rows[0] || null;
}

async function deleteReunion(id) {
  const nId = Number(id);
  if (!Number.isInteger(nId)) return null;
  const { rows } = await pool.query(`delete from public.reuniones where id = $1 returning id;`, [nId]);
  return rows[0] || null;
}

module.exports = { listReuniones, getReunion, createReunion, updateReunion, deleteReunion };
