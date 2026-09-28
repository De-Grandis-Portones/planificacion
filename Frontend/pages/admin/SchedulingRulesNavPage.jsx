// pages/admin/SchedulingRulesNavPage.jsx
//
// Navegación de reglas de desvío (scheduling_time_rule) en dos sentidos,
// sobre exactamente los mismos datos que antes vivían en la lista plana de
// SchedulingRulesPage.jsx (que ahora solo linkea acá):
//   - Por sección: elegís una etapa (ej. Diseño) y ves sus reglas agrupadas
//     por las 5 categorías (intrínseca/material/humana/rotativa/tiempo).
//   - Por tipo de variante: elegís una categoría (ej. Humana) y ves TODAS
//     sus reglas de todas las secciones, cada una identificada con su etapa.
//
// Sin endpoints nuevos: se sigue usando GET/PUT /admin/scheduling/rules
// (trae/guarda la lista completa de la línea) — esto es pura reorganización
// de navegación sobre el mismo arreglo en memoria.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  clearAdminToken, getAdminToken,
  getWorkflowConfig, getWorkflowConditionFields,
  getSchedulingRules, saveSchedulingRules,
  getSchedulingResourceVariables,
} from '../../src/api';

const CATEGORIES = [
  {
    key: 'intrinseca', label: 'Intrínseca', color: '#e0e7ff',
    hint: 'Propia del portón (medidas, sistema, doble inyección).',
    tooltip: 'Ajusta el tiempo según una propiedad del portón mismo (Sistema, medidas, etc.). Se configura eligiendo un campo del portón como condición y el efecto que tiene sobre el tiempo estándar.',
  },
  {
    key: 'material', label: 'Material', color: '#fde68a',
    hint: 'El insumo usado (símil madera vs. aluminio, cambio de rollo).',
    tooltip: 'Ajusta el tiempo según el insumo o material usado (ej. símil madera tarda más que aluminio, cambio de rollo). Se configura igual que Intrínseca, comparando un campo del portón.',
  },
  {
    key: 'humana', label: 'Humana', color: '#bbf7d0',
    hint: 'Nivel de personal, máquina usada — de la sección, no del portón.',
    tooltip: 'Ajusta el tiempo según un atributo de la sección/máquina que hace la etapa (nivel de personal, tipo de máquina) — no del portón. Primero se carga la variable en "Variables de recurso" (arriba en Motor de Reglas de Tiempo), y después se arma la regla usando ese campo.',
  },
  {
    key: 'rotativa', label: 'Rotativa', color: '#fbcfe8',
    hint: 'Compara contra el portón anterior/siguiente en la cola.',
    tooltip: 'Compara contra el portón anterior o siguiente en la cola de producción (ej. cambio de color/material entre uno y otro). El campo de condición se arma igual que las demás categorías.',
  },
  {
    key: 'tiempo', label: 'Tiempo', color: '#bae6fd',
    hint: 'Calendario de trabajo del recurso.',
    tooltip: 'No ajusta minutos como las demás — es el calendario de trabajo del recurso (turnos, feriados). Se carga aparte, en la sección "Calendario laboral por recurso".',
  },
];
// Campos derivados para reglas Rotativa (Fase 3c) — fijos, no vienen de una
// tabla (a diferencia de las Variables de recurso): se calculan comparando
// contra el portón anterior que usó el mismo recurso, ver rotativaFields.js
// en el backend. Solo aportan algo en modo Flota — en un porton_id puntual
// no hay "anterior" con quién comparar.
const ROTATIVA_FIELDS = [
  { key: 'sistema_changed', label: 'Cambió el Sistema respecto al anterior (true/false)' },
  { key: 'prev_sistema', label: 'Sistema del portón anterior en este recurso' },
  { key: 'prev_nv', label: 'NV del portón anterior en este recurso' },
];
const OPERATORS = ['=', '!=', '>', '>=', '<', '<=', 'in', 'contains'];
const EFFECT_TYPES = [
  { key: 'percent', label: '% del punto de partida' },
  { key: 'fixed_minutes', label: 'Minutos fijos' },
  { key: 'multiplier', label: 'Multiplicador (x)' },
  { key: 'override', label: 'Override (fija el valor)' },
];
const COMBINE_MODES = [
  { key: 'independent', label: 'Independiente (contra el estándar)' },
  { key: 'cascade', label: 'Cascada (sobre el resultado anterior)' },
];

