// lib/scheduling/rotativaFields.js
//
// Campos derivados para reglas Rotativa (Fase 3c): comparan este portón
// contra el ANTERIOR que usó el mismo recurso físico, en vez de comparar
// contra propiedades fijas del portón mismo (eso ya lo cubren Intrínseca/
// Material) — ej. "cambió el Sistema respecto al portón previo en la
// Cortadora" (costo de cambio de rollo/color).
//
// Deliberadamente NO se extiende evalRule/evalConditionJson (lib/workflow.js,
// compartido con el ruteo real de workflow_edge) para soportar comparar
// "campo contra campo" — en cambio, acá se PRE-CALCULA el resultado de la
// comparación como un campo más del ctx (ej. sistema_changed: true/false),
// y una regla Rotativa lo usa igual que cualquier otro campo (field=
// sistema_changed, operator='=', value=true). Mismo patrón que las
// Variables de recurso de Fase 3b: el motor de condiciones no cambia, solo
// el ctx que le llega.
//
// Orden de "cola" usado: el orden EDD (mismo con el que ya se procesa
// computeFleetRegression), no el orden cronológico final de cada recurso —
// el diseño original pedía una segunda pasada que recalcule el orden real
// después de una primera pasada sin Rotativas; se deja para más adelante si
// hace falta más precisión (ver nota en el plan). Esta aproximación alcanza
// para el caso real (cambio de color/rollo entre portones consecutivos en
// la cola) sin duplicar el cálculo de toda la flota.
function buildRotativaFields(ctx, prevCtx) {
  if (!prevCtx) return {};
  return {
    prev_sistema: prevCtx.Sistema ?? prevCtx.sistema ?? null,
    prev_nv: prevCtx.nv ?? null,
    sistema_changed: (ctx.Sistema ?? ctx.sistema ?? null) !== (prevCtx.Sistema ?? prevCtx.sistema ?? null),
  };
}

module.exports = { buildRotativaFields };
