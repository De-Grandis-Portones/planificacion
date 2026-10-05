const express = require('express');
const crypto = require('crypto');
const { pool } = require('../../db');
const { adminAuth } = require('../../middleware/adminAuth');

const router = express.Router();

const QC_PIN_SALT = process.env.QC_PIN_SALT || 'dev_change_me_pin_salt';
function hashPin(pin) {
  return crypto.createHmac('sha256', QC_PIN_SALT).update(String(pin)).digest('hex');
}
function isValidLine(line) { return ['portones', 'ipanel', 'prefabricados', 'servicio_tecnico', 'orden_externa', 'refabricado', 'insumos'].includes(line); }
function isValidKind(k) { return ['OBSERVADO', 'RECHAZADO'].includes(k); }

function normalizeScopes(scopesRaw) {
  if (Array.isArray(scopesRaw)) return scopesRaw.map((s) => String(s || '').trim()).filter(Boolean);
  if (typeof scopesRaw === 'string') return scopesRaw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  return [];
}
function hasScope(req, scope) {
  const scopes = normalizeScopes(req?.admin?.scopes ?? req?.admin?.scope ?? req?.admin?.permissions ?? []);
  return scopes.includes(scope);
}
function requireScope(scope) {
  return (req, res, next) => {
    if (!hasScope(req, scope)) return res.status(403).json({ error: `Requiere scope ${scope}` });
    return next();
  };
}

// Con path ('/qc', ...) en vez de global, mismo motivo que insumos.js: no
// pisar otros routers admin montados en la misma base /admin.
router.use('/qc', adminAuth, requireScope('qc:admin'));

// GET /admin/qc/users
router.get('/qc/users', async (_req, res) => {
  try {
    const [uQ, sQ] = await Promise.all([
      pool.query(
        `
        select id, name, is_active, is_global, created_at, updated_at
        from public.qc_users
        order by id asc;
        `
      ),
      pool.query(
        `
        select user_id, line, stage_key, enabled
        from public.qc_user_scope
        order by user_id asc, line asc, stage_key asc;
        `
      ),
    ]);

    const scopesByUser = new Map();
    for (const s of sQ.rows) {
      if (!scopesByUser.has(s.user_id)) scopesByUser.set(s.user_id, []);
      scopesByUser.get(s.user_id).push(s);
    }

    const users = uQ.rows.map(u => ({
      ...u,
      scopes: scopesByUser.get(u.id) || []
    }));

    return res.json({ ok: true, users });
  } catch (err) {
    console.error('admin qc users list error:', err);
    return res.status(500).json({ error: 'Error listando usuarios QC', detail: err.message });
  }
});

// POST /admin/qc/users
router.post('/qc/users', async (req, res) => {
  const { name, pin, is_global, is_active, scopes } = req.body || {};
  const nm = String(name || '').trim();
  const pinStr = String(pin || '').trim();

  if (!nm) return res.status(400).json({ error: 'name requerido' });
  if (!/^\d{3,10}$/.test(pinStr)) return res.status(400).json({ error: 'pin inválido (3 a 10 dígitos)' });

  const client = await pool.connect();
  try {
    await client.query('begin');

    const ins = await client.query(
      `
      insert into public.qc_users(name, pin_hash, is_active, is_global, created_at, updated_at)
      values ($1,$2,$3,$4, now(), now())
      returning id, name, is_active, is_global, created_at, updated_at;
      `,
      [
        nm,
        hashPin(pinStr),
        is_active !== false,
        is_global === true
      ]
    );

    const user = ins.rows[0];

    if (user.is_global !== true && Array.isArray(scopes)) {
      for (const s of scopes) {
        const line = String(s?.line || '').trim();
        const stage_key = String(s?.stage_key || '').trim();
        if (!isValidLine(line) || !stage_key) continue;

        await client.query(
          `
          insert into public.qc_user_scope(user_id, line, stage_key, enabled, created_at)
          values ($1,$2,$3,$4, now())
          on conflict (user_id, line, stage_key) do update
            set enabled = excluded.enabled;
          `,
          [user.id, line, stage_key, s?.enabled !== false]
        );
      }
    }

    await client.query('commit');

    const sQ = await pool.query(
      `
      select user_id, line, stage_key, enabled
      from public.qc_user_scope
      where user_id = $1
      order by line asc, stage_key asc;
      `,
      [user.id]
    );

    return res.status(201).json({ ok: true, user: { ...user, scopes: sQ.rows } });
  } catch (err) {
    await client.query('rollback');
    console.error('admin qc users create error:', err);
    return res.status(500).json({ error: 'Error creando usuario QC', detail: err.message });
  } finally {
    client.release();
  }
});

