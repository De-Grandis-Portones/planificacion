// lib/logisticaChecklistDb.js
//
// Checklist configurable que la cuadrilla debe completar (todo en "OK")
// antes de poder arrancar un viaje en /despacho_v2 (pedido explícito del
// usuario) - dos listas independientes según el viaje tenga alguna parada
// de instalación o sea solo despacho. Se configura desde
// /admin/logistica-fechas (panel de configuración, botón "CheckList"); la
// cuadrilla la ve/tilda al tocar Play en /despacho_v2.
const { pool } = require('../db');

const TIPOS_VALIDOS = ['solo_despacho', 'con_instalacion'];

function checkTipo(tipo) {
  if (!TIPOS_VALIDOS.includes(tipo)) throw new Error("tipo debe ser 'solo_despacho' o 'con_instalacion'");
}

// Todos los ítems (activos e inactivos) de un tipo, o de los dos si no se
// pasa tipo - para el panel de admin.
async function listChecklistItems(tipo) {
  const conds = [];
  const params = [];
  if (tipo) { checkTipo(tipo); params.push(tipo); conds.push(`tipo = $${params.length}`); }
  const { rows } = await pool.query(
    `select id, tipo, texto, orden, activo, created_at, updated_at
       from public.logistica_checklist_items
       ${conds.length ? `where ${conds.join(' and ')}` : ''}
      order by tipo asc, orden asc, id asc;`,
    params
  );
  return rows;
}

// Solo los activos, en orden - lo que ve la cuadrilla en /despacho_v2. Si no
// hay ninguno configurado todavía para ese tipo, vuelve vacío (retrocompatible:
// sin ítems configurados, Play arranca directo, sin checklist de por medio).
async function listChecklistItemsActivos(tipo) {
  checkTipo(tipo);
  const { rows } = await pool.query(
    `select id, texto, orden
       from public.logistica_checklist_items
      where tipo = $1 and activo
      order by orden asc, id asc;`,
    [tipo]
  );
  return rows;
}

async function crearChecklistItem({ tipo, texto, orden }) {
  checkTipo(tipo);
  const txt = String(texto || '').trim();
  if (!txt) throw new Error('Falta el texto del ítem');
  const { rows } = await pool.query(
    `insert into public.logistica_checklist_items (tipo, texto, orden)
     values ($1, $2, $3)
     returning id, tipo, texto, orden, activo, created_at, updated_at;`,
    [tipo, txt, Number.isFinite(Number(orden)) ? Number(orden) : 0]
  );
  return rows[0];
}

async function actualizarChecklistItem(id, { texto, orden, activo }) {
  const sets = [];
  const params = [Number(id)];
  if (texto !== undefined) { params.push(String(texto || '').trim()); sets.push(`texto = $${params.length}`); }
  if (orden !== undefined) { params.push(Number(orden) || 0); sets.push(`orden = $${params.length}`); }
  if (activo !== undefined) { params.push(!!activo); sets.push(`activo = $${params.length}`); }
  if (!sets.length) throw new Error('Nada para actualizar');
  sets.push('updated_at = now()');
  const { rows, rowCount } = await pool.query(
    `update public.logistica_checklist_items set ${sets.join(', ')} where id = $1
     returning id, tipo, texto, orden, activo, created_at, updated_at;`,
    params
  );
  if (!rowCount) throw new Error('Ítem no encontrado');
  return rows[0];
}

async function borrarChecklistItem(id) {
  await pool.query(`delete from public.logistica_checklist_items where id = $1;`, [Number(id)]);
}

// Valida y deja auditado el checklist de un viaje al arrancarlo. Si el tipo
// tiene ítems activos configurados, TODOS tienen que venir en itemIds - se
// revalida acá contra lo que está configurado AHORA (no se confía en lo que
// ya mostró el frontend), mismo criterio que el resto de la app. Si no hay
// ítems activos para ese tipo, no hay nada que exigir. items_snapshot guarda
// una copia de los ítems tal como estaban en ese momento (si después se
// edita/borra alguno, el historial de este viaje no cambia retroactivamente).
async function confirmarChecklistViaje({ viajeId, tipo, itemIds, confirmadoPor }) {
  checkTipo(tipo);
  const activos = await listChecklistItemsActivos(tipo);
  if (activos.length) {
    const enviados = new Set((itemIds || []).map(Number));
    const faltan = activos.filter((it) => !enviados.has(it.id));
    if (faltan.length) {
      const err = new Error(`Faltan tildar: ${faltan.map((f) => f.texto).join(', ')}`);
      err.status = 400;
      throw err;
    }
  }
  await pool.query(
    `insert into public.logistica_viaje_checklist_confirmaciones (viaje_id, tipo, items_snapshot, confirmado_por)
     values ($1, $2, $3, $4);`,
    [Number(viajeId), tipo, JSON.stringify(activos), confirmadoPor || null]
  );
}

module.exports = {
  TIPOS_VALIDOS,
  listChecklistItems, listChecklistItemsActivos,
  crearChecklistItem, actualizarChecklistItem, borrarChecklistItem,
  confirmarChecklistViaje,
};
