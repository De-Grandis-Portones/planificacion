// pages/admin/AdminExcelInfoPage.jsx
import { useEffect, useMemo, useRef, useState } from 'react';
import usePortones from '../../src/hooks/usePortones';
import useIpanels from '../../src/hooks/useIpanels';
import InformeSemanalPortones from '../../src/components/InformeSemanalPortones';
import { isoWeekLabelFromDate, weekNumberFromLabel } from '../../src/utils/isoWeek';

const fmtDateTime = (dt) => (dt ? new Date(dt).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '');
const dateOnly = (v) => (v ? String(v).slice(0, 10) : '');

// El Presupuestador reserva un intervalo de dos semanas (production_delivery_week_start/_end)
// y le muestra ese rango al cliente como "Fin de producción estimada". Acá tomamos solo la
// primera semana del intervalo (_start), que es la que efectivamente se comprometió.
const semanaPrometida = (r) => weekNumberFromLabel(isoWeekLabelFromDate(r.production_delivery_week_start));

const PORTON_STAGES = [
  { key: 'diseno', label: 'Diseño Tubos' },
  { key: 'diseno_piernas', label: 'Diseño Piernas' },
  { key: 'diseno_revestimiento', label: 'Diseño Revestimiento' },
  { key: 'laser_dintel', label: 'Laser tubos Dintel' },
  { key: 'laser_hojas', label: 'Laser tubos Hojas' },
  { key: 'laser_brazos_espada', label: 'Laser tubos Brazos y Espada' },
  { key: 'guillotina', label: 'Corte (Piernas)' },
  { key: 'corte_revest', label: 'Corte (Revestimiento)' },
  { key: 'plegadora', label: 'Plegado (Piernas)' },
  { key: 'plegado_revest', label: 'Plegado (Revestimiento)' },
  { key: 'armado_piernas', label: 'Armado Piernas' },
  { key: 'armado_marco_piernas', label: 'Armado Marco Piernas' },
  { key: 'armado_hojas', label: 'Armado Hojas' },
  { key: 'armado_primario', label: 'Armado Primario' },
  { key: 'inyeccion', label: 'Inyección' },
  { key: 'revestimiento', label: 'Revestimiento' },
  { key: 'pintura', label: 'Pintura' },
  { key: 'pintura_revestimiento', label: 'Pintura (Revestimiento)' },
  { key: 'armado_final', label: 'Armado Final' },
  { key: 'despacho', label: 'Despacho' },
];

const IPANEL_STAGES = [
  { key: 'diseno', label: 'Diseño' },
  { key: 'guillotina', label: 'Corte' },
  { key: 'plegado', label: 'Plegado' },
  { key: 'pintura', label: 'Pintura' },
  { key: 'inyeccion', label: 'Inyección' },
  { key: 'despacho', label: 'Despacho' },
];

