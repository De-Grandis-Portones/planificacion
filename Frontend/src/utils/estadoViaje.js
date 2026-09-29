// Estado de un viaje según lo que marca la cuadrilla en /despacho-v2 - pedido
// explícito del usuario (2026-09-29): el fondo del viaje refleja el estado.
// - pendiente: todavía no tocaron "Play" (sin hora_salida_real) -> verde
// - en curso: salió pero no se finalizó (sin hora_llegada_real) -> amarillo
// - finalizado: con hora_llegada_real -> gris
const ESTADOS = {
  pendiente: { label: 'Pendiente', bg: '#dcfce7', border: '#86efac', fg: '#15803d' },
  en_curso: { label: 'En curso', bg: '#fef9c3', border: '#facc15', fg: '#a16207' },
  finalizado: { label: 'Finalizado', bg: '#e5e7eb', border: '#9ca3af', fg: '#4b5563' },
};

export function estadoViaje(viaje) {
  if (viaje?.hora_llegada_real) return { key: 'finalizado', ...ESTADOS.finalizado };
  if (viaje?.hora_salida_real) return { key: 'en_curso', ...ESTADOS.en_curso };
  return { key: 'pendiente', ...ESTADOS.pendiente };
}
