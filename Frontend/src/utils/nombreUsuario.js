// src/utils/nombreUsuario.js — cómo mostrar a una persona en Tickets: el
// nombre real primero y el usuario de login entre paréntesis solo si es
// distinto ("Diego Pérez (comercial1)"), así se sabe quién fue y desde qué
// cuenta. El nombre lo resuelve el backend (creado_por_nombre / autor_nombre
// en Backend/server/lib/ticketsDb.js) y cae al usuario si no hay uno cargado.
export function nombreConUsuario(nombre, usuario) {
  const n = String(nombre || '').trim();
  const u = String(usuario || '').trim();
  if (!n) return u;
  if (!u || n.toLowerCase() === u.toLowerCase()) return n;
  return `${n} (${u})`;
}
