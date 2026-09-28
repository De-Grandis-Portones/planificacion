// pages/admin/SchedulingRulesPage.jsx
//
// Fase 0/1 del motor de reglas de tiempo (en sombra): carga de estándares y
// reglas de desvío por etapa, más un preview que compara el tiempo_efectivo
// calculado contra el tiempo real ya registrado. No cambia nada de lo que ve
// el tablero operador — esta página es aditiva y solo la ve quien tenga el
// scope 'scheduling:admin'.
import { useEffect, useMemo, useState } from 'react';
import {
  clearAdminToken,
  getAdminToken,
  getWorkflowConfig,
  getSchedulingStandard,
  saveSchedulingStandard,
  getSchedulingRules,
  getSchedulingPreview,
  getSchedulingRegressionPreview,
  setFechaDespachoLogistica,
  getSchedulingResources,
  saveSchedulingResource,
  deleteSchedulingResource,
  getSchedulingStageResource,
  saveSchedulingStageResource,
  getSchedulingCalendar,
  saveSchedulingCalendar,
  getSchedulingCalendarExceptions,
  saveSchedulingCalendarExceptions,
  getSchedulingResourceVariables,
  saveSchedulingResourceVariables,
} from '../../src/api';
import { Link, useNavigate } from 'react-router-dom';

