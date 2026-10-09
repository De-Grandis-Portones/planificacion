const express = require('express');
const { pool } = require('../../db');
const { sqlInstalacionSigueSalida } = require('../../lib/logisticaInstalacionVendida');

const router = express.Router();

// Las rutas /remitos-proxy/* vivían acá también (con REMITOS_BASE apuntando
// a un dominio de Render que ya no existe: remitos.onrender.com en vez de
// remitos-c77t.onrender.com) - al montarse ANTES que routes/public/remitosProxy.js
// en app.js, esta versión vieja/rota siempre ganaba y la buena nunca se
// llegaba a ejecutar (bug real encontrado 2026-09-04: /a nunca lo notó
// porque llama directo al dominio correcto desde el navegador, sin pasar
// por el backend). Se borran de acá - la única implementación queda en
// remitosProxy.js.

// GET /preproduccion-valores
router.get('/preproduccion-valores', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `
      with pq_raw as (
        select
          case
            when regexp_replace(coalesce(final_sale_order_name, odoo_sale_order_name, ''), '^[A-Za-z]+', '') ~ '^[0-9]+$'
            then regexp_replace(coalesce(final_sale_order_name, odoo_sale_order_name, ''), '^[A-Za-z]+', '')::integer
            else null
          end as nv_num,
          end_customer->>'phone'    as phone,
          end_customer->>'maps_url' as maps_url,
          end_customer->>'city'     as localidad,
          to_char(measurement_scheduled_for, 'YYYY-MM-DD') as fecha_medicion,
          measurement_scheduled_for
        from public.presupuestador_quotes
        where quote_kind = 'original'
      ),
      pq_best as (
        select distinct on (nv_num)
          nv_num, phone, maps_url, localidad, fecha_medicion
        from pq_raw
        where nv_num is not null
        order by nv_num, measurement_scheduled_for desc nulls last
      )
      select
        pv.id,
        pv.nv,
        pv.nv_tipo,
        coalesce(pv.data, '{}'::jsonb)
          || jsonb_strip_nulls(jsonb_build_object(
               'pq_phone',          pqb.phone,
               'pq_maps_url',       pqb.maps_url,
               'pq_localidad',      pqb.localidad,
               'pq_fecha_medicion', pqb.fecha_medicion
             )) as data,
        pv.updated_at
      from public.preproduccion_valores pv
      left join pq_best pqb on pqb.nv_num = pv.nv
      order by coalesce(pv.nv, 0) asc, pv.id asc;
      `
    );
    res.setHeader('Cache-Control', 'no-store');
    return res.json(rows);
  } catch (err) {
    console.error('preproduccion-valores get error:', err);
    return res.status(500).json({ error: 'Error leyendo preproduccion_valores', detail: err.message });
  }
});

// PUT /preproduccion-valores/:id
router.put('/preproduccion-valores/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' });

  const nvRaw = req.body?.nv;
  const patch = req.body?.patch;

  let nv;
  const hasNv = nvRaw !== undefined;
  if (hasNv) {
    if (nvRaw === null) nv = null;
    else {
      const n = Number(nvRaw);
      if (!Number.isInteger(n)) return res.status(400).json({ error: 'nv debe ser entero o null' });
      nv = n;
    }
  }

  let patchObj = {};
  const hasPatch = patch !== undefined;
  if (hasPatch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return res.status(400).json({ error: 'patch debe ser un objeto JSON' });
    }
    patchObj = patch;
  }

  if (!hasNv && !hasPatch) {
    return res.status(400).json({ error: 'Debe enviarse nv y/o patch' });
  }

  const sets = [];
  const params = [id];
  let idx = 2;

  if (hasNv) {
    sets.push(`nv = $${idx++}`);
    params.push(nv);
  }

  if (hasPatch) {
    const pIdx = idx++;
    params.push(JSON.stringify(patchObj));
    // Si se graba la fecha de despacho (y no se toca a la vez la de
    // instalación), un NV que vendió instalación la toma también - ver
    // lib/logisticaInstalacionVendida.js.
    const tocaSalidaSola = Object.prototype.hasOwnProperty.call(patchObj, 'fecha_salida_imput')
      && !Object.prototype.hasOwnProperty.call(patchObj, 'fecha_llegada_imput');
    sets.push(tocaSalidaSola
      ? `data = coalesce(data, '{}'::jsonb) || $${pIdx}::jsonb || ${sqlInstalacionSigueSalida('data', `($${pIdx}::jsonb->>'fecha_salida_imput')`)}`
      : `data = coalesce(data, '{}'::jsonb) || $${pIdx}::jsonb`);
  }

  sets.push(`updated_at = now()`);

  try {
    const { rows, rowCount } = await pool.query(
      `
      update public.preproduccion_valores
      set ${sets.join(', ')}
      where id = $1
      returning id, nv, data, updated_at;
      `,
      params
    );

    if (!rowCount) return res.status(404).json({ error: 'Registro no encontrado' });
    return res.json(rows[0]);
  } catch (err) {
    console.error('preproduccion-valores put error:', err);
    return res.status(500).json({ error: 'Error actualizando preproduccion_valores', detail: err.message });
  }
});

// GET /preproduccion-valores/:nv/nv-lines?tipo=ONV
router.get('/preproduccion-valores/:nv/nv-lines', async (req, res) => {
  const nv = Number(req.params.nv);
  if (!Number.isInteger(nv) || nv <= 0) {
    return res.status(400).json({ error: 'nv debe ser un entero positivo' });
  }
  const tipo = String(req.query.tipo || 'NV').trim().toUpperCase() || 'NV';
  try {
    const { rows } = await pool.query(
      `SELECT pv.nv, pv.nv_tipo, pv.nv_lines, pv.data,
              q.end_customer->>'name'     AS nombre,
              q.end_customer->>'address'  AS direccion,
              q.end_customer->>'locality' AS localidad,
              q.note
       FROM public.preproduccion_valores pv
       LEFT JOIN public.presupuestador_quotes q
         ON q.odoo_sale_order_name ~ ('^[A-Za-z]*' || pv.nv::text || '$')
       WHERE pv.nv = $1 AND pv.nv_tipo = $2
       LIMIT 1`,
      [nv, tipo]
    );
    res.setHeader('Cache-Control', 'no-store');
    if (!rows.length) return res.json({ found: false });
    const r = rows[0];
    return res.json({
      found: true,
      nv: r.nv,
      nv_tipo: r.nv_tipo,
      nv_lines: r.nv_lines || [],
      nombre: r.nombre || '',
      direccion: r.direccion || '',
      localidad: r.localidad || '',
      note: r.note || '',
    });
  } catch (err) {
    console.error('nv-lines get error:', err);
    return res.status(500).json({ error: 'Error leyendo nv-lines', detail: err.message });
  }
});

module.exports = router;
