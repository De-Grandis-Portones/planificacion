// src/components/programadoresProyectos/proyectosComun.js
//
// Constantes y helpers de los Proyectos de Programadores (tarjetas en
// pages/admin/ProgramadoresProyectosPage.jsx, ficha + chat en
// ProgramadoresProyectoPage.jsx).

// Mismos valores que valida el backend (lib/programadoresProyectosDb.js).
export const ESTADOS = {
  por_empezar: { label: 'Por empezar', color: '#64748b', fondo: '#f1f5f9' },
  en_curso: { label: 'En curso', color: '#008241', fondo: '#e8f6ee' },
  en_pausa: { label: 'En pausa', color: '#b45309', fondo: '#fef3c7' },
  terminado: { label: 'Terminado', color: '#1d4ed8', fondo: '#dbeafe' },
};

export const ORDEN_ESTADOS = ['en_curso', 'por_empezar', 'en_pausa', 'terminado'];

export function estadoDe(clave) {
  return ESTADOS[clave] || ESTADOS.en_curso;
}

// "Santiago Drapperi" si tiene nombre cargado, si no el usuario de login.
export function nombreDe(persona) {
  return persona?.name || persona?.username || '';
}

// "Migración tablero" -> "MT": va en el círculo del encabezado del chat.
export function inicialesProyecto(nombre) {
  const palabras = String(nombre || '').trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (!palabras.length) return 'P';
  if (palabras.length === 1) return palabras[0].slice(0, 2).toUpperCase();
  return (palabras[0][0] + palabras[1][0]).toUpperCase();
}

// "14:32" hoy, "ayer", "lun 3/10" esta semana... para el último mensaje.
export function cuandoCorto(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const hoy = new Date();
  if (d.toDateString() === hoy.toDateString()) {
    return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  }
  const ayer = new Date();
  ayer.setDate(hoy.getDate() - 1);
  if (d.toDateString() === ayer.toDateString()) return 'ayer';
  const opts = { day: 'numeric', month: 'numeric' };
  if (d.getFullYear() !== hoy.getFullYear()) opts.year = '2-digit';
  return d.toLocaleDateString('es-AR', opts);
}

export function fechaLarga(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' });
}