// nota: "Fecha Plan Entrega" existió acá pero se sacó (2026-08-27) porque para
// Portones nunca se carga (ningún flujo la escribe) y, si se cargara, sería
// redundante con "Fecha Salida (Plan)". En iPanel sí es un dato real y
// distinto (se sincroniza desde Presupuestador), por eso ahí se mantiene.
const PORTON_BASE_FIELDS = [
  { key: 'nv', label: 'NV', get: (r) => r.nv ?? '', hint: 'Número de venta: identifica el pedido en Presupuestador y en Planta.' },
  { key: 'nlista', label: 'N° Portón (Lista)', get: (r) => r.nlista ?? '', hint: 'Número de portón dentro del pedido. Puede repetir el NV cuando hay más de un portón por pedido (por ejemplo, en refabricaciones).' },
  { key: 'partida', label: 'Partida', get: (r) => r.partida ?? '', hint: 'Número de partida de producción asignado al portón.' },
  { key: 'nv_tipo', label: 'Tipo NV', get: (r) => r.nv_tipo ?? '', hint: 'Prefijo de origen del NV en Presupuestador: vacío = Portón, PNV = Puerta, INV = iPanel, ONV = Otros, PLNV = Plegado.' },
  { key: 'nombre_cliente', label: 'Nombre Cliente', get: (r) => r.nombre_cliente ?? '', hint: 'Nombre del cliente final del pedido.' },
  { key: 'fecha_aprobacion_cliente', label: 'Fecha Aprobación Cliente', get: (r) => fmtDateTime(r.fecha_aprobacion_cliente), hint: 'Fecha en que el cliente aprobó la medición final en Presupuestador.' },
  { key: 'semana_prometida', label: 'Semana Prometida', get: semanaPrometida, hint: 'Primera semana del intervalo de producción que el Presupuestador le mostró al cliente en su link (production_delivery_week_start).' },
  { key: 'fecha_nv', label: 'Fecha NV', get: (r) => dateOnly(r.fecha_nv), hint: 'Fecha en que se generó el NV en Presupuestador.' },
  { key: 'fecha_prod', label: 'Fecha Producción', get: (r) => dateOnly(r.fecha_prod), hint: 'Fecha planificada de inicio de producción en planta.' },
  { key: 'fecha_plan', label: 'Fecha Salida (Plan)', get: (r) => dateOnly(r.fecha_plan), hint: 'Fecha planificada de salida/despacho del portón.' },
  { key: 'fecha_med', label: 'Fecha Medición', get: (r) => dateOnly(r.fecha_med), hint: 'Fecha en que se realizó la medición del portón.' },
  { key: 'sistema', label: 'Sistema', get: (r) => r.sistema ?? '', hint: 'Sistema constructivo del portón (Coplanar, Común, etc.).' },
  { key: 'tipo', label: 'Tipo', get: (r) => r.tipo ?? '', hint: 'Tipo de portón.' },
  { key: 'created_at', label: 'Fecha de creación', get: (r) => fmtDateTime(r.created_at), hint: 'Fecha en que se creó el registro del portón en Planificación Planta.' },
  { key: 'revision_ok', label: 'Revisión OK', get: (r) => (r.revision_ok == null ? '' : (r.revision_ok ? 'Sí' : 'No')), hint: 'Indica si un portón con observación de calidad fue revisado y aprobado para seguir sin refabricar (pantalla de Refabricación).' },
  { key: 'revision_ok_at', label: 'Fecha revisión', get: (r) => fmtDateTime(r.revision_ok_at), hint: 'Fecha en que se marcó esa revisión como aprobada.' },
  { key: 'observaciones', label: 'Observaciones', get: (r) => r.observaciones ?? '', hint: 'Observaciones cargadas para el portón.' },
];

const IPANEL_BASE_FIELDS = [
  { key: 'nv', label: 'NV', get: (r) => r.nv ?? '', hint: 'Número de venta: identifica el pedido en Presupuestador y en Planta.' },
  { key: 'partida', label: 'Partida', get: (r) => r.partida ?? '', hint: 'Número de partida de producción asignado.' },
  { key: 'fecha_nv', label: 'Fecha NV', get: (r) => dateOnly(r.fecha_nv), hint: 'Fecha en que se generó el NV en Presupuestador.' },
  { key: 'fecha_prod', label: 'Fecha Producción', get: (r) => dateOnly(r.fecha_prod), hint: 'Fecha planificada de inicio de producción.' },
  { key: 'fecha_plan', label: 'Fecha Salida (Plan)', get: (r) => dateOnly(r.fecha_plan), hint: 'Fecha planificada de salida/despacho.' },
  { key: 'fecha_med', label: 'Fecha Medición', get: (r) => dateOnly(r.fecha_med), hint: 'Fecha en que se realizó la medición.' },
  { key: 'fecha_plan_entrega', label: 'Fecha Plan Entrega', get: (r) => dateOnly(r.fecha_plan_entrega), hint: 'Fecha comprometida de entrega al cliente, sincronizada desde Presupuestador.' },
  { key: 'descripcion', label: 'Descripción', get: (r) => r.descripcion ?? '', hint: 'Descripción completa del ítem de iPanel.' },
  { key: 'descripcion_simple', label: 'Descripción simple', get: (r) => r.descripcion_simple ?? '', hint: 'Descripción simplificada del ítem, pensada para mostrarse en planta.' },
  { key: 'observaciones', label: 'Observaciones', get: (r) => r.observaciones ?? '', hint: 'Observaciones cargadas para el ítem.' },
];

function buildStageFields(stages) {
  const out = [];
  for (const s of stages) {
    out.push({ key: `${s.key}__estado`, label: `${s.label} - Estado`, get: (r) => r[s.key] ?? '' });
    out.push({ key: `${s.key}__inicio`, label: `${s.label} - Inicio`, get: (r) => fmtDateTime(r[`${s.key}_inicio`]) });
    out.push({ key: `${s.key}__fin`, label: `${s.label} - Fin`, get: (r) => fmtDateTime(r[`${s.key}_fin`]) });
  }
  return out;
}

