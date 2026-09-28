// lib/scheduling/config.js
//
// Interruptor de modo por línea (scheduling_line_mode): legacy | shadow | live.
// Fase 0/1 no lo lee todavía en ningún camino operativo — existe desde ya para
// no tener que retrofitearlo cuando llegue la Fase 4 (ver plan). Devuelve
// 'legacy' si la tabla está vacía o la línea no tiene fila, a propósito: así
// el comportamiento nunca cambia por default.
const { pool } = require('../../db');

const VALID_MODES = new Set(['legacy', 'shadow', 'live']);

async function getSchedulingMode(line, db = pool) {
  const key = String(line || '').trim();
  if (!key) return 'legacy';

  const { rows } = await db.query(
    `select mode from public.scheduling_line_mode where line = $1 limit 1;`,
    [key]
  );
  const mode = String(rows?.[0]?.mode || '').trim();
  return VALID_MODES.has(mode) ? mode : 'legacy';
}

module.exports = { getSchedulingMode, VALID_MODES };
