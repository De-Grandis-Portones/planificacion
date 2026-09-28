// lib/logisticaWhatsapp.js
//
// Aviso automático de WhatsApp Business (Meta Cloud API) a la próxima
// parada de la ruta cuando la cuadrilla marca un portón entregado/instalado
// - pedido explícito del usuario. Requiere una plantilla APROBADA por Meta
// (mensajes que la empresa inicia primero, sin que el cliente haya escrito
// antes, siempre necesitan plantilla - no es opcional). Ver
// WHATSAPP_TEMPLATE_* en .env para el nombre/idioma de la plantilla.
//
// Limitación real de la plataforma (no del código): una plantilla admite UN
// solo header de imagen, no varias fotos sueltas - por eso todas las fotos
// (cuadrilla + vehículo) se combinan acá mismo en UN collage antes de
// mandar, en vez de mandar un mensaje por foto (que además multiplicaría
// el costo y necesitaría una plantilla aprobada por cada una).
const axios = require('axios');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const os = require('os');
const path = require('path');
const storage = require('./logisticaAdjuntosStorage');
const { pool } = require('../db');

ffmpeg.setFfmpegPath(ffmpegPath);

const GRAPH_VERSION = 'v21.0';
const WA_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WA_BUSINESS_ACCOUNT_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
const WA_TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME || 'porton_en_camino';
const WA_TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || 'es_AR';

function configurado() {
  return !!(WA_TOKEN && WA_PHONE_NUMBER_ID);
}

const TILE = 480;
// Línea divisoria gris entre fotos del collage - pedido explícito del
// usuario, para distinguir a simple vista dónde termina una foto y empieza
// la siguiente. Se dibuja ENCIMA de la costura (no separa/achica las fotos),
// mismo criterio que una grilla de collage típica.
const LINEA_GROSOR = 6;
const LINEA_COLOR = { r: 158, g: 158, b: 158 };

// Placeholder de marca (SVG->PNG con sharp, sin depender de ningún archivo
// externo) - se usa SOLO si todavía no hay ninguna foto de cuadrilla/vehículo
// cargada, para que el envío nunca falle por falta de imagen (la plantilla,
// una vez aprobada con header de imagen, SIEMPRE necesita una).
async function placeholderMarca() {
  const svg = `
    <svg width="${TILE}" height="${TILE}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#0a6a33"/>
      <text x="50%" y="46%" font-family="sans-serif" font-size="40" font-weight="900" fill="#fff" text-anchor="middle">De Grandis</text>
      <text x="50%" y="58%" font-family="sans-serif" font-size="40" font-weight="900" fill="#fff" text-anchor="middle">Portones</text>
    </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// Collage de 2 filas (pedido explícito del usuario): arriba las fotos de la
// cuadrilla (1 a 3, lado a lado), abajo SIEMPRE la del vehículo, estirada
// (cover, sin deformar) al ancho total de la fila de arriba - así el
// resultado queda prolijo tenga 1, 2 o 3 integrantes.
async function armarCollage({ fotosMiembros, fotoVehiculo }) {
  const pathsMiembros = (fotosMiembros || []).filter(Boolean).slice(0, 3);

  let buffersMiembros = [];
  if (pathsMiembros.length) {
    const descargadas = await Promise.all(pathsMiembros.map((p) => storage.descargarArchivo(p).catch(() => null)));
    buffersMiembros = descargadas.filter(Boolean);
  }
  if (!buffersMiembros.length) buffersMiembros = [await placeholderMarca()];

  const bufferVehiculo = (fotoVehiculo && await storage.descargarArchivo(fotoVehiculo).catch(() => null)) || await placeholderMarca();

  const cols = buffersMiembros.length;
  const anchoTotal = cols * TILE;

  const [arriba, abajo] = await Promise.all([
    Promise.all(buffersMiembros.map((buf) => sharp(buf).resize(TILE, TILE, { fit: 'cover' }).toBuffer())),
    // 'contain' en vez de 'cover' - pedido explícito del usuario: no quiere
    // que se recorte el vehículo para llenar el ancho, prefiere verlo
    // completo aunque quede espacio en blanco a los costados/arriba-abajo.
    sharp(bufferVehiculo).resize(anchoTotal, TILE, { fit: 'contain', background: '#ffffff' }).toBuffer(),
  ]);

  // Líneas divisorias: verticales entre las fotos de la fila de arriba (si
  // hay más de una), y una horizontal entre la fila de arriba y el vehículo.
  const [lineasVerticales, lineaHorizontal] = await Promise.all([
    Promise.all(
      Array.from({ length: cols - 1 }, () =>
        sharp({ create: { width: LINEA_GROSOR, height: TILE, channels: 3, background: LINEA_COLOR } }).png().toBuffer()
      )
    ),
    sharp({ create: { width: anchoTotal, height: LINEA_GROSOR, channels: 3, background: LINEA_COLOR } }).png().toBuffer(),
  ]);

  const composites = [
    ...arriba.map((buf, i) => ({ input: buf, left: i * TILE, top: 0 })),
    { input: abajo, left: 0, top: TILE },
    ...lineasVerticales.map((buf, i) => ({ input: buf, left: (i + 1) * TILE - LINEA_GROSOR / 2, top: 0 })),
    { input: lineaHorizontal, left: 0, top: TILE - LINEA_GROSOR / 2 },
  ];

  return sharp({ create: { width: anchoTotal, height: TILE * 2, channels: 3, background: '#ffffff' } })
    .composite(composites)
    .jpeg({ quality: 85 })
    .toBuffer();
}

// Sube el collage a Storage (mismo bucket privado de adjuntos, prefijo
// aparte) y devuelve una URL firmada - Meta la descarga al toque de mandar
// el mensaje, 10 minutos alcanza de sobra.
async function subirCollageYFirmar(buffer) {
  const path = `whatsapp-collage/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  await storage.subirArchivo(path, buffer, 'image/jpeg');
  return storage.urlFirmada(path, 600);
}

