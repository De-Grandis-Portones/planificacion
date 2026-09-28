// lib/despachoV2Db.js
//
// /despacho_v2: versión mobile-first para la cuadrilla, pensada para
// reemplazar en el futuro a /despacho (el tablero de workflow clásico) - por
// ahora conviven, se desarrolla en paralelo. Login con nombre de usuario QC
// + PIN (no es el login de admin) - solo ve sus propios viajes (los de su
// cuadrilla), reutiliza las tablas que ya existen de Logística de Viajes
// (logistica_cuadrilla_miembros/qc_users/logistica_viajes) y de Servicio
// Técnico (servicio_tecnico_solicitudes, para el botón ST/PV) sin tocarlas.
const { pool } = require('../db');
const { fetchItems, fetchParadasExtra, fetchDatosPorNv } = require('./logisticaMensajeViaje');
const solicitudesDb = require('./servicioTecnicoSolicitudesDb');

// Solo usuarios QC activos que están en AL MENOS una cuadrilla - son la
// única audiencia de este login (alguien de calidad que nunca maneja un
// camión no tiene sentido que aparezca acá).
async function listQcUsersDeCuadrillas() {
  const { rows } = await pool.query(
    `select distinct u.id, u.name
       from public.qc_users u
       join public.logistica_cuadrilla_miembros cm on cm.qc_user_id = u.id
       join public.logistica_cuadrillas c on c.id = cm.cuadrilla_id and c.activo
      where u.is_active
      order by u.name asc;`
  );
  return rows;
}

async function getQcUser(qcUserId) {
  const { rows } = await pool.query(
    `select id, name, pin_hash, is_active from public.qc_users where id = $1 limit 1;`,
    [Number(qcUserId)]
  );
  return rows[0] || null;
}

async function cuadrillasDeUsuario(qcUserId) {
  const { rows } = await pool.query(
    `select c.id, c.nombre
       from public.logistica_cuadrilla_miembros cm
       join public.logistica_cuadrillas c on c.id = cm.cuadrilla_id
      where cm.qc_user_id = $1 and c.activo
      order by c.nombre asc;`,
    [Number(qcUserId)]
  );
  return rows;
}

