// lib/programadoresProyectosDb.js
//
// Proyectos de la sección Programadores (/admin/programadores/proyectos):
// cada proyecto tiene un encargado, sus integrantes (TEXT[] de usernames, el
// encargado siempre incluido) y un chat propio entre ellos, con la misma
// mecánica que el Chat de Programadores (lib/programadoresChatDb.js) pero en
// tablas aparte. Nada se borra: un proyecto se archiva (archivado_at) y un
// mensaje eliminado queda con eliminado_at.
const { pool } = require('../db');

const ESTADOS = ['por_empezar', 'en_curso', 'en_pausa', 'terminado'];
const PAGINA = 50;

const PROYECTO_COLS = `p.id, p.nombre, p.descripcion, p.estado, p.encargado_username, p.integrantes,
  p.creado_por, p.archivado_at, p.created_at, p.updated_at`;

const MENSAJE_COLS = `id, proyecto_id, autor_id, autor_username, texto, adjuntos, responde_a_id,
  editado_at, eliminado_at, created_at, updated_at`;

// Activos o archivados, lo último movido primero. El último mensaje y los no
// leídos salen solo para los proyectos donde `username` es integrante: el
// chat es de ellos, los demás ven la tarjeta pero no la conversación.
async function listProyectos(username, { archivados = false } = {}) {
  const { rows } = await pool.query(
    `select ${PROYECTO_COLS},
            um.id as ultimo_id, um.autor_username as ultimo_autor, um.texto as ultimo_texto,
            um.n_adjuntos as ultimo_n_adjuntos, um.created_at as ultimo_at,
            coalesce(nl.total, 0)::int as no_leidos
       from public.programadores_proyectos p
       left join lateral (
         select m.id, m.autor_username, m.texto, jsonb_array_length(m.adjuntos) as n_adjuntos, m.created_at
           from public.programadores_proyectos_mensajes m
          where m.proyecto_id = p.id and m.eliminado_at is null
          order by m.id desc
          limit 1
       ) um on $1 = any(p.integrantes)
       left join lateral (
         select count(*) as total
           from public.programadores_proyectos_lecturas l
           join public.programadores_proyectos_mensajes m
             on m.proyecto_id = l.proyecto_id and m.id > l.ultimo_leido_id
          where l.proyecto_id = p.id and l.username = $1
            and m.autor_username <> $1 and m.eliminado_at is null
       ) nl on $1 = any(p.integrantes)
      where (p.archivado_at is not null) = $2
      order by greatest(p.updated_at, coalesce(um.created_at, p.updated_at)) desc, p.id desc;`,
    [username, !!archivados]
  );
  return rows;
}

async function getProyecto(id) {
  const { rows } = await pool.query(
    `select ${PROYECTO_COLS} from public.programadores_proyectos p where p.id = $1;`,
    [id]
  );
  return rows[0] || null;
}

// { username: nombre real } para mostrar "Santiago Drapperi" y no solo el login.
async function nombresDe(usernames) {
  const lista = [...new Set((usernames || []).filter(Boolean))];
  if (!lista.length) return {};
  const { rows } = await pool.query(
    `select username, nullif(trim(name), '') as name from public.admin_users where username = any($1::text[]);`,
    [lista]
  );
  const out = {};
  for (const r of rows) if (r.name) out[r.username] = r.name;
  return out;
}

// Quien entra a un proyecto arranca con todo lo anterior como leído: el
// contador de "nuevos" es por lo que llegue desde que lo sumaron, no por el
// historial (si vuelve a entrar después de que lo sacaron, idem).
async function lineaDeBaseLecturas(client, proyectoId, usernames) {
  if (!usernames.length) return;
  await client.query(
    `insert into public.programadores_proyectos_lecturas (proyecto_id, username, ultimo_leido_id)
     select $1, u, coalesce((select max(id) from public.programadores_proyectos_mensajes where proyecto_id = $1), 0)
       from unnest($2::text[]) as u
     on conflict (proyecto_id, username) do update
       set ultimo_leido_id = greatest(public.programadores_proyectos_lecturas.ultimo_leido_id, excluded.ultimo_leido_id),
           updated_at = now();`,
    [proyectoId, usernames]
  );
}

