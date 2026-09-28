// lib/scheduling/resourceVariables.js
//
// Variables de recurso (Fase 3b): atributos más o menos permanentes de una
// sección/máquina (ej. plegadora.nivel_personal="junior") — no del portón,
// y no de un día puntual (para eso ya existe scheduling_calendar_exception).
// Se cargan una sola vez (son datos de recurso, no de portón ni de línea) y
// se mezclan al ctx de evaluación de cada etapa según a qué resource_key
// esté mapeada — ver su uso en regressionEngine.js:computeBackwardPass.
const { pool } = require('../../db');

// Map<resource_key, {[key]: value}> — value ya viene deserializado (jsonb).
async function fetchResourceVariables(db = pool) {
  const { rows } = await db.query(
    `select resource_key, key, value from public.scheduling_resource_variable;`
  );
  const byResource = new Map();
  for (const r of rows) {
    if (!byResource.has(r.resource_key)) byResource.set(r.resource_key, {});
    byResource.get(r.resource_key)[r.key] = r.value;
  }
  return byResource;
}

module.exports = { fetchResourceVariables };