// Viajes de una o más cuadrillas, con lo que pide la pantalla mobile:
// vehículo, cuadrilla + nombres de los integrantes, cantidad de portones
// (NV únicos - despacho e instalación del mismo NV cuentan una vez, mismo
// criterio que el resto de la app), cantidad de paradas totales (portones +
// paradas extra, ej. hoteles), y hora_salida_real (botón "Play"). Switch
// pedido por el usuario: hoy hasta 10 días corridos después inclusive, o
// toda la programación.
async function listViajesDeCuadrillas(cuadrillaIds, { soloProximos10 } = {}) {
  const ids = (cuadrillaIds || []).map(Number).filter(Number.isInteger);
  if (!ids.length) return [];

  const filtroFecha = soloProximos10
    ? `and vi.fecha >= current_date and vi.fecha < current_date + 10`
    : '';

  const { rows } = await pool.query(
    `
    select
      vi.id, vi.nombre, vi.fecha::text as fecha, to_char(vi.hora_salida, 'HH24:MI') as hora_salida,
      vi.hora_salida_real, vi.hora_llegada_real, vi.ruta_real,
      c.id as cuadrilla_id, c.nombre as cuadrilla_nombre,
      ve.nombre as vehiculo_nombre, ve.capacidad_portones as vehiculo_capacidad,
      (select count(distinct p.nv)
         from public.logistica_viaje_portones vp
         join public.portones p on p.id = vp.porton_id
        where vp.viaje_id = vi.id) as cantidad_portones,
      (select count(*) from public.logistica_viaje_paradas_extra pe where pe.viaje_id = vi.id) as cantidad_paradas_extra,
      exists(
        select 1 from public.logistica_viaje_portones vp2
         where vp2.viaje_id = vi.id and vp2.tipo = 'instalacion'
      ) as tiene_instalacion
    from public.logistica_viajes vi
    left join public.logistica_cuadrillas c on c.id = vi.cuadrilla_id
    left join public.logistica_vehiculos ve on ve.id = vi.vehiculo_id
    where vi.cuadrilla_id = any($1::int[])
    ${filtroFecha}
    order by vi.fecha asc, vi.hora_salida asc nulls last, vi.id asc;
    `,
    [ids]
  );

  // Integrantes de cada cuadrilla involucrada - un solo query para todas
  // las que aparecen en el resultado, no uno por viaje.
  const cuadrillaIdsEnResultado = Array.from(new Set(rows.map((r) => r.cuadrilla_id).filter((x) => x != null)));
  const miembrosPorCuadrilla = new Map();
  if (cuadrillaIdsEnResultado.length) {
    const { rows: miembros } = await pool.query(
      `select cm.cuadrilla_id, cm.rol, u.name
         from public.logistica_cuadrilla_miembros cm
         join public.qc_users u on u.id = cm.qc_user_id and u.is_active
        where cm.cuadrilla_id = any($1::int[])
        order by u.name asc;`,
      [cuadrillaIdsEnResultado]
    );
    for (const m of miembros) {
      if (!miembrosPorCuadrilla.has(m.cuadrilla_id)) miembrosPorCuadrilla.set(m.cuadrilla_id, []);
      miembrosPorCuadrilla.get(m.cuadrilla_id).push({ name: m.name, rol: m.rol });
    }
  }

  return rows.map((r) => ({
    id: r.id,
    nombre: r.nombre,
    fecha: r.fecha,
    hora_salida: r.hora_salida,
    hora_salida_real: r.hora_salida_real,
    hora_llegada_real: r.hora_llegada_real,
    vehiculo_nombre: r.vehiculo_nombre,
    vehiculo_capacidad: r.vehiculo_capacidad,
    cuadrilla_id: r.cuadrilla_id,
    cuadrilla_nombre: r.cuadrilla_nombre,
    cuadrilla_miembros: miembrosPorCuadrilla.get(r.cuadrilla_id) || [],
    cantidad_portones: Number(r.cantidad_portones) || 0,
    cantidad_paradas: (Number(r.cantidad_portones) || 0) + (Number(r.cantidad_paradas_extra) || 0),
    distancia_km: r.ruta_real?.distancia_km ?? null,
    duracion_horas: r.ruta_real?.duracion_horas ?? null,
    // Para elegir qué checklist mostrar al arrancar el viaje (pedido
    // explícito del usuario): "con_instalacion" si tiene AL MENOS una
    // parada de instalación, "solo_despacho" si no.
    checklist_tipo: r.tiene_instalacion ? 'con_instalacion' : 'solo_despacho',
  }));
}

async function getViajeCuadrilla(viajeId) {
  const { rows } = await pool.query(
    `select id, cuadrilla_id, hora_salida_real, hora_llegada_real from public.logistica_viajes where id = $1;`,
    [Number(viajeId)]
  );
  return rows[0] || null;
}

// Botón "Play": solo la PRIMERA vez pisa hora_salida_real (un segundo toque
// - a propósito o por error - no debe correr el horario ya asentado).
async function marcarSalidaReal(viajeId) {
  const { rows } = await pool.query(
    `update public.logistica_viajes
        set hora_salida_real = coalesce(hora_salida_real, now())
      where id = $1
      returning hora_salida_real;`,
    [Number(viajeId)]
  );
  return rows[0]?.hora_salida_real || null;
}

// "Finalizar viaje" - pedido explícito del usuario: cierra el rango de
// fechas válido para los gastos de la rendición (hora_salida_real ->
// hora_llegada_real). Sin esto cargado, logística no puede aprobar la
// rendición (ver aprobarRendicion en logisticaGastosDb.js).
async function marcarLlegadaReal(viajeId) {
  const { rows } = await pool.query(
    `update public.logistica_viajes
        set hora_llegada_real = coalesce(hora_llegada_real, now())
      where id = $1
      returning hora_llegada_real;`,
    [Number(viajeId)]
  );
  return rows[0]?.hora_llegada_real || null;
}

