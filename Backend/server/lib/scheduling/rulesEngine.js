// lib/scheduling/rulesEngine.js
//
// Cálculo del "tiempo efectivo" de una etapa (Parte 1 del diseño): dos fases.
//   Fase 1 — independientes: cada regla combine_mode='independent' que
//     matchea calcula su efecto contra el estándar puro (nunca contra el
//     resultado de otra regla); todas miran el mismo punto de partida, así
//     que se suman sus deltas sin importar el orden.
//   Fase 2 — cascada: el resultado de la fase 1 es el nuevo punto de partida;
//     las reglas combine_mode='cascade' se aplican una por una, en su
//     sequence_order, cada una sobre el resultado de la anterior.
// Reusa evalRule() de lib/workflow.js — mismo evaluador que ya usa
// workflow_edge.condition_json, no se reimplementa nada.
const { evalRule } = require('../workflow');

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function toCondition(rule) {
  return { field: rule.field, op: rule.operator, value: rule.value };
}

// baseForIndependent: el estándar puro (fase 1).
// runningValue: el acumulado corriendo (fase 2, ignorado en fase 1).
function applyEffect({ phase, baseForIndependent, runningValue, rule }) {
  const raw = Number(rule.effect_value);
  const effect = Number.isFinite(raw) ? raw : 0;

  if (rule.effect_type === 'percent') {
    return phase === 'independent'
      ? baseForIndependent * (effect / 100)
      : runningValue * (1 + effect / 100);
  }
  if (rule.effect_type === 'fixed_minutes') {
    return phase === 'independent' ? effect : runningValue + effect;
  }
  if (rule.effect_type === 'multiplier') {
    return phase === 'independent'
      ? baseForIndependent * (effect - 1)
      : runningValue * effect;
  }
  if (rule.effect_type === 'override') {
    // Tiene sentido sobre todo en cascada; en independiente no rompe nada,
    // solo aporta ese valor fijo como si fuera un delta.
    return phase === 'independent' ? effect - 0 : effect;
  }
  return phase === 'independent' ? 0 : runningValue;
}

/**
 * @param {number} standardMinutes
 * @param {Array} rules - filas de scheduling_time_rule (line/stage_key ya filtrados)
 * @param {object} ctx - contexto del portón (ver lib/scheduling/portonCtx.js)
 */
function computeEffectiveMinutes({ standardMinutes, rules, ctx }) {
  const standard = Number.isFinite(Number(standardMinutes)) ? Number(standardMinutes) : 0;
  const enabled = (rules || []).filter((r) => r.enabled !== false);

  const independientes = enabled.filter((r) => r.combine_mode !== 'cascade');
  const cascada = enabled
    .filter((r) => r.combine_mode === 'cascade')
    .slice()
    .sort((a, b) => (Number(a.sequence_order) || 0) - (Number(b.sequence_order) || 0));

  const matchedRules = [];
  let independentDelta = 0;

  for (const rule of independientes) {
    let matches = false;
    try {
      matches = evalRule(ctx, toCondition(rule));
    } catch {
      matches = false;
    }
    if (!matches) continue;

    const delta = applyEffect({ phase: 'independent', baseForIndependent: standard, rule });
    independentDelta += delta;
    matchedRules.push({
      id: rule.id,
      category: rule.category,
      phase: 'independent',
      effect_type: rule.effect_type,
      effect_value: rule.effect_value,
      delta_minutes: round2(delta),
    });
  }

  const afterIndependentMinutes = standard + independentDelta;
  let running = afterIndependentMinutes;

  for (const rule of cascada) {
    let matches = false;
    try {
      matches = evalRule(ctx, toCondition(rule));
    } catch {
      matches = false;
    }
    if (!matches) continue;

    const before = running;
    running = applyEffect({ phase: 'cascade', runningValue: running, rule });
    matchedRules.push({
      id: rule.id,
      category: rule.category,
      phase: 'cascade',
      sequence_order: rule.sequence_order,
      effect_type: rule.effect_type,
      effect_value: rule.effect_value,
      before_minutes: round2(before),
      after_minutes: round2(running),
    });
  }

  return {
    standard_minutes: round2(standard),
    independent_delta_minutes: round2(independentDelta),
    after_independent_minutes: round2(afterIndependentMinutes),
    effective_minutes: round2(running),
    matched_rules: matchedRules,
  };
}

module.exports = { computeEffectiveMinutes };