const SOURCES = {
  portones: { label: 'Portones', baseFields: PORTON_BASE_FIELDS, stages: PORTON_STAGES, fileTag: 'portones' },
  ipanel: { label: 'iPanel', baseFields: IPANEL_BASE_FIELDS, stages: IPANEL_STAGES, fileTag: 'ipanel' },
};

const STAGE_COLS = [
  { suf: 'estado', label: 'Estado' },
  { suf: 'inicio', label: 'Inicio' },
  { suf: 'fin', label: 'Fin' },
];

const STAGE_COLS_HINT = 'Estado: en qué paso está la etapa (Pendiente / En Proceso / Finalizado). Inicio / Fin: cuándo arrancó y cuándo terminó esa etapa para este ítem.';

// Botón "?" que al tocarlo muestra una reseña de qué representa el campo.
// Se cierra al tocar afuera o al tocarlo de nuevo.
function FieldHint({ text }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  if (!text) return null;

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Qué significa este campo"
        aria-label="Qué significa este campo"
        style={{
          width: 16, height: 16, borderRadius: '50%', border: '1px solid var(--border)',
          background: 'transparent', color: 'inherit', fontSize: 10, fontWeight: 800,
          lineHeight: '14px', padding: 0, cursor: 'pointer', opacity: 0.65,
        }}
      >
        ?
      </button>
      {open && (
        <div
          style={{
            position: 'absolute', top: '130%', left: 0, zIndex: 30,
            width: 240, padding: '8px 10px', borderRadius: 8,
            border: '1px solid var(--border)', background: 'var(--surface)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.18)', fontSize: 12, fontWeight: 400,
            lineHeight: 1.4,
          }}
        >
          {text}
        </div>
      )}
    </span>
  );
}