// Lista desplegable (botón de tres líneas) de portones + paradas extra de un
// viaje, en orden real de ruta - portón: NV, Cliente, Distribuidor,
// Localidad (pedido explícito); parada extra: nombre + link de mapa. Mismas
// fuentes de datos ya usadas por el mensaje a la cuadrilla
// (logisticaMensajeViaje.js) - un solo query de datos por NV para todo el
// viaje, no uno por parada. Cada parada trae además horas_tramo (duración
// REAL del tramo hasta ESA parada, de ruta_real.segmentos_horas) - lo usa el
// botón "avisar que está en camino" (WhatsApp) para el ETA: al arrancar
// hacia una parada, "en aproximadamente X horas" es justo ese tramo, no
// hace falta acumular desde la salida del viaje.
async function listParadasDeViaje(viajeId) {
  const vId = Number(viajeId);
  const [items, paradasExtra, viajeRow] = await Promise.all([
    fetchItems(vId),
    fetchParadasExtra(vId),
    pool.query(`select ruta_real from public.logistica_viajes where id = $1;`, [vId]).then((r) => r.rows[0]),
  ]);
  const segmentosHoras = viajeRow?.ruta_real?.segmentos_horas || null;

  const nvsUnicos = Array.from(new Set(items.map((it) => it.nv)));
  const datosPorNv = await fetchDatosPorNv(nvsUnicos);

  // Portones dedupeados por NV (despacho+instalación del mismo NV = misma
  // parada), tomando el orden más chico entre sus filas - mismo criterio que
  // el resto de la app (rutasPorViaje en el frontend, construirRutaViaje en
  // el backend).
  const ordenPorNv = new Map();
  const tiposPorNv = new Map();
  for (const it of items) {
    if (!ordenPorNv.has(it.nv) || it.orden < ordenPorNv.get(it.nv)) ordenPorNv.set(it.nv, it.orden);
    if (!tiposPorNv.has(it.nv)) tiposPorNv.set(it.nv, new Set());
    tiposPorNv.get(it.nv).add(it.tipo);
  }

  const paradasPortones = Array.from(ordenPorNv.entries()).map(([nv, orden]) => ({
    tipo: 'porton', nv, orden, esExtra: false,
  }));
  const paradasExtraOut = paradasExtra.map((p) => ({
    tipo: 'extra', orden: p.orden, nombre: p.nombre, maps_url: p.maps_url, esExtra: true,
  }));

  // Todas juntas, en el MISMO orden que usó construirRutaViaje al calcular
  // ruta_real - así el índice de esta lista alinea 1 a 1 con segmentos_horas.
  const todas = [...paradasPortones, ...paradasExtraOut].sort((a, b) => a.orden - b.orden);

  return todas.map((p, i) => {
    const horas_tramo = segmentosHoras?.[i] ?? null;
    if (p.esExtra) return { tipo: 'extra', orden: p.orden, nombre: p.nombre, maps_url: p.maps_url, horas_tramo };
    const d = datosPorNv.get(p.nv) || {};
    const tipos = Array.from(tiposPorNv.get(p.nv) || []);
    return {
      tipo: 'porton',
      nv: p.nv,
      orden: p.orden,
      tipos_pendientes: tipos, // ['despacho'] | ['instalacion'] | ['despacho','instalacion']
      nombre_cliente: d.nombre_cliente || null,
      distribuidor: d.distribuidor || null,
      localidad: d.localidad || null,
      horas_tramo,
    };
  });
}

// Detalle completo de un NV (al tocar una parada-portón) - misma fuente de
// datos que el mensaje a la cuadrilla, más el maps_url (no viaja en
// listParadasDeViaje para no pesar la lista, se pide al abrir el detalle).
// MOTOR_Condicion viene con valores libres/sucios ('Automátizado',
// 'Manual (sin automatizar)', 'MANUAL   ', 'AUTOMATICO   ', etc.) -
// normaliza a una sola etiqueta prolija; si no matchea ninguno de los dos,
// devuelve el texto tal cual vino (mejor mostrar algo raro que nada).
function normalizaAutomaticoManual(raw) {
  if (!raw) return null;
  // "auto" alcanza (no "automat"): valores reales incluyen "Automátizado",
  // con tilde - "automat" sin tilde no matchea esa palabra.
  if (/^auto/i.test(raw)) return 'Automático';
  if (/manual/i.test(raw)) return 'Manual';
  return raw;
}

