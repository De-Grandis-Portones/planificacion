// routes/public/insumos.js — pedidos diarios de insumos por seccion (tablet).
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../../db');
const { INSUMOS_SECCIONES, isValidInsumosSeccion } = require('../../lib/insumosSecciones');
const { fetchOdooProductsByCategoryIds } = require('../../lib/insumosOdoo');
const { getOrCreatePedidoDelDia, loadPedidoConItems, argentinaTodayStr } = require('../../lib/insumosPedidos');
const { getProductoNombreOverrides } = require('../../insumosProductoNombreDb');

const router = express.Router();

// Mismo salt/hash que public/qc.js — un PIN de qc_users vale igual en ambos lugares.
const QC_PIN_SALT = process.env.QC_PIN_SALT || 'dev_change_me_pin_salt';
function hashPin(pin) {
  return crypto.createHmac('sha256', QC_PIN_SALT).update(String(pin)).digest('hex');
}

// Mapea cada "seccion" de insumos (por ruta/tablet, guion medio) a la o las
// stage_key de workflow de portones (guion bajo) que agrupa esa misma ruta
// (ver App.jsx ROUTES). Así, un scope de portones ya otorgado para esa
// sección física (ej. "pintura" para pasar un portón) también alcanza para
// confirmar pedidos de insumos ahí, sin tener que duplicar el alta.
const INSUMOS_TO_PORTON_STAGE_CANDIDATES = {
  diseno: ['diseno'],
  laser: ['laser', 'laser_dintel', 'laser_hojas', 'laser_brazos_espada'],
  corte: ['guillotina', 'corte_revest', 'corte_dintel'],
  plegado: ['plegadora', 'plegado_revest', 'plegado_dintel'],
  prefabricados: ['armado_piernas', 'armado_marco_piernas', 'armado_hojas', 'armado_dintel'],
  'armado-primario': ['armado_primario'],
  pintura: ['pintura', 'pintura_revestimiento'],
  inyeccion: ['inyeccion'],
  revestimiento: ['revestimiento'],
  'armado-final': ['armado_final'],
  despacho: ['despacho'],
};

async function userHasInsumosScope(client, userId, seccion) {
  const { rows } = await client.query(
    `select 1 from public.qc_user_scope where user_id = $1 and line = 'insumos' and stage_key = $2 and enabled = true limit 1`,
    [userId, seccion]
  );
  if (rows.length > 0) return true;

  const portonStages = INSUMOS_TO_PORTON_STAGE_CANDIDATES[seccion] || [];
  if (!portonStages.length) return false;

  const { rows: portonRows } = await client.query(
    `select 1 from public.qc_user_scope where user_id = $1 and line = 'portones' and stage_key = any($2::text[]) and enabled = true limit 1`,
    [userId, portonStages]
  );
  return portonRows.length > 0;
}

// GET /insumos/secciones
router.get('/insumos/secciones', (_req, res) => {
  res.json(INSUMOS_SECCIONES);
});

// GET /insumos/productos?seccion=X — catalogo de Odoo (por categoria mapeada a la seccion)
router.get('/insumos/productos', async (req, res) => {
  const seccion = String(req.query.seccion || '').trim();
  if (!isValidInsumosSeccion(seccion)) return res.status(400).json({ error: 'seccion invalida' });

  try {
    const { rows: mapRows } = await pool.query(
      `select categ_id from public.insumos_categoria_seccion where seccion = $1 and enabled = true`,
      [seccion]
    );
    const categIds = mapRows.map((r) => r.categ_id);
    if (!categIds.length) return res.json([]);

    const productos = await fetchOdooProductsByCategoryIds(categIds);
    const overrides = await getProductoNombreOverrides(productos.map((p) => p.id));
    return res.json(
      productos.map((p) => ({
        producto_odoo_id: p.id,
        producto_nombre: overrides.get(p.id) || p.name,
        producto_codigo: p.default_code || null,
        unidad: Array.isArray(p.uom_id) ? p.uom_id[1] : null,
        categoria_odoo_id: Array.isArray(p.x_studio_clasificacin_sectorizada) ? p.x_studio_clasificacin_sectorizada[0] ?? null : null,
      }))
    );
  } catch (err) {
    console.error('get insumos productos error:', err);
    return res.status(500).json({ error: 'Error leyendo productos de Odoo', detail: err.message });
  }
});

// GET /insumos/pedidos/hoy?seccion=X — crea (con arrastre de pendientes) si no existe
router.get('/insumos/pedidos/hoy', async (req, res) => {
  const seccion = String(req.query.seccion || '').trim();
  if (!isValidInsumosSeccion(seccion)) return res.status(400).json({ error: 'seccion invalida' });

  const client = await pool.connect();
  try {
    await client.query('begin');
    const pedido = await getOrCreatePedidoDelDia(client, seccion, argentinaTodayStr());
    await client.query('commit');
    const full = await loadPedidoConItems(pool, pedido.id);
    return res.json(full);
  } catch (err) {
    await client.query('rollback');
    console.error('get insumos pedido hoy error:', err);
    return res.status(500).json({ error: 'Error obteniendo el pedido del dia', detail: err.message });
  } finally {
    client.release();
  }
});

