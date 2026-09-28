// lib/programadoresChatStorage.js
//
// Adjuntos del Chat de Programadores. Mismo criterio que
// logisticaAdjuntosStorage.js: bucket PRIVADO de Supabase Storage (no BYTEA
// en la base, que es compartida con el resto del ecosistema), servido por
// URL firmada. Bucket propio ("programadores-chat") para no mezclar capturas
// y archivos de desarrollo con los DNI de Logística; si no existe se crea
// solo (privado) la primera vez que alguien sube algo.
const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'programadores-chat';
const MAX_BYTES = 15 * 1024 * 1024;
// Largo a propósito (12h, lo mismo que dura el token de admin): el chat
// queda abierto horas y las imágenes viejas se siguen mostrando/abriendo
// sin tener que volver a pedir las URLs.
const URL_SEGUNDOS = 12 * 60 * 60;

let client = null;
function getClient() {
  if (client) return client;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return client;
}

function requireClient() {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase Storage no está configurado en este entorno (falta SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  return supabase;
}

let bucketListo = null;
function asegurarBucket(supabase) {
  if (!bucketListo) {
    bucketListo = (async () => {
      const { data } = await supabase.storage.getBucket(BUCKET);
      if (data) return;
      const { error } = await supabase.storage.createBucket(BUCKET, { public: false, fileSizeLimit: MAX_BYTES });
      if (error && !/already exists/i.test(error.message || '')) throw error;
    })().catch((err) => {
      bucketListo = null; // que el próximo intento vuelva a probar
      throw err;
    });
  }
  return bucketListo;
}

async function subirArchivo(path, buffer, contentType) {
  const supabase = requireClient();
  await asegurarBucket(supabase);
  const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, { contentType, upsert: false });
  if (error) throw error;
}

// { path: signedUrl } para todos los paths en un solo pedido. Si Storage no
// está configurado o falla, devuelve {} (el mensaje se muestra igual, sin
// el link) en vez de romper el listado entero del chat.
async function urlsFirmadas(paths) {
  const lista = [...new Set((paths || []).filter(Boolean))];
  const supabase = getClient();
  if (!supabase || !lista.length) return {};
  try {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(lista, URL_SEGUNDOS);
    if (error) throw error;
    const out = {};
    for (const r of data || []) if (r?.path && r?.signedUrl) out[r.path] = r.signedUrl;
    return out;
  } catch (err) {
    console.error('programadores-chat urlsFirmadas error:', err);
    return {};
  }
}

module.exports = { subirArchivo, urlsFirmadas, BUCKET, MAX_BYTES };
