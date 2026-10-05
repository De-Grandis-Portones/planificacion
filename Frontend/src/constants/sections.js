// Universo de claves de sección física de planta, con su etiqueta legible.
// Usado por los pickers de workflow de Prefabricados y Servicio Técnico.
// Importante: no hay claves "extra" solo para estas líneas — los ítems de
// Prefabricados/Servicio Técnico se mezclan dentro de la columna de portones
// que ya existe para cada una de estas claves (ver merge en App.jsx), así que
// el workflow de un tipo/orden debe terminar en una de estas mismas secciones
// físicas (ej. un prefabricado que termina en "Prefabricados" usa
// armado_piernas, la misma columna que ya existe para esa sección).
export const SECTION_LABELS = {
  diseno: 'Diseño Tubos',
  diseno_piernas: 'Diseño Piernas',
  diseno_revestimiento: 'Diseño Revestimiento',
  laser: 'Laser',
  laser_dintel: 'Laser tubos Dintel',
  laser_hojas: 'Laser tubos Hojas',
  laser_brazos_espada: 'Laser tubos Brazos y Espada',
  guillotina: 'Corte piernas',
  corte_revest: 'Corte revestimiento',
  corte_dintel: 'Corte Dintel',
  plegadora: 'Plegado piernas',
  plegado_revest: 'Plegado revestimiento',
  plegado_dintel: 'Plegado Dintel',
  armado_piernas: 'Prefabricados (Armado de piernas)',
  armado_dintel: 'Armado Dintel',
  armado_marco_piernas: 'Armado de marcos piernas',
  armado_primario: 'Armado Primario',
  armado_hojas: 'Armado de hoja',
  inyeccion: 'Inyección',
  revestimiento: 'Revestimiento',
  pintura: 'Pintura Sistemas',
  pintura_revestimiento: 'Pintura Revestimiento',
  armado_final: 'Armado Final',
  despacho: 'Despacho',
};

export const SECTION_KEYS = Object.keys(SECTION_LABELS);

export function sectionLabel(key) {
  return SECTION_LABELS[key] || key;
}
