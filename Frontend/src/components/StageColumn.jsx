import React, { useEffect, useMemo, useState } from 'react';
import { qcAuthorize, qcGetMotives, qcHistory, fetchNvLines } from '../api';
import NuevoPedidoPrefabricadoModal from './modals/NuevoPedidoPrefabricadoModal';
import { sectionLabel } from '../constants/sections';

const bordo = '#008241ff';
const cardBorder = '#1d4ed8';
const cardBg = '#e0f2fe';

// Ordenes de Servicio Técnico sin NV propio (numeración correlativa en vez
// de atadas a un portón): Orden Externa y Prueba Laser Plano.
const NO_NV_TIPOS = ['OE', 'PRUEBA'];

function low(v) {
  return String(v ?? '').toLowerCase();
}
function up(v) {
  return String(v ?? '').trim().toUpperCase();
}
function fmt(dt) {
  return dt
    ? new Date(dt).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })
    : '';
}
function mapModeToLine(mode) {
  return mode === 'ipanel' ? 'ipanel' : 'portones';
}
function toText(v) {
  return String(v ?? '').trim();
}
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
function firstDefined(item, keys = []) {
  for (const key of keys) {
    const value = item?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}
function displayValue(v, fallback = '—') {
  const s = String(v ?? '').trim();
  return s || fallback;
}
function isTruthySi(v) {
  if (v === true) return true;
  const s = String(v ?? '').trim().toLowerCase();
  return ['si', 'sí', 'true', '1', 'yes'].includes(s);
}

function getQcItemId(item, line) {
  if (line === 'prefabricados' || line === 'orden_externa' || line === 'prueba') {
    const num = Number(item?.numero);
    return Number.isInteger(num) ? num : null;
  }

  const nv = Number(item?.nv ?? item?.NV);
  if (Number.isInteger(nv)) return nv;

  if (line === 'portones') {
    const nl = Number(item?.nlista ?? item?.NLista);
    if (Number.isInteger(nl)) return nl;
  }
  const pa = Number(item?.partida ?? item?.PARTIDA);
  if (Number.isInteger(pa)) return pa;

  return null;
}

// Prefabricados/Servicio Técnico tienen su propia línea de QC (separada de
// portones), aunque visualmente compartan la columna de la sección.
function getItemQcLine(item) {
  if (item?.__kind === 'prefabricado') return 'prefabricados';
  if (item?.__kind === 'servicio_tecnico') {
    if (item?.tipo === 'OE') return 'orden_externa';
    if (item?.tipo === 'REFAB') return 'refabricado';
    if (item?.tipo === 'PRUEBA') return 'prueba';
    return 'servicio_tecnico';
  }
  return null;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}
function toISODate10(v) {
  if (!v) return '';
  const s = String(v).trim();

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;

  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;

  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;

  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;

  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    const yyyy = d.getFullYear();
    const mm = pad2(d.getMonth() + 1);
    const dd = pad2(d.getDate());
    return `${yyyy}-${mm}-${dd}`;
  }

  return '';
}
function formatDate10DMY(v) {
  const iso = toISODate10(v);
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}
function todayISO10Local() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function getProdDate10(item) {
  const raw =
    item?.fecha_prod ??
    item?.Fecha_Prod ??
    item?.fecha_produccion ??
    item?.Fecha_Produccion ??
    item?.inicio_prod ??
    item?.Inicio_Prod ??
    item?.inicio_prod_imput ??
    item?.Inicio_Prod_Imput ??
    null;
  return toISODate10(raw);
}
function getSalidaDate10(item) {
  // fecha_salida_imput (editada en /a) tiene prioridad sobre fecha_plan_entrega (fijada al crear)
  const raw =
    item?.fecha_salida_imput ??
    item?.Fecha_Salida_Imput ??
    item?.fecha_entrega_imput ??
    item?.Fecha_Entrega_Imput ??
    item?.fecha_plan_entrega ??
    item?.Fecha_Plan_Entrega ??
    item?.fecha_plan ??
    item?.Fecha_Plan ??
    item?.fecha_salida ??
    item?.Fecha_Salida ??
    item?.fecha_entrega ??
    item?.Fecha_Entrega ??
    null;
  return toISODate10(raw);
}
function isFechaEntregaActualizada(item) {
  const fromImput = toISODate10(item?.fecha_salida_imput ?? item?.Fecha_Salida_Imput ?? null);
  const fromPlan = toISODate10(item?.fecha_plan_entrega ?? item?.Fecha_Plan_Entrega ?? null);
  return !!(fromImput && fromPlan && fromImput !== fromPlan);
}
function isClienteEnRegla(item) {
  return isTruthySi(item?.admin_cliente_en_regla);
}
function isAdminAutorizado(item) {
  return isTruthySi(item?.auth_admin);
}
function hasAdminAcciones(item) {
  return isTruthySi(item?.admin_acciones);
}
function getAdminAccionesDetalle(item) {
  return firstDefined(item, [
    'admin_acciones_detalle',
    'admin_acciones_observacion',
    'admin_acciones_observacion_imput',
    'acciones_detalle',
    'acciones_observacion',
  ]);
}
function canEnterQueue() {
  return true;
}

