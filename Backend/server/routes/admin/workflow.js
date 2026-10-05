const express = require('express');
const { adminAuth } = require('../../middleware/adminAuth');
const { pool } = require('../../db');
const { getWorkflowConfig } = require('../../lib/workflow');

const router = express.Router();

function isValidLine(line) {
  return ['portones', 'ipanel'].includes(String(line || '').trim());
}

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

// Con path ('/workflow', ...) en vez de global, mismo motivo que insumos.js.
// Esto NO afecta a los tableros de producción (los que corren en tablets):
// esos leen el config desde routes/public/workflow.js, un endpoint público
// aparte, sin login - este archivo es solo el editor visual de admin
// (WorkflowDesignerPage.jsx).
router.use('/workflow', adminAuth, requireScope('workflow:admin'));

router.get('/workflow/config', async (req, res) => {
  try {
    const line = String(req.query.line || '').trim();
    if (!isValidLine(line)) return res.status(400).json({ error: 'line debe ser portones o ipanel' });
    const cfg = await getWorkflowConfig(line);
    return res.json({ ok: true, ...cfg });
  } catch (err) {
    console.error('get workflow config error:', err);
    return res.status(500).json({ error: 'Error leyendo workflow', detail: err.message });
  }
});

router.get('/workflow/condition-fields', async (req, res) => {
  try {
    const line = String(req.query.line || '').trim();
    if (!isValidLine(line)) return res.status(400).json({ error: 'line debe ser portones o ipanel' });

    const limit = Math.min(Math.max(parseInt(req.query.limit || '2000', 10) || 2000, 100), 10000);
    const base = [];
    let rows = [];

    if (line === 'portones') {
      base.push({ key: 'nv', label: 'nv' });
      const q = await pool.query(
        `
        with sample as (
          select data
          from public.preproduccion_valores
          where data is not null
          order by updated_at desc, id desc
          limit $1
        ),
        keys as (
          select distinct jsonb_object_keys(data) as key
          from sample
        )
        select key
        from keys
        order by key asc;
        `,
        [limit]
      );
      rows = q.rows || [];
    } else {
      base.push(
        { key: 'id', label: 'id' },
        { key: 'partida', label: 'partida' },
        { key: 'nv', label: 'nv' },
        { key: 'descripcion', label: 'descripcion' },
        { key: 'fecha_prod', label: 'fecha_prod' },
        { key: 'fecha_plan_entrega', label: 'fecha_plan_entrega' }
      );
      const q = await pool.query(
        `
        with sample as (
          select data
          from public.preproduccion_valores_ipanels
          where data is not null
          order by updated_at desc, id desc
          limit $1
        ),
        keys as (
          select distinct jsonb_object_keys(data) as key
          from sample
        )
        select key
        from keys
        order by key asc;
        `,
        [limit]
      );
      rows = q.rows || [];
    }

    const blacklist = new Set(['created_at']);
    const seen = new Set(base.map((x) => x.key));
    const jsonKeys = (rows || [])
      .map((r) => String(r.key || '').trim())
      .filter(Boolean)
      .filter((k) => !blacklist.has(k))
      .filter((k) => {
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((k) => ({ key: k, label: k }));

    return res.json({ ok: true, fields: [...base, ...jsonKeys] });
  } catch (err) {
    console.error('get condition-fields error:', err);
    return res.status(500).json({ error: 'Error leyendo campos', detail: err.message });
  }
});

router.put('/workflow/config', async (req, res) => {
  const line = String(req.query.line || '').trim();
  if (!isValidLine(line)) return res.status(400).json({ error: 'line debe ser portones o ipanel' });

  const { edges = [], requirements = [], stageLabels = [] } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (Array.isArray(stageLabels) && stageLabels.length) {
      for (const s of stageLabels) {
        if (!s?.key) continue;
        await client.query(
          `update public.workflow_stage set label = $3, updated_at = now() where line = $1 and key = $2;`,
          [line, String(s.key), String(s.label || s.key)]
        );
      }
    }

    await client.query(`delete from public.workflow_edge where line = $1;`, [line]);
    for (const e of edges) {
      if (!e?.from_key || !e?.to_key) continue;
      await client.query(
        `
        insert into public.workflow_edge(line, from_key, to_key, priority, enabled, condition_json)
        values ($1,$2,$3,$4,$5,$6);
        `,
        [
          line,
          String(e.from_key),
          String(e.to_key),
          Number.isInteger(Number(e.priority)) ? Number(e.priority) : 100,
          e.enabled !== false,
          e.condition_json ?? null,
        ]
      );
    }

    await client.query(`delete from public.workflow_requirement where line = $1;`, [line]);
    for (const r of requirements) {
      if (!r?.stage_key || !r?.type || !r?.required_key) continue;
      await client.query(
        `
        insert into public.workflow_requirement(line, stage_key, type, group_id, required_key)
        values ($1,$2,$3,$4,$5);
        `,
        [
          line,
          String(r.stage_key),
          String(r.type),
          r.group_id == null ? null : Number(r.group_id),
          String(r.required_key),
        ]
      );
    }

    await client.query('COMMIT');
    const cfg = await getWorkflowConfig(line);
    return res.json({ ok: true, ...cfg });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('save workflow config error:', err);
    return res.status(500).json({ error: 'Error guardando workflow', detail: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
