// lib/scheduling/capacityLedger.js
//
// Cupo diario compartido entre portones (Fase 2b). Deliberadamente "tonto":
// no sabe nada de turnos/feriados (eso vive en calendar.js, que ya tiene esa
// data por recurso) — solo guarda, por (resource_key, date_key), cuánta
// capacidad cruda tiene ese día y cuánto ya se comprometió. Vive en memoria,
// dura lo que dura un cálculo de flota (computeFleetRegression); no se
// persiste en ninguna tabla.

function createCapacityLedger() {
  return new Map(); // resource_key -> Map(date_key -> {capacityMinutes, consumedMinutes})
}

function getOrInitDayEntry(ledger, resourceKey, dateKey, computeCapacity) {
  let byDate = ledger.get(resourceKey);
  if (!byDate) {
    byDate = new Map();
    ledger.set(resourceKey, byDate);
  }
  let entry = byDate.get(dateKey);
  if (!entry) {
    entry = { capacityMinutes: computeCapacity(), consumedMinutes: 0 };
    byDate.set(dateKey, entry);
  }
  return entry;
}

function getDayCapacityMinutes(ledger, resourceKey, dateKey, computeCapacity) {
  return getOrInitDayEntry(ledger, resourceKey, dateKey, computeCapacity).capacityMinutes;
}

// Consumo ya COMPROMETIDO por llamadas anteriores (otros portones/etapas) —
// nunca incluye el consumo "provisional" de la llamada en curso, que
// rollBackByWorkingMinutes trackea localmente en su propio array
// `consumption` antes de comprometerlo acá vía commitConsumption.
function getCommittedMinutes(ledger, resourceKey, dateKey) {
  return ledger.get(resourceKey)?.get(dateKey)?.consumedMinutes || 0;
}

// Aplica el `consumption` de un rollback EXITOSO. No llamar nunca para un
// rollback fallido (ok:false) — comprometer un intento que agotó
// maxLookbackDays sin alcanzar "gastaría" cupo real por un resultado que ni
// siquiera es válido.
function commitConsumption(ledger, consumption) {
  for (const item of consumption || []) {
    const minutes = Number(item?.minutes) || 0;
    if (minutes <= 0) continue;
    const entry = getOrInitDayEntry(ledger, item.resource_key, item.date_key, () => 0);
    entry.consumedMinutes += minutes;
  }
}

// Para el endpoint/UI: aplana a filas serializables, solo los (resource_key,
// date_key) que realmente se tocaron durante el cálculo.
function summarizeLedger(ledger) {
  const rows = [];
  for (const [resourceKey, byDate] of ledger.entries()) {
    for (const [dateKey, entry] of byDate.entries()) {
      rows.push({
        resource_key: resourceKey,
        date_key: dateKey,
        capacity_minutes: entry.capacityMinutes,
        consumed_minutes: entry.consumedMinutes,
        remaining_minutes: entry.capacityMinutes - entry.consumedMinutes,
      });
    }
  }
  return rows.sort((a, b) => a.resource_key.localeCompare(b.resource_key) || a.date_key.localeCompare(b.date_key));
}

module.exports = {
  createCapacityLedger,
  getDayCapacityMinutes,
  getCommittedMinutes,
  commitConsumption,
  summarizeLedger,
};
