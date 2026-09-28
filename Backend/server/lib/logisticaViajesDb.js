// lib/logisticaViajesDb.js
//
// Logística de Viajes: arma "viajes" (fecha + zona + cuadrilla + vehículo) por
// semana ISO y reparte en ellos los portones (unidades físicas de
// public.portones) que tienen despacho y/o instalación esa semana, según
// fecha_salida_imput / fecha_llegada_imput cargados en /a
// (public.preproduccion_valores.data, 1 fila por NV).
//
// Granularidad: "portón" acá = fila de public.portones (unidad física). Fecha
// y medidas (Alto/Ancho) se resuelven por join a preproduccion_valores vía
// portones.nv, porque no existen a nivel unidad — para los NV con más de una
// unidad física, todas heredan la misma fecha/medida del NV (documentado en
// el plan; es un caso raro).
//
// Todas las funciones que mutan devuelven el detalle fresco de la semana
// (getSemanaDetalle), mismo patrón que logisticaConsultasDb: simple y evita
// que el frontend tenga que reconciliar respuestas parciales a mano mientras
// varios usuarios arman viajes al mismo tiempo.
const { pool } = require('../db');
const { computePeso } = require('./logisticaCapacidad');
const { DEPOSITO } = require('./logisticaDeposito');
// OJO: logisticaRutaZonas.js depende de logisticaMapa.js, que a su vez
// depende de ESTE archivo (logisticaViajesDb.js) - importarlo acá cerraría
// un ciclo de require. La sincronización de zonas por viaje se dispara
// desde la capa de rutas (routes/admin/logisticaViajes.js), no desde acá -
// mismo patrón ya usado para logisticaMapaExtras.js.
const { geocodeAddress } = require('./geocoding');
const { listChecklistItems } = require('./logisticaChecklistDb');

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    try { await client.query('rollback'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

// ===========================================================================
// Config: zonas / vehículos / cuadrillas / reglas de capacidad
// ===========================================================================

async function listZonas() {
  const { rows } = await pool.query(
    `select id, nombre, activo, poligono, created_at, updated_at from public.logistica_zonas order by nombre asc;`
  );
  return rows;
}

// poligono: [[lat,lng], ...] (>=3 puntos) dibujado a mano en el mapa, o null
// (zona clasificada solo por localidades de referencia, como antes).
function normalizaPoligono(poligono) {
  if (poligono == null) return null;
  if (!Array.isArray(poligono) || poligono.length < 3) throw new Error('poligono debe tener al menos 3 puntos');
  return poligono.map((p) => {
    const lat = Number(p?.[0]);
    const lng = Number(p?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('poligono tiene un punto inválido');
    return [lat, lng];
  });
}

async function createZona({ nombre, activo, poligono }) {
  const nm = String(nombre || '').trim();
  if (!nm) throw new Error('Falta nombre');
  const poligonoNorm = normalizaPoligono(poligono);
  const { rows } = await pool.query(
    `insert into public.logistica_zonas (nombre, activo, poligono) values ($1, $2, $3)
     returning id, nombre, activo, poligono, created_at, updated_at;`,
    [nm, activo !== false, poligonoNorm ? JSON.stringify(poligonoNorm) : null]
  );
  return rows[0];
}

async function updateZona(id, { nombre, activo, poligono }) {
  const sets = [];
  const params = [Number(id)];
  if (nombre !== undefined) { params.push(String(nombre || '').trim()); sets.push(`nombre = $${params.length}`); }
  if (activo !== undefined) { params.push(!!activo); sets.push(`activo = $${params.length}`); }
  if (poligono !== undefined) {
    const poligonoNorm = normalizaPoligono(poligono);
    params.push(poligonoNorm ? JSON.stringify(poligonoNorm) : null);
    sets.push(`poligono = $${params.length}`);
  }
  if (!sets.length) throw new Error('Nada para actualizar');
  sets.push('updated_at = now()');
  const { rows, rowCount } = await pool.query(
    `update public.logistica_zonas set ${sets.join(', ')} where id = $1
     returning id, nombre, activo, poligono, created_at, updated_at;`,
    params
  );
  if (!rowCount) throw new Error('Zona no encontrada');
  return rows[0];
}

async function deleteZona(id) {
  await pool.query(`delete from public.logistica_zonas where id = $1;`, [Number(id)]);
}

async function listVehiculos() {
  const { rows } = await pool.query(
    `select id, nombre, capacidad_portones, activo, created_at, updated_at
     from public.logistica_vehiculos order by nombre asc;`
  );
  return rows;
}

async function createVehiculo({ nombre, capacidad_portones, activo }) {
  const nm = String(nombre || '').trim();
  if (!nm) throw new Error('Falta nombre');
  const cap = Number(capacidad_portones);
  if (!Number.isFinite(cap) || cap < 0) throw new Error('capacidad_portones inválida');
  const { rows } = await pool.query(
    `insert into public.logistica_vehiculos (nombre, capacidad_portones, activo) values ($1, $2, $3)
     returning id, nombre, capacidad_portones, activo, created_at, updated_at;`,
    [nm, cap, activo !== false]
  );
  return rows[0];
}

async function updateVehiculo(id, { nombre, capacidad_portones, activo }) {
  const sets = [];
  const params = [Number(id)];
  if (nombre !== undefined) { params.push(String(nombre || '').trim()); sets.push(`nombre = $${params.length}`); }
  if (capacidad_portones !== undefined) {
    const cap = Number(capacidad_portones);
    if (!Number.isFinite(cap) || cap < 0) throw new Error('capacidad_portones inválida');
    params.push(cap);
    sets.push(`capacidad_portones = $${params.length}`);
  }
  if (activo !== undefined) { params.push(!!activo); sets.push(`activo = $${params.length}`); }
  if (!sets.length) throw new Error('Nada para actualizar');
  sets.push('updated_at = now()');
  const { rows, rowCount } = await pool.query(
    `update public.logistica_vehiculos set ${sets.join(', ')} where id = $1
     returning id, nombre, capacidad_portones, activo, created_at, updated_at;`,
    params
  );
  if (!rowCount) throw new Error('Vehículo no encontrado');
  return rows[0];
}

async function deleteVehiculo(id) {
  await pool.query(`delete from public.logistica_vehiculos where id = $1;`, [Number(id)]);
}

async function listCuadrillas() {
  const [cQ, mQ] = await Promise.all([
    pool.query(`select id, nombre, activo, created_at, updated_at from public.logistica_cuadrillas order by nombre asc;`),
    pool.query(
      `select cm.cuadrilla_id, cm.qc_user_id, cm.rol, u.name as qc_user_name
       from public.logistica_cuadrilla_miembros cm
       join public.qc_users u on u.id = cm.qc_user_id
       order by u.name asc;`
    ),
  ]);
  const miembrosByCuadrilla = new Map();
  for (const m of mQ.rows) {
    if (!miembrosByCuadrilla.has(m.cuadrilla_id)) miembrosByCuadrilla.set(m.cuadrilla_id, []);
    miembrosByCuadrilla.get(m.cuadrilla_id).push({ qc_user_id: m.qc_user_id, name: m.qc_user_name, rol: m.rol });
  }
  return cQ.rows.map((c) => ({ ...c, miembros: miembrosByCuadrilla.get(c.id) || [] }));
}

async function createCuadrilla({ nombre, activo }) {
  const nm = String(nombre || '').trim();
  if (!nm) throw new Error('Falta nombre');
  const { rows } = await pool.query(
    `insert into public.logistica_cuadrillas (nombre, activo) values ($1, $2)
     returning id, nombre, activo, created_at, updated_at;`,
    [nm, activo !== false]
  );
  return { ...rows[0], miembros: [] };
}

async function updateCuadrilla(id, { nombre, activo }) {
  const sets = [];
  const params = [Number(id)];
  if (nombre !== undefined) { params.push(String(nombre || '').trim()); sets.push(`nombre = $${params.length}`); }
  if (activo !== undefined) { params.push(!!activo); sets.push(`activo = $${params.length}`); }
  if (!sets.length) throw new Error('Nada para actualizar');
  sets.push('updated_at = now()');
  const { rows, rowCount } = await pool.query(
    `update public.logistica_cuadrillas set ${sets.join(', ')} where id = $1
     returning id, nombre, activo, created_at, updated_at;`,
    params
  );
  if (!rowCount) throw new Error('Cuadrilla no encontrada');
  return rows[0];
}

async function deleteCuadrilla(id) {
  await pool.query(`delete from public.logistica_cuadrillas where id = $1;`, [Number(id)]);
}

// miembros: acepta tanto [id, id, ...] (formato viejo, rol queda null) como
// [{qc_user_id, rol}, ...] (formato nuevo, con "calidad" - ej. "Chofer" -
// pedido del usuario para el mensaje de WhatsApp de /despacho_v2).
async function setCuadrillaMiembros(id, miembros) {
  const cuadrillaId = Number(id);
  const normalizados = new Map(); // qc_user_id -> rol
  for (const m of Array.isArray(miembros) ? miembros : []) {
    const uid = Number(typeof m === 'object' && m !== null ? m.qc_user_id : m);
    if (!Number.isFinite(uid)) continue;
    const rol = typeof m === 'object' && m !== null ? (String(m.rol || '').trim() || null) : null;
    normalizados.set(uid, rol);
  }
  await withTx(async (client) => {
    const exists = await client.query(`select id from public.logistica_cuadrillas where id = $1;`, [cuadrillaId]);
    if (!exists.rowCount) throw new Error('Cuadrilla no encontrada');
    await client.query(`delete from public.logistica_cuadrilla_miembros where cuadrilla_id = $1;`, [cuadrillaId]);
    for (const [uid, rol] of normalizados) {
      await client.query(
        `insert into public.logistica_cuadrilla_miembros (cuadrilla_id, qc_user_id, rol) values ($1, $2, $3)
         on conflict do nothing;`,
        [cuadrillaId, uid, rol]
      );
    }
  });
  const all = await listCuadrillas();
  return all.find((c) => c.id === cuadrillaId) || null;
}

async function listReglasCapacidad() {
  const { rows } = await pool.query(
    `select id, nombre, campo, operador, valor_mm, peso, prioridad, activo, created_at, updated_at
     from public.logistica_reglas_capacidad order by prioridad asc, id asc;`
  );
  return rows;
}

async function createReglaCapacidad({ nombre, campo, operador, valor_mm, peso, prioridad, activo }) {
  const valorMm = Number(valor_mm);
  if (!Number.isFinite(valorMm)) throw new Error('valor_mm inválido');
  const pesoNum = peso === undefined ? 2 : Number(peso);
  if (!Number.isFinite(pesoNum)) throw new Error('peso inválido');
  const { rows } = await pool.query(
    `insert into public.logistica_reglas_capacidad (nombre, campo, operador, valor_mm, peso, prioridad, activo)
     values ($1, coalesce($2,'max_mm'), coalesce($3,'>'), $4, $5, coalesce($6,0), $7)
     returning id, nombre, campo, operador, valor_mm, peso, prioridad, activo, created_at, updated_at;`,
    [String(nombre || '').trim() || null, campo || null, operador || null, valorMm, pesoNum, prioridad ?? null, activo !== false]
  );
  return rows[0];
}

async function updateReglaCapacidad(id, patch) {
  const fields = ['nombre', 'campo', 'operador', 'valor_mm', 'peso', 'prioridad', 'activo'];
  const sets = [];
  const params = [Number(id)];
  for (const f of fields) {
    if (patch[f] === undefined) continue;
    params.push(f === 'activo' ? !!patch[f] : patch[f]);
    sets.push(`${f} = $${params.length}`);
  }
  if (!sets.length) throw new Error('Nada para actualizar');
  sets.push('updated_at = now()');
  const { rows, rowCount } = await pool.query(
    `update public.logistica_reglas_capacidad set ${sets.join(', ')} where id = $1
     returning id, nombre, campo, operador, valor_mm, peso, prioridad, activo, created_at, updated_at;`,
    params
  );
  if (!rowCount) throw new Error('Regla no encontrada');
  return rows[0];
}

async function deleteReglaCapacidad(id) {
  await pool.query(`delete from public.logistica_reglas_capacidad where id = $1;`, [Number(id)]);
}

// ===========================================================================
// Zonificación geográfica: referencias (localidades) por zona
// ===========================================================================

async function listZonaReferencias() {
  const { rows } = await pool.query(
    `select r.id, r.zona_id, r.nombre, r.lat, r.lng, r.created_at, z.nombre as zona_nombre
       from public.logistica_zona_referencias r
       join public.logistica_zonas z on z.id = r.zona_id
      order by z.nombre asc, r.nombre asc;`
  );
  return rows;
}

// Geocodifica el nombre de la localidad (vía Nominatim, ver lib/geocoding.js)
// y la guarda como referencia de la zona. Si no se puede geocodificar, avisa
// claro en vez de guardar una referencia sin coordenadas.
async function createZonaReferencia({ zona_id, nombre }) {
  const zonaId = Number(zona_id);
  const nm = String(nombre || '').trim();
  if (!Number.isInteger(zonaId)) throw new Error('Falta zona_id');
  if (!nm) throw new Error('Falta el nombre de la localidad');

  const coords = await geocodeAddress(nm, '').catch(() => null);
  if (!coords) {
    const err = new Error(`No se pudo ubicar "${nm}" en el mapa. Probá con más detalle (ej. "Rosario, Santa Fe").`);
    err.status = 422;
    throw err;
  }

  const { rows } = await pool.query(
    `insert into public.logistica_zona_referencias (zona_id, nombre, lat, lng)
     values ($1, $2, $3, $4)
     returning id, zona_id, nombre, lat, lng, created_at;`,
    [zonaId, nm, coords.lat, coords.lng]
  );
  return rows[0];
}

async function deleteZonaReferencia(id) {
  await pool.query(`delete from public.logistica_zona_referencias where id = $1;`, [Number(id)]);
}

// ===========================================================================
// Reglas de envío: días mínimos antes de poder despachar un portón
// ===========================================================================

async function listReglasEnvio() {
  const { rows } = await pool.query(
    `select id, nombre, descripcion, dias_minimos, fecha_referencia_campo, campo, operador, valor, prioridad, activo, created_at, updated_at
     from public.logistica_reglas_envio order by prioridad asc, id asc;`
  );
  return rows;
}

async function createReglaEnvio({ nombre, descripcion, dias_minimos, fecha_referencia_campo, campo, operador, valor, prioridad, activo }) {
  const nm = String(nombre || '').trim();
  if (!nm) throw new Error('Falta nombre');
  const dias = Number(dias_minimos);
  if (!Number.isFinite(dias) || dias < 0) throw new Error('dias_minimos inválido');
  const { rows } = await pool.query(
    `insert into public.logistica_reglas_envio (nombre, descripcion, dias_minimos, fecha_referencia_campo, campo, operador, valor, prioridad, activo)
     values ($1, $2, $3, coalesce($4,'fecha_nv'), $5, $6, $7, coalesce($8,0), $9)
     returning id, nombre, descripcion, dias_minimos, fecha_referencia_campo, campo, operador, valor, prioridad, activo, created_at, updated_at;`,
    [nm, descripcion || null, dias, fecha_referencia_campo || null, campo || null, operador || null, valor || null, prioridad ?? null, activo !== false]
  );
  return rows[0];
}

async function updateReglaEnvio(id, patch) {
  const fields = ['nombre', 'descripcion', 'dias_minimos', 'fecha_referencia_campo', 'campo', 'operador', 'valor', 'prioridad', 'activo'];
  const sets = [];
  const params = [Number(id)];
  for (const f of fields) {
    if (patch[f] === undefined) continue;
    params.push(f === 'activo' ? !!patch[f] : patch[f]);
    sets.push(`${f} = $${params.length}`);
  }
  if (!sets.length) throw new Error('Nada para actualizar');
  sets.push('updated_at = now()');
  const { rows, rowCount } = await pool.query(
    `update public.logistica_reglas_envio set ${sets.join(', ')} where id = $1
     returning id, nombre, descripcion, dias_minimos, fecha_referencia_campo, campo, operador, valor, prioridad, activo, created_at, updated_at;`,
    params
  );
  if (!rowCount) throw new Error('Regla no encontrada');
  return rows[0];
}

async function deleteReglaEnvio(id) {
  await pool.query(`delete from public.logistica_reglas_envio where id = $1;`, [Number(id)]);
}

async function getConfig() {
  const [zonas, vehiculos, cuadrillas, reglas, zonaReferencias, reglasEnvio, qcUsersQ, checklistItems] = await Promise.all([
    listZonas(),
    listVehiculos(),
    listCuadrillas(),
    listReglasCapacidad(),
    listZonaReferencias(),
    listReglasEnvio(),
    pool.query(`select id, name, is_active from public.qc_users where is_active is true order by name asc;`),
    listChecklistItems(),
  ]);
  return {
    zonas, vehiculos, cuadrillas, reglas, zona_referencias: zonaReferencias, reglas_envio: reglasEnvio,
    qc_users: qcUsersQ.rows, deposito: DEPOSITO, checklist_items: checklistItems,
  };
}

// ===========================================================================
// Portones por semana (despacho / instalación) y viajes
// ===========================================================================

// Campos de contacto/dirección: mismos sourceKeys que usa el PDF de /a
// (getPdfFieldDefs en PreproduccionValoresTable.jsx) para nombre/distribuidor/dirección.
// Usada igual en las dos mitades del UNION ALL de abajo (despacho/instalación),
// siempre contra el alias "p" de la CTE "base" (que trae pv.data como p.pv_data).
const ITEMS_SELECT_COLS = `
  p.id as porton_id,
  p.nv,
  p.nlista,
  p.partida,
  p.sistema,
  p.tipo as porton_tipo,
  p.pv_data->>'Alto' as alto,
  p.pv_data->>'Ancho' as ancho,
  coalesce(p.pv_data->>'Nombre', '') as nombre,
  coalesce(p.pv_data->>'RazSoc', '') as distribuidor,
  coalesce(p.pv_data->>'Direccion', p.pv_data->>'Dirección', p.pv_data->>'direccion', '') as direccion
`;

async function fetchItemsForSemana(semana) {
  const { rows } = await pool.query(
    `
    with base as (
      select p.*, pv.data as pv_data
      from public.portones p
      left join public.preproduccion_valores pv on pv.nv = p.nv and pv.nv_tipo = 'NV'
      where p.parent_id is null
    )
    select ${ITEMS_SELECT_COLS},
      'despacho' as tipo,
      vp.viaje_id, vp.peso as peso_asignado, vp.orden
    from base p
    left join public.logistica_viaje_portones vp on vp.porton_id = p.id and vp.tipo = 'despacho'
    where nullif(p.pv_data->>'fecha_salida_imput','') is not null
      and to_char(nullif(p.pv_data->>'fecha_salida_imput','')::date, 'IYYY-"W"IW') = $1
      and p.despacho is distinct from 'Finalizado'

    union all

    select ${ITEMS_SELECT_COLS},
      'instalacion' as tipo,
      vp.viaje_id, vp.peso as peso_asignado, vp.orden
    from base p
    left join public.logistica_viaje_portones vp on vp.porton_id = p.id and vp.tipo = 'instalacion'
    where nullif(p.pv_data->>'fecha_llegada_imput','') is not null
      and to_char(nullif(p.pv_data->>'fecha_llegada_imput','')::date, 'IYYY-"W"IW') = $1
    `,
    [semana]
  );
  return rows;
}

// Igual que fetchItemsForSemana pero para TODAS las semanas de una vez
// (acotado a una ventana razonable alrededor de hoy), con o sin viaje
// asignado - para la "sombra" de Logística en Planificación de Fechas de
// Servicio Técnico (a diferencia de listPortonesSinViaje, que solo trae lo
// SIN asignar). Un row por despacho/instalación, con su semana ya calculada.
async function listItemsAllSemanas() {
  const { rows } = await pool.query(
    `
    with base as (
      select p.*, pv.data as pv_data
      from public.portones p
      left join public.preproduccion_valores pv on pv.nv = p.nv and pv.nv_tipo = 'NV'
      where p.parent_id is null
    )
    select ${ITEMS_SELECT_COLS},
      'despacho' as tipo,
      nullif(p.pv_data->>'fecha_salida_imput','')::date as fecha,
      to_char(nullif(p.pv_data->>'fecha_salida_imput','')::date, 'IYYY-"W"IW') as semana,
      vp.viaje_id
    from base p
    left join public.logistica_viaje_portones vp on vp.porton_id = p.id and vp.tipo = 'despacho'
    where nullif(p.pv_data->>'fecha_salida_imput','') is not null
      and p.despacho is distinct from 'Finalizado'
      and nullif(p.pv_data->>'fecha_salida_imput','')::date between (current_date - interval '35 days') and (current_date + interval '150 days')

    union all

    select ${ITEMS_SELECT_COLS},
      'instalacion' as tipo,
      nullif(p.pv_data->>'fecha_llegada_imput','')::date as fecha,
      to_char(nullif(p.pv_data->>'fecha_llegada_imput','')::date, 'IYYY-"W"IW') as semana,
      vp.viaje_id
    from base p
    left join public.logistica_viaje_portones vp on vp.porton_id = p.id and vp.tipo = 'instalacion'
    where nullif(p.pv_data->>'fecha_llegada_imput','') is not null
      and nullif(p.pv_data->>'fecha_llegada_imput','')::date between (current_date - interval '35 days') and (current_date + interval '150 days')
    `
  );
  return rows;
}

// NV con despacho y/o instalación pendiente (fecha cargada, sin viaje
// asignado todavía) de CUALQUIER semana - para el mapa de selección de
// "Generar viaje con IA" en Planificación de Fechas (a diferencia de
// fetchItemsForSemana, que está acotado a una sola semana). Un pin por NV:
// si tiene despacho y/o instalación pendiente, y de qué semana es cada uno
// (pueden ser semanas distintas).
async function listPortonesSinViaje() {
  const { rows } = await pool.query(
    `
    with base as (
      select p.*, pv.data as pv_data
      from public.portones p
      left join public.preproduccion_valores pv on pv.nv = p.nv and pv.nv_tipo = 'NV'
      where p.parent_id is null
    )
    select distinct p.nv, 'despacho' as tipo,
      to_char(nullif(p.pv_data->>'fecha_salida_imput','')::date, 'IYYY-"W"IW') as semana
    from base p
    left join public.logistica_viaje_portones vp on vp.porton_id = p.id and vp.tipo = 'despacho'
    where nullif(p.pv_data->>'fecha_salida_imput','') is not null
      and p.despacho is distinct from 'Finalizado'
      and vp.viaje_id is null

    union all

    select distinct p.nv, 'instalacion' as tipo,
      to_char(nullif(p.pv_data->>'fecha_llegada_imput','')::date, 'IYYY-"W"IW') as semana
    from base p
    left join public.logistica_viaje_portones vp on vp.porton_id = p.id and vp.tipo = 'instalacion'
    where nullif(p.pv_data->>'fecha_llegada_imput','') is not null
      and vp.viaje_id is null;
    `
  );

  const byNv = new Map();
  for (const r of rows) {
    if (!byNv.has(r.nv)) {
      byNv.set(r.nv, { nv: r.nv, despacho_pendiente: false, instalacion_pendiente: false, semana_despacho: null, semana_instalacion: null });
    }
    const e = byNv.get(r.nv);
    if (r.tipo === 'despacho') { e.despacho_pendiente = true; e.semana_despacho = r.semana; }
    else { e.instalacion_pendiente = true; e.semana_instalacion = r.semana; }
  }
  return Array.from(byNv.values());
}

async function getSemanaCounts(semana) {
  const items = await fetchItemsForSemana(semana);
  const out = { despacho_total: 0, despacho_asignados: 0, instalacion_total: 0, instalacion_asignados: 0 };
  for (const it of items) {
    if (it.tipo === 'despacho') {
      out.despacho_total += 1;
      if (it.viaje_id != null) out.despacho_asignados += 1;
    } else {
      out.instalacion_total += 1;
      if (it.viaje_id != null) out.instalacion_asignados += 1;
    }
  }
  return out;
}

async function getSemanas() {
  const [rowsQ, viajesQ, semanasQ] = await Promise.all([
    pool.query(
      `
      with base as (
        select p.*, pv.data as pv_data
        from public.portones p
        left join public.preproduccion_valores pv on pv.nv = p.nv and pv.nv_tipo = 'NV'
        where p.parent_id is null
      )
      select
        to_char(nullif(pv_data->>'fecha_salida_imput','')::date, 'IYYY-"W"IW') as semana,
        'despacho' as tipo,
        id as porton_id,
        despacho as despacho_estado
      from base
      where nullif(pv_data->>'fecha_salida_imput','') is not null
        and despacho is distinct from 'Finalizado'

      union all

      select
        to_char(nullif(pv_data->>'fecha_llegada_imput','')::date, 'IYYY-"W"IW') as semana,
        'instalacion' as tipo,
        id as porton_id,
        despacho as despacho_estado
      from base
      where nullif(pv_data->>'fecha_llegada_imput','') is not null
      `
    ),
    pool.query(`select semana, count(*)::int as viajes_count from public.logistica_viajes group by semana;`),
    pool.query(`select semana, cerrada from public.logistica_semanas;`),
  ]);

  const asignadosQ = await pool.query(`select porton_id, tipo from public.logistica_viaje_portones;`);
  const asignadosSet = new Set(asignadosQ.rows.map((r) => `${r.porton_id}::${r.tipo}`));

  const bySemana = new Map();
  for (const r of rowsQ.rows) {
    if (!r.semana) continue;
    if (!bySemana.has(r.semana)) {
      bySemana.set(r.semana, {
        semana: r.semana,
        despacho_total: 0,
        despacho_asignados: 0,
        instalacion_total: 0,
        instalacion_asignados: 0,
        viajes_count: 0,
        cerrada: false,
      });
    }
    const acc = bySemana.get(r.semana);
    const asignado = asignadosSet.has(`${r.porton_id}::${r.tipo}`);
    if (r.tipo === 'despacho') {
      acc.despacho_total += 1;
      if (asignado) acc.despacho_asignados += 1;
    } else {
      acc.instalacion_total += 1;
      if (asignado) acc.instalacion_asignados += 1;
    }
  }
  for (const v of viajesQ.rows) {
    if (!bySemana.has(v.semana)) continue;
    bySemana.get(v.semana).viajes_count = v.viajes_count;
  }
  for (const s of semanasQ.rows) {
    if (!bySemana.has(s.semana)) continue;
    bySemana.get(s.semana).cerrada = !!s.cerrada;
  }

  return Array.from(bySemana.values()).sort((a, b) => a.semana.localeCompare(b.semana));
}

async function getViajesForSemana(semana) {
  const { rows } = await pool.query(
    `
    select
      vi.id, vi.semana, vi.fecha, vi.nombre, vi.orden,
      vi.zona_id, z.nombre as zona_nombre,
      vi.cuadrilla_id, c.nombre as cuadrilla_nombre,
      vi.vehiculo_id, veh.nombre as vehiculo_nombre, coalesce(veh.capacidad_portones, 0) as vehiculo_capacidad,
      vi.ruta_real, to_char(vi.hora_salida, 'HH24:MI') as hora_salida, vi.fondo_efectivo,
      vi.created_at, vi.updated_at
    from public.logistica_viajes vi
    left join public.logistica_zonas z on z.id = vi.zona_id
    left join public.logistica_cuadrillas c on c.id = vi.cuadrilla_id
    left join public.logistica_vehiculos veh on veh.id = vi.vehiculo_id
    where vi.semana = $1
    order by vi.orden asc, vi.id asc;
    `,
    [semana]
  );
  return rows;
}

async function isSemanaCerrada(semana) {
  const { rows } = await pool.query(`select cerrada from public.logistica_semanas where semana = $1;`, [semana]);
  return !!rows?.[0]?.cerrada;
}

async function assertSemanaAbierta(semana) {
  if (await isSemanaCerrada(semana)) {
    throw new Error('La semana está cerrada. Reabrila para modificar viajes.');
  }
}

async function getSemanaDetalle(semana) {
  const reglas = await listReglasCapacidad();
  const [items, viajes, cerrada] = await Promise.all([
    fetchItemsForSemana(semana),
    getViajesForSemana(semana),
    isSemanaCerrada(semana),
  ]);

  const itemsOut = items.map((it) => {
    const { peso } = computePeso({ alto: it.alto, ancho: it.ancho }, reglas);
    return {
      porton_id: it.porton_id,
      nv: it.nv,
      nlista: it.nlista,
      partida: it.partida,
      sistema: it.sistema,
      porton_tipo: it.porton_tipo,
      alto: it.alto,
      ancho: it.ancho,
      nombre: it.nombre,
      distribuidor: it.distribuidor,
      direccion: it.direccion,
      tipo: it.tipo,
      viaje_id: it.viaje_id,
      orden: it.orden,
      peso,
    };
  });

  const viajesOut = viajes.map((v) => {
    const pesoUsado = itemsOut
      .filter((it) => it.tipo === 'despacho' && it.viaje_id === v.id)
      .reduce((acc, it) => acc + Number(it.peso || 0), 0);
    return { ...v, peso_despacho_usado: pesoUsado };
  });

  const counts = itemsOut.reduce(
    (acc, it) => {
      if (it.tipo === 'despacho') {
        acc.despacho_total += 1;
        if (it.viaje_id != null) acc.despacho_asignados += 1;
      } else {
        acc.instalacion_total += 1;
        if (it.viaje_id != null) acc.instalacion_asignados += 1;
      }
      return acc;
    },
    { despacho_total: 0, despacho_asignados: 0, instalacion_total: 0, instalacion_asignados: 0 }
  );

  return { semana, cerrada, counts, items: itemsOut, viajes: viajesOut };
}

// Acepta HH:MM o HH:MM:SS (lo que ya entiende <input type="time">).
function normalizaHoraSalida(horaSalida) {
  if (horaSalida == null || horaSalida === '') return null;
  const s = String(horaSalida).trim();
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(s)) throw new Error('hora_salida debe tener formato HH:MM');
  return s;
}

async function crearViaje(semana, { fecha, zona_id, cuadrilla_id, vehiculo_id, nombre, orden, hora_salida, fondo_efectivo }) {
  await assertSemanaAbierta(semana);
  const fechaStr = String(fecha || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaStr)) throw new Error('fecha inválida');

  const chk = await pool.query(`select to_char($1::date, 'IYYY-"W"IW') as semana;`, [fechaStr]);
  if (chk.rows?.[0]?.semana !== semana) {
    throw new Error(`La fecha ${fechaStr} no cae dentro de la semana ${semana}`);
  }

  await pool.query(
    `insert into public.logistica_viajes (semana, fecha, zona_id, cuadrilla_id, vehiculo_id, nombre, orden, hora_salida, fondo_efectivo)
     values ($1, $2, $3, $4, $5, $6, coalesce($7, 0), $8, $9);`,
    [
      semana, fechaStr, zona_id || null, cuadrilla_id || null, vehiculo_id || null, nombre || null, orden ?? null,
      normalizaHoraSalida(hora_salida), fondo_efectivo != null && fondo_efectivo !== '' ? Number(fondo_efectivo) : null,
    ]
  );

  return getSemanaDetalle(semana);
}

async function getViajeSemana(viajeId) {
  const { rows } = await pool.query(`select semana from public.logistica_viajes where id = $1;`, [Number(viajeId)]);
  if (!rows.length) throw new Error('Viaje no encontrado');
  return rows[0].semana;
}

async function patchViaje(id, { fecha, zona_id, cuadrilla_id, vehiculo_id, nombre, orden, hora_salida, fondo_efectivo }) {
  const viajeId = Number(id);
  const semana = await getViajeSemana(viajeId);
  await assertSemanaAbierta(semana);

  const sets = [];
  const params = [viajeId];

  if (fecha !== undefined) {
    const fechaStr = String(fecha || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaStr)) throw new Error('fecha inválida');
    const chk = await pool.query(`select to_char($1::date, 'IYYY-"W"IW') as semana;`, [fechaStr]);
    if (chk.rows?.[0]?.semana !== semana) throw new Error(`La fecha ${fechaStr} no cae dentro de la semana ${semana}`);
    params.push(fechaStr);
    sets.push(`fecha = $${params.length}`);
  }
  if (zona_id !== undefined) { params.push(zona_id || null); sets.push(`zona_id = $${params.length}`); }
  if (cuadrilla_id !== undefined) { params.push(cuadrilla_id || null); sets.push(`cuadrilla_id = $${params.length}`); }
  if (vehiculo_id !== undefined) { params.push(vehiculo_id || null); sets.push(`vehiculo_id = $${params.length}`); }
  if (nombre !== undefined) { params.push(nombre || null); sets.push(`nombre = $${params.length}`); }
  if (orden !== undefined) { params.push(orden); sets.push(`orden = $${params.length}`); }
  if (hora_salida !== undefined) { params.push(normalizaHoraSalida(hora_salida)); sets.push(`hora_salida = $${params.length}`); }
  if (fondo_efectivo !== undefined) {
    params.push(fondo_efectivo != null && fondo_efectivo !== '' ? Number(fondo_efectivo) : null);
    sets.push(`fondo_efectivo = $${params.length}`);
  }

  if (sets.length) {
    sets.push('updated_at = now()');
    await pool.query(`update public.logistica_viajes set ${sets.join(', ')} where id = $1;`, params);
  }

  return getSemanaDetalle(semana);
}