// Argentina exige el "9" después del 54 para celulares en el formato que
// pide la API (a diferencia de wa.me, que es más permisivo y no lo exige) -
// ej. 5493572405259, no 543572405259 - confirmado por el usuario al probar
// la API real. Ningún código de área argentino arranca con 9, así que
// chequear si YA está no confunde un área real con la marca de celular.
function formatearTelefono(telefono) {
  const digitos = String(telefono || '').replace(/\D/g, '');
  if (!digitos) return null;
  if (digitos.startsWith('54')) {
    const resto = digitos.slice(2);
    return resto.startsWith('9') ? digitos : `549${resto}`;
  }
  return `549${digitos.replace(/^0/, '')}`;
}

/**
 * @param {object} p
 * @param {string} p.telefono - del cliente destino
 * @param {string} p.nombreCliente
 * @param {string} p.horasTexto - ej. "2 horas y 50 minutos"
 * @param {string} p.cuadrillaTexto - ej. "Martín Ferreyra (Chofer), Francisco Correa"
 * @param {string} p.vehiculoNombre
 * @param {string[]} p.fotosMiembros - paths de Storage de la cuadrilla (1 a 3)
 * @param {string} p.fotoVehiculo - path de Storage de la foto del vehículo
 */
async function enviarAvisoEnCamino({ telefono, nombreCliente, horasTexto, cuadrillaTexto, vehiculoNombre, fotosMiembros, fotoVehiculo }) {
  if (!configurado()) {
    console.warn('WhatsApp Business no configurado en este entorno (falta WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID) - no se manda el aviso.');
    return { ok: false, error: 'WhatsApp Business no configurado en este entorno' };
  }
  const conCodigo = formatearTelefono(telefono);
  if (!conCodigo) return { ok: false, error: 'El cliente no tiene teléfono cargado' };

  let imagenUrl = null;
  try {
    const collage = await armarCollage({ fotosMiembros, fotoVehiculo });
    imagenUrl = await subirCollageYFirmar(collage);
  } catch (e) {
    console.error('Error armando/subiendo el collage de WhatsApp:', e.message);
    return { ok: false, error: 'No se pudo armar la imagen del mensaje', detalle: e.message };
  }

  try {
    const { data } = await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${WA_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: conCodigo,
        type: 'template',
        template: {
          name: WA_TEMPLATE_NAME,
          language: { code: WA_TEMPLATE_LANG },
          components: [
            { type: 'header', parameters: [{ type: 'image', image: { link: imagenUrl } }] },
            {
              type: 'body',
              parameters: [
                { type: 'text', text: nombreCliente || 'cliente' },
                { type: 'text', text: horasTexto || 'poco tiempo' },
                { type: 'text', text: cuadrillaTexto || '(sin cargar)' },
                { type: 'text', text: vehiculoNombre || 'un camión' },
              ],
            },
          ],
        },
      },
      { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    const waMessageId = data?.messages?.[0]?.id || null;
    // Se registra en la bandeja general (mismo hilo que ve el chat) además
    // del log puntual que ya lleva despachoV2Db.js - best-effort, si falla
    // el registro no hace fallar el envío que ya salió.
    registrarMensajeSaliente({
      telefono: conCodigo, tipo: 'template',
      contenido: `📦 Aviso "en camino" a ${nombreCliente || 'cliente'} (${horasTexto || 'poco tiempo'})`,
      waMessageId,
    }).catch(() => {});
    return { ok: true, wa_message_id: waMessageId };
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    console.error('Error mandando WhatsApp:', msg, JSON.stringify(e.response?.data || {}));
    return { ok: false, error: msg, detalle: e.response?.data };
  }
}

// Lista las plantillas de mensaje ya cargadas en Meta para esta cuenta de
// WhatsApp Business (nombre, idioma, categoría, estado de aprobación y el
// texto de cada componente) - pedido explícito del usuario, para poder
// verlas desde la app en vez de entrar a WhatsApp Manager.
async function listarTemplates() {
  if (!WA_TOKEN || !WA_BUSINESS_ACCOUNT_ID) {
    throw new Error('WhatsApp Business no configurado en este entorno (falta WHATSAPP_ACCESS_TOKEN / WHATSAPP_BUSINESS_ACCOUNT_ID)');
  }
  const { data } = await axios.get(
    `https://graph.facebook.com/${GRAPH_VERSION}/${WA_BUSINESS_ACCOUNT_ID}/message_templates`,
    { headers: { Authorization: `Bearer ${WA_TOKEN}` }, params: { limit: 100 }, timeout: 15000 }
  );
  return (data?.data || []).map((t) => ({
    id: t.id,
    name: t.name,
    language: t.language,
    category: t.category,
    status: t.status,
    components: t.components || [],
  }));
}

// ===========================================================================
// Bandeja de WhatsApp (pedido explícito del usuario): registro de TODOS los
// mensajes (entrantes por webhook + salientes desde acá) en una sola tabla,
// para poder mostrar el hilo de conversación por teléfono como un chat.
// ===========================================================================

async function registrarMensajeSaliente({ telefono, tipo, contenido, waMessageId, enviadoPor, mediaStoragePath }) {
  const { rows } = await pool.query(
    `insert into public.logistica_whatsapp_mensajes
       (telefono, direccion, tipo, contenido, wa_message_id, estado, enviado_por, media_storage_path)
     values ($1, 'saliente', $2, $3, $4, 'enviado', $5, $6)
     returning *;`,
    [telefono, tipo || 'text', contenido || null, waMessageId || null, enviadoPor || null, mediaStoragePath || null]
  );
  return rows[0];
}

async function registrarMensajeEntrante({ telefono, tipo, contenido, mediaId, mediaStoragePath, waMessageId, raw }) {
  const { rows } = await pool.query(
    `insert into public.logistica_whatsapp_mensajes
       (telefono, direccion, tipo, contenido, media_id, media_storage_path, wa_message_id, estado, raw)
     values ($1, 'entrante', $2, $3, $4, $5, $6, 'recibido', $7)
     on conflict (wa_message_id) where wa_message_id is not null do nothing
     returning *;`,
    [telefono, tipo || 'text', contenido || null, mediaId || null, mediaStoragePath || null, waMessageId || null, raw ? JSON.stringify(raw) : null]
  );
  return rows[0] || null;
}

// Baja el archivo de un mensaje ENTRANTE (Meta da un media_id, hay que
// resolverlo a una URL temporal - unos minutos de vida - y bajarla con el
// mismo token) y lo resube al bucket privado propio, para poder mostrarlo en
// el chat con una URL firmada nuestra en vez de depender de la de Meta.
async function descargarMediaEntrante(mediaId, tipo) {
  const { data: meta } = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${WA_TOKEN}` }, timeout: 15000,
  });
  const { data: buffer } = await axios.get(meta.url, {
    headers: { Authorization: `Bearer ${WA_TOKEN}` }, responseType: 'arraybuffer', timeout: 30000,
  });
  const ext = (meta.mime_type || '').split('/')[1]?.split(';')[0] || 'bin';
  const path = `whatsapp-chat/${tipo}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  await storage.subirArchivo(path, Buffer.from(buffer), meta.mime_type || 'application/octet-stream');
  return path;
}

// Los navegadores graban audio en webm/opus (Chrome) u ogg/opus (Firefox) -
// WhatsApp solo acepta ogg/opus para notas de voz, nunca webm. Se transcodea
// siempre que no sea ya ogg, así funciona sin importar el navegador de quien
// esté grabando. Vía archivos temporales (ffmpeg no labura bien con buffers
// puros para contenedores como estos).
async function transcodearAudioOgg(buffer, mimeTypeOriginal) {
  if (/ogg/i.test(mimeTypeOriginal || '')) return buffer; // ya viene en el formato que necesitamos
  const tmpDir = os.tmpdir();
  const inPath = path.join(tmpDir, `wa-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const outPath = `${inPath}.ogg`;
  await fs.promises.writeFile(inPath, buffer);
  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inPath)
        .audioCodec('libopus')
        .audioBitrate('32k')
        .audioChannels(1)
        .format('ogg')
        .on('error', reject)
        .on('end', resolve)
        .save(outPath);
    });
    return await fs.promises.readFile(outPath);
  } finally {
    fs.promises.unlink(inPath).catch(() => {});
    fs.promises.unlink(outPath).catch(() => {});
  }
}

// Sube un archivo NUESTRO (adjuntado desde el chat) y lo manda por Meta -
// necesita una URL pública (firmada) para que Meta la descargue al momento
// de entregar el mensaje, mismo patrón que el header de imagen del aviso
// automático (logisticaWhatsapp.js#subirCollageYFirmar).
async function enviarMedia({ telefono, tipo, buffer, mimeType, caption, enviadoPor }) {
  if (!configurado()) return { ok: false, error: 'WhatsApp Business no configurado en este entorno' };
  try {
    await avisarAtencionSiCorresponde(telefono, enviadoPor);
    let bufferFinal = buffer;
    let mimeFinal = mimeType;
    if (tipo === 'audio') {
      bufferFinal = await transcodearAudioOgg(buffer, mimeType);
      mimeFinal = 'audio/ogg';
    }
    const ext = (mimeFinal || '').split('/')[1]?.split(';')[0] || 'bin';
    const path = `whatsapp-chat/${tipo}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    await storage.subirArchivo(path, bufferFinal, mimeFinal || 'application/octet-stream');
    const url = await storage.urlFirmada(path, 600);
    const { data } = await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${WA_PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: telefono, type: tipo, [tipo]: { link: url, ...(caption ? { caption } : {}) } },
      { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 20000 }
    );
    const waMessageId = data?.messages?.[0]?.id || null;
    const mensaje = await registrarMensajeSaliente({ telefono, tipo, contenido: caption || null, waMessageId, enviadoPor, mediaStoragePath: path });
    return { ok: true, mensaje };
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    return { ok: false, error: msg, detalle: e.response?.data };
  }
}