// PUT /admin/qc/users/:id
router.put('/qc/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' });

  const patch = req.body || {};
  const fields = [];
  const params = [];
  let idx = 1;

  if (patch.name != null) {
    const nm = String(patch.name).trim();
    if (!nm) return res.status(400).json({ error: 'name no puede ser vacío' });
    fields.push(`name = $${idx++}`);
    params.push(nm);
  }

  if (patch.pin != null) {
    const pinStr = String(patch.pin).trim();
    if (!/^\d{3,10}$/.test(pinStr)) return res.status(400).json({ error: 'pin inválido (3 a 10 dígitos)' });
    fields.push(`pin_hash = $${idx++}`);
    params.push(hashPin(pinStr));
  }

  if (patch.is_active != null) {
    fields.push(`is_active = $${idx++}`);
    params.push(patch.is_active === true);
  }

  if (patch.is_global != null) {
    fields.push(`is_global = $${idx++}`);
    params.push(patch.is_global === true);
  }

  if (!fields.length) return res.status(400).json({ error: 'No hay campos para actualizar' });

  params.push(id);

  try {
    const { rows } = await pool.query(
      `
      update public.qc_users
      set ${fields.join(', ')}, updated_at = now()
      where id = $${idx}
      returning id, name, is_active, is_global, created_at, updated_at;
      `,
      params
    );

    if (!rows.length) return res.status(404).json({ error: 'Usuario QC no encontrado' });

    const sQ = await pool.query(
      `
      select user_id, line, stage_key, enabled
      from public.qc_user_scope
      where user_id = $1
      order by line asc, stage_key asc;
      `,
      [id]
    );

    return res.json({ ok: true, user: { ...rows[0], scopes: sQ.rows } });
  } catch (err) {
    console.error('admin qc users update error:', err);
    return res.status(500).json({ error: 'Error actualizando usuario QC', detail: err.message });
  }
});

// PUT /admin/qc/users/:id/scopes
router.put('/qc/users/:id/scopes', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' });

  const scopes = Array.isArray(req.body?.scopes) ? req.body.scopes : null;
  if (!scopes) return res.status(400).json({ error: 'scopes debe ser array' });

  const client = await pool.connect();
  try {
    await client.query('begin');

    const uQ = await client.query(
      `select id, is_global from public.qc_users where id = $1 limit 1;`,
      [id]
    );
    if (!uQ.rows.length) {
      await client.query('rollback');
      return res.status(404).json({ error: 'Usuario QC no encontrado' });
    }
    const isGlobal = uQ.rows[0].is_global === true;

    await client.query(`delete from public.qc_user_scope where user_id = $1;`, [id]);

    for (const s of scopes) {
      const line = String(s?.line || '').trim();
      const stage_key = String(s?.stage_key || '').trim();
      if (!isValidLine(line) || !stage_key) continue;

      await client.query(
        `
        insert into public.qc_user_scope(user_id, line, stage_key, enabled, created_at)
        values ($1,$2,$3,$4, now());
        `,
        [id, line, stage_key, s?.enabled !== false]
      );
    }

    await client.query('commit');

    const sQ = await pool.query(
      `
      select user_id, line, stage_key, enabled
      from public.qc_user_scope
      where user_id = $1
      order by line asc, stage_key asc;
      `,
      [id]
    );

    return res.json({ ok: true, user_id: id, is_global: isGlobal, scopes: sQ.rows });
  } catch (err) {
    await client.query('rollback');
    console.error('admin qc scopes error:', err);
    return res.status(500).json({ error: 'Error guardando scopes QC', detail: err.message });
  } finally {
    client.release();
  }
});