function getIsoWeekInfo(dateLike) {
  const date10 = toISODate10(dateLike);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date10)) return null;

  const d = new Date(`${date10}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);

  const year = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);

  return { year, week, label: `Semana ${week}` };
}
function getProdWeekLabel(item) {
  const info = getIsoWeekInfo(getProdDate10(item));
  return info?.week != null ? `Semana N° ${info.week}` : 'Semana N° —';
}
function getSalidaWeekLabel(item) {
  const info = getIsoWeekInfo(getSalidaDate10(item));
  return info?.week != null ? `Semana N° ${info.week}` : 'Semana N° —';
}

// ST y Refabricado no tienen fecha propia de producción/despacho (son
// ordenes ligadas a un NV, no portones): para mostrarles la semana hay que
// resolver el portón real con ese mismo NV y usar SU fecha. Prefabricados,
// Orden Externa y Prueba Laser Plano no tienen NV asociado (numero propio),
// así que no aplica.
function resolveWeekSourceItem(p, portonByNv) {
  if (p?.__kind === 'servicio_tecnico' && !NO_NV_TIPOS.includes(p?.tipo)) {
    const nvNum = Number(p?.nv);
    const matched = Number.isInteger(nvNum) ? portonByNv?.get(nvNum) : null;
    if (matched) return matched;
  }
  return p;
}

function getPuertaPos(row) {
  return toText(
    row?.PUERTA_Posicion ??
      row?.Puerta_Posicion ??
      row?.puerta_posicion ??
      row?.PUERTA_POSICION ??
      row?.puertaPosicion
  ).toUpperCase();
}
function getPuertaAlto(row) {
  const v =
    row?.Puerta_Alto ??
    row?.PUERTA_Alto ??
    row?.PUERTA_ALTO ??
    row?.puerta_alto ??
    row?.PUERTAalto ??
    row?.puertaAlto;
  const n = toNum(v);
  return n != null ? String(Math.round(n)) : toText(v);
}
function getPuertaAncho(row) {
  const v =
    row?.Puerta_Ancho ??
    row?.PUERTA_Ancho ??
    row?.PUERTA_ANCHO ??
    row?.puerta_ancho ??
    row?.PUERTAancho ??
    row?.puertaAncho;
  const n = toNum(v);
  return n != null ? String(Math.round(n)) : toText(v);
}
function hasPuerta(row) {
  const pos = getPuertaPos(row);
  return !!pos && pos !== 'NO' && pos !== '0' && pos !== 'N';
}
function calcLadoMasAltoFromParantesDescripcion(desc) {
  const s = toText(desc);
  if (!s) return 0;
  const m = s.match(/(\d+(?:[.,]\d+)?)\s*[xX]\s*(\d+(?:[.,]\d+)?)/);
  if (!m) return 0;
  const a = Number(String(m[1]).replace(',', '.'));
  const b = Number(String(m[2]).replace(',', '.'));
  const max = Math.max(Number.isFinite(a) ? a : 0, Number.isFinite(b) ? b : 0);
  return max || 0;
}
function getLadoMasAlto(row) {
  const fromRow = toNum(row?.lado_mas_alto);
  if (fromRow) return fromRow;
  return calcLadoMasAltoFromParantesDescripcion(row?.PARANTES_Descripcion);
}
function calcCalcEspadaFromRow(row) {
  const A = getLadoMasAlto(row);
  const B = toNum(row?.Largo_Parantes);
  const C = toNum(row?.DATOS_Brazos);
  if (!A || !B || !C) return 0;
  if (A === 50) {
    if (B >= 2950 && B < 3150) return C - 12 - 45;
    if (B < 2950) return C - 12 - 40;
    return C - 12 - 55;
  }
  if (A === 70) {
    if (B <= 2300) return C - 12 - 22;
    if (B <= 2420) return C - 12 - 25;
    if (B <= 2800) return C - 12 - 33;
    if (B < 3150) return C - 12 - 38;
    return C - 12 - 55;
  }
  if (A === 80) return C - 12 - 35;
  return 0;
}
function getLargoTraves(row) {
  return firstDefined(row, [
    'Largo_Travesaños',
    'Largo_Travesanos',
    'Largo_Travesaño',
    'Largo_Travesano',
  ]);
}
function getLaserSectionData(item, sectionKey) {
  switch (sectionKey) {
    case 'dintel':
      return [
        { label: 'Tipo', value: firstDefined(item, ['DINTEL_tipo', 'DINTEL_Tipo', 'Dintel_Tipo']) },
        { label: 'Ancho', value: firstDefined(item, ['DINTEL_Ancho', 'DINTEL_ancho', 'Dintel_Ancho']) },
      ];
    case 'brazos':
      return [
        { label: 'Brazos', value: firstDefined(item, ['DATOS_Brazos', 'datos_brazos']) },
        { label: 'Largo planchuelas', value: firstDefined(item, ['Largo_Planchuelas', 'largo_planchuelas']) },
        { label: 'Tipo pierna', value: firstDefined(item, ['PIERNAS_Tipo', 'PIERNAS_tipo', 'PIERNA_Tipo']) },
      ];
    case 'marco-hoja':
      return [
        { label: 'Parantes descripción', value: firstDefined(item, ['PARANTES_Descripcion']) },
        { label: 'Largo parantes', value: firstDefined(item, ['Largo_Parantes']) },
        { label: 'Largo travesaños', value: getLargoTraves(item) },
        { label: 'Parantes internos', value: firstDefined(item, ['Parantes_Internos']) },
        { label: 'Parantes cantidad', value: firstDefined(item, ['PARANTES_Cantidad']) },
        { label: 'Parantes distribución', value: firstDefined(item, ['PARANTES_Distribucion']) },
      ];
    case 'puerta':
      return [
        { label: 'Posición', value: getPuertaPos(item) },
        { label: 'Alto', value: getPuertaAlto(item) },
        { label: 'Ancho', value: getPuertaAncho(item) },
        { label: 'Condición', value: firstDefined(item, ['PUERTA_Condicion', 'Puerta_Condicion']) },
      ];
    case 'espada': {
      const calcStored = firstDefined(item, ['calc_espada']);
      const calcValue =
        calcStored !== ''
          ? calcStored
          : (() => {
              const calc = calcCalcEspadaFromRow(item);
              return calc ? String(Math.round(calc)) : '';
            })();
      return [
        { label: 'Espada', value: calcValue },
        { label: 'Lado más alto', value: getLadoMasAlto(item) ? String(getLadoMasAlto(item)) : '' },
        { label: 'Largo parantes', value: firstDefined(item, ['Largo_Parantes']) },
        { label: 'Brazos', value: firstDefined(item, ['DATOS_Brazos']) },
        { label: 'Espesor revestimiento', value: firstDefined(item, ['Espesor_Revestimiento']) },
      ];
    }
    case 'rebaje':
      return [
        { label: 'Rebaje sí/no', value: firstDefined(item, ['REBAJE_SINO']) },
        { label: 'Rebaje descuento', value: firstDefined(item, ['REBAJE_Descuento']) },
        { label: 'Rebaje altura', value: firstDefined(item, ['REBAJE_Altura', 'rebaje_altura']) },
        { label: 'RBJ ancho', value: firstDefined(item, ['RBJ_Ancho', 'RBJ_ancho']) },
        { label: 'Lateral / inferior', value: firstDefined(item, ['REB_Lateral_Inferior', 'REBAJE_Lateral_Inferior']) },
      ];
    default:
      return [];
  }
}

function ShellModal({ open, onClose, headerBg = '#f8fafc', borderColor = '#e5e7eb', title, children, width = 'min(760px, 100%)', disableClose = false }) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (!disableClose && e.target === e.currentTarget) onClose?.();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,23,42,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        zIndex: 9999,
      }}
    >
      <div
        style={{
          width,
          background: '#fff',
          borderRadius: 14,
          border: `1px solid ${borderColor}`,
          boxShadow: '0 18px 55px rgba(0,0,0,0.25)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '12px 14px',
            borderBottom: `1px solid ${borderColor}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            background: headerBg,
          }}
        >
          <div style={{ fontWeight: 900 }}>{title}</div>
          {!disableClose ? (
            <button className="btn" type="button" onClick={onClose}>
              Cerrar
            </button>
          ) : null}
        </div>
        {children}
      </div>
    </div>
  );
}

function DatosModal({ open, onClose, item, title }) {
  const sections = useMemo(() => ([
    { key: 'dintel', label: 'Dintel', enabled: true },
    { key: 'brazos', label: 'Brazos', enabled: true },
    { key: 'marco-hoja', label: 'Marco de hoja', enabled: true },
    { key: 'puerta', label: 'Puerta', enabled: hasPuerta(item) },
    { key: 'espada', label: 'Espada', enabled: true },
    { key: 'rebaje', label: 'Rebaje', enabled: true },
  ]), [item]);
  const firstEnabledKey = useMemo(() => sections.find((s) => s.enabled)?.key || sections[0]?.key || 'dintel', [sections]);
  const [activeKey, setActiveKey] = useState(firstEnabledKey);

  useEffect(() => {
    if (!open) return;
    setActiveKey(firstEnabledKey);
  }, [open, firstEnabledKey, item?.id, item?.nv, item?.nlista, item?.partida]);

  if (!open || !item) return null;

  const active = sections.find((s) => s.key === activeKey) || sections[0];
  const rows = getLaserSectionData(item, active?.key).filter((r) => String(r?.value ?? '').trim() !== '');

  return (
    <ShellModal open={open} onClose={onClose} title={`Datos · ${title} · NV ${item?.nv ?? item?.NV ?? '-'}`} width="min(840px, 100%)">
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {sections.map((section) => (
            <button
              key={section.key}
              type="button"
              className="btn"
              disabled={!section.enabled}
              onClick={() => section.enabled && setActiveKey(section.key)}
              style={{ fontWeight: activeKey === section.key ? 900 : 700, opacity: section.enabled ? 1 : 0.5 }}
              title={!section.enabled ? 'Este portón no tiene puerta' : section.label}
            >
              {section.label}
            </button>
          ))}
        </div>
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontWeight: 900, fontSize: 16 }}>{active?.label}</div>
          {rows.length === 0 ? (
            <div style={{ opacity: 0.7 }}>No hay datos disponibles para este bloque.</div>
          ) : (
            rows.map((row) => (
              <div key={`${active?.key}-${row.label}`} style={{ fontSize: 14 }}>
                <b>{row.label}:</b> {displayValue(row.value)}
              </div>
            ))
          )}
        </div>
      </div>
    </ShellModal>
  );
}

