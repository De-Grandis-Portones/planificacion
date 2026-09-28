const { pool } = require('./db');

// Nota + usuario/contraseña compartidos por nodo del diagrama "Índice de
// Programación" (quién está trabajando ahí, qué está haciendo, y el acceso
// real cargado a mano por el equipo). Un nodo sin fila propia todavía no
// tiene nada cargado.

async function getNota(nodoId) {
  const { rows } = await pool.query(
    `select nodo_id, nota, admin_user, admin_password, link, env_vars, info_programacion, updated_by, updated_at
       from public.notas_nodo where nodo_id = $1`,
    [nodoId]
  );
  if (!rows.length) {
    return {
      nodo_id: nodoId,
      nota: '',
      admin_user: '',
      admin_password: '',
      link: '',
      env_vars: '',
      info_programacion: '',
      updated_by: null,
      updated_at: null,
    };
  }
  return rows[0];
}

// El acceso principal (admin_user/admin_password) sólo se pisa cuando llegan
// los DOS campos cargados: si solo vino uno (o ninguno), esta fila guarda el
// resto igual pero deja admin_user/admin_password como estaban en la base -
// así un blur a medio cargar nunca borra un acceso que ya estaba guardado.
// nota/link/env_vars/info_programacion, en cambio, cada uno se guarda
// independiente del resto (el frontend manda solo el campo que cambió en
// cada blur): un campo ausente (undefined) en el payload deja esa columna
// como estaba en la base (coalesce($n, notas_nodo.col)) en vez de vaciarla.
async function setNota(nodoId, { nota, adminUser, adminPassword, link, envVars, infoProgramacion } = {}, updatedBy) {
  const hasCreds = String(adminUser || '').trim() && String(adminPassword || '').trim();

  const notaVal = nota === undefined ? null : String(nota || '');
  const linkVal = link === undefined ? null : String(link || '');
  const envVarsVal = envVars === undefined ? null : String(envVars || '');
  const infoProgramacionVal = infoProgramacion === undefined ? null : String(infoProgramacion || '');

  if (hasCreds) {
    const { rows } = await pool.query(
      `insert into public.notas_nodo (nodo_id, nota, admin_user, admin_password, link, env_vars, info_programacion, updated_by, updated_at)
       values ($1, coalesce($2, ''), $3, $4, coalesce($5, ''), coalesce($6, ''), coalesce($7, ''), $8, now())
       on conflict (nodo_id) do update
         set nota = coalesce($2, notas_nodo.nota),
             admin_user = excluded.admin_user,
             admin_password = excluded.admin_password,
             link = coalesce($5, notas_nodo.link),
             env_vars = coalesce($6, notas_nodo.env_vars),
             info_programacion = coalesce($7, notas_nodo.info_programacion),
             updated_by = excluded.updated_by,
             updated_at = now()
       returning nodo_id, nota, admin_user, admin_password, link, env_vars, info_programacion, updated_by, updated_at`,
      [nodoId, notaVal, String(adminUser).trim(), String(adminPassword).trim(), linkVal, envVarsVal, infoProgramacionVal, updatedBy || null]
    );
    return rows[0];
  }

  const { rows } = await pool.query(
    `insert into public.notas_nodo (nodo_id, nota, link, env_vars, info_programacion, updated_by, updated_at)
     values ($1, coalesce($2, ''), coalesce($3, ''), coalesce($4, ''), coalesce($5, ''), $6, now())
     on conflict (nodo_id) do update
       set nota = coalesce($2, notas_nodo.nota),
           link = coalesce($3, notas_nodo.link),
           env_vars = coalesce($4, notas_nodo.env_vars),
           info_programacion = coalesce($5, notas_nodo.info_programacion),
           updated_by = excluded.updated_by,
           updated_at = now()
     returning nodo_id, nota, admin_user, admin_password, link, env_vars, info_programacion, updated_by, updated_at`,
    [nodoId, notaVal, linkVal, envVarsVal, infoProgramacionVal, updatedBy || null]
  );
  return rows[0];
}

// Entradas de "¿qué se está trabajando acá?" - a diferencia de nota/admin_user/
// admin_password/link (un solo valor compartido por nodo), acá cada admin
// tiene SU PROPIA fila (nodo_id, autor_username) - así dos personas escribiendo
// al mismo tiempo nunca se pisan: cada uno guarda y borra solo la suya.
async function listNotaEntradas(nodoId) {
  const { rows } = await pool.query(
    `select nodo_id, autor_username, texto, updated_at
       from public.notas_nodo_entradas
      where nodo_id = $1
      order by updated_at desc`,
    [nodoId]
  );
  return rows;
}

// texto vacío borra la fila directamente (así "vaciar el cuadro y salir" y
// "Terminé, liberar" hacen exactamente lo mismo, sin dejar filas fantasma con
// texto en blanco dando vueltas en la lista).
async function upsertNotaEntrada(nodoId, autorUsername, texto) {
  const limpio = String(texto || '').trim();
  if (!limpio) {
    await deleteNotaEntrada(nodoId, autorUsername);
    return null;
  }
  const { rows } = await pool.query(
    `insert into public.notas_nodo_entradas (nodo_id, autor_username, texto, updated_at)
     values ($1, $2, $3, now())
     on conflict (nodo_id, autor_username) do update
       set texto = excluded.texto,
           updated_at = now()
     returning nodo_id, autor_username, texto, updated_at`,
    [nodoId, autorUsername, limpio]
  );
  return rows[0];
}

async function deleteNotaEntrada(nodoId, autorUsername) {
  await pool.query(
    'delete from public.notas_nodo_entradas where nodo_id = $1 and autor_username = $2',
    [nodoId, autorUsername]
  );
}

module.exports = { getNota, setNota, listNotaEntradas, upsertNotaEntrada, deleteNotaEntrada };