async function getNvDetalle(nv) {
  const nNv = Number(nv);
  if (!Number.isInteger(nNv)) return null;
  const [datos, stAbierta] = await Promise.all([
    fetchDatosPorNv([nNv]),
    solicitudesDb.getSolicitudAbiertaPorNv(nNv).catch(() => null),
  ]);
  const d = datos.get(nNv);
  if (!d) return { nv: nNv, nombre_cliente: null, distribuidor: null, direccion: null, localidad: null, telefono: null, maps_url: null, st_abierta: stAbierta };
  return { nv: nNv, ...d, automatico_manual: normalizaAutomaticoManual(d.motor_condicion), st_abierta: stAbierta };
}

// Botón "ST/PV" - crea una solicitud de Servicio Técnico (Fase 0, mismo
// sistema que ya usa el admin) desde el celular de la cuadrilla, con
// descripción y opcionalmente una foto/video (mismo formato base64 data_url
// que ya acepta el historial de la solicitud - sin storage nuevo).
async function crearSolicitudSt({ nv, descripcion, attachment, creadoPor }) {
  const solicitud = await solicitudesDb.createSolicitud({ nv, descripcion, creado_por: creadoPor });
  if (attachment) {
    await solicitudesDb.agregarHistorial(solicitud.id, { tipo: 'tecnico', autor: creadoPor, texto: descripcion, attachment });
  }
  return solicitud;
}

// ===========================================================================
// "Marcar entregado/instalado" - cierre OFICIAL real (pedido explícito del
// usuario, no un aviso interno aparte): despacho pasa por el mismo QC/PIN
// que ya usa /despacho (qc_authorize) - se reusa esa ruta YA PROBADA por
// llamado interno en vez de reimplementar su lógica (scopes, motivos,
// RECHAZADO, etc.) acá. Instalación no tiene ese mecanismo en el resto de
// la app (no hay columna portones.instalacion ni etapa de workflow para
// eso) - su "cierre oficial" YA ES, en todo el resto de la app, poner
// fecha_llegada_imput (lo que hace el campo "Fecha Llegada/Instalación" en
// /a) - así que es lo que hacemos acá, sin pedir PIN (nunca lo pidió nada
// que ya exista para este campo).
const PORT = process.env.PORT || 4000;

async function marcarDespachoOficial({ nv, pin }) {
  const axios = require('axios');
  const { data } = await axios.post(
    `http://127.0.0.1:${PORT}/qc/authorize`,
    { line: 'portones', item_id: Number(nv), stage_key: 'despacho', qc_status: 'FINALIZADO', pin },
    { timeout: 15000 }
  );
  return data;
}

async function marcarInstalacionOficial(nv) {
  const { rows } = await pool.query(
    `select id from public.preproduccion_valores where nv = $1 and nv_tipo = 'NV' limit 1;`,
    [Number(nv)]
  );
  if (!rows.length) throw new Error('No se encontró el registro de este NV para marcar instalación');
  const hoy = new Date().toISOString().slice(0, 10);
  await pool.query(
    `update public.preproduccion_valores set data = coalesce(data,'{}'::jsonb) || $2::jsonb where id = $1;`,
    [rows[0].id, JSON.stringify({ fecha_llegada_imput: hoy })]
  );
  return hoy;
}

// tipo: 'despacho' | 'instalacion'. pin solo hace falta para despacho.
async function marcarEntregado({ nv, tipo, pin }) {
  if (tipo === 'despacho') {
    const r = await marcarDespachoOficial({ nv, pin });
    return { ok: true, detalle: r };
  }
  if (tipo === 'instalacion') {
    const fecha = await marcarInstalacionOficial(nv);
    return { ok: true, fecha_llegada: fecha };
  }
  throw new Error("tipo debe ser 'despacho' o 'instalacion'");
}

