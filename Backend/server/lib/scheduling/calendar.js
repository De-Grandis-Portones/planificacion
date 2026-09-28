// lib/scheduling/calendar.js
//
// Calendario laboral por recurso (categoría "Tiempo" del diseño): dado un
// recurso, una fecha límite y una duración en minutos, calcula hacia atrás
// el instante de entrada saltando horas no laborables/feriados.
//
// Argentina usa UTC-3 fijo, sin horario de verano, desde 2009 — por eso acá
// se hace la matemática de fecha/hora con un offset fijo en vez de
// Intl.DateTimeFormat (que sí usa insumosPedidos.js para *formatear* la hora
// actual, un caso de uso distinto): en un loop que recorre muchos días hacia
// atrás, el offset fijo es más simple y evita reformatear en cada iteración.
const { pool } = require('../../db');
const { getDayCapacityMinutes, getCommittedMinutes } = require('./capacityLedger');

const AR_OFFSET_MINUTES = -180; // UTC-3

const DEFAULT_MAX_LOOKBACK_DAYS = 180;

// Fallback si un recurso no tiene calendario cargado: Lun-Vie 08:00-18:00.
// weekday: 0=domingo..6=sábado (igual que Date.getUTCDay()).
const DEFAULT_SHIFTS = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  start_time: '08:00:00',
  end_time: '18:00:00',
}));

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Instante absoluto -> {dateKey, weekday, minutesOfDay} en hora de Argentina.
function toArParts(date) {
  const local = new Date(date.getTime() + AR_OFFSET_MINUTES * 60000);
  const y = local.getUTCFullYear();
  const m = pad2(local.getUTCMonth() + 1);
  const d = pad2(local.getUTCDate());
  return {
    dateKey: `${y}-${m}-${d}`,
    weekday: local.getUTCDay(),
    minutesOfDay: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

// 'YYYY-MM-DD' + 'HH:MM[:SS]' en hora de Argentina -> instante absoluto (Date).
function arDateTimeToInstant(dateKey, timeStr) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const [hh, mm, ss] = String(timeStr).split(':').map(Number);
  const asIfUtc = Date.UTC(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, ss || 0);
  return new Date(asIfUtc - AR_OFFSET_MINUTES * 60000);
}

function addDaysToDateKey(dateKey, delta) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

// Turnos habilitados de un día concreto: la excepción puntual si existe
// (is_working=false => día cerrado, [] ), si no la plantilla semanal
// filtrada por weekday. Extraído para reusarlo también al sumar la
// capacidad cruda de un día (Fase 2b), sin duplicar esta resolución.
function resolveDayShifts(dateKey, weekday, shiftList, exMap) {
  const exception = exMap.get(dateKey);
  if (exception) {
    if (!exception.is_working) return [];
    return [{ start_time: exception.start_time || '00:00:00', end_time: exception.end_time || '23:59:59' }];
  }
  return shiftList.filter((s) => Number(s.weekday) === weekday && s.enabled !== false);
}

// Suma de minutos de todos los turnos habilitados de un día — la capacidad
// "cruda" de ese (recurso, fecha) antes de aplicar el multiplicador de
// paralelismo (eso lo hace el caller, rollBackForStage, que es quien conoce
// parallel_capacity).
function computeDayCapacityMinutes(dateKey, weekday, shiftList, exMap) {
  const dayShifts = resolveDayShifts(dateKey, weekday, shiftList, exMap);
  return dayShifts.reduce((sum, s) => {
    const mins = (arDateTimeToInstant(dateKey, s.end_time).getTime() - arDateTimeToInstant(dateKey, s.start_time).getTime()) / 60000;
    return sum + Math.max(0, mins);
  }, 0);
}

/**
 * Función pura: recorre hacia atrás desde `deadline` consumiendo `minutes` de
 * tiempo laborable, saltando feriados/fuera de horario.
 *
 * @param {Date} deadline
 * @param {number} minutes
 * @param {Array<{weekday:number, start_time:string, end_time:string}>} shifts
 * @param {Map<string, {is_working:boolean, start_time:string|null, end_time:string|null}>} exceptions - keyed by 'YYYY-MM-DD'
 * @param {number} maxLookbackDays
 * @param {{resourceKey:string, getDayCapacityMinutes:Function, getCommittedMinutes:Function}} [capacity] -
 *   Fase 2b: si se pasa, el cupo de cada día deja de ser "toda la ventana
 *   horaria" y pasa a ser lo que quede de la capacidad diaria del recurso
 *   una vez descontado lo que otras llamadas (otros portones/etapas) ya
 *   comprometieron. Sin este parámetro, el comportamiento es idéntico al de
 *   Fase 2a (capacidad infinita dentro de la ventana horaria).
 */
function rollBackByWorkingMinutes({ deadline, minutes, shifts, exceptions, maxLookbackDays = DEFAULT_MAX_LOOKBACK_DAYS, capacity }) {
  const safeMinutes = Number.isFinite(minutes) ? Math.max(0, minutes) : 0;
  if (safeMinutes === 0) return { ok: true, start: new Date(deadline), consumption: [], resource_constrained: false };

  const exMap = exceptions instanceof Map ? exceptions : new Map();
  // Sin fallback acá a propósito: un `shifts` vacío es una entrada válida (un
  // recurso realmente sin ningún turno habilitado) y tiene que poder agotar
  // maxLookbackDays y devolver error — no silenciarse con el default. El
  // fallback a DEFAULT_SHIFTS pasa una sola vez, en loadResourceCalendar,
  // cuando de verdad no hay ninguna fila de calendario cargada.
  const shiftList = Array.isArray(shifts) ? shifts : [];

  let remaining = safeMinutes;
  let cursor = new Date(deadline);
  let daysChecked = 0;
  const consumption = [];
  let resourceConstrained = false;

  while (remaining > 0) {
    daysChecked += 1;
    if (daysChecked > maxLookbackDays) {
      return {
        ok: false,
        error: `No se encontró suficiente tiempo hábil en los últimos ${maxLookbackDays} días (revisar el calendario del recurso).`,
        consumption,
        resource_constrained: resourceConstrained,
      };
    }

    const { dateKey, weekday } = toArParts(cursor);
    const dayShifts = resolveDayShifts(dateKey, weekday, shiftList, exMap);
    if (!dayShifts.length) {
      cursor = arDateTimeToInstant(addDaysToDateKey(dateKey, -1), '23:59:59');
      continue;
    }

    // Turno más tardío primero: consumimos desde el final del día hacia atrás.
    const sorted = [...dayShifts].sort((a, b) => String(b.start_time).localeCompare(String(a.start_time)));

    for (const shift of sorted) {
      const shiftStart = arDateTimeToInstant(dateKey, shift.start_time);
      const shiftEnd = arDateTimeToInstant(dateKey, shift.end_time);
      const windowEnd = cursor.getTime() < shiftEnd.getTime() ? cursor : shiftEnd;
      if (windowEnd.getTime() <= shiftStart.getTime()) continue; // turno ya consumido por el cursor actual

      let availableMinutes = (windowEnd.getTime() - shiftStart.getTime()) / 60000;

      if (capacity) {
        // Consumido por OTRAS llamadas (otros portones/etapas) — esto, y solo
        // esto, marca resource_constrained. Lo que esta misma llamada ya
        // reclamó hoy (ej. un turno partido repartiendo una sola etapa entre
        // mañana y tarde) no cuenta como contención con nadie.
        const committed = capacity.getCommittedMinutes(dateKey);
        if (committed > 0) resourceConstrained = true;
        const claimedThisCall = consumption
          .filter((c) => c.date_key === dateKey)
          .reduce((sum, c) => sum + c.minutes, 0);
        const dayCapacity = capacity.getDayCapacityMinutes(dateKey, weekday);
        availableMinutes = Math.min(availableMinutes, Math.max(0, dayCapacity - committed - claimedThisCall));
      }

      if (availableMinutes <= 0) continue; // sin cupo hoy en este turno — probar el próximo turno/día

      if (availableMinutes >= remaining) {
        const start = new Date(windowEnd.getTime() - remaining * 60000);
        if (capacity) consumption.push({ resource_key: capacity.resourceKey, date_key: dateKey, minutes: remaining });
        return { ok: true, start, consumption, resource_constrained: resourceConstrained };
      }
      if (capacity) consumption.push({ resource_key: capacity.resourceKey, date_key: dateKey, minutes: availableMinutes });
      remaining -= availableMinutes;
      cursor = shiftStart;
    }

    cursor = arDateTimeToInstant(addDaysToDateKey(dateKey, -1), '23:59:59');
  }

  // No debería llegar acá (el loop retorna en cuanto remaining llega a 0).
  return { ok: true, start: cursor, consumption, resource_constrained: resourceConstrained };
}

// Todas las filas de scheduling_stage_resource de una línea, en un solo
// viaje — el mapeo etapa->recurso es un dato de la LÍNEA, no de un portón
// puntual, así que tiene sentido pedirlo una sola vez (por portón aislado,
// o una vez para todo un lote en computeFleetRegression) en vez de una
// query por etapa.
async function fetchStageResourceMap(line, db = pool) {
  const { rows } = await db.query(
    `select stage_key, resource_key from public.scheduling_stage_resource where line = $1;`,
    [line]
  );
  return new Map(rows.map((r) => [r.stage_key, r.resource_key]));
}

// Si se pasa `stageResourceMap` (ver fetchStageResourceMap), resuelve sin
// tocar la base — si no, hace la consulta puntual de siempre (para llamadas
// sueltas que no arman el mapa completo).
async function getResourceKeyForStage(line, stageKey, db = pool, stageResourceMap) {
  if (stageResourceMap) return stageResourceMap.get(stageKey) || stageKey;
  const { rows } = await db.query(
    `select resource_key from public.scheduling_stage_resource where line = $1 and stage_key = $2 limit 1;`,
    [line, stageKey]
  );
  return rows[0]?.resource_key || stageKey;
}

function exceptionsToMap(rows) {
  const map = new Map();
  const globals = rows.filter((r) => r.resource_key == null);
  const specifics = rows.filter((r) => r.resource_key != null);
  // Global primero, específico pisa: un feriado propio del recurso gana sobre
  // uno de planta si por algún motivo coexisten para la misma fecha.
  for (const r of [...globals, ...specifics]) map.set(r.exception_date, r);
  return map;
}

async function loadResourceCalendar(resourceKey, { deadline, maxLookbackDays = DEFAULT_MAX_LOOKBACK_DAYS } = {}, db = pool) {
  const anchor = deadline instanceof Date ? deadline : new Date(deadline);

  const [{ rows: shiftRows }, { rows: exceptionRows }, { rows: resourceRows }] = await Promise.all([
    db.query(
      `
      select weekday, start_time, end_time, enabled
      from public.scheduling_resource_calendar
      where resource_key = $1 and enabled = true
      order by weekday asc, start_time asc;
      `,
      [resourceKey]
    ),
    db.query(
      `
      select resource_key, to_char(exception_date, 'YYYY-MM-DD') as exception_date, is_working, start_time, end_time
      from public.scheduling_calendar_exception
      where (resource_key = $1 or resource_key is null)
        and exception_date between ($2::timestamptz - ($3 || ' days')::interval)::date and $2::date
      order by exception_date asc;
      `,
      [resourceKey, anchor.toISOString(), maxLookbackDays]
    ),
    // parallel_capacity puede no existir si todavía no se corrió
    // migration_scheduling_fase2b.sql — se tolera y cae a 1 (comportamiento
    // de Fase 2a) en vez de romper el resto del calendario.
    db.query(`select parallel_capacity from public.scheduling_resource where resource_key = $1;`, [resourceKey]).catch(() => ({ rows: [] })),
  ]);

  const usingFallback = shiftRows.length === 0;
  return {
    shifts: usingFallback ? DEFAULT_SHIFTS : shiftRows,
    exceptions: exceptionsToMap(exceptionRows),
    usingFallback,
    parallelCapacity: Math.max(1, Number(resourceRows[0]?.parallel_capacity) || 1),
  };
}

// Versión en lote de loadResourceCalendar: en vez de un viaje a la base por
// cada resource_key (lo que con ~19 etapas eran ~57 round-trips solo para
// calendarios — medido: ~30s para UN portón aislado), trae los turnos,
// excepciones y paralelismo de TODOS los `resourceKeys` pedidos en 3
// consultas totales (`= ANY($1)`), y arma el mismo objeto `{shifts,
// exceptions, usingFallback, parallelCapacity}` que loadResourceCalendar
// para cada uno. Pensada para pre-cargar el `cache` de rollBackForStage de
// una sola vez antes de recorrer un subgrafo (o un lote de portones), no
// para reemplazar loadResourceCalendar en llamadas sueltas.
async function loadResourceCalendars(resourceKeys, { deadline, maxLookbackDays = DEFAULT_MAX_LOOKBACK_DAYS } = {}, db = pool) {
  const keys = Array.from(new Set((resourceKeys || []).filter(Boolean)));
  const result = new Map();
  if (!keys.length) return result;

  const anchor = deadline instanceof Date ? deadline : new Date(deadline);

  const [{ rows: shiftRows }, { rows: exceptionRows }, { rows: resourceRows }] = await Promise.all([
    db.query(
      `
      select resource_key, weekday, start_time, end_time, enabled
      from public.scheduling_resource_calendar
      where resource_key = any($1) and enabled = true
      order by resource_key asc, weekday asc, start_time asc;
      `,
      [keys]
    ),
    db.query(
      `
      select resource_key, to_char(exception_date, 'YYYY-MM-DD') as exception_date, is_working, start_time, end_time
      from public.scheduling_calendar_exception
      where (resource_key = any($1) or resource_key is null)
        and exception_date between ($2::timestamptz - ($3 || ' days')::interval)::date and $2::date
      order by exception_date asc;
      `,
      [keys, anchor.toISOString(), maxLookbackDays]
    ),
    db.query(`select resource_key, parallel_capacity from public.scheduling_resource where resource_key = any($1);`, [keys]).catch(() => ({ rows: [] })),
  ]);

  const shiftsByResource = new Map();
  for (const row of shiftRows) {
    if (!shiftsByResource.has(row.resource_key)) shiftsByResource.set(row.resource_key, []);
    shiftsByResource.get(row.resource_key).push(row);
  }
  // Las excepciones globales (resource_key null) aplican a todos los
  // recursos pedidos; exceptionsToMap ya resuelve "específico pisa a global".
  const globalExceptionRows = exceptionRows.filter((r) => r.resource_key == null);
  const exceptionRowsByResource = new Map();
  for (const row of exceptionRows) {
    if (row.resource_key == null) continue;
    if (!exceptionRowsByResource.has(row.resource_key)) exceptionRowsByResource.set(row.resource_key, []);
    exceptionRowsByResource.get(row.resource_key).push(row);
  }
  const parallelByResource = new Map(resourceRows.map((r) => [r.resource_key, Math.max(1, Number(r.parallel_capacity) || 1)]));

  for (const resourceKey of keys) {
    const shifts = shiftsByResource.get(resourceKey) || [];
    const usingFallback = shifts.length === 0;
    result.set(resourceKey, {
      shifts: usingFallback ? DEFAULT_SHIFTS : shifts,
      exceptions: exceptionsToMap([...globalExceptionRows, ...(exceptionRowsByResource.get(resourceKey) || [])]),
      usingFallback,
      parallelCapacity: parallelByResource.get(resourceKey) || 1,
    });
  }
  return result;
}

/**
 * Wrapper de alto nivel: resuelve el recurso de una etapa, carga (con cache
 * por resource_key) su calendario, y calcula hacia atrás la hora de entrada.
 *
 * `cache` es un Map compartido por todo un árbol de regresión (pasado por el
 * caller) para no releer el calendario por cada nodo — lo ideal es
 * pre-cargarlo con loadResourceCalendars antes de recorrer el subgrafo (ver
 * computeBackwardPass en regressionEngine.js); si un resource_key no está
 * pre-cargado, esta función igual lo resuelve solo, con loadResourceCalendar
 * de a uno (más lento, pero sigue siendo correcto).
 *
 * `stageResourceMap` (opcional): ver getResourceKeyForStage — evita una
 * consulta por etapa cuando ya se pre-cargó el mapeo completo de la línea.
 */
async function rollBackForStage({ line, stageKey, deadline, minutes, db = pool, cache, maxLookbackDays, capacityLedger, calendarWindow, stageResourceMap } = {}) {
  const resourceKey = await getResourceKeyForStage(line, stageKey, db, stageResourceMap);

  let calendar = cache?.get(resourceKey);
  if (!calendar) {
    // calendarWindow (Fase 2b, computeFleetRegression): cuando el `cache` se
    // comparte entre varios portones, la ventana de búsqueda de excepciones
    // tiene que cubrir a TODOS ellos, no solo al deadline de la etapa que
    // dispara la primera carga de este recurso — ver el comentario de
    // computeFleetRegression en regressionEngine.js para el cálculo.
    const windowDeadline = calendarWindow?.deadline || deadline;
    const windowMaxLookback = calendarWindow?.maxLookbackDays ?? maxLookbackDays;
    calendar = await loadResourceCalendar(resourceKey, { deadline: windowDeadline, maxLookbackDays: windowMaxLookback }, db);
    cache?.set(resourceKey, calendar);
  }

  // Fase 2b: si hay un ledger compartido, la capacidad de cada día pasa a
  // ser la ventana horaria (todos los turnos del día sumados) multiplicada
  // por el paralelismo del recurso — no el recurso en sí, que ya resolvió
  // getResourceKeyForStage arriba.
  const capacity = capacityLedger
    ? {
        resourceKey,
        getDayCapacityMinutes: (dateKey, weekday) =>
          getDayCapacityMinutes(capacityLedger, resourceKey, dateKey, () =>
            computeDayCapacityMinutes(dateKey, weekday, calendar.shifts, calendar.exceptions) * calendar.parallelCapacity
          ),
        getCommittedMinutes: (dateKey) => getCommittedMinutes(capacityLedger, resourceKey, dateKey),
      }
    : undefined;

  const result = rollBackByWorkingMinutes({
    deadline,
    minutes,
    shifts: calendar.shifts,
    exceptions: calendar.exceptions,
    maxLookbackDays,
    capacity,
  });

  return { ...result, resource_key: resourceKey, using_fallback_calendar: calendar.usingFallback };
}

module.exports = {
  AR_OFFSET_MINUTES,
  DEFAULT_SHIFTS,
  DEFAULT_MAX_LOOKBACK_DAYS,
  toArParts,
  arDateTimeToInstant,
  addDaysToDateKey,
  resolveDayShifts,
  computeDayCapacityMinutes,
  rollBackByWorkingMinutes,
  getResourceKeyForStage,
  fetchStageResourceMap,
  loadResourceCalendar,
  loadResourceCalendars,
  rollBackForStage,
};
