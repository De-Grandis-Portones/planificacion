// src/utils/soloMisTareas.js — preferencia "Solo mis tareas" de Tickets
// (lista /admin/tickets y tablero /admin/tickets-tablero): mostrar solo lo
// que uno tiene asignado (en_progreso_por). Se recuerda en este navegador y
// la comparten las dos vistas; si el navegador no deja guardar, arranca
// apagada y listo.
const CLAVE = 'dg_tickets_solo_mis_tareas';

export function leerSoloMisTareas() {
  try {
    return localStorage.getItem(CLAVE) === '1';
  } catch {
    return false;
  }
}

export function guardarSoloMisTareas(valor) {
  try {
    if (valor) localStorage.setItem(CLAVE, '1');
    else localStorage.removeItem(CLAVE);
  } catch {
    // sin almacenamiento: queda solo para esta visita
  }
}