// Próxima PARADA-PORTÓN de la ruta después de la actual (salta paradas
// extra tipo hotel - no tiene sentido avisarle a un hotel "su portón está
// en camino"). null si esta era la última parada del viaje.
async function siguienteParadaPorton(viajeId, nvActual) {
  const paradas = await listParadasDeViaje(viajeId);
  const idx = paradas.findIndex((p) => p.tipo === 'porton' && p.nv === Number(nvActual));
  if (idx === -1) return null;
  for (let i = idx + 1; i < paradas.length; i++) {
    if (paradas[i].tipo === 'porton') return paradas[i];
  }
  return null;
}

// Primera PARADA-PORTÓN del viaje - se usa al arrancar la ruta (botón
// Play/marcar-salida), donde todavía no hay ningún NV "actual" del cual
// partir. null si el viaje no tiene ningún portón cargado.
async function primeraParadaPorton(viajeId) {
  const paradas = await listParadasDeViaje(viajeId);
  return paradas.find((p) => p.tipo === 'porton') || null;
}

// ===========================================================================
// Aviso automático de WhatsApp a la siguiente parada - collage de fotos de
// la cuadrilla (qc_users.foto_storage_path) + del vehículo
// (logistica_vehiculos.foto_storage_path), lo que haya cargado (ver
// logisticaWhatsapp.js, tiene un placeholder de marca si no hay ninguna
// foto todavía).
function formatearDuracionHoras(horas) {
  if (horas == null) return 'poco tiempo';
  if (horas < 1) return `${Math.max(1, Math.round(horas * 60))} minutos`;
  const h = Math.floor(horas);
  const min = Math.round((horas - h) * 60);
  const horaTxt = `${h} hora${h === 1 ? '' : 's'}`;
  return min > 0 ? `${horaTxt} y ${min} minutos` : horaTxt;
}

async function datosParaAviso(viajeId) {
  const { rows } = await pool.query(
    `select vi.id, vi.cuadrilla_id, ve.nombre as vehiculo_nombre, ve.foto_storage_path as vehiculo_foto
       from public.logistica_viajes vi
       left join public.logistica_vehiculos ve on ve.id = vi.vehiculo_id
      where vi.id = $1;`,
    [Number(viajeId)]
  );
  const viaje = rows[0];
  if (!viaje) return null;

  const { rows: miembros } = await pool.query(
    `select u.name, cm.rol, u.foto_storage_path
       from public.logistica_cuadrilla_miembros cm
       join public.qc_users u on u.id = cm.qc_user_id and u.is_active
      where cm.cuadrilla_id = $1
      order by u.name asc;`,
    [viaje.cuadrilla_id]
  );

  const cuadrillaTexto = miembros.length
    ? miembros.map((m) => `${m.name}${m.rol ? ` (${m.rol})` : ''}`).join(', ')
    : null;
  const fotosMiembros = miembros.map((m) => m.foto_storage_path).filter(Boolean);

  return { vehiculoNombre: viaje.vehiculo_nombre, cuadrillaTexto, fotosMiembros, fotoVehiculo: viaje.vehiculo_foto || null };
}

async function registrarAviso({ viajeId, nvOrigen, nvDestino, telefono, resultado, enviadoPor }) {
  await pool.query(
    `insert into public.logistica_whatsapp_avisos
       (viaje_id, nv_origen, nv_destino, telefono_destino, estado, detalle_error, wa_message_id, enviado_por)
     values ($1,$2,$3,$4,$5,$6,$7,$8);`,
    [
      Number(viajeId), Number(nvOrigen), Number(nvDestino), telefono || null,
      resultado.ok ? 'enviado' : 'error',
      resultado.ok ? null : String(resultado.error || 'error desconocido').slice(0, 500),
      resultado.wa_message_id || null,
      enviadoPor || null,
    ]
  );
}