const AR_TZ = 'America/Argentina/Buenos_Aires';
function fmtArDateTime(iso) {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('es-AR', {
      timeZone: AR_TZ,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return String(iso);
  }
}

// weekday: 0=domingo..6=sábado, mismo criterio que Date.getUTCDay() (ver lib/scheduling/calendar.js).
const WEEKDAYS = [
  { key: 1, label: 'Lunes' },
  { key: 2, label: 'Martes' },
  { key: 3, label: 'Miércoles' },
  { key: 4, label: 'Jueves' },
  { key: 5, label: 'Viernes' },
  { key: 6, label: 'Sábado' },
  { key: 0, label: 'Domingo' },
];
function newShiftRow() {
  return { _localId: `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, weekday: 1, start_time: '08:00', end_time: '18:00', enabled: true };
}
function newExceptionRow() {
  return { _localId: `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, exception_date: '', is_working: false, start_time: '', end_time: '', notes: '' };
}

// Tabla de excepciones (feriados / turnos puntuales) — reusada para las
// excepciones de un recurso puntual y para los feriados globales de planta
// (mismo shape, distinto resource_key en el save del caller).
function ExceptionsTable({ rows, onRemove, onUpdate }) {
  if (!rows.length) {
    return <div style={{ fontSize: 13, opacity: 0.7, marginTop: 8 }}>Sin excepciones cargadas.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
      {rows.map((e) => (
        <div key={e._localId} style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr 1fr 1.5fr auto', gap: 8, alignItems: 'center' }}>
          <input className="btn" type="date" value={e.exception_date || ''} onChange={(ev) => onUpdate(e._localId, { exception_date: ev.target.value })} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={!!e.is_working} onChange={(ev) => onUpdate(e._localId, { is_working: ev.target.checked })} />
            Laborable
          </label>
          <input
            className="btn"
            type="time"
            disabled={!e.is_working}
            value={e.start_time?.slice(0, 5) || ''}
            onChange={(ev) => onUpdate(e._localId, { start_time: ev.target.value })}
            placeholder="desde"
          />
          <input
            className="btn"
            type="time"
            disabled={!e.is_working}
            value={e.end_time?.slice(0, 5) || ''}
            onChange={(ev) => onUpdate(e._localId, { end_time: ev.target.value })}
            placeholder="hasta"
          />
          <input className="btn" value={e.notes || ''} onChange={(ev) => onUpdate(e._localId, { notes: ev.target.value })} placeholder="Notas (ej. Navidad)" />
          <button className="btn" type="button" onClick={() => onRemove(e._localId)}>Quitar</button>
        </div>
      ))}
    </div>
  );
}

export default function SchedulingRulesPage() {
  const nav = useNavigate();

  // Guard simple: si no hay token, afuera. Mismo patrón que WorkflowDesignerPage.
  useEffect(() => {
    const t = getAdminToken();
    if (!t) nav('/admin/login', { replace: true });
  }, [nav]);

  const [line, setLine] = useState('portones');
  const [loading, setLoading] = useState(true);
  const [savingStandards, setSavingStandards] = useState(false);
  const [err, setErr] = useState('');

  const [stages, setStages] = useState([]);
  const [standards, setStandards] = useState([]); // [{stage_key, standard_minutes, notes}]
  const [rules, setRules] = useState([]);

  const [resources, setResources] = useState([]); // catálogo global: [{resource_key, label, enabled, parallel_capacity}]
  const [savingResource, setSavingResource] = useState(false);
  const [newResource, setNewResource] = useState({ resource_key: '', label: '', parallel_capacity: 1 });
  const [stageResourceMap, setStageResourceMap] = useState({}); // {stage_key: resource_key} — solo mapeos explícitos de esta línea
  const [savingStageResource, setSavingStageResource] = useState(false);
  const [resourceErr, setResourceErr] = useState('');

  const [variablesResourceKey, setVariablesResourceKey] = useState('');
  const [resourceVariables, setResourceVariables] = useState([]);
  const [variablesLoading, setVariablesLoading] = useState(false);
  const [savingVariables, setSavingVariables] = useState(false);
  const [variablesErr, setVariablesErr] = useState('');

  const [calendarResourceKey, setCalendarResourceKey] = useState('');
  const [calendarShifts, setCalendarShifts] = useState([]);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [savingCalendar, setSavingCalendar] = useState(false);
  const [calendarExceptions, setCalendarExceptions] = useState([]);
  const [savingCalendarExceptions, setSavingCalendarExceptions] = useState(false);
  const [globalExceptions, setGlobalExceptions] = useState([]);
  const [globalExceptionsLoading, setGlobalExceptionsLoading] = useState(false);
  const [savingGlobalExceptions, setSavingGlobalExceptions] = useState(false);
  const [calendarErr, setCalendarErr] = useState('');

  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewErr, setPreviewErr] = useState('');

  const [portonIdInput, setPortonIdInput] = useState('');
  const [fleetMode, setFleetMode] = useState('fleet'); // 'fleet' | 'isolated' — solo aplica sin porton_id
  const [flow, setFlow] = useState('presupuesto'); // 'presupuesto' | 'logistica'
  const [regression, setRegression] = useState(null);
  const [regressionLoading, setRegressionLoading] = useState(false);
  const [regressionErr, setRegressionErr] = useState('');

  const [logisticaDateInput, setLogisticaDateInput] = useState('');
  const [savingLogisticaDate, setSavingLogisticaDate] = useState(false);

  const regressionPortones = useMemo(() => {
    if (!regression) return [];
    if (Array.isArray(regression.portones)) return regression.portones;
    if (regression.id != null) return [regression];
    return [];
  }, [regression]);

  const stageOptions = useMemo(
    () => (stages || []).filter((s) => s.enabled !== false).map((s) => ({ key: s.status_col || s.key, label: s.label || s.key })),
    [stages]
  );

  const reload = async () => {
    setErr('');
    setLoading(true);
    try {
      const [wf, std, rl, res, sr] = await Promise.all([
        getWorkflowConfig(line),
        getSchedulingStandard(line),
        getSchedulingRules(line),
        getSchedulingResources(),
        getSchedulingStageResource(line),
      ]);
      setStages(wf.stages || []);

      const stageKeys = (wf.stages || []).filter((s) => s.enabled !== false).map((s) => s.status_col || s.key);
      const byKey = new Map((std.standards || []).map((s) => [s.stage_key, s]));
      setStandards(stageKeys.map((k) => byKey.get(k) || { stage_key: k, standard_minutes: 0, notes: '' }));

      setRules((rl.rules || []).map((r) => ({ ...r, _localId: `db-${r.id}` })));

      setResources(res.resources || []);
      setStageResourceMap(Object.fromEntries((sr.mappings || []).map((m) => [m.stage_key, m.resource_key])));
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    setPreview(null);
  }, [line]);

  // Auto-selecciona el primer recurso del catálogo apenas hay alguno, así las
  // sub-secciones de variables/calendario no arrancan vacías si ya existen
  // recursos (ej. después de cargar Cortadora/Plegadora/Pintura arriba).
  useEffect(() => {
    if (!variablesResourceKey && resources.length) setVariablesResourceKey(resources[0].resource_key);
    if (!calendarResourceKey && resources.length) setCalendarResourceKey(resources[0].resource_key);
  }, [resources]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadVariablesForResource = async (resourceKey) => {
    if (!resourceKey) { setResourceVariables([]); return; }
    setVariablesErr('');
    setVariablesLoading(true);
    try {
      const data = await getSchedulingResourceVariables(resourceKey);
      setResourceVariables((data.variables || []).map((v) => ({
        _localId: `db-${v.resource_key}-${v.key}`,
        key: v.key,
        // El valor viaja como jsonb — si es un string JSON ("junior") lo
        // desenvuelve para el input de texto; cualquier otro tipo (número,
        // bool, objeto) se muestra tal cual serializado.
        value: typeof v.value === 'string' ? v.value : JSON.stringify(v.value),
        label: v.label || '',
        notes: v.notes || '',
      })));
    } catch (e) {
      setVariablesErr(e?.response?.data?.error || e.message);
    } finally {
      setVariablesLoading(false);
    }
  };

  useEffect(() => {
    loadVariablesForResource(variablesResourceKey);
  }, [variablesResourceKey]);

  const addVariable = () => setResourceVariables((prev) => [...prev, { _localId: `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, key: '', value: '', label: '', notes: '' }]);
  const removeVariable = (localId) => setResourceVariables((prev) => prev.filter((v) => v._localId !== localId));
  const updateVariable = (localId, patch) => setResourceVariables((prev) => prev.map((v) => (v._localId === localId ? { ...v, ...patch } : v)));

  const onSaveVariables = async () => {
    if (!variablesResourceKey) return;
    setVariablesErr('');
    setSavingVariables(true);
    try {
      for (const v of resourceVariables) {
        if (!v.key.trim()) throw new Error('Cada variable necesita un nombre (key).');
      }
      await saveSchedulingResourceVariables(
        variablesResourceKey,
        resourceVariables.map((v) => {
          // Intenta interpretar el valor tipado (número/true/false); si no,
          // lo guarda como string — mismo criterio simple que ya usan las
          // reglas para su campo "value".
          let value = v.value;
          if (value !== '' && !Number.isNaN(Number(value))) value = Number(value);
          else if (value === 'true') value = true;
          else if (value === 'false') value = false;
          return { key: v.key.trim(), value, label: v.label || null, notes: v.notes || null };
        })
      );
      alert('Variables de recurso guardadas.');
    } catch (e) {
      setVariablesErr(e?.response?.data?.error || e.message);
    } finally {
      setSavingVariables(false);
    }
  };

  const loadCalendarForResource = async (resourceKey) => {
    if (!resourceKey) { setCalendarShifts([]); setCalendarExceptions([]); return; }
    setCalendarErr('');
    setCalendarLoading(true);
    try {
      const [cal, exc] = await Promise.all([
        getSchedulingCalendar(resourceKey),
        getSchedulingCalendarExceptions(resourceKey),
      ]);
      setCalendarShifts((cal.shifts || []).map((s) => ({ ...s, _localId: `db-${s.id}` })));
      setCalendarExceptions((exc.exceptions || []).map((e) => ({ ...e, _localId: `db-${e.id}` })));
    } catch (e) {
      setCalendarErr(e?.response?.data?.error || e.message);
    } finally {
      setCalendarLoading(false);
    }
  };

  useEffect(() => {
    loadCalendarForResource(calendarResourceKey);
  }, [calendarResourceKey]);

  const loadGlobalExceptions = async () => {
    setGlobalExceptionsLoading(true);
    try {
      const exc = await getSchedulingCalendarExceptions(null);
      setGlobalExceptions((exc.exceptions || []).map((e) => ({ ...e, _localId: `db-${e.id}` })));
    } catch (e) {
      setCalendarErr(e?.response?.data?.error || e.message);
    } finally {
      setGlobalExceptionsLoading(false);
    }
  };

  useEffect(() => {
    loadGlobalExceptions();
  }, []);

  const addShift = () => setCalendarShifts((prev) => [...prev, newShiftRow()]);
  const removeShift = (localId) => setCalendarShifts((prev) => prev.filter((s) => s._localId !== localId));
  const updateShift = (localId, patch) => setCalendarShifts((prev) => prev.map((s) => (s._localId === localId ? { ...s, ...patch } : s)));
  const loadDefaultShifts = () => setCalendarShifts([1, 2, 3, 4, 5].map((weekday) => ({ ...newShiftRow(), weekday })));

  const onSaveCalendar = async () => {
    if (!calendarResourceKey) return;
    setCalendarErr('');
    setSavingCalendar(true);
    try {
      await saveSchedulingCalendar(
        calendarResourceKey,
        calendarShifts.map((s) => ({ weekday: Number(s.weekday), start_time: s.start_time, end_time: s.end_time, enabled: s.enabled !== false }))
      );
      alert('Turnos guardados.');
    } catch (e) {
      setCalendarErr(e?.response?.data?.error || e.message);
    } finally {
      setSavingCalendar(false);
    }
  };

  const addException = (setter) => setter((prev) => [...prev, newExceptionRow()]);
  const removeException = (setter, localId) => setter((prev) => prev.filter((e) => e._localId !== localId));
  const updateException = (setter, localId, patch) => setter((prev) => prev.map((e) => (e._localId === localId ? { ...e, ...patch } : e)));

  const saveExceptions = async (resourceKey, exceptions, setSaving) => {
    setCalendarErr('');
    setSaving(true);
    try {
      for (const e of exceptions) {
        if (!e.exception_date) throw new Error('Cada excepción necesita una fecha.');
      }
      await saveSchedulingCalendarExceptions(
        resourceKey,
        exceptions.map((e) => ({
          exception_date: e.exception_date,
          is_working: !!e.is_working,
          start_time: e.is_working ? (e.start_time || null) : null,
          end_time: e.is_working ? (e.end_time || null) : null,
          notes: e.notes || null,
        }))
      );
      alert('Excepciones guardadas.');
    } catch (e) {
      setCalendarErr(e?.response?.data?.error || e.message);
    } finally {
      setSaving(false);
    }
  };

  const updateStandard = (stageKey, patch) => {
    setStandards((prev) => prev.map((s) => (s.stage_key === stageKey ? { ...s, ...patch } : s)));
  };

  const onSaveStandards = async () => {
    setErr('');
    try {
      setSavingStandards(true);
      await saveSchedulingStandard(
        line,
        standards.map((s) => ({
          stage_key: s.stage_key,
          standard_minutes: Number(s.standard_minutes) || 0,
          notes: s.notes || null,
        }))
      );
      alert('Estándares guardados.');
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setSavingStandards(false);
    }
  };

  const onCreateResource = async () => {
    setResourceErr('');
    const key = newResource.resource_key.trim();
    if (!key) return;
    setSavingResource(true);
    try {
      await saveSchedulingResource({
        resource_key: key,
        label: newResource.label.trim() || null,
        parallel_capacity: Number(newResource.parallel_capacity) || 1,
        enabled: true,
      });
      setNewResource({ resource_key: '', label: '', parallel_capacity: 1 });
      const res = await getSchedulingResources();
      setResources(res.resources || []);
    } catch (e) {
      setResourceErr(e?.response?.data?.error || e.message);
    } finally {
      setSavingResource(false);
    }
  };

  const onUpdateResource = async (resource) => {
    setResourceErr('');
    setSavingResource(true);
    try {
      await saveSchedulingResource(resource);
      const res = await getSchedulingResources();
      setResources(res.resources || []);
    } catch (e) {
      setResourceErr(e?.response?.data?.error || e.message);
    } finally {
      setSavingResource(false);
    }
  };

  const onDeleteResource = async (resourceKey) => {
    if (!window.confirm(`¿Borrar el recurso "${resourceKey}"? Falla si todavía hay etapas mapeadas a él.`)) return;
    setResourceErr('');
    setSavingResource(true);
    try {
      await deleteSchedulingResource(resourceKey);
      const res = await getSchedulingResources();
      setResources(res.resources || []);
    } catch (e) {
      setResourceErr(e?.response?.data?.error || e.message);
    } finally {
      setSavingResource(false);
    }
  };

  const updateStageResource = (stageKey, resourceKey) => {
    setStageResourceMap((prev) => {
      const next = { ...prev };
      if (resourceKey) next[stageKey] = resourceKey;
      else delete next[stageKey];
      return next;
    });
  };

  const onSaveStageResourceMap = async () => {
    setResourceErr('');
    setSavingStageResource(true);
    try {
      const mappings = Object.entries(stageResourceMap)
        .filter(([, resourceKey]) => resourceKey)
        .map(([stageKey, resourceKey]) => ({ stage_key: stageKey, resource_key: resourceKey }));
      await saveSchedulingStageResource(line, mappings);
      alert('Mapeo etapa → recurso guardado.');
    } catch (e) {
      setResourceErr(e?.response?.data?.error || e.message);
    } finally {
      setSavingStageResource(false);
    }
  };

  const runPreview = async () => {
    setPreviewErr('');
    setPreviewLoading(true);
    try {
      const data = await getSchedulingPreview(line, 30);
      setPreview(data);
    } catch (e) {
      setPreviewErr(e?.response?.data?.error || e.message);
    } finally {
      setPreviewLoading(false);
    }
  };

  const runRegression = async () => {
    setRegressionErr('');
    setRegressionLoading(true);
    try {
      const id = portonIdInput.trim();
      const data = await getSchedulingRegressionPreview(line, id ? { porton_id: id, flow } : { limit: 20, mode: fleetMode, flow });
      setRegression(data);
    } catch (e) {
      setRegressionErr(e?.response?.data?.error || e.message);
    } finally {
      setRegressionLoading(false);
    }
  };

  const saveLogisticaDate = async () => {
    const id = portonIdInput.trim();
    if (!id) return;
    setSavingLogisticaDate(true);
    setRegressionErr('');
    try {
      await setFechaDespachoLogistica(id, logisticaDateInput.trim() || null);
      await runRegression();
    } catch (e) {
      setRegressionErr(e?.response?.data?.error || e.message);
    } finally {
      setSavingLogisticaDate(false);
    }
  };

  const logout = () => {
    clearAdminToken();
    nav('/admin/login', { replace: true });
  };

  if (loading) return <div className="container">Cargando motor de reglas de tiempo…</div>;

  return (
    // "Escapa" del `.container` (max-width 1440px) que envuelve esta página
    // vía NonProductionLayout, compartido con el resto de /admin/* — no se
    // toca ese layout. A diferencia del Gantt (que sí quiere el viewport
    // completo para la línea de tiempo), acá el contenido es formularios en
    // grilla: un ancho infinito los deja demasiado espaciados/desalineados,
    // así que se centra con un tope generoso (1700px) en vez de ir a los
    // bordes reales.
    <div style={{ width: '100vw', position: 'relative', left: '50%', marginLeft: '-50vw', boxSizing: 'border-box' }}>
    <div style={{ maxWidth: 1700, margin: '0 auto', padding: '16px 20px', boxSizing: 'border-box' }}>
      <div className="header-row" style={{ alignItems: 'center' }}>
        <h2 className="h1">Motor de Reglas de Tiempo (Beta)</h2>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn" to="/admin">Volver</Link>
          <Link className="btn" to="/">Inicio</Link>

          <select className="btn" value={line} onChange={(e) => setLine(e.target.value)}>
            <option value="portones">Portones</option>
            <option value="ipanel">iPanels</option>
          </select>

          <button className="btn" onClick={reload}>Refrescar</button>
          <button className="btn" onClick={logout}>Salir</button>
        </div>
      </div>

      <div style={{ marginTop: 12, fontSize: 13, opacity: 0.75 }}>
        Modo sombra: nada de acá cambia lo que ve el tablero (<code>/board</code>) todavía — es solo
        cálculo y comparación. El tiempo efectivo de cada etapa sale de dos fases: primero se suman las
        reglas <b>independientes</b> contra el estándar puro, y ese resultado es el punto de partida para
        encadenar las reglas de <b>cascada</b>, en orden.
      </div>

      {err && <div style={{ color: 'crimson', fontWeight: 800, marginTop: 10 }}>{err}</div>}

      {/* ===== Estándares por etapa ===== */}
      <section style={{ marginTop: 20, border: '1px solid var(--border)', borderRadius: 12, padding: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ fontWeight: 900, fontSize: 16 }}>Tiempo estándar por etapa</div>
          <button className="btn btn--brand" onClick={onSaveStandards} disabled={savingStandards}>
            {savingStandards ? 'Guardando…' : 'Guardar estándares'}
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          {standards.map((s) => (
            <div
              key={s.stage_key}
              style={{ display: 'grid', gridTemplateColumns: '1.2fr .8fr 2fr', gap: 8, alignItems: 'center' }}
            >
              <div>
                <b>{s.stage_key}</b>
              </div>
              <input
                className="btn"
                type="number"
                min="0"
                value={s.standard_minutes}
                onChange={(e) => updateStandard(s.stage_key, { standard_minutes: e.target.value })}
                placeholder="minutos"
              />
              <input
                className="btn"
                value={s.notes || ''}
                onChange={(e) => updateStandard(s.stage_key, { notes: e.target.value })}
                placeholder="Notas del perfil de referencia (ej. Coplanar, chapa lisa, 2000x2200mm)"
              />
            </div>
          ))}
        </div>
      </section>

      {/* ===== Reglas de desvío — navegación dedicada (por sección / por tipo de variante) ===== */}
      <section style={{ marginTop: 20, border: '1px solid var(--border)', borderRadius: 12, padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: 16 }}>Reglas de desvío</div>
          <div style={{ fontSize: 13, opacity: 0.75, marginTop: 2 }}>
            {rules.length} regla{rules.length === 1 ? '' : 's'} cargada{rules.length === 1 ? '' : 's'} — navegable por sección o por tipo de variante.
          </div>
        </div>
        <Link className="btn btn--brand" to="/admin/scheduling/reglas">Abrir Reglas de Desvío</Link>
      </section>

      {/* ===== Recursos físicos compartidos (Fase 3) ===== */}
      <section style={{ marginTop: 20, border: '1px solid var(--border)', borderRadius: 12, padding: 12 }}>
        <div style={{ fontWeight: 900, fontSize: 16 }}>Recursos físicos compartidos entre etapas</div>
        <div style={{ fontSize: 13, opacity: 0.75, marginTop: 4 }}>
          Sin mapeo, cada etapa usa su propio cupo (una máquina por etapa). Agrupar dos etapas bajo el
          mismo recurso (ej. Cortadora = guillotina + corte_revest) hace que compitan por el mismo cupo
          diario en la Regresión — incluido dentro de un mismo portón, si sus dos etapas caen el mismo día.
        </div>
        {resourceErr && <div style={{ color: 'crimson', marginTop: 8 }}>{resourceErr}</div>}

        <div style={{ marginTop: 14, fontWeight: 800, fontSize: 14 }}>Catálogo de recursos</div>
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: 6 }}>resource_key</th>
                <th style={{ textAlign: 'left', padding: 6 }}>Label</th>
                <th style={{ textAlign: 'right', padding: 6 }}>Paralelismo</th>
                <th style={{ textAlign: 'center', padding: 6 }}>Activo</th>
                <th style={{ padding: 6 }} />
              </tr>
            </thead>
            <tbody>
              {resources.map((r) => (
                <tr key={r.resource_key} style={{ borderTop: '1px solid #eee' }}>
                  <td style={{ padding: 6 }}><code>{r.resource_key}</code></td>
                  <td style={{ padding: 6 }}>
                    <input
                      className="btn"
                      value={r.label || ''}
                      onChange={(e) => setResources((prev) => prev.map((x) => (x.resource_key === r.resource_key ? { ...x, label: e.target.value } : x)))}
                    />
                  </td>
                  <td style={{ padding: 6, textAlign: 'right' }}>
                    <input
                      className="btn"
                      type="number"
                      min="1"
                      style={{ width: 70 }}
                      value={r.parallel_capacity}
                      onChange={(e) => setResources((prev) => prev.map((x) => (x.resource_key === r.resource_key ? { ...x, parallel_capacity: e.target.value } : x)))}
                    />
                  </td>
                  <td style={{ padding: 6, textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={r.enabled !== false}
                      onChange={(e) => setResources((prev) => prev.map((x) => (x.resource_key === r.resource_key ? { ...x, enabled: e.target.checked } : x)))}
                    />
                  </td>
                  <td style={{ padding: 6, display: 'flex', gap: 6 }}>
                    <button className="btn" disabled={savingResource} onClick={() => onUpdateResource(r)}>Guardar</button>
                    <button className="btn" disabled={savingResource} onClick={() => onDeleteResource(r.resource_key)}>Borrar</button>
                  </td>
                </tr>
              ))}
              <tr style={{ borderTop: '1px solid #eee' }}>
                <td style={{ padding: 6 }}>
                  <input
                    className="btn"
                    value={newResource.resource_key}
                    onChange={(e) => setNewResource((p) => ({ ...p, resource_key: e.target.value }))}
                    placeholder="ej. cortadora"
                  />
                </td>
                <td style={{ padding: 6 }}>
                  <input
                    className="btn"
                    value={newResource.label}
                    onChange={(e) => setNewResource((p) => ({ ...p, label: e.target.value }))}
                    placeholder="ej. Cortadora"
                  />
                </td>
                <td style={{ padding: 6, textAlign: 'right' }}>
                  <input
                    className="btn"
                    type="number"
                    min="1"
                    style={{ width: 70 }}
                    value={newResource.parallel_capacity}
                    onChange={(e) => setNewResource((p) => ({ ...p, parallel_capacity: e.target.value }))}
                  />
                </td>
                <td />
                <td style={{ padding: 6 }}>
                  <button className="btn btn--brand" disabled={savingResource || !newResource.resource_key.trim()} onClick={onCreateResource}>
                    + Agregar
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 18 }}>
          <div style={{ fontWeight: 800, fontSize: 14 }}>Mapeo etapa → recurso ({line})</div>
          <button className="btn btn--brand" disabled={savingStageResource} onClick={onSaveStageResourceMap}>
            {savingStageResource ? 'Guardando…' : 'Guardar mapeo'}
          </button>
        </div>
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: 6 }}>Etapa</th>
                <th style={{ textAlign: 'left', padding: 6 }}>Recurso</th>
              </tr>
            </thead>
            <tbody>
              {stageOptions.map((s) => (
                <tr key={s.key} style={{ borderTop: '1px solid #eee' }}>
                  <td style={{ padding: 6 }}>{s.label} <span style={{ opacity: 0.6 }}>({s.key})</span></td>
                  <td style={{ padding: 6 }}>
                    <select
                      className="btn"
                      value={stageResourceMap[s.key] || ''}
                      onChange={(e) => updateStageResource(s.key, e.target.value)}
                    >
                      <option value="">— por defecto ({s.key})</option>
                      {resources.map((r) => (
                        <option key={r.resource_key} value={r.resource_key}>{r.label || r.resource_key}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ===== Variables de recurso (Fase 3b) ===== */}
      <section style={{ marginTop: 20, border: '1px solid var(--border)', borderRadius: 12, padding: 12 }}>
        <div style={{ fontWeight: 900, fontSize: 16 }}>Variables de recurso</div>
        <div style={{ fontSize: 13, opacity: 0.75, marginTop: 4 }}>
          Atributos más o menos permanentes de una sección/máquina (ej. "nivel de personal", "máquina") —
          no del portón, y no de un día puntual (para eso está el Calendario, más abajo). Se suman al
          contexto de las etapas mapeadas a este recurso, y quedan disponibles como "campo" al armar una
          regla en <Link to="/admin/scheduling/reglas">Reglas de Desvío</Link>.
        </div>
        {variablesErr && <div style={{ color: 'crimson', marginTop: 8 }}>{variablesErr}</div>}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>Recurso:</span>
          <select className="btn" value={variablesResourceKey} onChange={(e) => setVariablesResourceKey(e.target.value)}>
            <option value="">— elegir —</option>
            {resources.map((r) => (
              <option key={r.resource_key} value={r.resource_key}>{r.label || r.resource_key}</option>
            ))}
          </select>
          {!resources.length && <span style={{ fontSize: 12, opacity: 0.7 }}>Cargá un recurso en "Recursos físicos compartidos" arriba primero.</span>}
          {variablesLoading && <span style={{ fontSize: 12, opacity: 0.7 }}>Cargando…</span>}
        </div>

        {!!variablesResourceKey && (
          <>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button className="btn" onClick={addVariable}>+ Agregar variable</button>
              <button className="btn btn--brand" disabled={savingVariables} onClick={onSaveVariables}>
                {savingVariables ? 'Guardando…' : 'Guardar variables'}
              </button>
            </div>
            {!resourceVariables.length && (
              <div style={{ fontSize: 13, opacity: 0.7, marginTop: 8 }}>Sin variables cargadas para {variablesResourceKey} todavía.</div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
              {resourceVariables.map((v) => (
                <div key={v._localId} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.2fr 1.2fr auto', gap: 8, alignItems: 'center' }}>
                  <input className="btn" value={v.key} onChange={(e) => updateVariable(v._localId, { key: e.target.value })} placeholder="key (ej. nivel_personal)" />
                  <input className="btn" value={v.value} onChange={(e) => updateVariable(v._localId, { value: e.target.value })} placeholder="valor (ej. junior)" />
                  <input className="btn" value={v.label} onChange={(e) => updateVariable(v._localId, { label: e.target.value })} placeholder="Etiqueta (ej. Nivel de personal)" />
                  <input className="btn" value={v.notes} onChange={(e) => updateVariable(v._localId, { notes: e.target.value })} placeholder="Notas" />
                  <button className="btn" type="button" onClick={() => removeVariable(v._localId)}>Quitar</button>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {/* ===== Calendario laboral por recurso (Fase 2a, sin UI hasta ahora) ===== */}
      <section style={{ marginTop: 20, border: '1px solid var(--border)', borderRadius: 12, padding: 12 }}>
        <div style={{ fontWeight: 900, fontSize: 16 }}>Calendario laboral por recurso</div>
        <div style={{ fontSize: 13, opacity: 0.75, marginTop: 4 }}>
          Sin cargar nada, un recurso usa el default Lunes a Viernes 08:00–18:00. Acá se puede cargar un
          calendario propio (turnos partidos incluidos) y excepciones puntuales (feriados) por recurso o de
          planta completa.
        </div>
        {calendarErr && <div style={{ color: 'crimson', marginTop: 8 }}>{calendarErr}</div>}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>Recurso:</span>
          <select className="btn" value={calendarResourceKey} onChange={(e) => setCalendarResourceKey(e.target.value)}>
            <option value="">— elegir —</option>
            {resources.map((r) => (
              <option key={r.resource_key} value={r.resource_key}>{r.label || r.resource_key}</option>
            ))}
          </select>
          {!resources.length && (
            <span style={{ fontSize: 12, opacity: 0.7 }}>
              Todavía no hay recursos en el catálogo — cargá uno en "Recursos físicos compartidos" arriba
              (una etapa cualquiera también sirve como recurso propio, usando su mismo stage_key).
            </span>
          )}
          {calendarLoading && <span style={{ fontSize: 12, opacity: 0.7 }}>Cargando…</span>}
        </div>

        {!!calendarResourceKey && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 18 }}>
              <div style={{ fontWeight: 800, fontSize: 14 }}>Turnos semanales — {calendarResourceKey}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn" onClick={loadDefaultShifts} title="Reemplaza la tabla por Lun-Vie 08:00-18:00 (sin guardar todavía)">
                  Cargar Lun-Vie 08–18
                </button>
                <button className="btn" onClick={addShift}>+ Agregar turno</button>
                <button className="btn btn--brand" disabled={savingCalendar} onClick={onSaveCalendar}>
                  {savingCalendar ? 'Guardando…' : 'Guardar turnos'}
                </button>
              </div>
            </div>

            {calendarShifts.length === 0 && (
              <div style={{ fontSize: 13, opacity: 0.7, marginTop: 8 }}>
                Sin turnos cargados — este recurso está usando el default Lun-Vie 08:00–18:00.
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
              {calendarShifts.map((s) => (
                <div key={s._localId} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto auto', gap: 8, alignItems: 'center' }}>
                  <select className="btn" value={s.weekday} onChange={(e) => updateShift(s._localId, { weekday: e.target.value })}>
                    {WEEKDAYS.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
                  </select>
                  <input className="btn" type="time" value={s.start_time?.slice(0, 5) || ''} onChange={(e) => updateShift(s._localId, { start_time: e.target.value })} />
                  <input className="btn" type="time" value={s.end_time?.slice(0, 5) || ''} onChange={(e) => updateShift(s._localId, { end_time: e.target.value })} />
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                    <input type="checkbox" checked={s.enabled !== false} onChange={(e) => updateShift(s._localId, { enabled: e.target.checked })} />
                    Activo
                  </label>
                  <button className="btn" type="button" onClick={() => removeShift(s._localId)}>Quitar</button>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 22 }}>
              <div style={{ fontWeight: 800, fontSize: 14 }}>Excepciones de {calendarResourceKey}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn" onClick={() => addException(setCalendarExceptions)}>+ Agregar excepción</button>
                <button className="btn btn--brand" disabled={savingCalendarExceptions} onClick={() => saveExceptions(calendarResourceKey, calendarExceptions, setSavingCalendarExceptions)}>
                  {savingCalendarExceptions ? 'Guardando…' : 'Guardar excepciones'}
                </button>
              </div>
            </div>
            <ExceptionsTable rows={calendarExceptions} onRemove={(id) => removeException(setCalendarExceptions, id)} onUpdate={(id, patch) => updateException(setCalendarExceptions, id, patch)} />
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 26, borderTop: '1px dashed #d1d5db', paddingTop: 14 }}>
          <div style={{ fontWeight: 800, fontSize: 14 }}>Feriados de planta completa (todos los recursos)</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {globalExceptionsLoading && <span style={{ fontSize: 12, opacity: 0.7, alignSelf: 'center' }}>Cargando…</span>}
            <button className="btn" onClick={() => addException(setGlobalExceptions)}>+ Agregar feriado</button>
            <button className="btn btn--brand" disabled={savingGlobalExceptions} onClick={() => saveExceptions(null, globalExceptions, setSavingGlobalExceptions)}>
              {savingGlobalExceptions ? 'Guardando…' : 'Guardar feriados'}
            </button>
          </div>
        </div>
        <ExceptionsTable rows={globalExceptions} onRemove={(id) => removeException(setGlobalExceptions, id)} onUpdate={(id, patch) => updateException(setGlobalExceptions, id, patch)} />
      </section>

      {/* ===== Preview: calculado vs. real ===== */}
      <section style={{ marginTop: 20, border: '1px solid var(--border)', borderRadius: 12, padding: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ fontWeight: 900, fontSize: 16 }}>Preview: calculado vs. real</div>
          <button className="btn btn--brand" onClick={runPreview} disabled={previewLoading || line !== 'portones'}>
            {previewLoading ? 'Calculando…' : 'Correr preview (últimos 30 portones)'}
          </button>
        </div>

        {line !== 'portones' && (
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>
            El preview de esta fase solo soporta la línea Portones.
          </div>
        )}
        {previewErr && <div style={{ color: 'crimson', marginTop: 8 }}>{previewErr}</div>}
        {preview?.warning && <div style={{ opacity: 0.7, marginTop: 8 }}>{preview.warning}</div>}

        {preview?.portones?.length > 0 && (
          <div style={{ overflowX: 'auto', marginTop: 12 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: 6 }}>NV</th>
                  <th style={{ textAlign: 'left', padding: 6 }}>Etapa</th>
                  <th style={{ textAlign: 'right', padding: 6 }}>Estándar</th>
                  <th style={{ textAlign: 'right', padding: 6 }}>Efectivo (calc.)</th>
                  <th style={{ textAlign: 'right', padding: 6 }}>Real</th>
                  <th style={{ textAlign: 'right', padding: 6 }}>Delta</th>
                </tr>
              </thead>
              <tbody>
                {preview.portones.flatMap((p) =>
                  p.stages.map((s) => (
                    <tr key={`${p.id}-${s.stage_key}`} style={{ borderTop: '1px solid #eee' }}>
                      <td style={{ padding: 6 }}>{p.nv}</td>
                      <td style={{ padding: 6 }}>{s.stage_key}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{s.standard_minutes}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{s.effective_minutes}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{s.real_minutes ?? '—'}</td>
                      <td style={{ padding: 6, textAlign: 'right', fontWeight: s.delta_vs_real != null && Math.abs(s.delta_vs_real) > 30 ? 800 : 400 }}>
                        {s.delta_vs_real ?? '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ===== Regresión: backward-pass desde fecha_plan_entrega (Fase 2a) ===== */}
      <section style={{ marginTop: 20, border: '1px solid var(--border)', borderRadius: 12, padding: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ fontWeight: 900, fontSize: 16 }}>Regresión (calcular hacia atrás desde la fecha de despacho)</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              className="btn"
              style={{ width: 140 }}
              value={portonIdInput}
              onChange={(e) => setPortonIdInput(e.target.value)}
              placeholder="ID de portón (vacío = últimos 20 con fecha)"
            />
            {!portonIdInput.trim() && (
              <select className="btn" value={fleetMode} onChange={(e) => setFleetMode(e.target.value)} title="Cómo se reparte el cupo entre portones">
                <option value="fleet">Flota (cupo compartido)</option>
                <option value="isolated">Aislado (capacidad infinita, depuración)</option>
              </select>
            )}
            <select className="btn" value={flow} onChange={(e) => setFlow(e.target.value)} title="Fecha ancla del cálculo">
              <option value="presupuesto">Flujo Presupuesto</option>
              <option value="logistica">Flujo Logística</option>
            </select>
            <button className="btn btn--brand" onClick={runRegression} disabled={regressionLoading || line !== 'portones'}>
              {regressionLoading ? 'Calculando…' : 'Calcular'}
            </button>
          </div>
        </div>

        {line !== 'portones' && (
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>
            La regresión de esta fase solo soporta la línea Portones.
          </div>
        )}
        {portonIdInput.trim() && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, opacity: 0.75 }}>Fecha de despacho — Flujo Logística:</span>
            <input
              className="btn"
              type="date"
              style={{ width: 160 }}
              value={logisticaDateInput}
              onChange={(e) => setLogisticaDateInput(e.target.value)}
            />
            <button className="btn" onClick={saveLogisticaDate} disabled={savingLogisticaDate}>
              {savingLogisticaDate ? 'Guardando…' : 'Guardar'}
            </button>
            <span style={{ fontSize: 12, opacity: 0.6 }}>Vacío = usa la fecha del Presupuesto.</span>
          </div>
        )}
        {regression?.mode === 'fleet' && (
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>
            Modo flota: los portones compiten por el cupo diario real de cada recurso. Dos portones pueden mostrar
            horarios que se superponen dentro del mismo día — lo garantizado es que la suma de minutos por día no
            supera el cupo, no un orden de cola exacto dentro del día.
          </div>
        )}
        {regressionErr && <div style={{ color: 'crimson', marginTop: 8 }}>{regressionErr}</div>}

        {regressionPortones.map((p) => {
          const stages = p.stages ? Object.values(p.stages).sort((a, b) => new Date(a.latest_start) - new Date(b.latest_start)) : [];
          return (
            <div key={p.id} style={{ marginTop: 16, borderTop: '1px dashed #d1d5db', paddingTop: 12 }}>
              <div style={{ fontWeight: 800 }}>
                Portón {p.nv ?? p.id} <span style={{ opacity: 0.7, fontWeight: 400 }}>({p.sistema || 'sin sistema'})</span>
              </div>
              {p.warning && <div style={{ opacity: 0.7, fontSize: 13, marginTop: 4 }}>{p.warning}</div>}
              {p.error && <div style={{ color: 'crimson', fontSize: 13, marginTop: 4 }}>{p.error}</div>}
              {!!p.warnings?.length && (
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                  {p.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
                </div>
              )}
              {!!stages.length && (
                <div style={{ overflowX: 'auto', marginTop: 8 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', padding: 6 }}>Etapa</th>
                        <th style={{ textAlign: 'left', padding: 6 }}>Debe entrar</th>
                        <th style={{ textAlign: 'left', padding: 6 }}>Debe salir</th>
                        <th style={{ textAlign: 'right', padding: 6 }}>Min.</th>
                        <th style={{ textAlign: 'left', padding: 6 }}>Recurso</th>
                        <th style={{ textAlign: 'left', padding: 6 }}>Predecesores</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stages.map((s) => {
                        const atRisk = new Date(s.latest_start).getTime() < Date.now();
                        return (
                          <tr key={s.stage_key} style={{ borderTop: '1px solid #eee' }}>
                            <td style={{ padding: 6 }}>{s.stage_key}</td>
                            <td style={{ padding: 6, fontWeight: atRisk ? 800 : 400, color: atRisk ? 'crimson' : 'inherit' }}>
                              {fmtArDateTime(s.latest_start)} {atRisk ? '⚠' : ''}
                            </td>
                            <td style={{ padding: 6 }}>{fmtArDateTime(s.latest_finish)}</td>
                            <td style={{ padding: 6, textAlign: 'right' }}>{s.effective_minutes}</td>
                            <td style={{ padding: 6 }}>
                              {s.resource_key}
                              {s.resource_constrained && (
                                <span title="Se corrió por falta de cupo compartido con otro portón" style={{ marginLeft: 6, color: '#b45309' }}>
                                  ⏳
                                </span>
                              )}
                            </td>
                            <td style={{ padding: 6, opacity: 0.7 }}>{(s.predecessors || []).join(', ') || '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}

        {!!regression?.ledger_summary?.length && (
          <details style={{ marginTop: 16 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 800, fontSize: 13 }}>
              Cupo por recurso y día ({regression.ledger_summary.length})
            </summary>
            <div style={{ overflowX: 'auto', marginTop: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: 6 }}>Recurso</th>
                    <th style={{ textAlign: 'left', padding: 6 }}>Fecha</th>
                    <th style={{ textAlign: 'right', padding: 6 }}>Capacidad</th>
                    <th style={{ textAlign: 'right', padding: 6 }}>Consumido</th>
                    <th style={{ textAlign: 'right', padding: 6 }}>Restante</th>
                  </tr>
                </thead>
                <tbody>
                  {regression.ledger_summary.map((row) => (
                    <tr key={`${row.resource_key}-${row.date_key}`} style={{ borderTop: '1px solid #eee' }}>
                      <td style={{ padding: 6 }}>{row.resource_key}</td>
                      <td style={{ padding: 6 }}>{row.date_key}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{row.capacity_minutes}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{row.consumed_minutes}</td>
                      <td style={{ padding: 6, textAlign: 'right', fontWeight: row.remaining_minutes <= 0 ? 800 : 400 }}>{row.remaining_minutes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </section>
    </div>
    </div>
  );
}