// GET /admin/qc/motives
router.get('/qc/motives', async (req, res) => {
  try {
    const line = req.query.line ? String(req.query.line).trim() : null;
    const kind = req.query.kind ? String(req.query.kind).trim().toUpperCase() : null;
    const stage = req.query.stage ? String(req.query.stage).trim() : null;

    if (line && !isValidLine(line)) return res.status(400).json({ error: 'line inválida' });
    if (kind && !isValidKind(kind)) return res.status(400).json({ error: 'kind inválido' });

    const { rows } = await pool.query(
      `
      select id, line, kind, stage_key, label, enabled, priority, created_at
      from public.qc_motive
      where ($1::text is null or line = $1)
        and ($2::text is null or kind = $2)
        and ($3::text is null or stage_key = $3 or stage_key is null)
      order by line asc, kind asc, priority asc, id asc;
      `,
      [line, kind, stage]
    );

    return res.json({ ok: true, motives: rows });
  } catch (err) {
    console.error('admin qc motives list error:', err);
    return res.status(500).json({ error: 'Error listando motivos', detail: err.message });
  }
});

// POST /admin/qc/motives
router.post('/qc/motives', async (req, res) => {
  try {
    const { line, kind, stage_key, label, enabled, priority } = req.body || {};
    const ln = String(line || '').trim();
    const kd = String(kind || '').trim().toUpperCase();
    const sk = stage_key == null || stage_key === '' ? null : String(stage_key).trim();
    const lb = String(label || '').trim();

    if (!isValidLine(ln)) return res.status(400).json({ error: 'line inválida' });
    if (!isValidKind(kd)) return res.status(400).json({ error: 'kind inválido' });
    if (!lb) return res.status(400).json({ error: 'label requerido' });

    const pr = Number.isInteger(Number(priority)) ? Number(priority) : 100;

    const { rows } = await pool.query(
      `
      insert into public.qc_motive(line, kind, stage_key, label, enabled, priority, created_at)
      values ($1,$2,$3,$4,$5,$6, now())
      returning *;
      `,
      [ln, kd, sk, lb, enabled !== false, pr]
    );

    return res.status(201).json({ ok: true, motive: rows[0] });
  } catch (err) {
    console.error('admin qc motives create error:', err);
    return res.status(500).json({ error: 'Error creando motivo', detail: err.message });
  }
});

// PUT /admin/qc/motives/:id
router.put('/qc/motives/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' });

  const patch = req.body || {};
  const fields = [];
  const params = [];
  let idx = 1;

  if (patch.label != null) {
    const lb = String(patch.label).trim();
    if (!lb) return res.status(400).json({ error: 'label no puede ser vacío' });
    fields.push(`label = $${idx++}`);
    params.push(lb);
  }

  if (patch.enabled != null) {
    fields.push(`enabled = $${idx++}`);
    params.push(patch.enabled === true);
  }

  if (patch.priority != null) {
    const pr = Number(patch.priority);
    if (!Number.isFinite(pr)) return res.status(400).json({ error: 'priority inválido' });
    fields.push(`priority = $${idx++}`);
    params.push(pr);
  }

  if (patch.stage_key !== undefined) {
    const sk = patch.stage_key == null || patch.stage_key === '' ? null : String(patch.stage_key).trim();
    fields.push(`stage_key = $${idx++}`);
    params.push(sk);
  }

  if (!fields.length) return res.status(400).json({ error: 'No hay campos para actualizar' });

  params.push(id);

  try {
    const { rows } = await pool.query(
      `
      update public.qc_motive
      set ${fields.join(', ')}
      where id = $${idx}
      returning *;
      `,
      params
    );

    if (!rows.length) return res.status(404).json({ error: 'Motivo no encontrado' });
    return res.json({ ok: true, motive: rows[0] });
  } catch (err) {
    console.error('admin qc motives update error:', err);
    return res.status(500).json({ error: 'Error actualizando motivo', detail: err.message });
  }
});

module.exports = router;