async function borrarViaje(id) {
  const viajeId = Number(id);
  const semana = await getViajeSemana(viajeId);
  await assertSemanaAbierta(semana);
  // on delete cascade en logistica_viaje_portones: los portones vuelven al pool.
  await pool.query(`delete from public.logistica_viajes where id = $1;`, [viajeId]);
  return getSemanaDetalle(semana);
}

async function asignarPorton(viajeId, { porton_id, tipo }) {
  const vId = Number(viajeId);
  const tipoNorm = String(tipo || '').trim();
  if (!['despacho', 'instalacion'].includes(tipoNorm)) throw new Error('tipo debe ser despacho o instalacion');
  if (!porton_id) throw new Error('Falta porton_id');

  const viajeQ = await pool.query(
    `select vi.id, vi.semana, vi.vehiculo_id, coalesce(veh.capacidad_portones, 0) as capacidad
     from public.logistica_viajes vi
     left join public.logistica_vehiculos veh on veh.id = vi.vehiculo_id
     where vi.id = $1;`,
    [vId]
  );
  if (!viajeQ.rowCount) throw new Error('Viaje no encontrado');
  const viaje = viajeQ.rows[0];
  await assertSemanaAbierta(viaje.semana);

  const detalle = await getSemanaDetalle(viaje.semana);
  const item = detalle.items.find((it) => it.porton_id === porton_id && it.tipo === tipoNorm);
  if (!item) throw new Error('Ese portón no tiene ' + (tipoNorm === 'despacho' ? 'despacho' : 'instalación') + ' en esta semana');

  if (tipoNorm === 'despacho') {
    if (!viaje.vehiculo_id) throw new Error('Asigná un vehículo al viaje antes de sumar portones de despacho');
    const usadoSinEste = detalle.viajes.find((v) => v.id === vId)?.peso_despacho_usado || 0;
    const usadoActualDeEste = item.viaje_id === vId ? item.peso : 0;
    const proyectado = usadoSinEste - usadoActualDeEste + item.peso;
    if (proyectado > Number(viaje.capacidad)) {
      throw new Error(`No entra: el viaje ya usa ${usadoSinEste - usadoActualDeEste} de ${viaje.capacidad} y este portón pesa ${item.peso}`);
    }
  }

  // Nuevo va al final de la columna (no a la posición 0) - así no reordena
  // por sorpresa lo que el usuario ya venía acomodando a mano en ese viaje.
  const maxOrdenQ = await pool.query(
    `select coalesce(max(orden), -1) + 1 as next_orden from public.logistica_viaje_portones where viaje_id = $1;`,
    [vId]
  );
  const nextOrden = maxOrdenQ.rows[0].next_orden;

  await pool.query(
    `insert into public.logistica_viaje_portones (viaje_id, porton_id, tipo, peso, orden)
     values ($1, $2, $3, $4, $5)
     on conflict (porton_id, tipo) do update set viaje_id = excluded.viaje_id, peso = excluded.peso, orden = excluded.orden;`,
    [vId, porton_id, tipoNorm, item.peso, nextOrden]
  );

  return getSemanaDetalle(viaje.semana);
}

