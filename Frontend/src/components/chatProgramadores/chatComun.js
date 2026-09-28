// src/components/chatProgramadores/chatComun.js
//
// Constantes y helpers compartidos por el Chat de Programadores
// (pages/admin/ProgramadoresChatPage.jsx), su burbuja/composer y los avisos
// del encabezado (ChatProgramadoresProvider.jsx).
import { getCurrentScopes } from '../../utils/adminScopes';

export const RUTA_CHAT = '/admin/programadores/chat';
export const SCOPE_CHAT = 'programadores:admin';

export function puedeUsarChat() {
  return getCurrentScopes().includes(SCOPE_CHAT);
}

export const MAX_ARCHIVOS = 5;
export const MAX_BYTES = 15 * 1024 * 1024;
// Mismo set que routes/admin/programadoresChat.js (el backend es el que
// manda; esto es para avisar antes de subir).
export const EXTENSIONES = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'heic',
  'pdf', 'txt', 'log', 'md', 'csv', 'json', 'xml', 'sql',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'zip', 'rar', '7z',
  'mp4', 'webm', 'mov', 'mp3', 'ogg', 'wav', 'm4a',
]);

export const EMOJIS = [
  '😀', '😂', '🤣', '😅', '😊', '😉', '😍', '😎', '🤔', '🙄',
  '😬', '😴', '😢', '😭', '😡', '🤯', '🥳', '😱', '🤦', '🤷',
  '👍', '👎', '👏', '🙌', '🙏', '💪', '👀', '🤝', '👋', '👌',
  '✌️', '🔥', '✨', '🎉', '💯', '✅', '❌', '⚠️', '🐛', '🚀',
  '💻', '🖥️', '⌨️', '🧪', '🔧', '🛠️', '📦', '📌', '📎', '📝',
  '📊', '⏰', '☕', '🍕', '❤️', '💚', '💡', '🧠', '🙃', '😏',
];

// Las de acceso rápido del menú de cada mensaje.
export const REACCIONES_RAPIDAS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

export const C = {
  fondo: '#efeae2',
  propio: '#d9fdd3',
  ajeno: '#ffffff',
  texto: '#111b21',
  suave: '#667781',
  tildeAzul: '#53bdeb',
  tildeGris: '#8696a0',
  link: '#027eb5',
};

// En vw y no en %: un max-width en % no achica el ancho "intrínseco" que la
// burbuja (shrink-to-fit) calcula para una imagen grande, y quedaba un
// hueco en blanco al costado.
export const MEDIA_MAX = 'min(280px, 62vw)';

export function extensionDe(nombre) {
  const m = String(nombre || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

export function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatHora(iso) {
  return new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

export function claveDia(iso) {
  return new Date(iso).toDateString();
}

export function etiquetaDia(iso) {
  const d = new Date(iso);
  const hoy = new Date();
  const ayer = new Date();
  ayer.setDate(hoy.getDate() - 1);
  if (d.toDateString() === hoy.toDateString()) return 'Hoy';
  if (d.toDateString() === ayer.toDateString()) return 'Ayer';
  const opts = { weekday: 'long', day: 'numeric', month: 'long' };
  if (d.getFullYear() !== hoy.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('es-AR', opts);
}

export function iconoArchivo(nombre) {
  const ext = extensionDe(nombre);
  if (ext === 'pdf') return '📕';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
  if (['doc', 'docx'].includes(ext)) return '📝';
  if (['ppt', 'pptx'].includes(ext)) return '📽️';
  if (['zip', 'rar', '7z'].includes(ext)) return '🗜️';
  if (['mp3', 'ogg', 'wav', 'm4a'].includes(ext)) return '🎵';
  return '📄';
}

export function esImagen(tipo, nombre) {
  const ext = extensionDe(nombre);
  return (String(tipo || '').startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) && ext !== 'heic';
}

// Una línea para citas y avisos: el texto, o "📷 Foto" / "📄 archivo.pdf".
export function previewDe({ texto, adjunto, n_adjuntos: nAdjuntos, eliminado }) {
  if (eliminado) return '🚫 Mensaje eliminado';
  const t = String(texto || '').replace(/```/g, '').replace(/\s+/g, ' ').trim();
  if (t) return t;
  if (adjunto) return esImagen(adjunto.tipo, adjunto.nombre) ? '📷 Foto' : `📄 ${adjunto.nombre}`;
  if (nAdjuntos) return nAdjuntos === 1 ? '📎 Archivo' : `📎 ${nAdjuntos} archivos`;
  return '';
}

// Datos de cita/aviso a partir de un mensaje completo.
export function resumenDe(m) {
  return {
    id: m.id,
    autor_username: m.autor_username,
    texto: m.texto,
    eliminado: m.eliminado,
    adjunto: m.adjuntos?.[0] ? { nombre: m.adjuntos[0].nombre, tipo: m.adjuntos[0].tipo } : null,
    n_adjuntos: m.adjuntos?.length || 0,
  };
}

export const MENCION_RE = /(^|[^\w@])@([A-Za-z0-9._-]+)/g;

export function mencionaA(texto, username) {
  if (!texto || !username) return false;
  const u = username.toLowerCase();
  for (const m of String(texto).matchAll(MENCION_RE)) if (m[2].toLowerCase() === u) return true;
  return false;
}

// Reemplaza por id (ediciones, reacciones, eliminados) y agrega lo nuevo.
// Lo que sea más viejo que lo cargado se ignora: se trae fresco al tocar
// "Cargar anteriores".
// También actualiza las citas de las respuestas a un mensaje que se editó o
// eliminó, para no esperar a recargar.
export function aplicarMensajes(prev, nuevos) {
  if (!nuevos?.length) return prev;
  const minId = prev.length ? prev[0].id : -Infinity;
  const porId = new Map(prev.map((m) => [m.id, m]));
  const citas = new Map();
  let cambio = false;
  for (const m of nuevos) {
    if (!porId.has(m.id) && m.id < minId) continue;
    porId.set(m.id, m);
    citas.set(m.id, resumenDe(m));
    cambio = true;
  }
  if (!cambio) return prev;
  for (const [id, m] of porId) {
    const c = m.responde_a && citas.get(m.responde_a.id);
    if (c) porId.set(id, { ...m, responde_a: { ...m.responde_a, ...c, texto: c.texto ? String(c.texto).slice(0, 300) : null } });
  }
  return [...porId.values()].sort((a, b) => a.id - b.id);
}

// Para agregar una página de anteriores (esos sí son más viejos).
export function mergeMensajes(prev, nuevos) {
  if (!nuevos?.length) return prev;
  const porId = new Map(prev.map((m) => [m.id, m]));
  for (const m of nuevos) porId.set(m.id, m);
  return [...porId.values()].sort((a, b) => a.id - b.id);
}

// Para el polling: no reemplazar el estado (y re-renderizar todo el chat)
// si lecturas/miembros vinieron iguales.
export function siCambio(nuevo) {
  return (prev) => (JSON.stringify(prev) === JSON.stringify(nuevo) ? prev : nuevo);
}