function QcModal({ open, onClose, item, line, stageKey, title, onSaved, forceComplete = false }) {
  const [pin, setPin] = useState('');
  const [status, setStatus] = useState('APROBADO');
  const [motiveId, setMotiveId] = useState('');
  const [motives, setMotives] = useState([]);
  const [loadingMotives, setLoadingMotives] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const qcItemId = useMemo(() => getQcItemId(item, line), [item, line]);
  const needsMotive = up(status) === 'OBSERVADO' || up(status) === 'RECHAZADO';

  useEffect(() => {
    if (!open) return;
    setErr('');
    setPin('');
    setStatus('APROBADO');
    setMotiveId('');
    setMotives([]);
    setLoadingMotives(false);
    setSaving(false);
  }, [open, item?.id, item?.nv, item?.nlista, item?.partida, stageKey, line]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!open || !item) return;
      const st = up(status);
      if (!(st === 'OBSERVADO' || st === 'RECHAZADO')) {
        setMotives([]);
        setMotiveId('');
        return;
      }
      try {
        setLoadingMotives(true);
        setErr('');
        const data = await qcGetMotives({ line, kind: st, stage: stageKey });
        if (cancelled) return;
        setMotives(Array.isArray(data) ? data : []);
        setMotiveId('');
      } catch (e) {
        if (cancelled) return;
        setErr(e?.response?.data?.error || e.message);
        setMotives([]);
        setMotiveId('');
      } finally {
        if (!cancelled) setLoadingMotives(false);
      }
    }
    run();
    return () => { cancelled = true; };
  }, [open, status, item, line, stageKey]);

  const submit = async () => {
    const pinStr = String(pin || '').trim();
    const qc_status = up(status);
    setErr('');
    if (!/^\d{3,10}$/.test(pinStr)) {
      setErr('PIN inválido (solo numérico, 3 a 10 dígitos).');
      return;
    }
    if (!Number.isInteger(qcItemId)) {
      setErr('Item QC inválido: no se pudo resolver un ID numérico (NV/NLista/Partida).');
      return;
    }
    if ((qc_status === 'OBSERVADO' || qc_status === 'RECHAZADO') && !String(motiveId || '').trim()) {
      setErr('Tenés que elegir un motivo para OBSERVADO/RECHAZADO.');
      return;
    }
    try {
      setSaving(true);
      const payload = { line, item_id: qcItemId, stage_key: stageKey, qc_status, pin: pinStr };
      if (qc_status === 'OBSERVADO' || qc_status === 'RECHAZADO') payload.motive_id = Number(motiveId);
      const resp = await qcAuthorize(payload);
      const uname = resp?.user?.name ? ` (${resp.user.name})` : '';
      alert(`QC registrado: ${qc_status}${uname}`);
      onSaved?.();
      onClose?.();
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setSaving(false);
    }
  };
  const handleSubmit = (e) => {
    e?.preventDefault?.();
    if (!saving) submit();
  };
  const handleEnterKey = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!saving) submit();
  };

  if (!open || !item) return null;
  return (
    <ShellModal open={open} onClose={onClose} title={`QC – ${title}`} width="min(720px, 100%)" disableClose={forceComplete}>
      <form onSubmit={handleSubmit} style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {err && <div style={{ color: 'crimson', fontWeight: 800 }}>{err}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontWeight: 800 }}>PIN</span>
            <input className="btn" type="password" value={pin} onChange={(e) => setPin(e.target.value)} onKeyDown={handleEnterKey} inputMode="numeric" autoComplete="off" placeholder="Ej: 1234" />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontWeight: 800 }}>Estado</span>
            <select className="btn" value={status} onChange={(e) => setStatus(e.target.value)} onKeyDown={handleEnterKey}>
              <option value="APROBADO">Autorizar</option>
              <option value="OBSERVADO">Observar</option>
              <option value="RECHAZADO">Rechazar</option>
            </select>
          </label>
        </div>
        {needsMotive && (
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>Motivo ({up(status)})</div>
            {loadingMotives ? (
              <div style={{ opacity: 0.8 }}>Cargando motivos…</div>
            ) : (
              <select className="btn" style={{ width: '100%' }} value={motiveId} onChange={(e) => setMotiveId(e.target.value)} onKeyDown={handleEnterKey}>
                <option value="">— Elegí un motivo —</option>
                {(motives || []).map((m) => (
                  <option key={m.id} value={String(m.id)}>{m.label}</option>
                ))}
              </select>
            )}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            Line: <b>{line}</b> · Stage: <b>{stageKey}</b> · QC Item ID: <b>{qcItemId ?? '-'}</b>
          </div>
          <button className="btn btn--brand" type="submit" disabled={saving}>{saving ? 'Guardando…' : 'Confirmar'}</button>
        </div>
      </form>
    </ShellModal>
  );
}