// POST /insumos/pedidos/:id/items — upsert de un item del borrador
router.post('/insumos/pedidos/:id/items', async (req, res) => {
  const pedidoId = Number(req.params.id);
  const { producto_odoo_id, producto_nombre, producto_codigo, unidad, categoria_odoo_id, cantidad } = req.body || {};
  const productoId = Number(producto_odoo_id);
  const nombre = String(producto_nombre || '').trim();
  const qty = Number(cantidad);

  if (!Number.isInteger(pedidoId)) return res.status(400).json({ error: 'id de pedido invalido' });
  if (!Number.isInteger(productoId) || !nombre) return res.status(400).json({ error: 'producto_odoo_id y producto_nombre son requeridos' });
  if (!Number.isFinite(qty) || qty < 0) return res.status(400).json({ error: 'cantidad invalida' });

  try {
    const { rows: pedidoRows } = await pool.query(`select status from public.insumos_pedidos where id = $1`, [pedidoId]);
    const pedido = pedidoRows[0];
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (pedido.status !== 'ABIERTO') return res.status(409).json({ error: 'El pedido ya no se puede editar' });

    await pool.query(
      `insert into public.insumos_pedido_items
         (pedido_id, producto_odoo_id, producto_nombre, producto_codigo, unidad, categoria_odoo_id, cantidad_pedida)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (pedido_id, producto_odoo_id) do update set
         cantidad_pedida = excluded.cantidad_pedida,
         producto_nombre = excluded.producto_nombre,
         producto_codigo = excluded.producto_codigo,
         unidad = excluded.unidad,
         categoria_odoo_id = excluded.categoria_odoo_id,
         updated_at = now()`,
      [pedidoId, productoId, nombre, producto_codigo || null, unidad || null, categoria_odoo_id || null, qty]
    );

    const full = await loadPedidoConItems(pool, pedidoId);
    return res.json(full);
  } catch (err) {
    console.error('upsert insumos pedido item error:', err);
    return res.status(500).json({ error: 'Error guardando el item', detail: err.message });
  }
});

// DELETE /insumos/pedidos/:id/items/:itemId
router.delete('/insumos/pedidos/:id/items/:itemId', async (req, res) => {
  const pedidoId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  if (!Number.isInteger(pedidoId) || !Number.isInteger(itemId)) return res.status(400).json({ error: 'parametros invalidos' });

  try {
    const { rows: pedidoRows } = await pool.query(`select status from public.insumos_pedidos where id = $1`, [pedidoId]);
    const pedido = pedidoRows[0];
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (pedido.status !== 'ABIERTO') return res.status(409).json({ error: 'El pedido ya no se puede editar' });

    await pool.query(`delete from public.insumos_pedido_items where id = $1 and pedido_id = $2`, [itemId, pedidoId]);
    const full = await loadPedidoConItems(pool, pedidoId);
    return res.json(full);
  } catch (err) {
    console.error('delete insumos pedido item error:', err);
    return res.status(500).json({ error: 'Error eliminando el item', detail: err.message });
  }
});

// POST /insumos/pedidos/:id/confirm — body { pin }
router.post('/insumos/pedidos/:id/confirm', async (req, res) => {
  const pedidoId = Number(req.params.id);
  const pinStr = String((req.body || {}).pin || '').trim();
  if (!Number.isInteger(pedidoId)) return res.status(400).json({ error: 'id de pedido invalido' });
  if (!/^\d{3,10}$/.test(pinStr)) return res.status(400).json({ error: 'PIN invalido (solo numerico)' });

  const client = await pool.connect();
  try {
    await client.query('begin');

    const { rows: pedidoRows } = await client.query(
      `select * from public.insumos_pedidos where id = $1 for update`,
      [pedidoId]
    );
    const pedido = pedidoRows[0];
    if (!pedido) {
      await client.query('rollback');
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    if (pedido.status !== 'ABIERTO') {
      await client.query('rollback');
      return res.status(409).json({ error: 'El pedido ya no esta abierto' });
    }

    const pinHash = hashPin(pinStr);
    const { rows: userRows } = await client.query(
      `select id, name, is_global, is_active from public.qc_users where pin_hash = $1 limit 1`,
      [pinHash]
    );
    const user = userRows[0];
    if (!user || !user.is_active) {
      await client.query('rollback');
      return res.status(401).json({ error: 'PIN incorrecto o usuario inactivo' });
    }
    if (!user.is_global) {
      const hasScope = await userHasInsumosScope(client, user.id, pedido.seccion);
      if (!hasScope) {
        await client.query('rollback');
        return res.status(403).json({ error: 'Usuario sin permiso para confirmar pedidos de esta seccion' });
      }
    }

    const upd = await client.query(
      `update public.insumos_pedidos
          set status = 'CONFIRMADO', confirmed_by_user_id = $2, confirmed_at = now()
        where id = $1
        returning *`,
      [pedidoId, user.id]
    );

    await client.query(
      `insert into public.qc_event (line, item_id, stage_key, qc_status, by_user_id)
       values ('insumos', $1, $2, 'APROBADO', $3)`,
      [pedidoId, pedido.seccion, user.id]
    );

    await client.query('commit');
    const full = await loadPedidoConItems(pool, pedidoId);
    return res.json({ ...full, confirmed_by_name: user.name });
  } catch (err) {
    await client.query('rollback');
    console.error('confirm insumos pedido error:', err);
    return res.status(500).json({ error: 'Error confirmando el pedido', detail: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