// Reordena los portones DENTRO de un mismo viaje - el orden de la columna en
// Logística de Viajes pasa a ser el orden real de la ruta (primero se hace
// el que queda arriba). itemsOrdenados: [{porton_id, tipo}, ...] en el orden
// final deseado; se les asigna orden = posición en el array.
async function reordenarViaje(viajeId, itemsOrdenados) {
  const vId = Number(viajeId);
  if (!Array.isArray(itemsOrdenados) || !itemsOrdenados.length) throw new Error('Falta la lista ordenada de items');

  const viajeQ = await pool.query(`select semana from public.logistica_viajes where id = $1;`, [vId]);
  if (!viajeQ.rowCount) throw new Error('Viaje no encontrado');
  const semana = viajeQ.rows[0].semana;
  await assertSemanaAbierta(semana);

  // Items mixtos: {porton_id, tipo} (como siempre) o {punto_extra_id} (parada
  // que no es un portón, ej. alojamiento) - conviven en la MISMA secuencia
  // de `orden`, así se pueden intercalar libremente en la ruta.
  await withTx(async (client) => {
    for (let i = 0; i < itemsOrdenados.length; i++) {
      const it = itemsOrdenados[i] || {};
      if (it.punto_extra_id != null) {
        await client.query(
          `update public.logistica_viaje_paradas_extra set orden = $1 where viaje_id = $2 and punto_extra_id = $3;`,
          [i, vId, Number(it.punto_extra_id)]
        );
        continue;
      }
      const tipoNorm = String(it.tipo || '').trim();
      if (!it.porton_id || !['despacho', 'instalacion'].includes(tipoNorm)) continue;
      await client.query(
        `update public.logistica_viaje_portones set orden = $1 where viaje_id = $2 and porton_id = $3 and tipo = $4;`,
        [i, vId, it.porton_id, tipoNorm]
      );
    }
  });

  return getSemanaDetalle(semana);
}

