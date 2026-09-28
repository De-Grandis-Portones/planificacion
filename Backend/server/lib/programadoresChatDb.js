// lib/programadoresChatDb.js
//
// Chat de Programadores (/admin/programadores/chat): un único grupo tipo
// WhatsApp entre los usuarios con scope programadores:admin. Eliminar es
// lógico (eliminado_at): el mensaje queda en la base, solo deja de mostrarse.
const { pool } = require('../db');

const SCOPE = 'programadores:admin';
const PAGINA = 50;

const MENSAJE_COLS = `id, autor_id, autor_username, texto, adjuntos, responde_a_id,
  editado_at, eliminado_at, created_at, updated_at`;

// Tres modos, excluyentes:
// - despuesDe: lo nuevo desde el último que ya tiene el front (polling de
//   respaldo). Con cambiosDesde trae además los mensajes ya existentes que
//   se editaron/eliminaron/recibieron reacciones desde ese momento.
// - antesDe: la página anterior ("Cargar anteriores").
// - ninguno: los últimos PAGINA (carga inicial).
// Siempre devuelve en orden cronológico (id asc) + `ahora` (reloj de la
// base) para usar como próximo cambiosDesde.
async function listMensajes({ despuesDe, antesDe, cambiosDesde } = {}) {
  if (despuesDe != null) {
    // Margen de 10s: una transacción que arrancó antes de este SELECT pero
    // commiteó después tiene updated_at "viejo" y se perdería sin margen.
    // Traer de más es inofensivo (el front reemplaza por id).
    const { rows } = await pool.query(
      `select ${MENSAJE_COLS}, now() as ahora from public.programadores_chat_mensajes
        where id > $1 or ($2::timestamptz is not null and updated_at > $2::timestamptz - interval '10 seconds')
        order by id asc limit 300;`,
      [despuesDe, cambiosDesde || null]
    );
    const ahora = rows[0]?.ahora || (await pool.query('select now() as ahora')).rows[0].ahora;
    return { mensajes: rows, hayMas: false, ahora };
  }
  const params = [PAGINA + 1];
  let where = '';
  if (antesDe != null) {
    params.push(antesDe);
    where = 'where id < $2';
  }
  const { rows } = await pool.query(
    `select ${MENSAJE_COLS}, now() as ahora from public.programadores_chat_mensajes
      ${where} order by id desc limit $1;`,
    params
  );
  const hayMas = rows.length > PAGINA;
  const ahora = rows[0]?.ahora || (await pool.query('select now() as ahora')).rows[0].ahora;
  return { mensajes: rows.slice(0, PAGINA).reverse(), hayMas, ahora };
}

async function getMensaje(id) {
  const { rows } = await pool.query(
    `select ${MENSAJE_COLS} from public.programadores_chat_mensajes where id = $1;`,
    [id]
  );
  return rows[0] || null;
}

async function getMensajesPorIds(ids) {
  if (!ids?.length) return [];
  const { rows } = await pool.query(
    `select ${MENSAJE_COLS} from public.programadores_chat_mensajes where id = any($1::bigint[]);`,
    [ids]
  );
  return rows;
}

async function createMensaje({ autorId, autorUsername, texto, adjuntos, respondeAId }) {
  const { rows } = await pool.query(
    `insert into public.programadores_chat_mensajes (autor_id, autor_username, texto, adjuntos, responde_a_id)
     values ($1, $2, $3, $4, $5)
     returning ${MENSAJE_COLS};`,
    [autorId || null, autorUsername, texto || null, JSON.stringify(adjuntos || []), respondeAId || null]
  );
  return rows[0];
}

async function editarMensaje(id, texto) {
  const { rows } = await pool.query(
    `update public.programadores_chat_mensajes
        set texto = $2, editado_at = now(), updated_at = now()
      where id = $1 and eliminado_at is null
      returning ${MENSAJE_COLS};`,
    [id, texto || null]
  );
  return rows[0] || null;
}

async function eliminarMensaje(id) {
  const { rows } = await pool.query(
    `update public.programadores_chat_mensajes
        set eliminado_at = coalesce(eliminado_at, now()), updated_at = now()
      where id = $1
      returning ${MENSAJE_COLS};`,
    [id]
  );
  return rows[0] || null;
}