// Arma el texto/collage y manda el WhatsApp para UNA parada puntual -
// compartido por los tres disparadores posibles (primera parada al iniciar
// el viaje, siguiente parada en el orden original, o parada elegida a mano
// porque la ruta cambió). `nvOrigen` es solo para el log (de qué NV se
// viene) - en el caso de la primera parada no hay un "de dónde viene", así
// que los callers pasan el mismo nv de destino.
async function enviarAvisoParaParada({ viajeId, parada, nvOrigen, enviadoPor }) {
  const whatsapp = require('./logisticaWhatsapp');

  const [nvDetalle, datos] = await Promise.all([getNvDetalle(parada.nv), datosParaAviso(viajeId)]);
  if (!datos) return { ok: false, error: 'Viaje no encontrado' };

  // Mientras se testea el flujo (pedido explícito del usuario): TODOS los
  // avisos van a este celular en vez de al cliente real, sin importar el
  // NV. Sacar esta env var en Render el día que se confirme que el flujo
  // anda bien y se quiera activar para clientes de verdad.
  const telefonoTest = String(process.env.WHATSAPP_AVISO_TELEFONO_TEST || '').trim();
  const telefonoDestino = telefonoTest || nvDetalle?.telefono;

  const resultado = await whatsapp.enviarAvisoEnCamino({
    telefono: telefonoDestino,
    nombreCliente: nvDetalle?.nombre_cliente,
    horasTexto: formatearDuracionHoras(parada.horas_tramo),
    cuadrillaTexto: datos.cuadrillaTexto,
    vehiculoNombre: datos.vehiculoNombre,
    fotosMiembros: datos.fotosMiembros,
    fotoVehiculo: datos.fotoVehiculo,
  });

  await registrarAviso({
    viajeId, nvOrigen, nvDestino: parada.nv, telefono: telefonoDestino, resultado, enviadoPor,
  }).catch((e) => console.error('No se pudo registrar el aviso de WhatsApp:', e.message));

  return {
    ok: resultado.ok, error: resultado.error, siguienteNv: parada.nv,
    nombreCliente: nvDetalle?.nombre_cliente, horasTramo: parada.horas_tramo,
  };
}

// Se llama al arrancar el viaje (botón Play/marcar-salida) - manda el aviso
// de la PRIMERA parada-portón de la ruta, sin pedirle confirmación a la
// cuadrilla (pedido explícito del usuario: el primer mensaje sale solo).
async function avisarPrimeraParada({ viajeId, enviadoPor }) {
  const primera = await primeraParadaPorton(viajeId);
  if (!primera) return { ok: false, sinSiguiente: true };
  return enviarAvisoParaParada({ viajeId, parada: primera, nvOrigen: primera.nv, enviadoPor });
}

// Orquesta todo: busca la próxima parada-portón, arma el texto/collage, y
// manda - pensado para llamarse DESPUÉS de que el usuario confirmó "sí, la
// ruta sigue así" (ver el endpoint, que ya le mostró esta misma parada
// antes de preguntar).
async function avisarSiguienteParada({ viajeId, nvOrigen, enviadoPor }) {
  const siguiente = await siguienteParadaPorton(viajeId, nvOrigen);
  if (!siguiente) return { ok: false, sinSiguiente: true };
  return enviarAvisoParaParada({ viajeId, parada: siguiente, nvOrigen, enviadoPor });
}

// La ruta cambió y la cuadrilla eligió a mano cuál es la próxima parada a
// entregar - manda el aviso para ESA parada puntual (no necesariamente la
// que seguía en el orden original armado por el sistema).
async function avisarParadaElegida({ viajeId, nvOrigen, nvDestino, enviadoPor }) {
  const paradas = await listParadasDeViaje(viajeId);
  const parada = paradas.find((p) => p.tipo === 'porton' && p.nv === Number(nvDestino));
  if (!parada) return { ok: false, error: 'Esa parada no pertenece a este viaje' };
  return enviarAvisoParaParada({ viajeId, parada, nvOrigen: Number(nvOrigen), enviadoPor });
}

module.exports = {
  listQcUsersDeCuadrillas, getQcUser, cuadrillasDeUsuario,
  listViajesDeCuadrillas, getViajeCuadrilla, marcarSalidaReal, marcarLlegadaReal,
  listParadasDeViaje, getNvDetalle, crearSolicitudSt,
  marcarEntregado, siguienteParadaPorton, primeraParadaPorton,
  avisarPrimeraParada, avisarSiguienteParada, avisarParadaElegida, datosParaAviso,
};