// URL firmada para mostrar un adjunto del chat - se calcula al leer, nunca
// se guarda. Una hora (no los 600s de la URL que sube a Meta) para que una
// conversación abierta un rato largo no se quede con imágenes/videos rotos
// a mitad de sesión - el frontend además reusa la misma URL entre polls
// mientras sea el mismo archivo, para no recargar el media de arriba.
async function urlFirmadaDeMensaje(path) {
  if (!path) return null;
  return storage.urlFirmada(path, 3600).catch(() => null);
}

// Orden de progreso de un mensaje saliente - evita que "delivered" pise a
// "read" si los webhooks de Meta llegan desordenados.
const ORDEN_ESTADO = ['enviado', 'entregado', 'leido', 'fallido'];

async function actualizarEstadoMensaje({ waMessageId, estado, detalleError }) {
  if (!waMessageId) return;
  await pool.query(
    `update public.logistica_whatsapp_mensajes
        set estado = $2, detalle_error = coalesce($3, detalle_error)
      where wa_message_id = $1
        and coalesce(array_position($4::text[], $2::text), 0) >= coalesce(array_position($4::text[], estado), 0);`,
    [waMessageId, estado, detalleError || null, ORDEN_ESTADO]
  ).catch(() => {}); // best-effort: si no matchea ningún mensaje (ej. muy viejo), no rompe el webhook
}