function newRuleRow({ stageKey = '', category = 'intrinseca' } = {}) {
  return {
    _localId: `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    stage_key: stageKey, category, field: '', operator: '=', value: '',
    effect_type: 'percent', effect_value: 0, combine_mode: 'independent',
    sequence_order: null, enabled: true,
  };
}

export default function SchedulingRulesNavPage() {
  const nav = useNavigate();
  const line = 'portones'; // Fase 1 del preview también está acotada a esta línea

  useEffect(() => {
    const t = getAdminToken();
    if (!t) nav('/admin/login', { replace: true });
  }, [nav]);

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [stages, setStages] = useState([]);
  const [conditionFields, setConditionFields] = useState([]);
  const [resourceVariableFields, setResourceVariableFields] = useState([]); // [{key, resources: [resource_key,...]}]
  const [rules, setRules] = useState([]);

  // view: 'home' | 'sections' | 'section' | 'categories' | 'category'
  const [view, setView] = useState('home');
  const [activeStageKey, setActiveStageKey] = useState('');
  const [activeCategory, setActiveCategory] = useState('');

  const reload = async () => {
    setErr('');
    setLoading(true);
    try {
      const [wf, fields, rl, resVars] = await Promise.all([
        getWorkflowConfig(line),
        getWorkflowConditionFields(line).catch(() => ({ fields: [] })),
        getSchedulingRules(line),
        getSchedulingResourceVariables().catch(() => ({ variables: [] })),
      ]);
      setStages((wf.stages || []).filter((s) => s.enabled !== false).map((s) => ({ key: s.status_col || s.key, label: s.label || s.key })));
      setConditionFields(Array.isArray(fields?.fields) ? fields.fields : []);
      setRules((rl.rules || []).map((r) => ({ ...r, _localId: `db-${r.id}` })));

      // Une variables con el mismo key de distintos recursos en una sola
      // opción del selector (ej. "nivel_personal" puede existir en varios
      // recursos) — solo importa que el key exista en ALGÚN recurso.
      const byKey = new Map();
      for (const v of resVars.variables || []) {
        if (!byKey.has(v.key)) byKey.set(v.key, new Set());
        byKey.get(v.key).add(v.resource_key);
      }
      setResourceVariableFields([...byKey.entries()].map(([key, resources]) => ({ key, resources: [...resources] })).sort((a, b) => a.key.localeCompare(b.key)));
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { reload(); }, []);

  const stageLabel = (key) => stages.find((s) => s.key === key)?.label || key || '(sin etapa)';
  const categoryLabel = (key) => CATEGORIES.find((c) => c.key === key)?.label || key;

  const rulesByStage = useMemo(() => {
    const m = new Map();
    for (const r of rules) { if (!m.has(r.stage_key)) m.set(r.stage_key, []); m.get(r.stage_key).push(r); }
    return m;
  }, [rules]);
  const rulesByCategory = useMemo(() => {
    const m = new Map();
    for (const r of rules) { if (!m.has(r.category)) m.set(r.category, []); m.get(r.category).push(r); }
    return m;
  }, [rules]);

  const addRule = (overrides) => setRules((prev) => [...prev, newRuleRow(overrides)]);
  const removeRule = (localId) => setRules((prev) => prev.filter((r) => r._localId !== localId));
  const updateRule = (localId, patch) => setRules((prev) => prev.map((r) => (r._localId === localId ? { ...r, ...patch } : r)));

  const onSave = async () => {
    setErr('');
    setSaving(true);
    try {
      await saveSchedulingRules(
        line,
        rules.map((r) => ({
          stage_key: r.stage_key,
          category: r.category,
          field: r.field,
          operator: r.operator,
          value: r.operator === 'in' ? String(r.value || '').split(',').map((v) => v.trim()).filter(Boolean) : r.value,
          effect_type: r.effect_type,
          effect_value: Number(r.effect_value) || 0,
          combine_mode: r.combine_mode,
          sequence_order: r.combine_mode === 'cascade' ? Number(r.sequence_order) || 0 : null,
          enabled: r.enabled !== false,
        }))
      );
      await reload();
      alert('Reglas guardadas.');
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setSaving(false);
    }
  };

  const logout = () => { clearAdminToken(); nav('/admin/login', { replace: true }); };

  const goHome = () => { setView('home'); setActiveStageKey(''); setActiveCategory(''); };

  if (loading) return <div className="container">Cargando reglas…</div>;

  return (
    // "Escapa" del `.container` (max-width 1440px) que envuelve esta página
    // vía NonProductionLayout — pero el contenido acá es formularios en
    // grilla (RuleRow), así que se centra con un tope generoso (1700px) en
    // vez de ir a los bordes reales del viewport (a diferencia del Gantt).
    <div style={{ width: '100vw', position: 'relative', left: '50%', marginLeft: '-50vw', boxSizing: 'border-box' }}>
    <div style={{ maxWidth: 1700, margin: '0 auto', padding: '16px 20px', boxSizing: 'border-box' }}>
      <div className="header-row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h2 className="h1">Reglas de Desvío</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn" to="/admin/scheduling">Motor de Reglas de Tiempo</Link>
          <Link className="btn" to="/admin/scheduling/gantt">Gantt</Link>
          <Link className="btn" to="/">Inicio</Link>
          <button className="btn btn--brand" onClick={onSave} disabled={saving}>{saving ? 'Guardando…' : 'Guardar todo'}</button>
          <button className="btn" onClick={logout}>Salir</button>
        </div>
      </div>

      {err && <div style={{ color: 'crimson', fontWeight: 700, marginTop: 10 }}>{err}</div>}

      <HelpSection />

      {/* ---- Breadcrumb ---- */}
      {view !== 'home' && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginTop: 14, opacity: 0.8 }}>
          <button className="btn" onClick={goHome}>← Menú</button>
          {(view === 'section' || view === 'sections') && (
            <button className="btn" onClick={() => setView('sections')}>Por sección</button>
          )}
          {(view === 'category' || view === 'categories') && (
            <button className="btn" onClick={() => setView('categories')}>Por tipo de variante</button>
          )}
          {view === 'section' && <span>→ {stageLabel(activeStageKey)}</span>}
          {view === 'category' && <span>→ {categoryLabel(activeCategory)}</span>}
        </div>
      )}

      {/* ---- Home: menú de dos cards ---- */}
      {view === 'home' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 20 }}>
          <NavCard
            title="Reglas por sección"
            desc="Elegí una etapa (ej. Diseño) y mirá sus reglas agrupadas por tipo de variante."
            onClick={() => setView('sections')}
          />
          <NavCard
            title="Listado por tipo de variante"
            desc="Elegí un tipo (ej. Humana) y mirá todas sus reglas de todas las secciones, identificadas."
            onClick={() => setView('categories')}
          />
        </div>
      )}

      {/* ---- Lista de secciones ---- */}
      {view === 'sections' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginTop: 20 }}>
          {stages.map((s) => (
            <ListCard key={s.key} title={s.label} sub={s.key} count={(rulesByStage.get(s.key) || []).length} onClick={() => { setActiveStageKey(s.key); setView('section'); }} />
          ))}
        </div>
      )}

      {/* ---- Detalle de una sección: sus reglas agrupadas por categoría ---- */}
      {view === 'section' && (
        <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {CATEGORIES.map((cat) => {
            const rowsHere = (rulesByStage.get(activeStageKey) || []).filter((r) => r.category === cat.key);
            return (
              <section key={cat.key} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12, background: cat.color }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <div>
                    <div style={{ fontWeight: 900, fontSize: 15, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {cat.label} <HelpIcon text={cat.tooltip} />
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>{cat.hint}</div>
                  </div>
                  <button className="btn" onClick={() => addRule({ stageKey: activeStageKey, category: cat.key })}>+ Agregar regla</button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                  {!rowsHere.length && <div style={{ fontSize: 13, opacity: 0.6 }}>Sin reglas {cat.label.toLowerCase()} para esta sección.</div>}
                  {rowsHere.map((r) => (
                    <RuleRow key={r._localId} rule={r} stages={stages} conditionFields={conditionFields} resourceVariableFields={resourceVariableFields} onUpdate={(patch) => updateRule(r._localId, patch)} onRemove={() => removeRule(r._localId)} lockCategory lockStage />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* ---- Lista de tipos de variante ---- */}
      {view === 'categories' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginTop: 20 }}>
          {CATEGORIES.map((c) => (
            <ListCard key={c.key} title={c.label} sub={c.hint} count={(rulesByCategory.get(c.key) || []).length} bg={c.color} tooltip={c.tooltip} onClick={() => { setActiveCategory(c.key); setView('category'); }} />
          ))}
        </div>
      )}

      {/* ---- Detalle de un tipo de variante: todas sus reglas, identificadas por sección ---- */}
      {view === 'category' && (
        <section style={{ marginTop: 20, border: '1px solid var(--border)', borderRadius: 12, padding: 12, background: CATEGORIES.find((c) => c.key === activeCategory)?.color }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ fontWeight: 900, fontSize: 16, display: 'flex', alignItems: 'center', gap: 6 }}>
              {categoryLabel(activeCategory)} — todas las secciones <HelpIcon text={CATEGORIES.find((c) => c.key === activeCategory)?.tooltip} />
            </div>
            <button className="btn" onClick={() => addRule({ stageKey: stages[0]?.key, category: activeCategory })}>+ Agregar regla</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
            {!(rulesByCategory.get(activeCategory) || []).length && <div style={{ fontSize: 13, opacity: 0.7 }}>Sin reglas de este tipo todavía.</div>}
            {(rulesByCategory.get(activeCategory) || []).map((r) => (
              <RuleRow key={r._localId} rule={r} stages={stages} conditionFields={conditionFields} resourceVariableFields={resourceVariableFields} onUpdate={(patch) => updateRule(r._localId, patch)} onRemove={() => removeRule(r._localId)} lockCategory />
            ))}
          </div>
        </section>
      )}
    </div>
    </div>
  );
}

function NavCard({ title, desc, onClick }) {
  return (
    <button
      type="button" onClick={onClick}
      style={{
        textAlign: 'left', cursor: 'pointer', border: '2px solid var(--brand)', background: 'var(--surface)',
        borderRadius: 14, padding: 20, display: 'flex', flexDirection: 'column', gap: 8,
      }}
    >
      <div style={{ fontWeight: 900, fontSize: 18, color: 'var(--brand-700)' }}>{title}</div>
      <div style={{ fontSize: 13.5, opacity: 0.75 }}>{desc}</div>
    </button>
  );
}

function ListCard({ title, sub, count, bg, tooltip, onClick }) {
  return (
    <button
      type="button" onClick={onClick}
      style={{
        textAlign: 'left', cursor: 'pointer', border: '1px solid var(--border)', background: bg || 'var(--surface)',
        borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 4,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <div style={{ fontWeight: 800, fontSize: 14.5, display: 'flex', alignItems: 'center', gap: 6 }}>
          {title} {tooltip && <HelpIcon text={tooltip} />}
        </div>
        <span style={{ fontSize: 11.5, opacity: 0.6, whiteSpace: 'nowrap' }}>{count} regla{count === 1 ? '' : 's'}</span>
      </div>
      <div style={{ fontSize: 12, opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>
    </button>
  );
}

// Ícono "?" con explicación al pasar el mouse (title nativo — simple y
// consistente con el resto de la app, ej. el badge ⏳ del Gantt).
function HelpIcon({ text }) {
  if (!text) return null;
  return (
    <span
      title={text}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 15, height: 15, borderRadius: '50%', border: '1px solid currentColor',
        fontSize: 10, fontWeight: 700, opacity: 0.55, cursor: 'help', flex: 'none',
      }}
    >
      ?
    </span>
  );
}

// Ejemplos reales (ya cargados/probados en la base) de cómo configurar cada
// tipo de variante — plegado a propósito, para no ensuciar la pantalla a
// quien ya lo sabe, pero siempre a mano sin tener que preguntar.
function HelpSection() {
  const example = (label, value) => (
    <div style={{ display: 'flex', gap: 6, fontSize: 12.5 }}>
      <span style={{ opacity: 0.6, minWidth: 110, flex: 'none' }}>{label}:</span>
      <code style={{ fontSize: 12 }}>{value}</code>
    </div>
  );

  return (
    <details style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface)' }}>
      <summary style={{ cursor: 'pointer', padding: 12, fontWeight: 800, fontSize: 14 }}>
        ❓ Ayuda: cómo configurar cada tipo de variante (con ejemplos reales)
      </summary>
      <div style={{ padding: '0 14px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ fontSize: 12.5, opacity: 0.75 }}>
          Todas las reglas se combinan en dos pasos: primero se suman TODAS las <b>independientes</b> que
          matcheen, cada una contra el estándar puro (el orden entre ellas no importa); ese resultado es el
          punto de partida para aplicar, una por una en su <code>orden</code>, las de <b>cascada</b> — cada
          una sobre el resultado que dejó la anterior (por eso ahí sí importa el orden, sobre todo con %).
        </div>

        <div style={{ borderLeft: `4px solid ${CATEGORIES[0].color}`, paddingLeft: 12 }}>
          <b>Intrínseca</b> — algo del portón mismo (Sistema, medidas). Ejemplo ya cargado, Pintura Sistemas:
          {example('Combinación', 'Independiente')}
          {example('Campo', 'Sistema')}
          {example('Operador / Valor', 'in / ACERO SIMIL ALUMINIO DOBLE INY, COPLANAR ACERO SIMIL ALUMINIO DOBLE INY, CORREDIZO SIMIL ALUMINIO DOBLE')}
          {example('Efecto', 'Minutos fijos / 20')}
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>"Si el Sistema es uno de los doble inyección, sumale 20 min fijos."</div>
        </div>

        <div style={{ borderLeft: `4px solid ${CATEGORIES[1].color}`, paddingLeft: 12 }}>
          <b>Material</b> — el insumo usado. Ejemplo ya cargado, Corte piernas:
          {example('Combinación', 'Independiente')}
          {example('Campo', 'Sistema')}
          {example('Operador / Valor', 'contains / MADERA')}
          {example('Efecto', '% del punto de partida / 15')}
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>"Si el Sistema contiene MADERA, el corte tarda 15% más."</div>
        </div>

        <div style={{ borderLeft: `4px solid ${CATEGORIES[2].color}`, paddingLeft: 12 }}>
          <b>Humana</b> — de la sección/máquina, NO del portón. Se configura en dos pasos:
          <div style={{ fontSize: 12.5, marginTop: 4 }}>
            1) En "Variables de recurso" (Motor de Reglas de Tiempo): recurso <code>plegadora</code>, key{' '}
            <code>nivel_personal</code>, valor <code>junior</code>.
          </div>
          <div style={{ fontSize: 12.5, marginTop: 2 }}>2) Acá, en Plegado piernas:</div>
          {example('Campo', 'nivel_personal (grupo "Variable del recurso")')}
          {example('Operador / Valor', '= / junior')}
          {example('Efecto', '% del punto de partida / 30')}
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
            "Si el recurso mapeado a esta etapa tiene nivel_personal=junior, sumale 30%." Cambiando el valor
            en Variables de recurso (sin tocar la regla) deja de aplicar.
          </div>
        </div>

        <div style={{ borderLeft: `4px solid ${CATEGORIES[3].color}`, paddingLeft: 12 }}>
          <b>Rotativa</b> — compara contra el portón <b>anterior</b> que usó el mismo recurso físico (ej.
          cambio de color/material en la Cortadora). Solo funciona en modo <b>Flota</b> de la Regresión — un
          <code>porton_id</code> puntual no tiene "anterior" con quién comparar. Ejemplo ya probado, Corte
          piernas:
          {example('Combinación', 'Independiente')}
          {example('Campo', 'sistema_changed (grupo "Comparación con portón anterior")')}
          {example('Operador / Valor', '= / true')}
          {example('Efecto', 'Minutos fijos / 25')}
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
            "Si el Sistema de este portón es distinto al del portón anterior que pasó por la Cortadora,
            sumale 25 min fijos (costo de cambio de rollo/color)."
          </div>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
            <b>Sobre el orden de "anterior":</b> el diseño original pedía una segunda pasada — calcular todo
            una vez sin Rotativas, usar esos resultados para saber el orden real de cada recurso, y recién
            ahí recalcular con eso. Se implementó en cambio algo más simple: usa el mismo orden de urgencia
            (EDD) con el que ya se procesa toda la flota como si fuera el orden de cola. Es más rápido (no
            duplica el cálculo) y en la práctica coincide con el orden real casi siempre — solo puede
            desviarse si la capacidad compartida obliga a correr un portón menos urgente antes que uno más
            urgente en ese recurso puntual. Si en el uso real eso pasa seguido y la precisión exacta importa,
            se puede migrar a la versión de dos pasadas más adelante.
          </div>
        </div>

        <div style={{ borderLeft: `4px solid ${CATEGORIES[4].color}`, paddingLeft: 12 }}>
          <b>Tiempo</b> — no se arma acá con campo/valor: es el calendario de turnos/feriados del recurso.
          Se carga en "Calendario laboral por recurso" (Motor de Reglas de Tiempo). Dejarla vacía en esta
          pantalla es lo esperado.
        </div>
      </div>
    </details>
  );
}

// Fila de edición de una regla — misma forma de siempre (SchedulingRulesPage),
// con lockStage/lockCategory para ocultar el selector correspondiente cuando
// el contexto de navegación ya lo fija (sección o categoría activa).
function RuleRow({ rule: r, stages, conditionFields, resourceVariableFields, onUpdate, onRemove, lockStage, lockCategory }) {
  return (
    <div style={{ border: '1px dashed #d1d5db', borderRadius: 12, padding: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: `${lockStage ? '' : '1fr '}${lockCategory ? '' : '1fr '}1fr 1fr auto`, gap: 8, alignItems: 'center' }}>
        {!lockStage && (
          <select className="btn" value={r.stage_key} onChange={(e) => onUpdate({ stage_key: e.target.value })}>
            <option value="">(sección)</option>
            {stages.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        )}
        {!lockCategory && (
          <select className="btn" value={r.category} onChange={(e) => onUpdate({ category: e.target.value })}>
            {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        )}
        <select className="btn" value={r.combine_mode} onChange={(e) => onUpdate({ combine_mode: e.target.value })}>
          {COMBINE_MODES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        {r.combine_mode === 'cascade' ? (
          <input className="btn" type="number" value={r.sequence_order ?? ''} onChange={(e) => onUpdate({ sequence_order: e.target.value })} placeholder="orden" title="Orden dentro de la cascada" />
        ) : (
          <div style={{ fontSize: 12, opacity: 0.6, alignSelf: 'center' }}>sin orden (independiente)</div>
        )}
        <button className="btn" type="button" onClick={onRemove}>Quitar</button>
      </div>

      {lockStage && (
        <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 4 }}>Sección: {stages.find((s) => s.key === r.stage_key)?.label || r.stage_key}</div>
      )}
      {lockCategory && !lockStage && (
        <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 4 }}>Tipo: {CATEGORIES.find((c) => c.key === r.category)?.label || r.category}</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr .7fr 1fr 1fr 1fr auto', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <select className="btn" value={r.field} onChange={(e) => onUpdate({ field: e.target.value })}>
          <option value="">(campo)</option>
          <optgroup label="Propiedad del portón">
            {conditionFields.map((f) => <option key={f.key} value={f.key}>{f.label} ({f.key})</option>)}
          </optgroup>
          {!!resourceVariableFields?.length && (
            <optgroup label="Variable del recurso">
              {resourceVariableFields.map((f) => <option key={f.key} value={f.key}>{f.key} — {f.resources.join(', ')}</option>)}
            </optgroup>
          )}
          <optgroup label="Comparación con portón anterior (solo Rotativa, modo Flota)">
            {ROTATIVA_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </optgroup>
        </select>
        <select className="btn" value={r.operator} onChange={(e) => onUpdate({ operator: e.target.value })}>
          {OPERATORS.map((op) => <option key={op} value={op}>{op}</option>)}
        </select>
        <input className="btn" value={r.value ?? ''} onChange={(e) => onUpdate({ value: e.target.value })} placeholder={r.operator === 'in' ? 'valor1, valor2' : 'valor'} />
        <select className="btn" value={r.effect_type} onChange={(e) => onUpdate({ effect_type: e.target.value })}>
          {EFFECT_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <input className="btn" type="number" value={r.effect_value} onChange={(e) => onUpdate({ effect_value: e.target.value })} placeholder="efecto" />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={r.enabled !== false} onChange={(e) => onUpdate({ enabled: e.target.checked })} />
          Activa
        </label>
      </div>
    </div>
  );
}