function ObservacionesModal({ open, onClose, title, item, line, despacho = false, portonByNv }) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [observations, setObservations] = useState([]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!open || !item) return;
      const qcId = getQcItemId(item, line);
      if (!Number.isInteger(qcId)) {
        setObservations([]);
        return;
      }
      try {
        setErr('');
        setLoading(true);
        const resp = await qcHistory({ line, item_id: qcId });
        const arr = Array.isArray(resp) ? resp : [];
        const onlyObs = arr.filter((x) => up(x?.qc_status) === 'OBSERVADO');
        if (cancelled) return;
        setObservations(onlyObs);
      } catch (e) {
        if (cancelled) return;
        setErr(e?.response?.data?.error || e.message);
        setObservations([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => { cancelled = true; };
  }, [open, item, line]);

  if (!open || !item) return null;
  const pref = item?.__kind === 'prefabricado' && item?.numero != null
    ? `Pref ${item.numero}${item?.referencia ? ` (Ref: ${item.referencia})` : ''}`
    : '';
  const oe = item?.__kind === 'servicio_tecnico' && item?.tipo === 'OE' && item?.numero != null ? `OE ${item.numero}` : '';
  const prueba = item?.__kind === 'servicio_tecnico' && item?.tipo === 'PRUEBA' && item?.numero != null ? `PRUEBA ${item.numero}` : '';
  const nv = item?.nv != null ? (item?.__kind === 'servicio_tecnico' ? `ST ${item.nv}` : `NV ${item.nv}`) : '';
  const nlista = item?.nlista != null ? `Portón ${item.nlista}` : '';
  const weekSource = resolveWeekSourceItem(item, portonByNv);
  const semana = despacho ? `Despacho: ${getSalidaWeekLabel(weekSource)}` : `Producción: ${getProdWeekLabel(weekSource)}`;
  const head = [title, pref, oe, prueba, nv, nlista, semana].filter(Boolean).join(' · ');
  const rows = (observations || []).map((o) => ({
    sector: o?.stage_key || o?.sector || o?.stage || '-',
    fecha: o?.created_at || o?.timestamp || null,
    motivo: o?.motive_label || o?.motive?.label || '-',
    quien: o?.user_name || o?.user?.name || '-',
    status: up(o?.qc_status),
  }));

  return (
    <ShellModal open={open} onClose={onClose} title={`Observaciones · ${head}`} headerBg="#fff5f5" borderColor="#fecaca" width="min(860px, 100%)">
      <div style={{ padding: 14 }}>
        {err && <div style={{ color: 'crimson', fontWeight: 800, marginBottom: 10 }}>{err}</div>}
        {loading ? (
          <div style={{ opacity: 0.8 }}>Cargando observaciones…</div>
        ) : rows.length === 0 ? (
          <div style={{ opacity: 0.75 }}>No hay observaciones registradas.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {rows.map((r, idx) => (
              <div key={`obs-${idx}`} style={{ border: '1px solid #fecaca', background: '#fffafa', borderRadius: 12, padding: 12 }}>
                <div style={{ fontWeight: 900, color: '#7f1d1d', marginBottom: 6 }}>{r.status || 'OBSERVADO'}</div>
                <div style={{ fontSize: 13 }}><b>Sector:</b> {r.sector}</div>
                <div style={{ fontSize: 13 }}><b>Fecha:</b> {r.fecha ? fmt(r.fecha) : '-'}</div>
                <div style={{ fontSize: 13 }}><b>Motivo:</b> {r.motivo}</div>
                <div style={{ fontSize: 13 }}><b>Quién puso el PIN:</b> {r.quien}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </ShellModal>
  );
}

function AdminAccionesModal({ open, onClose, title, item }) {
  if (!open || !item) return null;
  const nv = item?.nv != null ? `NV ${item.nv}` : '';
  const nlista = item?.nlista != null ? `Portón ${item.nlista}` : '';
  // Este modal solo se abre para portones en la columna de Despacho.
  const semana = `Despacho: ${getSalidaWeekLabel(item)}`;
  const head = [title, nv, nlista, semana].filter(Boolean).join(' · ');
  const detalle = getAdminAccionesDetalle(item);

  return (
    <ShellModal open={open} onClose={onClose} title={`Acciones administrativas · ${head}`} headerBg="#fffbeb" borderColor="#f59e0b" width="min(760px, 100%)">
      <div style={{ padding: 14 }}>
        <div style={{ border: '1px solid #fcd34d', background: '#fffbeb', borderRadius: 12, padding: 12, whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>
          {detalle || 'Sin detalle cargado.'}
        </div>
      </div>
    </ShellModal>
  );
}

function HistoryModal({ open, onClose, title, effKey, rows = [] }) {
  if (!open) return null;
  return (
    <ShellModal open={open} onClose={onClose} title={<span>Historial sección · {title} <span style={{ opacity: 0.7, fontWeight: 700 }}>({effKey})</span></span>} width="min(900px, 100%)">
      <div style={{ padding: 14 }}>
        {rows.length === 0 ? (
          <div style={{ opacity: 0.75 }}>Sin historial para mostrar.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rows.map((r) => (
              <div key={r._key} style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 12, background: '#ffffff', display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'center' }}>
                <div style={{ fontSize: 13 }}>
                  <div style={{ fontWeight: 900 }}>{r.label}</div>
                  {r.semana ? <div style={{ opacity: 0.8, marginTop: 2 }}>{r.semana}</div> : null}
                  <div style={{ opacity: 0.8, marginTop: 2 }}>Fin etapa: <b>{r.fin ? fmt(r.fin) : '-'}</b></div>
                </div>
                <div style={{ fontSize: 12, fontWeight: 900, opacity: 0.9 }}>{r.qcLatest ? `QC: ${r.qcLatest}` : ''}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </ShellModal>
  );
}

function PortonHistoryModal({ open, onClose, title, effKey, items = [], mode = 'porton' }) {
  const [nv, setNv] = useState('');
  const [result, setResult] = useState(null);
  const [searchDone, setSearchDone] = useState(false);
  const cleanEffKey = String(effKey || '').trim();
  const isDespachoCtx = mode === 'porton' && cleanEffKey === 'despacho';
  const startKey = `${cleanEffKey}_inicio`;
  const finKey = `${cleanEffKey}_fin`;
  const normalizedNv = String(nv || '').trim();
  const parsedNv = Number(normalizedNv);
  const invalidNv = searchDone && !Number.isInteger(parsedNv);

  useEffect(() => {
    if (!open) return;
    setNv('');
    setResult(null);
    setSearchDone(false);
  }, [open, cleanEffKey]);

  const handleSearch = (e) => {
    e?.preventDefault?.();
    if (!Number.isInteger(parsedNv)) {
      setResult(null);
      setSearchDone(true);
      return;
    }
    const found = (Array.isArray(items) ? items : []).find((p) => Number(p?.nv ?? p?.NV) === parsedNv) || null;
    setResult(found);
    setSearchDone(true);
  };

  if (!open) return null;
  return (
    <ShellModal open={open} onClose={onClose} title={<span>Historial {mode === 'ipanel' ? 'iPanel' : 'portón'} · {title} <span style={{ opacity: 0.7, fontWeight: 700 }}>({cleanEffKey})</span></span>}>
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <form onSubmit={handleSearch} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 220 }}>
            <span style={{ fontWeight: 800 }}>NV</span>
            <input className="btn" type="text" value={nv} onChange={(e) => setNv(e.target.value)} inputMode="numeric" placeholder="Ej: 3995" autoFocus />
          </label>
          <button className="btn btn--brand" type="submit">Buscar</button>
        </form>
        {invalidNv ? <div style={{ color: 'crimson', fontWeight: 800 }}>Ingresá un NV numérico válido.</div> : null}
        {searchDone && !invalidNv && !result ? <div style={{ opacity: 0.8 }}>No se encontró ningún portón con NV <b>{normalizedNv}</b>.</div> : null}
        {result ? (
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontWeight: 900, fontSize: 16 }}>
              {result?.__kind === 'servicio_tecnico'
                ? getOrderLabel(result, 'servicio_tecnico')
                : mode === 'ipanel'
                  ? `iPanel · NV ${result?.nv ?? result?.NV ?? '-'}`
                  : `Portón ${result?.nlista ?? result?.NLista ?? '-'} · NV ${result?.nv ?? result?.NV ?? '-'} · ${isDespachoCtx ? `Despacho: ${getSalidaWeekLabel(result)}` : `Producción: ${getProdWeekLabel(result)}`}`}
            </div>
            <div style={{ fontSize: 14 }}><b>Sector:</b> {title}</div>
            <div style={{ fontSize: 14 }}><b>Estado:</b> {displayValue(result?.[cleanEffKey], 'Sin datos')}</div>
            <div style={{ fontSize: 14 }}><b>Inicio:</b> {result?.[startKey] ? fmt(result[startKey]) : '-'}</div>
            <div style={{ fontSize: 14 }}><b>Finalizado:</b> {result?.[finKey] ? fmt(result[finKey]) : '-'}</div>
          </div>
        ) : null}
      </div>
    </ShellModal>
  );
}

// Devuelve true si el tipo NO es la NV principal (es un anexo)
function isAnexo(p) {
  const tipo = String(p?.nv_tipo || 'NV').trim().toUpperCase();
  return tipo !== 'NV';
}

// Portón migrado del sistema anterior (Presupuestador legacy_import): su ficha técnica
// viaja en nv_lines, así que el tablero le muestra el botón "Ver" como a un anexo.
function isLegacyImport(p) {
  return p?.legacy_import === true || p?.legacy_import === 'true';
}

function getNvLabel(p) {
  const nv = p?.nv ?? p?.NV ?? '-';
  if (String(p?.tipo || '').trim().toLowerCase() === 'puerta') return `PNV ${nv}`;
  const tipo = String(p?.nv_tipo || 'NV').trim().toUpperCase();
  return isAnexo(p) ? `ANEXO NV ${nv} (${tipo})` : `NV ${nv}`;
}

// Prefabricados: número propio (secuencia global). Servicio Técnico: reusa el NV del portón.
function getOrderLabel(p, kind) {
  if (kind === 'prefabricado') return `Pref ${p?.numero ?? '-'}`;
  if (kind === 'servicio_tecnico') {
    if (p?.tipo === 'OE') return `OE ${p?.numero ?? '-'}`;
    if (p?.tipo === 'REFAB') return `REFAB ${p?.nv ?? '-'}`;
    if (p?.tipo === 'PRUEBA') return `PRUEBA ${p?.numero ?? '-'}`;
    return `ST ${p?.nv ?? '-'}`;
  }
  return getNvLabel(p);
}

function AnexoDetailModal({ open, onClose, item }) {
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open || !item) return;
    let cancelled = false;
    setDetail(null);
    setErr('');
    setLoading(true);
    const nv = item?.nv ?? item?.NV;
    const tipo = String(item?.nv_tipo || 'NV').trim().toUpperCase();
    fetchNvLines(nv, tipo)
      .then((res) => {
        if (!cancelled) setDetail(res?.data || null);
      })
      .catch((e) => {
        if (!cancelled) setErr(e?.response?.data?.error || e?.message || 'Error al cargar detalle');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, item?.nv, item?.nv_tipo]);

  if (!open || !item) return null;

  const tipo = String(item?.nv_tipo || 'NV').trim().toUpperCase();
  const lines = Array.isArray(detail?.nv_lines) ? detail.nv_lines : [];
  const legacy = isLegacyImport(item);

  return (
    <ShellModal
      open={open}
      onClose={onClose}
      title={legacy ? `NV ${item?.nv ?? '-'} · Ficha técnica (sistema anterior)` : `${tipo} ${item?.nv ?? '-'} · Detalle`}
      width="min(640px, 100%)"
    >
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {loading ? (
          <div style={{ opacity: 0.8 }}>Cargando…</div>
        ) : err ? (
          <div style={{ color: 'crimson', fontWeight: 800 }}>{err}</div>
        ) : !detail?.found ? (
          <div style={{ opacity: 0.75 }}>No se encontraron datos para este ítem en el presupuestador.</div>
        ) : (
          <>
            {detail.nombre && (
              <div style={{ fontSize: 14 }}>
                <b>Cliente:</b> {detail.nombre}
                {detail.direccion ? ` · ${detail.direccion}` : ''}
                {detail.localidad ? `, ${detail.localidad}` : ''}
              </div>
            )}
            <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ background: '#f8fafc', padding: '8px 12px', fontWeight: 900, fontSize: 13, borderBottom: '1px solid #e5e7eb' }}>
                Ítems
              </div>
              {lines.length === 0 ? (
                <div style={{ padding: '10px 12px', opacity: 0.7, fontSize: 13 }}>Sin ítems cargados.</div>
              ) : (
                lines.map((l, i) => (
                  <div
                    key={i}
                    style={{
                      padding: '8px 12px',
                      fontSize: 13,
                      borderBottom: i < lines.length - 1 ? '1px solid #f1f5f9' : 'none',
                      display: 'flex',
                      gap: 10,
                    }}
                  >
                    <span style={{ fontWeight: 700, minWidth: 28, color: '#64748b' }}>{Number(l.qty) || 1}×</span>
                    <span>{String((legacy ? (l.name || l.raw_name) : (l.raw_name || l.name)) || '').trim()}</span>
                  </div>
                ))
              )}
            </div>
            {detail.note && (
              <div style={{ fontSize: 12, opacity: 0.7, whiteSpace: 'pre-wrap' }}>{detail.note}</div>
            )}
          </>
        )}
      </div>
    </ShellModal>
  );
}

function PreObsModal({ open, onClose, item }) {
  if (!open || !item) return null;
  const obs = String(item?.observacion_imput || '').trim();
  const nv = item?.nv != null ? `NV ${item.nv}` : '';
  const nlista = item?.nlista != null ? `Portón ${item.nlista}` : '';
  return (
    <ShellModal open={open} onClose={onClose} title={`Observación · ${[nv, nlista].filter(Boolean).join(' · ')}`} headerBg="#f0fdf4" borderColor="#86efac" width="min(560px, 100%)">
      <div style={{ padding: 16, fontSize: 14, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
        {obs || <span style={{ opacity: 0.5 }}>Sin observaciones.</span>}
      </div>
    </ShellModal>
  );
}

function DetalleRefabricacionModal({ open, onClose, item }) {
  if (!open || !item) return null;
  const detalle = String(item?.detalle_refabricacion || '').trim();
  const nv = item?.nv != null ? `NV ${item.nv}` : '';
  const nlista = item?.nlista != null ? `Portón ${item.nlista}` : '';
  return (
    <ShellModal open={open} onClose={onClose} title={`Detalle Refabricación · ${[nv, nlista].filter(Boolean).join(' · ')}`} headerBg="#fff1f2" borderColor="#fda4af" width="min(560px, 100%)">
      <div style={{ padding: 16, fontSize: 14, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
        {detalle || <span style={{ opacity: 0.5 }}>Sin detalle cargado.</span>}
      </div>
    </ShellModal>
  );
}

export default function StageColumn({
  title,
  stageKey,
  mode = 'porton',
  items = [],
  allItems = [],
  onStart,
  onStop,
  onStartPrefab,
  onStopPrefab,
  onStartSt,
  onStopSt,
  disabledId,
  qcSummaryMap = {},
  qcSummaryMapPrefab = {},
  qcSummaryMapSt = {},
  qcSummaryMapOe = {},
  qcSummaryMapRefab = {},
  qcSummaryMapPrueba = {},
  onQcSaved,
  prefabTipos = [],
  onCreatePrefabOrden,
}) {
  const [qcOpen, setQcOpen] = useState(false);
  const [qcTarget, setQcTarget] = useState(null);
  const [qcForceComplete, setQcForceComplete] = useState(false);
  const [obsOpen, setObsOpen] = useState(false);
  const [obsTarget, setObsTarget] = useState(null);
  const [adminAccionesOpen, setAdminAccionesOpen] = useState(false);
  const [adminAccionesTarget, setAdminAccionesTarget] = useState(null);
  const [histOpen, setHistOpen] = useState(false);
  const [portonHistOpen, setPortonHistOpen] = useState(false);
  const [datosOpen, setDatosOpen] = useState(false);
  const [datosTarget, setDatosTarget] = useState(null);
  const [preObsOpen, setPreObsOpen] = useState(false);
  const [preObsTarget, setPreObsTarget] = useState(null);
  const [anexoOpen, setAnexoOpen] = useState(false);
  const [anexoTarget, setAnexoTarget] = useState(null);
  const [detalleRefabOpen, setDetalleRefabOpen] = useState(false);
  const [detalleRefabTarget, setDetalleRefabTarget] = useState(null);
  const [nuevoPedidoOpen, setNuevoPedidoOpen] = useState(false);

  const effKey = mode === 'ipanel' && stageKey === 'plegadora' ? 'plegado' : stageKey;
  const line = mapModeToLine(mode);
  const keyTrim = String(effKey || '').trim();
  const isDespachoColumn = mode === 'porton' && keyTrim === 'despacho';
  const isLaserColumn = mode === 'porton' && ['laser', 'laser_dintel', 'laser_hojas', 'laser_brazos_espada'].includes(keyTrim);

  const eligiblePrefabTipos = useMemo(() => {
    if (mode !== 'porton') return [];
    return (prefabTipos || []).filter(
      (t) => t?.enabled !== false && Array.isArray(t?.seccion_solicitante) && t.seccion_solicitante.includes(stageKey)
    );
  }, [mode, prefabTipos, stageKey]);

  // Historial de pedidos de prefabricado solicitados por ESTA sección, para
  // mostrar en el popup de "Nuevo pedido" en qué etapa del workflow está
  // parado cada uno hoy. Si ninguna etapa de su ruta está Pendiente/En Proceso
  // se considera Finalizado (recorrió toda la ruta).
  const prefabHistorialSeccion = useMemo(() => {
    if (mode !== 'porton') return [];
    const src = Array.isArray(allItems) ? allItems : [];
    return src
      .filter((p) => p?.__kind === 'prefabricado' && p?.solicitado_por_seccion === stageKey)
      .map((p) => {
        const stages = Array.isArray(p?.workflow_stages) ? p.workflow_stages : [];
        const pendienteEn = stages.find((st) => low(p?.[st]) !== 'finalizado');
        return {
          id: p.id,
          numero: p.numero,
          tipo_nombre: p.tipo_nombre,
          cantidad: p.cantidad,
          created_at: p.created_at,
          referencia: p.referencia,
          finalizado: !pendienteEn,
          seccionActual: pendienteEn ? sectionLabel(pendienteEn) : null,
        };
      })
      .sort((a, b) => (Number(b.numero) || 0) - (Number(a.numero) || 0));
  }, [mode, allItems, stageKey]);

  // NV -> portón "puro" (sin __kind), para resolverle la semana a ST/Refab
  // (ver resolveWeekSourceItem). allItems trae el listado completo, no solo
  // lo que entra en esta columna.
  const portonByNv = useMemo(() => {
    const map = new Map();
    for (const it of (Array.isArray(allItems) ? allItems : [])) {
      if (it?.__kind) continue;
      const nvNum = Number(it?.nv ?? it?.NV);
      if (Number.isInteger(nvNum)) map.set(nvNum, it);
    }
    return map;
  }, [allItems]);

  function qcMapForItem(p) {
    const itemLine = getItemQcLine(p);
    if (itemLine === 'prefabricados') return qcSummaryMapPrefab;
    if (itemLine === 'orden_externa') return qcSummaryMapOe;
    if (itemLine === 'refabricado') return qcSummaryMapRefab;
    if (itemLine === 'prueba') return qcSummaryMapPrueba;
    if (itemLine === 'servicio_tecnico') return qcSummaryMapSt;
    return qcSummaryMap;
  }

  function shouldHideFinalizado(p) {
    const itemLine = getItemQcLine(p) || line;
    const qcId = getQcItemId(p, itemLine);
    if (!Number.isInteger(qcId)) return false;
    const info = qcMapForItem(p)?.[qcId];
    const latest = up(info?.latest_by_stage?.[keyTrim] || '');
    if (!latest) return false;
    return latest === 'APROBADO' || latest === 'OBSERVADO';
  }

  const ordered = useMemo(() => {
    const filtered = (items || [])
      .filter((p) => {
        const st = low(p?.[effKey]);
        if (!(st === 'pendiente' || st === 'en proceso' || st === 'finalizado')) return false;
        return canEnterQueue(p, effKey);
      })
      .slice();
    const groupRank = (st) => {
      if (st === 'en proceso') return 0;
      if (st === 'pendiente') return 1;
      return 2;
    };
    const dateRank = (prod10) => (prod10 ? prod10 : '9999-12-31');
    filtered.sort((a, b) => {
      const aSt = low(a?.[effKey]);
      const bSt = low(b?.[effKey]);
      const gA = groupRank(aSt);
      const gB = groupRank(bSt);
      if (gA !== gB) return gA - gB;
      const aProd = dateRank(getProdDate10(a));
      const bProd = dateRank(getProdDate10(b));
      if (aProd !== bProd) return aProd.localeCompare(bProd);
      return (a?.nv || 0) - (b?.nv || 0);
    });
    return filtered;
  }, [items, effKey]);

  const handleStopAndOpenQc = async (p) => {
    const stopFn = p?.__kind === 'prefabricado' ? onStopPrefab : p?.__kind === 'servicio_tecnico' ? onStopSt : onStop;
    if (!stopFn || !p) return;
    const resp = await stopFn(p.id, effKey);
    if (!resp?.ok) return;
    setQcTarget(resp.item || p);
    setQcForceComplete(true);
    setQcOpen(true);
  };

  const historyLast10 = useMemo(() => {
    const key = String(keyTrim || '').trim();
    const finKey = `${key}_fin`;
    const src = Array.isArray(allItems) ? allItems : [];

    const qcInfoFor = (p) => {
      const itemLine = getItemQcLine(p) || 'portones';
      const qcId = getQcItemId(p, itemLine);
      return Number.isInteger(qcId) ? qcMapForItem(p)?.[qcId] : null;
    };

    const done = src.filter((p) => {
      const st = low(p?.[key]);
      if (st !== 'finalizado') return false;
      const info = qcInfoFor(p);
      const latest = up(info?.latest_by_stage?.[key] || '');
      if (latest) return latest === 'APROBADO' || latest === 'OBSERVADO';
      return true;
    });
    done.sort((a, b) => {
      const aT = a?.[finKey] ? new Date(a[finKey]).getTime() : 0;
      const bT = b?.[finKey] ? new Date(b[finKey]).getTime() : 0;
      if (aT && bT && aT !== bT) return bT - aT;
      if (aT && !bT) return -1;
      if (!aT && bT) return 1;
      return (Number(b?.nv) || 0) - (Number(a?.nv) || 0);
    });
    return done.slice(0, 10).map((p) => {
      const qcLatest = up(qcInfoFor(p)?.latest_by_stage?.[key] || '');
      const isNoNv = p?.__kind === 'servicio_tecnico' && NO_NV_TIPOS.includes(p?.tipo);
      const label = p?.__kind === 'prefabricado'
        ? `Pref ${p?.numero ?? '-'}${p?.tipo_nombre ? ` · ${p.tipo_nombre}` : ''}${p?.referencia ? ` · Ref: ${p.referencia}` : ''}`
        : p?.__kind === 'servicio_tecnico'
          ? getOrderLabel(p, 'servicio_tecnico')
          : mode === 'ipanel'
            ? `iPanel NV ${p?.nv ?? '-'}`
            : `Portón ${p?.nlista ?? '-'} · NV ${p?.nv ?? '-'}`;
      // Prefabricados, Orden Externa y Prueba Laser Plano no tienen NV propio -> sin semana.
      const semana = mode === 'ipanel' || p?.__kind === 'prefabricado' || isNoNv
        ? ''
        : (() => {
            const src = resolveWeekSourceItem(p, portonByNv);
            return isDespachoColumn ? `Despacho: ${getSalidaWeekLabel(src)}` : `Producción: ${getProdWeekLabel(src)}`;
          })();
      return {
        _key: String(p?.id ?? p?.nv ?? `${Math.random()}`),
        label,
        semana,
        fin: p?.[finKey] ?? null,
        qcLatest,
      };
    });
  }, [mode, keyTrim, allItems, qcSummaryMap, qcSummaryMapPrefab, qcSummaryMapSt, qcSummaryMapOe, qcSummaryMapRefab, qcSummaryMapPrueba, portonByNv, isDespachoColumn]);

  return (
    <div style={{ border: `2px solid ${bordo}`, borderRadius: 12, overflow: 'hidden', background: 'var(--surface)', display: 'flex', flexDirection: 'column', minHeight: 320 }}>
      <div style={{ background: bordo, color: '#fff', fontWeight: 800, padding: '10px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div>{title}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={() => setHistOpen(true)} title="Ver historial sección (últimos 10)" style={{ background: 'rgba(255,255,255,0.18)', color: '#fff', borderColor: 'rgba(255,255,255,0.35)', fontWeight: 900, padding: '6px 10px' }}>Hist. sección</button>
          <button type="button" className="btn" onClick={() => setPortonHistOpen(true)} title={mode === 'ipanel' ? 'Ver historial de un iPanel por NV' : 'Ver historial de un portón por NV'} style={{ background: 'rgba(255,255,255,0.18)', color: '#fff', borderColor: 'rgba(255,255,255,0.35)', fontWeight: 900, padding: '6px 10px' }}>
            {mode === 'ipanel' ? 'Hist. iPanel' : 'Hist. portón'}
          </button>
          {mode === 'porton' && eligiblePrefabTipos.length > 0 ? (
            <button type="button" className="btn" onClick={() => setNuevoPedidoOpen(true)} title="Crear pedido de fabricación de prefabricado" style={{ background: 'rgba(255,255,255,0.18)', color: '#fff', borderColor: 'rgba(255,255,255,0.35)', fontWeight: 900, padding: '6px 10px' }}>+ Nuevo pedido</button>
          ) : null}
        </div>
      </div>

      <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {ordered
          .filter((p) => {
            const st = low(p?.[effKey]);
            if (st === 'finalizado') return !shouldHideFinalizado(p);
            return st === 'pendiente' || st === 'en proceso';
          })
          .map((p) => {
            const st = low(p?.[effKey]);
            const canStop = st === 'en proceso';
            const canStart = st === 'pendiente';

            if (p?.__kind === 'prefabricado' || p?.__kind === 'servicio_tecnico') {
              const kind = p.__kind;
              const startFn = kind === 'prefabricado' ? onStartPrefab : onStartSt;
              const itemLine = getItemQcLine(p);
              const itemQcId = getQcItemId(p, itemLine);
              const itemQcInfo = Number.isInteger(itemQcId) ? qcMapForItem(p)?.[itemQcId] : null;
              const itemHasObs = Boolean(itemQcInfo?.has_obs);
              return (
                <div
                  key={`${kind}-${p?.id}`}
                  style={{ border: `2px solid ${cardBorder}`, borderRadius: 12, padding: '10px 12px', background: cardBg, position: 'relative' }}
                >
                  {itemHasObs ? (
                    <button
                      type="button"
                      onClick={() => { setObsTarget(p); setObsOpen(true); }}
                      title="Ver observaciones"
                      style={{ position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: 999, border: '1px solid #b91c1c', background: '#ef4444', color: '#fff', fontWeight: 900, cursor: 'pointer', display: 'grid', placeItems: 'center', boxShadow: '0 6px 18px rgba(0,0,0,0.18)' }}
                    >
                      !
                    </button>
                  ) : null}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 900 }}>{getOrderLabel(p, kind)}</span>
                    {kind === 'prefabricado' && p?.tipo_nombre ? (
                      <span style={{ fontSize: 12, opacity: 0.75 }}>{p.tipo_nombre}</span>
                    ) : null}
                    {kind === 'prefabricado' && p?.referencia ? (
                      <span style={{ fontSize: 12, fontWeight: 700, background: '#fef3c7', color: '#92400e', padding: '1px 6px', borderRadius: 6 }}>
                        Ref: {p.referencia}
                      </span>
                    ) : null}
                  </div>
                  {kind === 'servicio_tecnico' ? (
                    <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>
                      Cant.: <b>{p?.cantidad ?? '-'}</b>{p?.descripcion ? <> · {p.descripcion}</> : null}
                    </div>
                  ) : null}
                  {kind === 'servicio_tecnico' && !NO_NV_TIPOS.includes(p?.tipo) ? (
                    <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>
                      {(() => {
                        const src = resolveWeekSourceItem(p, portonByNv);
                        return isDespachoColumn
                          ? <>Despacho: <b>{getSalidaWeekLabel(src)}</b></>
                          : <>Producción: <b>{getProdWeekLabel(src)}</b></>;
                      })()}
                    </div>
                  ) : null}
                  {kind === 'prefabricado' ? (
                    <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>
                      Cant.: <b>{p?.cantidad ?? '-'}</b>
                    </div>
                  ) : null}
                  <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>Estado: {p?.[effKey] || ''}</div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => { setQcTarget(p); setQcForceComplete(false); setQcOpen(true); }}
                      style={{ fontWeight: 900 }}
                    >
                      QC
                    </button>
                    <button className="btn btn--brand" onClick={() => startFn && startFn(p.id, effKey)} disabled={!canStart || disabledId === p.id}>▶</button>
                    <button className="btn" onClick={() => handleStopAndOpenQc(p)} disabled={!canStop || disabledId === p.id}>⏹</button>
                  </div>
                </div>
              );
            }

            const qcId = getQcItemId(p, line);
            const info = Number.isInteger(qcId) ? qcSummaryMap?.[qcId] : null;
            const hasObs = Boolean(info?.has_obs);
            const prod10 = getProdDate10(p);
            const salida10 = getSalidaDate10(p);
            const today10 = todayISO10Local();
            const vencida = salida10 ? salida10 <= today10 : false;
            const adminAutorizado = isAdminAutorizado(p);
            const adminAcciones = isDespachoColumn && hasAdminAcciones(p);
            const adminAccionesDetalle = getAdminAccionesDetalle(p);

            // No tocar el comportamiento rojo existente: si falta autorización administrativa
            // y la salida ya está vencida, sigue rojo.
            // Regla nueva: si ya fue autorizado por Administración y tiene Acciones = Sí, va amarillo.
            const needsAdminActionsYellow = isDespachoColumn && adminAutorizado && adminAcciones;
            const needsAdminAuthRed = isDespachoColumn && vencida && !adminAutorizado;
            const isRefabricacion = String(p?.tipo || '').trim() === 'refabricacion';
            const hasDetalleRefab = isRefabricacion && String(p?.detalle_refabricacion || '').trim();

            // Refabricaciones tienen borde rojo propio (distinto al de admin)
            const borderStyle = isRefabricacion
              ? '2px solid #dc2626'
              : needsAdminActionsYellow ? '2px solid #f59e0b'
              : needsAdminAuthRed ? '2px solid #ef4444'
              : '1px solid var(--border)';
            const bgStyle = isRefabricacion
              ? '#fff5f5'
              : needsAdminActionsYellow ? '#fffbeb'
              : needsAdminAuthRed ? '#fff5f5'
              : 'var(--surface)';
            const shadowStyle = isRefabricacion
              ? '0 8px 22px rgba(220,38,38,0.18)'
              : needsAdminActionsYellow ? '0 8px 22px rgba(245,158,11,0.18)'
              : needsAdminAuthRed ? '0 8px 22px rgba(239,68,68,0.16)'
              : undefined;

            return (
              <div
                key={`${mode}-${p?.id ?? `${p?.nv}-${p?.nlista}-${p?.partida}`}`}
                style={{
                  border: borderStyle,
                  borderRadius: 12,
                  padding: '10px 12px',
                  background: bgStyle,
                  position: 'relative',
                  boxShadow: shadowStyle,
                }}
              >
                {hasObs ? (
                  <button
                    type="button"
                    onClick={() => { setObsTarget(p); setObsOpen(true); }}
                    title="Ver observaciones"
                    style={{ position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: 999, border: '1px solid #b91c1c', background: '#ef4444', color: '#fff', fontWeight: 900, cursor: 'pointer', display: 'grid', placeItems: 'center', boxShadow: '0 6px 18px rgba(0,0,0,0.18)' }}
                  >
                    !
                  </button>
                ) : null}

                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 900 }}>{getNvLabel(p)}</span>
                  {isRefabricacion ? (
                    <span style={{ fontSize: 11, fontWeight: 900, background: '#dc2626', color: '#fff', borderRadius: 4, padding: '2px 6px', letterSpacing: 0.3 }}>
                      Refabricación
                    </span>
                  ) : null}
                  {isDespachoColumn ? (() => {
                    const phone = String(p?.pq_phone ?? p?.cliente_telefono ?? '').trim().replace(/\D/g, '');
                    const mapsUrl = String(p?.pq_maps_url ?? p?.cliente_maps_url ?? p?.logistica_maps_url ?? '').trim();
                    return (
                      <>
                        {phone ? (
                          <a href={`https://wa.me/54${phone}`} target="_blank" rel="noopener noreferrer" title={`WhatsApp: +54 ${phone}`} style={{ display: 'inline-flex', alignItems: 'center', color: '#25D366', textDecoration: 'none' }}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-label="WhatsApp"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                          </a>
                        ) : null}
                        {mapsUrl ? (
                          <a href={mapsUrl} target="_blank" rel="noopener noreferrer" title="Ver en Google Maps" style={{ display: 'inline-flex', alignItems: 'center', color: '#EA4335', textDecoration: 'none' }}>
                            <svg width="16" height="18" viewBox="0 0 24 24" fill="currentColor" aria-label="Google Maps"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
                          </a>
                        ) : null}
                      </>
                    );
                  })() : null}
                </div>
                <div>
                  {isDespachoColumn ? (
                    <>Despacho: <b>{getSalidaWeekLabel(p)}</b></>
                  ) : (
                    <>Producción: <b>{getProdWeekLabel(p)}</b></>
                  )}
                  {isFechaEntregaActualizada(p) ? (
                    <span style={{ marginLeft: 6, fontSize: 11, background: '#dcfce7', color: '#15803d', border: '1px solid #86efac', borderRadius: 4, padding: '1px 5px', fontWeight: 700 }}>
                      Fecha actualizada
                    </span>
                  ) : null}
                </div>
                {isDespachoColumn ? (
                  <div style={{ fontSize: 12, opacity: 0.85 }}>
                    Fecha despacho: <b>{salida10 ? formatDate10DMY(salida10) : '—'}</b>
                  </div>
                ) : null}
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  Estado: {p?.[effKey] || ''}
                  {prod10 ? <> {' '}· Producción: <b>{formatDate10DMY(prod10)}</b></> : null}
                  {needsAdminActionsYellow ? <> {' '}· <b style={{ color: '#92400e' }}>Acciones administrativas</b></> : null}
                  {needsAdminAuthRed ? <> {' '}· <b style={{ color: '#b91c1c' }}>Cliente NO en regla (Administración)</b></> : null}
                </div>

                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  {isAnexo(p) || isLegacyImport(p) ? (
                    <button
                      className="btn"
                      type="button"
                      onClick={() => { setAnexoTarget(p); setAnexoOpen(true); }}
                      style={{ fontWeight: 900 }}
                      title={isLegacyImport(p) ? 'Ver ficha técnica del sistema anterior' : 'Ver detalle del ítem en el presupuestador'}
                    >
                      Ver
                    </button>
                  ) : null}

                  {hasDetalleRefab ? (
                    <button
                      className="btn"
                      type="button"
                      onClick={() => { setDetalleRefabTarget(p); setDetalleRefabOpen(true); }}
                      style={{ fontWeight: 900, background: '#dc2626', color: '#fff', borderColor: '#b91c1c' }}
                      title="Ver detalle de refabricación"
                    >
                      Detalle
                    </button>
                  ) : null}

                  {String(p?.observacion_imput || '').trim() ? (
                    <button
                      className="btn"
                      type="button"
                      onClick={() => { setPreObsTarget(p); setPreObsOpen(true); }}
                      style={{ fontWeight: 900, background: '#16a34a', color: '#fff', borderColor: '#15803d' }}
                      title="Ver observación de preproducción"
                    >
                      OBS
                    </button>
                  ) : null}

                  {isLaserColumn ? (
                    <button className="btn" type="button" onClick={() => { setDatosTarget(p); setDatosOpen(true); }} style={{ fontWeight: 900 }} title="Ver datos del sector Laser">Datos</button>
                  ) : null}

                  <button
                    className="btn"
                    type="button"
                    onClick={() => { setQcTarget(p); setQcForceComplete(false); setQcOpen(true); }}
                    style={{ fontWeight: 900 }}
                  >
                    QC
                  </button>

                  {needsAdminActionsYellow ? (
                    <button
                      className="btn"
                      type="button"
                      onClick={() => { setAdminAccionesTarget(p); setAdminAccionesOpen(true); }}
                      style={{ fontWeight: 900, borderColor: '#f59e0b', background: '#fffbeb', color: '#92400e' }}
                      title={adminAccionesDetalle ? 'Ver detalle de acciones administrativas' : 'Acciones sin detalle'}
                    >
                      Acciones
                    </button>
                  ) : null}

                  <button className="btn btn--brand" onClick={() => onStart && onStart(p.id, effKey)} disabled={!canStart || disabledId === p.id}>▶</button>
                  <button className="btn" onClick={() => handleStopAndOpenQc(p)} disabled={!canStop || disabledId === p.id}>⏹</button>
                </div>
              </div>
            );
          })}
      </div>

      <HistoryModal open={histOpen} onClose={() => setHistOpen(false)} title={title} effKey={String(effKey || '').trim()} rows={historyLast10} />
      <PortonHistoryModal open={portonHistOpen} onClose={() => setPortonHistOpen(false)} title={title} effKey={String(effKey || '').trim()} items={allItems} mode={mode} />
      <DatosModal open={datosOpen} onClose={() => { setDatosOpen(false); setDatosTarget(null); }} item={datosTarget} title={title} />
      <AnexoDetailModal open={anexoOpen} onClose={() => { setAnexoOpen(false); setAnexoTarget(null); }} item={anexoTarget} />
      <PreObsModal open={preObsOpen} onClose={() => { setPreObsOpen(false); setPreObsTarget(null); }} item={preObsTarget} />
      <QcModal open={qcOpen} onClose={() => { setQcOpen(false); setQcTarget(null); setQcForceComplete(false); }} item={qcTarget} line={getItemQcLine(qcTarget) || line} stageKey={effKey} title={title} onSaved={() => onQcSaved?.()} forceComplete={qcForceComplete} />
      <AdminAccionesModal open={adminAccionesOpen} onClose={() => { setAdminAccionesOpen(false); setAdminAccionesTarget(null); }} title={title} item={adminAccionesTarget} />
      <ObservacionesModal open={obsOpen} onClose={() => { setObsOpen(false); setObsTarget(null); }} title={title} item={obsTarget} line={getItemQcLine(obsTarget) || line} despacho={isDespachoColumn} portonByNv={portonByNv} />
      <DetalleRefabricacionModal open={detalleRefabOpen} onClose={() => { setDetalleRefabOpen(false); setDetalleRefabTarget(null); }} item={detalleRefabTarget} />
      {mode === 'porton' ? (
        <NuevoPedidoPrefabricadoModal
          open={nuevoPedidoOpen}
          onClose={() => setNuevoPedidoOpen(false)}
          tipos={eligiblePrefabTipos}
          seccion={stageKey}
          seccionLabel={title}
          onCreate={onCreatePrefabOrden}
          historial={prefabHistorialSeccion}
        />
      ) : null}
    </div>
  );
}