// Última línea de cada conversación (agrupada por teléfono) - para la lista
// de chats tipo WhatsApp Web, ordenada por más reciente primero.
async function listarConversaciones() {
  const { rows } = await pool.query(
    `
    select distinct on (telefono)
      telefono, direccion, tipo, contenido, estado, created_at
    from public.logistica_whatsapp_mensajes
    order by telefono, created_at desc;
    `
  );
  const conNombre = await Promise.all(
    rows.map(async (r) => ({ ...r, nombreCliente: await nombreClientePorTelefono(r.telefono).catch(() => null) }))
  );
  return conNombre.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

async function listarMensajes(telefono, { antes } = {}) {
  const params = [telefono];
  let cond = '';
  if (antes) { params.push(antes); cond = 'and created_at < $2'; }
  const { rows } = await pool.query(
    `select * from public.logistica_whatsapp_mensajes
      where telefono = $1 ${cond}
      order by created_at desc
      limit 100;`,
    params
  );
  const conUrl = await Promise.all(
    rows.map(async (r) => ({ ...r, media_url: r.media_storage_path ? await urlFirmadaDeMensaje(r.media_storage_path) : null }))
  );
  return conUrl.reverse();
}

async function _enviarTextoCrudo(telefono, texto) {
  const { data } = await axios.post(
    `https://graph.facebook.com/${GRAPH_VERSION}/${WA_PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to: telefono, type: 'text', text: { body: texto } },
    { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  return data?.messages?.[0]?.id || null;
}

// "Usted está siendo atendido por X" - pedido explícito del usuario: se
// manda solo en el PRIMER mensaje de una respuesta (el anterior en el hilo
// es del cliente) o cuando cambia quién contesta respecto del último
// saliente - nunca dos veces seguidas para el mismo usuario en la misma
// tanda de mensajes.
async function avisarAtencionSiCorresponde(telefono, enviadoPor) {
  if (!enviadoPor) return;
  const { rows } = await pool.query(
    `select direccion, enviado_por from public.logistica_whatsapp_mensajes
      where telefono = $1 order by created_at desc limit 1;`,
    [telefono]
  );
  const ultimo = rows[0];
  const corresponde = !!ultimo && (ultimo.direccion === 'entrante' || ultimo.enviado_por !== enviadoPor);
  if (!corresponde) return;
  try {
    const texto = `Usted está siendo atendido por ${enviadoPor}`;
    const waMessageId = await _enviarTextoCrudo(telefono, texto);
    await registrarMensajeSaliente({ telefono, tipo: 'text', contenido: texto, waMessageId, enviadoPor });
  } catch (e) {
    console.error('No se pudo mandar el aviso de "atendido por":', e.response?.data || e.message);
  }
}

// Texto libre - solo funciona dentro de las 24hs desde el último mensaje del
// cliente (regla de la plataforma, no de este código); pasada la ventana,
// Meta devuelve un error explícito que se propaga tal cual.
async function enviarTextoLibre({ telefono, texto, enviadoPor }) {
  if (!configurado()) return { ok: false, error: 'WhatsApp Business no configurado en este entorno' };
  try {
    await avisarAtencionSiCorresponde(telefono, enviadoPor);
    const waMessageId = await _enviarTextoCrudo(telefono, texto);
    const mensaje = await registrarMensajeSaliente({ telefono, tipo: 'text', contenido: texto, waMessageId, enviadoPor });
    return { ok: true, mensaje };
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    return { ok: false, error: msg, detalle: e.response?.data };
  }
}

// Plantilla SIN variables (ej. hello_world) - para reabrir una conversación
// con la ventana de 24hs vencida sin necesitar un formulario de parámetros.
// Las que sí tienen variables (ej. porton_en_camino) se siguen mandando
// desde su flujo dedicado (el aviso automático del viaje).
async function enviarTemplateSimple({ telefono, templateName, language, enviadoPor }) {
  if (!configurado()) return { ok: false, error: 'WhatsApp Business no configurado en este entorno' };
  try {
    const { data } = await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${WA_PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: telefono, type: 'template', template: { name: templateName, language: { code: language } } },
      { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    const waMessageId = data?.messages?.[0]?.id || null;
    const mensaje = await registrarMensajeSaliente({ telefono, tipo: 'template', contenido: `📦 Plantilla: ${templateName}`, waMessageId, enviadoPor });
    return { ok: true, mensaje };
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    return { ok: false, error: msg, detalle: e.response?.data };
  }
}

// Nombre del cliente para mostrar en el chat - mismo criterio "últimos 10
// dígitos" para comparar teléfonos guardados en formatos distintos (con/sin
// 54, 9, 15, etc.) contra el canónico que usa la API de WhatsApp. El nombre
// cargado a mano (logistica_whatsapp_contactos) pisa al resuelto automático
// - pedido explícito del usuario: el de presupuestador_quotes a veces sale
// mezclado con la descripción del producto, según cómo haya quedado cargado
// el presupuesto.
async function nombreClientePorTelefono(telefono) {
  const { rows: manual } = await pool.query(
    `select nombre from public.logistica_whatsapp_contactos where telefono = $1;`,
    [telefono]
  );
  if (manual[0]?.nombre) return manual[0].nombre;

  const digitos = String(telefono || '').replace(/\D/g, '').slice(-10);
  if (digitos.length < 8) return null;
  const { rows } = await pool.query(
    `select q.end_customer->>'name' as nombre
       from public.presupuestador_quotes q
      where q.quote_kind = 'original'
        and right(regexp_replace(coalesce(q.end_customer->>'phone', ''), '\\D', '', 'g'), 10) = $1
      order by q.id desc
      limit 1;`,
    [digitos]
  );
  return rows[0]?.nombre || null;
}

async function setNombreContacto(telefono, nombre, updatedBy) {
  const nm = String(nombre || '').trim();
  if (!nm) {
    await pool.query(`delete from public.logistica_whatsapp_contactos where telefono = $1;`, [telefono]);
    return null;
  }
  const { rows } = await pool.query(
    `insert into public.logistica_whatsapp_contactos (telefono, nombre, updated_by, updated_at)
     values ($1, $2, $3, now())
     on conflict (telefono) do update set nombre = excluded.nombre, updated_by = excluded.updated_by, updated_at = now()
     returning nombre;`,
    [telefono, nm, updatedBy || null]
  );
  return rows[0].nombre;
}

const VENTANA_24HS_MS = 24 * 60 * 60 * 1000;

// Estado de la ventana de conversación (regla de WhatsApp: solo se puede
// mandar texto libre dentro de las 24hs desde el último mensaje ENTRANTE).
async function estadoConversacion(telefono) {
  const { rows } = await pool.query(
    `select created_at from public.logistica_whatsapp_mensajes
      where telefono = $1 and direccion = 'entrante'
      order by created_at desc limit 1;`,
    [telefono]
  );
  const ultimoEntranteAt = rows[0]?.created_at || null;
  const ventanaAbierta = !!ultimoEntranteAt && (Date.now() - new Date(ultimoEntranteAt).getTime()) < VENTANA_24HS_MS;
  return { ventanaAbierta, ultimoEntranteAt };
}

module.exports = {
  configurado, enviarAvisoEnCamino, armarCollage, listarTemplates, formatearTelefono,
  registrarMensajeSaliente, registrarMensajeEntrante, actualizarEstadoMensaje,
  listarConversaciones, listarMensajes, enviarTextoLibre, enviarTemplateSimple,
  descargarMediaEntrante, enviarMedia, urlFirmadaDeMensaje,
  nombreClientePorTelefono, estadoConversacion, setNombreContacto,
};