// Una reacción por persona por mensaje: poner otra la reemplaza, emoji null
// la quita (queda la fila con NULL, no se borra). Toca updated_at del
// mensaje para que el polling de respaldo se entere.
async function setReaccion(mensajeId, username, emoji) {
  await pool.query(
    `insert into public.programadores_chat_reacciones (mensaje_id, username, emoji)
     values ($1, $2, $3)
     on conflict (mensaje_id, username) do update set emoji = excluded.emoji, updated_at = now();`,
    [mensajeId, username, emoji || null]
  );
  const { rows } = await pool.query(
    `update public.programadores_chat_mensajes set updated_at = now() where id = $1 returning ${MENSAJE_COLS};`,
    [mensajeId]
  );
  return rows[0] || null;
}

// [{ mensaje_id, emoji, usernames[] }] de los mensajes pedidos.
async function listReacciones(ids) {
  if (!ids?.length) return [];
  const { rows } = await pool.query(
    `select mensaje_id, emoji, array_agg(username order by updated_at) as usernames
       from public.programadores_chat_reacciones
      where mensaje_id = any($1::bigint[]) and emoji is not null
      group by mensaje_id, emoji;`,
    [ids]
  );
  return rows.map((r) => ({ mensaje_id: Number(r.mensaje_id), emoji: r.emoji, usernames: r.usernames }));
}

async function listLecturas() {
  const { rows } = await pool.query(
    'select username, ultimo_leido_id from public.programadores_chat_lecturas;'
  );
  return rows.map((r) => ({ username: r.username, ultimo_leido_id: Number(r.ultimo_leido_id) }));
}

// Nunca retrocede: si llega un "leído hasta 10" viejo después de un "hasta
// 15", queda 15. Devuelve el valor que quedó.
async function marcarLeido(username, hastaId) {
  const { rows } = await pool.query(
    `insert into public.programadores_chat_lecturas (username, ultimo_leido_id)
     values ($1, $2)
     on conflict (username) do update
       set ultimo_leido_id = greatest(public.programadores_chat_lecturas.ultimo_leido_id, excluded.ultimo_leido_id),
           updated_at = now()
     returning ultimo_leido_id;`,
    [username, hastaId]
  );
  return Number(rows[0]?.ultimo_leido_id || 0);
}

// Mensajes de OTROS (no eliminados) posteriores a lo último que leyó, más el
// último de ellos para mostrar en un aviso. La primera vez que se consulta
// para un usuario (sin fila en _lecturas) se fija la línea de base en el
// último mensaje existente: lo que ya estaba antes no cuenta como "no
// leído", solo lo que llegue desde ahora.
async function contarNoLeidos(username) {
  await pool.query(
    `insert into public.programadores_chat_lecturas (username, ultimo_leido_id)
     select $1, coalesce(max(id), 0) from public.programadores_chat_mensajes
     on conflict (username) do nothing;`,
    [username]
  );
  const { rows } = await pool.query(
    `select m.id, m.autor_username, m.texto, jsonb_array_length(m.adjuntos) as n_adjuntos,
            count(*) over ()::int as total
       from public.programadores_chat_mensajes m
       join public.programadores_chat_lecturas l on l.username = $1
      where m.id > l.ultimo_leido_id and m.autor_username <> $1 and m.eliminado_at is null
      order by m.id desc
      limit 1;`,
    [username]
  );
  const r = rows[0];
  if (!r) return { count: 0, ultimo: null };
  return {
    count: r.total,
    ultimo: { id: Number(r.id), autor_username: r.autor_username, texto: r.texto, n_adjuntos: r.n_adjuntos },
  };
}

// Integrantes del grupo = admins activos con el scope. Se usa para el
// encabezado del chat, las @menciones y para saber cuándo un mensaje lo
// vieron todos.
async function listMiembros() {
  const { rows } = await pool.query(
    `select username, name from public.admin_users
      where is_active and $1 = any(coalesce(scopes, '{}'::text[]))
      order by lower(username);`,
    [SCOPE]
  );
  return rows;
}

module.exports = {
  SCOPE,
  listMensajes,
  getMensaje,
  getMensajesPorIds,
  createMensaje,
  editarMensaje,
  eliminarMensaje,
  setReaccion,
  listReacciones,
  listLecturas,
  marcarLeido,
  contarNoLeidos,
  listMiembros,
};