async function enTransaccion(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function crearProyecto({ nombre, descripcion, estado, encargado, integrantes, creadoPor }) {
  return enTransaccion(async (client) => {
    const { rows } = await client.query(
      `insert into public.programadores_proyectos (nombre, descripcion, estado, encargado_username, integrantes, creado_por)
       values ($1, $2, $3, $4, $5, $6)
       returning id;`,
      [nombre, descripcion, estado, encargado, integrantes, creadoPor || null]
    );
    const id = rows[0].id;
    await lineaDeBaseLecturas(client, id, integrantes);
    const { rows: [p] } = await client.query(`select ${PROYECTO_COLS} from public.programadores_proyectos p where p.id = $1;`, [id]);
    return p;
  });
}

async function actualizarProyecto(id, { nombre, descripcion, estado, encargado, integrantes }, nuevosIntegrantes) {
  return enTransaccion(async (client) => {
    const { rows } = await client.query(
      `update public.programadores_proyectos
          set nombre = $2, descripcion = $3, estado = $4, encargado_username = $5, integrantes = $6, updated_at = now()
        where id = $1
        returning id;`,
      [id, nombre, descripcion, estado, encargado, integrantes]
    );
    if (!rows[0]) return null;
    await lineaDeBaseLecturas(client, id, nuevosIntegrantes);
    const { rows: [p] } = await client.query(`select ${PROYECTO_COLS} from public.programadores_proyectos p where p.id = $1;`, [id]);
    return p;
  });
}

async function setArchivado(id, archivado) {
  const { rows } = await pool.query(
    `update public.programadores_proyectos p
        set archivado_at = case when $2 then coalesce(p.archivado_at, now()) else null end, updated_at = now()
      where p.id = $1
      returning ${PROYECTO_COLS};`,
    [id, !!archivado]
  );
  return rows[0] || null;
}

// ---- chat del proyecto (mismos tres modos que programadoresChatDb.listMensajes) ----
async function listMensajes(proyectoId, { despuesDe, antesDe, cambiosDesde } = {}) {
  if (despuesDe != null) {
    // Margen de 10s: ver nota en programadoresChatDb.listMensajes.
    const { rows } = await pool.query(
      `select ${MENSAJE_COLS}, now() as ahora from public.programadores_proyectos_mensajes
        where proyecto_id = $1
          and (id > $2 or ($3::timestamptz is not null and updated_at > $3::timestamptz - interval '10 seconds'))
        order by id asc limit 300;`,
      [proyectoId, despuesDe, cambiosDesde || null]
    );
    const ahora = rows[0]?.ahora || (await pool.query('select now() as ahora')).rows[0].ahora;
    return { mensajes: rows, hayMas: false, ahora };
  }
  const params = [proyectoId, PAGINA + 1];
  let extra = '';
  if (antesDe != null) {
    params.push(antesDe);
    extra = 'and id < $3';
  }
  const { rows } = await pool.query(
    `select ${MENSAJE_COLS}, now() as ahora from public.programadores_proyectos_mensajes
      where proyecto_id = $1 ${extra} order by id desc limit $2;`,
    params
  );
  const hayMas = rows.length > PAGINA;
  const ahora = rows[0]?.ahora || (await pool.query('select now() as ahora')).rows[0].ahora;
  return { mensajes: rows.slice(0, PAGINA).reverse(), hayMas, ahora };
}

// Siempre dentro del proyecto: un id de otro proyecto da null.
async function getMensaje(proyectoId, id) {
  const { rows } = await pool.query(
    `select ${MENSAJE_COLS} from public.programadores_proyectos_mensajes where id = $1 and proyecto_id = $2;`,
    [id, proyectoId]
  );
  return rows[0] || null;
}

async function getMensajesPorIds(ids) {
  if (!ids?.length) return [];
  const { rows } = await pool.query(
    `select ${MENSAJE_COLS} from public.programadores_proyectos_mensajes where id = any($1::bigint[]);`,
    [ids]
  );
  return rows;
}

async function createMensaje({ proyectoId, autorId, autorUsername, texto, adjuntos, respondeAId }) {
  const { rows } = await pool.query(
    `insert into public.programadores_proyectos_mensajes (proyecto_id, autor_id, autor_username, texto, adjuntos, responde_a_id)
     values ($1, $2, $3, $4, $5, $6)
     returning ${MENSAJE_COLS};`,
    [proyectoId, autorId || null, autorUsername, texto || null, JSON.stringify(adjuntos || []), respondeAId || null]
  );
  return rows[0];
}

async function editarMensaje(id, texto) {
  const { rows } = await pool.query(
    `update public.programadores_proyectos_mensajes
        set texto = $2, editado_at = now(), updated_at = now()
      where id = $1 and eliminado_at is null
      returning ${MENSAJE_COLS};`,
    [id, texto || null]
  );
  return rows[0] || null;
}

async function eliminarMensaje(id) {
  const { rows } = await pool.query(
    `update public.programadores_proyectos_mensajes
        set eliminado_at = coalesce(eliminado_at, now()), updated_at = now()
      where id = $1
      returning ${MENSAJE_COLS};`,
    [id]
  );
  return rows[0] || null;
}

// Una reacción por persona por mensaje; emoji null la quita (la fila queda).
async function setReaccion(mensajeId, username, emoji) {
  await pool.query(
    `insert into public.programadores_proyectos_reacciones (mensaje_id, username, emoji)
     values ($1, $2, $3)
     on conflict (mensaje_id, username) do update set emoji = excluded.emoji, updated_at = now();`,
    [mensajeId, username, emoji || null]
  );
  const { rows } = await pool.query(
    `update public.programadores_proyectos_mensajes set updated_at = now() where id = $1 returning ${MENSAJE_COLS};`,
    [mensajeId]
  );
  return rows[0] || null;
}

async function listReacciones(ids) {
  if (!ids?.length) return [];
  const { rows } = await pool.query(
    `select mensaje_id, emoji, array_agg(username order by updated_at) as usernames
       from public.programadores_proyectos_reacciones
      where mensaje_id = any($1::bigint[]) and emoji is not null
      group by mensaje_id, emoji;`,
    [ids]
  );
  return rows.map((r) => ({ mensaje_id: Number(r.mensaje_id), emoji: r.emoji, usernames: r.usernames }));
}

async function listLecturas(proyectoId) {
  const { rows } = await pool.query(
    'select username, ultimo_leido_id from public.programadores_proyectos_lecturas where proyecto_id = $1;',
    [proyectoId]
  );
  return rows.map((r) => ({ username: r.username, ultimo_leido_id: Number(r.ultimo_leido_id) }));
}

// Nunca retrocede (ver programadoresChatDb.marcarLeido).
async function marcarLeido(proyectoId, username, hastaId) {
  const { rows } = await pool.query(
    `insert into public.programadores_proyectos_lecturas (proyecto_id, username, ultimo_leido_id)
     values ($1, $2, $3)
     on conflict (proyecto_id, username) do update
       set ultimo_leido_id = greatest(public.programadores_proyectos_lecturas.ultimo_leido_id, excluded.ultimo_leido_id),
           updated_at = now()
     returning ultimo_leido_id;`,
    [proyectoId, username, hastaId]
  );
  return Number(rows[0]?.ultimo_leido_id || 0);
}

// Total de mensajes nuevos de otros en los proyectos activos donde
// `username` es integrante (badge del menú).
async function contarNoLeidos(username) {
  const { rows } = await pool.query(
    `select count(*)::int as total
       from public.programadores_proyectos p
       join public.programadores_proyectos_lecturas l on l.proyecto_id = p.id and l.username = $1
       join public.programadores_proyectos_mensajes m on m.proyecto_id = p.id and m.id > l.ultimo_leido_id
      where $1 = any(p.integrantes) and p.archivado_at is null
        and m.autor_username <> $1 and m.eliminado_at is null;`,
    [username]
  );
  return rows[0]?.total || 0;
}

module.exports = {
  ESTADOS,
  listProyectos,
  getProyecto,
  nombresDe,
  crearProyecto,
  actualizarProyecto,
  setArchivado,
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
};