export default function AdminExcelInfoPage() {
  const [activeTab, setActiveTab] = useState('columnas'); // 'columnas' | 'semanal'
  const [source, setSource] = useState('portones');
  const [selectedKeys, setSelectedKeys] = useState(['nv']);

  const {
    data: portones, loading: loadingP, err: errP, refresh: refreshP, refreshing: refreshingP,
  } = usePortones({ pollMs: 0 });

  const {
    data: ipanels, loading: loadingI, err: errI, refresh: refreshI, refreshing: refreshingI,
  } = useIpanels({ pollMs: 0, onlyProduction: false });

  const cfg = SOURCES[source];
  const rows = source === 'portones' ? portones : ipanels;
  const loading = source === 'portones' ? loadingP : loadingI;
  const err = source === 'portones' ? errP : errI;
  const refreshing = source === 'portones' ? refreshingP : refreshingI;
  const refresh = source === 'portones' ? refreshP : refreshI;

  const stageFields = useMemo(() => buildStageFields(cfg.stages), [cfg]);
  const catalog = useMemo(() => [...cfg.baseFields, ...stageFields], [cfg, stageFields]);
  const fieldByKey = useMemo(() => {
    const m = new Map();
    for (const f of catalog) m.set(f.key, f);
    return m;
  }, [catalog]);

  const handleSourceChange = (next) => {
    if (next === source) return;
    setSource(next);
    setSelectedKeys(['nv']);
  };

  const toggleField = (key) => {
    setSelectedKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const removeField = (key) => {
    setSelectedKeys((prev) => prev.filter((k) => k !== key));
  };

  const moveField = (key, dir) => {
    setSelectedKeys((prev) => {
      const idx = prev.indexOf(key);
      if (idx === -1) return prev;
      const swapWith = idx + dir;
      if (swapWith < 0 || swapWith >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
      return next;
    });
  };

  async function handleGenerate() {
    if (!selectedKeys.length || !Array.isArray(rows) || rows.length === 0) return;

    const xlsxMod = await import('xlsx');
    const XLSX = xlsxMod.default || xlsxMod;

    const fields = selectedKeys.map((k) => fieldByKey.get(k)).filter(Boolean);
    const header = fields.map((f) => f.label);
    const dataRows = rows.map((r) => fields.map((f) => f.get(r)));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows]);
    ws['!cols'] = fields.map(() => ({ wch: 20 }));
    XLSX.utils.book_append_sheet(wb, ws, cfg.label);

    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const fname = `informacion_${cfg.fileTag}_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.xlsx`;
    XLSX.writeFile(wb, fname);
  }

  return (
    <div className="container" style={{ maxWidth: activeTab === 'semanal' ? 1700 : 1100 }}>
      <div className="header-row" style={{ alignItems: 'center' }}>
        <h2 className="h1">Información Excel</h2>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        <button
          type="button"
          className={`btn${activeTab === 'columnas' ? ' btn--brand' : ''}`}
          onClick={() => setActiveTab('columnas')}
        >
          Columnas personalizadas
        </button>
        <button
          type="button"
          className={`btn${activeTab === 'semanal' ? ' btn--brand' : ''}`}
          onClick={() => setActiveTab('semanal')}
        >
          Reporte semanal
        </button>
      </div>

      {activeTab === 'semanal' ? (
        <InformeSemanalPortones
          portones={portones}
          loading={loadingP}
          err={errP}
          refresh={refreshP}
          refreshing={refreshingP}
        />
      ) : (
        <>
          <div style={{ opacity: 0.75, marginTop: -6, marginBottom: 14 }}>
            Elegí qué columnas incluir (NV, fechas de cada etapa, etc.) y descargá un Excel con esa información.
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              {Object.entries(SOURCES).map(([key, s]) => (
                <button
                  key={key}
                  type="button"
                  className={`btn${source === key ? ' btn--brand' : ''}`}
                  onClick={() => handleSourceChange(key)}
                >
                  {s.label}
                </button>
              ))}
            </div>

            <button type="button" className="btn" onClick={refresh} disabled={refreshing}>
              {refreshing ? 'Actualizando…' : 'Refrescar datos'}
            </button>

            <span style={{ opacity: 0.7, fontSize: 13 }}>
              {loading ? 'Cargando…' : `${Array.isArray(rows) ? rows.length : 0} NV disponibles`}
            </span>
          </div>

          {err && <div style={{ color: 'crimson', marginBottom: 10 }}>Error: {err}</div>}

          <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 16, alignItems: 'start' }}>
            <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, background: 'var(--surface)' }}>
              <div style={{ fontWeight: 800, marginBottom: 10 }}>Campos disponibles</div>

              <div style={{ fontWeight: 700, fontSize: 13, opacity: 0.8, marginBottom: 6 }}>Datos generales</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 16 }}>
                {cfg.baseFields.map((f) => (
                  <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                      <input type="checkbox" checked={selectedKeys.includes(f.key)} onChange={() => toggleField(f.key)} />
                      {f.label}
                    </label>
                    <FieldHint text={f.hint} />
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <div style={{ fontWeight: 700, fontSize: 13, opacity: 0.8 }}>Etapas de producción</div>
                <FieldHint text={STAGE_COLS_HINT} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {cfg.stages.map((s) => (
                  <div
                    key={s.key}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
                      borderBottom: '1px dashed var(--border)', paddingBottom: 6,
                    }}
                  >
                    <div style={{ minWidth: 180, fontWeight: 600 }}>{s.label}</div>
                    {STAGE_COLS.map(({ suf, label }) => {
                      const key = `${s.key}__${suf}`;
                      return (
                        <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
                          <input type="checkbox" checked={selectedKeys.includes(key)} onChange={() => toggleField(key)} />
                          {label}
                        </label>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, background: 'var(--surface)', position: 'sticky', top: 12 }}>
              <div style={{ fontWeight: 800, marginBottom: 10 }}>Columnas seleccionadas (orden del Excel)</div>

              {selectedKeys.length === 0 && (
                <div style={{ opacity: 0.7, fontSize: 13, marginBottom: 10 }}>
                  Elegí campos de la izquierda para armar las columnas.
                </div>
              )}

              <ol style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 18, margin: 0 }}>
                {selectedKeys.map((key, i) => {
                  const f = fieldByKey.get(key);
                  if (!f) return null;
                  return (
                    <li key={key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ flex: 1 }}>{f.label}</span>
                      <button type="button" className="btn" onClick={() => moveField(key, -1)} disabled={i === 0} title="Subir">↑</button>
                      <button type="button" className="btn" onClick={() => moveField(key, 1)} disabled={i === selectedKeys.length - 1} title="Bajar">↓</button>
                      <button type="button" className="btn" onClick={() => removeField(key)} title="Quitar">✕</button>
                    </li>
                  );
                })}
              </ol>

              <button
                type="button"
                className="btn btn--brand"
                style={{ marginTop: 14, width: '100%' }}
                onClick={handleGenerate}
                disabled={!selectedKeys.length || loading || !Array.isArray(rows) || rows.length === 0}
              >
                Generar y descargar Excel
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