async function desasignarPorton(viajeId, portonId, tipo) {
  const vId = Number(viajeId);
  const tipoNorm = String(tipo || '').trim();
  if (!['despacho', 'instalacion'].includes(tipoNorm)) throw new Error('tipo debe ser despacho o instalacion');

  const semana = await getViajeSemana(vId);
  await assertSemanaAbierta(semana);

  await pool.query(
    `delete from public.logistica_viaje_portones where viaje_id = $1 and porton_id = $2 and tipo = $3;`,
    [vId, portonId, tipoNorm]
  );

  return getSemanaDetalle(semana);
}

async function cerrarSemana(semana, cerradaBy) {
  const counts = await getSemanaCounts(semana);
  const falta = (counts.despacho_total - counts.despacho_asignados) + (counts.instalacion_total - counts.instalacion_asignados);
  if (falta > 0) {
    throw new Error(`Todavía faltan ${falta} portón(es) por asignar a un viaje`);
  }
  await pool.query(
    `insert into public.logistica_semanas (semana, cerrada, cerrada_at, cerrada_by)
     values ($1, true, now(), $2)
     on conflict (semana) do update set cerrada = true, cerrada_at = now(), cerrada_by = excluded.cerrada_by, updated_at = now();`,
    [semana, cerradaBy || null]
  );
  return getSemanaDetalle(semana);
}

async function reabrirSemana(semana) {
  await pool.query(
    `insert into public.logistica_semanas (semana, cerrada)
     values ($1, false)
     on conflict (semana) do update set cerrada = false, cerrada_at = null, updated_at = now();`,
    [semana]
  );
  return getSemanaDetalle(semana);
}

module.exports = {
  listZonas, createZona, updateZona, deleteZona,
  listVehiculos, createVehiculo, updateVehiculo, deleteVehiculo,
  listCuadrillas, createCuadrilla, updateCuadrilla, deleteCuadrilla, setCuadrillaMiembros,
  listReglasCapacidad, createReglaCapacidad, updateReglaCapacidad, deleteReglaCapacidad,
  listZonaReferencias, createZonaReferencia, deleteZonaReferencia,
  listReglasEnvio, createReglaEnvio, updateReglaEnvio, deleteReglaEnvio,
  getConfig,
  listPortonesSinViaje,
  listItemsAllSemanas,
  getSemanas,
  getSemanaDetalle,
  crearViaje, patchViaje, borrarViaje,
  asignarPorton, desasignarPorton, reordenarViaje,
  cerrarSemana, reabrirSemana,
  getViajeSemana,
};
