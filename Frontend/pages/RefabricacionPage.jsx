// pages/RefabricacionPage.jsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchRefabricacionPendientes, crearRefabricacion, aprobarRevision } from '../src/api';

const ETAPAS = [
  { key: 'diseno',               label: 'Diseño Tubos' },
  { key: 'diseno_piernas',       label: 'Diseño Piernas' },
  { key: 'diseno_revestimiento', label: 'Diseño Revestimiento' },
  { key: 'laser_dintel',         label: 'Laser tubos Dintel' },
  { key: 'laser_hojas',          label: 'Laser tubos Hojas' },
  { key: 'laser_brazos_espada',  label: 'Laser tubos Brazos y Espada' },
  { key: 'guillotina',           label: 'Corte piernas' },
  { key: 'corte_revest',         label: 'Corte revestimiento' },
  { key: 'corte_dintel',         label: 'Corte dintel' },
  { key: 'plegadora',            label: 'Plegado piernas' },
  { key: 'plegado_revest',       label: 'Plegado revestimiento' },
  { key: 'plegado_dintel',       label: 'Plegado dintel' },
  { key: 'armado_piernas',       label: 'Armado piernas' },
  { key: 'armado_dintel',        label: 'Armado dintel' },
  { key: 'armado_marco_piernas', label: 'Armado marco piernas' },
  { key: 'armado_hojas',         label: 'Armado hojas' },
  { key: 'armado_primario',      label: 'Armado primario' },
  { key: 'revestimiento',        label: 'Revestimiento' },
  { key: 'pintura',              label: 'Pintura' },
  { key: 'pintura_revestimiento',label: 'Pintura revestimiento' },
  { key: 'inyeccion',            label: 'Inyección' },
  { key: 'armado_final',         label: 'Armado final' },
];

function pad2(n) { return String(n).padStart(2, '0'); }
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function fmt(dt) {
  return dt
    ? new Date(dt).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })
    : '—';
}

// ───── Modal shell ─────
function Modal({ open, onClose, title, children, width = 'min(680px,100%)' }) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 9999 }}
    >
      <div style={{ width, background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', boxShadow: '0 18px 55px rgba(0,0,0,0.25)', overflow: 'hidden' }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, background: '#f8fafc' }}>
          <div style={{ fontWeight: 900 }}>{title}</div>
          <button className="btn" type="button" onClick={onClose}>Cerrar</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ───── Modal PIN QC (para aprobar despacho) ─────
function QcPinModal({ open, onClose, onConfirm, title, loading }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) { setPin(''); setErr(''); setTimeout(() => inputRef.current?.focus(), 80); }
  }, [open]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!/^\d{3,10}$/.test(pin.trim())) {
      setErr('PIN inválido: solo números, entre 3 y 10 dígitos');
      return;
    }
    onConfirm(pin.trim());
  };

  if (!open) return null;
  return (
    <Modal open={open} onClose={onClose} title={title || 'Confirmar con PIN QC'} width="min(380px,100%)">
      <form onSubmit={handleSubmit} style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {err && <div style={{ color: 'crimson', fontWeight: 800 }}>{err}</div>}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontWeight: 800 }}>PIN de QC global</span>
          <input
            ref={inputRef}
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => { setPin(e.target.value); setErr(''); }}
            placeholder="Ingresá tu PIN"
            className="btn"
            style={{ letterSpacing: 4, fontSize: 18 }}
          />
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn btn--brand" disabled={loading}>
            {loading ? 'Validando…' : 'Confirmar'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ───── Modal crear refabricación ─────
function RefabricacionModal({ open, onClose, porton, onCreated }) {
  const [fechaProd, setFechaProd] = useState(todayISO());
  const [detalle, setDetalle] = useState('');
  const [etapasARealizar, setEtapasARealizar] = useState([]);
  const [pin, setPin] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open) return;
    setFechaProd(todayISO());
    setDetalle('');
    setEtapasARealizar([]);
    setPin('');
    setErr('');
    setSaving(false);
  }, [open, porton?.id]);

  const toggleEtapa = (key) => {
    setEtapasARealizar((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  };

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    setErr('');
    if (!porton?.nv) { setErr('Portón inválido'); return; }
    if (etapasARealizar.length === 0) { setErr('Seleccioná al menos una sección a fabricar'); return; }
    if (!/^\d{3,10}$/.test(pin.trim())) { setErr('PIN inválido (solo números, 3-10 dígitos)'); return; }
    try {
      setSaving(true);
      await crearRefabricacion({
        parent_nv: porton.nv,
        pin: pin.trim(),
        fecha_prod: fechaProd || null,
        detalle_refabricacion: detalle.trim() || null,
        etapas_a_realizar: etapasARealizar,
      });
      alert(`Refabricación creada para NV ${porton.nv} · Portón ${porton.nlista}`);
      onCreated?.();
      onClose?.();
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!open || !porton) return null;

  return (
    <Modal open={open} onClose={onClose} title={`Nueva Refabricación · NV ${porton.nv} · Portón ${porton.nlista}`} width="min(720px,100%)">
      <form onSubmit={handleSubmit} style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {err && <div style={{ color: 'crimson', fontWeight: 800 }}>{err}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontWeight: 800 }}>Fecha de producción</span>
            <input
              className="btn"
              type="date"
              value={fechaProd}
              onChange={(e) => setFechaProd(e.target.value)}
            />
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontWeight: 800, fontSize: 13 }}>Sistema: <b>{porton.sistema || '—'}</b></span>
            <span style={{ fontSize: 13 }}>NV: <b>{porton.nv}</b> · Portón: <b>{porton.nlista}</b> · Partida: <b>{porton.partida}</b></span>
          </div>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontWeight: 800 }}>Detalle de la acción</span>
          <textarea
            className="btn"
            value={detalle}
            onChange={(e) => setDetalle(e.target.value)}
            rows={3}
            placeholder="Describí el motivo y la acción a realizar en la refabricación…"
            style={{ resize: 'vertical', fontFamily: 'inherit', fontSize: 14 }}
          />
        </label>

        <div>
          <div style={{ fontWeight: 800, marginBottom: 4 }}>Secciones a fabricar (marcá las que sí deben producirse)</div>
          <div style={{ fontSize: 12, opacity: 0.65, marginBottom: 8 }}>
            Las marcadas quedan como Pendiente en el flujo; el resto se da por finalizado.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {ETAPAS.map((e) => {
              const checked = etapasARealizar.includes(e.key);
              return (
                <label
                  key={e.key}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                    border: checked ? '2px solid #dc2626' : '1px solid #d1d5db',
                    borderRadius: 8, padding: '5px 10px',
                    background: checked ? '#fff5f5' : '#fff',
                    fontWeight: checked ? 800 : 500,
                    fontSize: 13,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleEtapa(e.key)}
                    style={{ accentColor: '#dc2626' }}
                  />
                  {e.label}
                </label>
              );
            })}
          </div>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontWeight: 800 }}>PIN de QC (usuario global)</span>
          <input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="Ingresá tu PIN para autorizar"
            className="btn"
            style={{ maxWidth: 200, letterSpacing: 4 }}
          />
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn btn--brand" type="submit" disabled={saving}>
            {saving ? 'Creando…' : 'Crear Refabricación'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ───── Badge de estado de refabricación ─────
function RefabricacionBadge({ r }) {
  if (!r) return null;

  const desp = r.despacho;
  let resumenColor, resumenLabel;
  if (desp === 'Finalizado') {
    resumenColor = '#16a34a'; resumenLabel = 'Despachada';
  } else if (desp === 'En Proceso' || desp === 'Pendiente') {
    resumenColor = '#2563eb'; resumenLabel = 'En despacho';
  } else if (r.etapas_proceso) {
    resumenColor = '#d97706'; resumenLabel = 'En producción';
  } else if (r.etapas_pendiente) {
    resumenColor = '#6b7280'; resumenLabel = 'Pendiente de iniciar';
  } else {
    resumenColor = '#16a34a'; resumenLabel = 'Finalizada';
  }

  return (
    <div style={{
      marginTop: 4,
      border: '1.5px solid #fca5a5',
      borderRadius: 8,
      padding: '8px 10px',
      background: '#fff5f5',
      fontSize: 12,
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 900, background: '#dc2626', color: '#fff', borderRadius: 4, padding: '1px 7px', fontSize: 11 }}>
          Refabricación
        </span>
        <span style={{ fontWeight: 800, color: resumenColor }}>
          {resumenLabel}
        </span>
        <span style={{ opacity: 0.5 }}>{fmt(r.created_at)}</span>
      </div>
      {r.detalle && (
        <div style={{ opacity: 0.75 }}><b>Motivo:</b> {r.detalle}</div>
      )}
      {r.etapas_proceso && (
        <div style={{ color: '#d97706', fontWeight: 700 }}>
          En proceso: <b>{r.etapas_proceso}</b>
        </div>
      )}
      {r.etapas_pendiente && (
        <div style={{ color: '#6b7280' }}>
          Pendiente: {r.etapas_pendiente}
        </div>
      )}
      {r.etapas_finalizado && (
        <div style={{ color: '#16a34a' }}>
          Finalizado: {r.etapas_finalizado}
        </div>
      )}
    </div>
  );
}

// ───── Tarjeta de portón ─────
function PortonCard({ porton, tipo, onRefabricar, onAprobar }) {
  const motivoLabel = porton.ultimo_qc_motive_label || '—';
  const fecha = fmt(porton.ultimo_qc_fecha);
  const isAprobado = Boolean(porton.revision_ok);
  const enDespacho = porton.despacho_estado != null;
  const refab = porton.ultima_refabricacion || null;

  return (
    <div style={{
      border: tipo === 'RECHAZADO' ? '2px solid #dc2626' : '2px solid #f59e0b',
      borderRadius: 12, padding: '12px 14px',
      background: tipo === 'RECHAZADO' ? '#fff5f5' : '#fffbeb',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div>
          <span style={{ fontWeight: 900 }}>NV {porton.nv}</span>
          {' · '}
          <span style={{ fontWeight: 700 }}>Portón {porton.nlista}</span>
          {' · '}
          <span style={{ fontSize: 12, opacity: 0.75 }}>Partida {porton.partida}</span>
        </div>
        {isAprobado && (
          <span style={{ fontSize: 11, fontWeight: 900, background: '#16a34a', color: '#fff', borderRadius: 4, padding: '2px 6px' }}>
            Aprobado ✓ {porton.revision_ok_at ? fmt(porton.revision_ok_at) : ''}
          </span>
        )}
      </div>

      <div style={{ fontSize: 13 }}>
        <b>Sistema:</b> {porton.sistema || '—'} &nbsp;·&nbsp;
        <b>Estado:</b>{' '}
        <span style={{ fontWeight: 900, color: tipo === 'RECHAZADO' ? '#b91c1c' : '#92400e' }}>
          {tipo}
        </span>
      </div>

      <div style={{ fontSize: 13 }}>
        <b>Motivo:</b> {motivoLabel} &nbsp;·&nbsp;
        <b>Sector:</b> {porton.ultimo_qc_stage || '—'} &nbsp;·&nbsp;
        <b>Fecha:</b> {fecha} &nbsp;·&nbsp;
        <b>Firmado por:</b> {porton.ultimo_qc_usuario || '—'}
      </div>

      {porton.ultimo_qc_note && (
        <div style={{ fontSize: 12, background: 'rgba(0,0,0,0.04)', borderRadius: 6, padding: '4px 8px' }}>
          <b>Nota:</b> {porton.ultimo_qc_note}
        </div>
      )}

      {porton.etapas_en_proceso && (
        <div style={{ fontSize: 12, fontWeight: 700, color: '#1d4ed8' }}>
          En proceso: <b>{porton.etapas_en_proceso}</b>
        </div>
      )}

      {enDespacho && (
        <div style={{ fontSize: 12, fontWeight: 700, color: '#15803d' }}>
          En cola de despacho: <b>{porton.despacho_estado}</b>
        </div>
      )}

      <RefabricacionBadge r={refab} />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
        <button
          className="btn btn--brand"
          type="button"
          onClick={() => onRefabricar(porton)}
        >
          Refabricar
        </button>

        {!isAprobado && (
          <button
            className="btn"
            type="button"
            onClick={() => onAprobar(porton)}
            style={{ borderColor: '#16a34a', color: '#15803d', fontWeight: 900 }}
          >
            Aprobar → Despacho
          </button>
        )}
      </div>
    </div>
  );
}

// ───── Página principal ─────
export default function RefabricacionPage() {
  const [observados, setObservados] = useState([]);
  const [rechazados, setRechazados] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const [refabModal, setRefabModal] = useState(false);
  const [refabTarget, setRefabTarget] = useState(null);

  const [pinModal, setPinModal] = useState(false);
  const [pinTarget, setPinTarget] = useState(null);
  const [pinLoading, setPinLoading] = useState(false);

  const load = useCallback(async () => {
    setErr('');
    setLoading(true);
    try {
      const { data } = await fetchRefabricacionPendientes();
      setObservados(Array.isArray(data?.observados) ? data.observados : []);
      setRechazados(Array.isArray(data?.rechazados) ? data.rechazados : []);
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAprobar = (porton) => {
    setPinTarget(porton);
    setPinModal(true);
  };

  const handlePinConfirm = async (pin) => {
    if (!pinTarget) return;
    setPinLoading(true);
    try {
      await aprobarRevision(pinTarget.nv, pin);
      setPinModal(false);
      setPinTarget(null);
      await load();
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    } finally {
      setPinLoading(false);
    }
  };

  const handleRefabricar = (porton) => {
    setRefabTarget(porton);
    setRefabModal(true);
  };

  const total = observados.length + rechazados.length;

  return (
    <div className="container">
      <div className="header-row">
        <h2 className="h1" style={{ borderColor: '#dc2626' }}>Revisión de Calidad · Observados / Rechazados</h2>
        <button className="btn btn--brand" onClick={load} disabled={loading}>
          {loading ? 'Cargando…' : 'Actualizar'}
        </button>
      </div>

      {err && (
        <div style={{ color: 'crimson', fontWeight: 800, marginBottom: 12 }}>{err}</div>
      )}

      {!loading && total === 0 && !err && (
        <div style={{ padding: 20, border: '1px solid #e5e7eb', borderRadius: 12, background: '#f8fafc', textAlign: 'center', opacity: 0.7 }}>
          No hay portones observados ni rechazados pendientes de revisión.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
        {/* Columna OBSERVADOS */}
        <div>
          <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 10, color: '#92400e', borderBottom: '2px solid #f59e0b', paddingBottom: 6 }}>
            Observados ({observados.length})
          </div>
          {observados.length === 0 && !loading ? (
            <div style={{ opacity: 0.55, fontSize: 13 }}>Sin observados pendientes.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {observados.map((p) => (
                <PortonCard
                  key={`obs-${p.id}`}
                  porton={p}
                  tipo="OBSERVADO"
                  onRefabricar={handleRefabricar}
                  onAprobar={handleAprobar}
                />
              ))}
            </div>
          )}
        </div>

        {/* Columna RECHAZADOS */}
        <div>
          <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 10, color: '#b91c1c', borderBottom: '2px solid #dc2626', paddingBottom: 6 }}>
            Rechazados ({rechazados.length})
          </div>
          {rechazados.length === 0 && !loading ? (
            <div style={{ opacity: 0.55, fontSize: 13 }}>Sin rechazados pendientes.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {rechazados.map((p) => (
                <PortonCard
                  key={`rec-${p.id}`}
                  porton={p}
                  tipo="RECHAZADO"
                  onRefabricar={handleRefabricar}
                  onAprobar={handleAprobar}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <RefabricacionModal
        open={refabModal}
        onClose={() => { setRefabModal(false); setRefabTarget(null); }}
        porton={refabTarget}
        onCreated={load}
      />

      <QcPinModal
        open={pinModal}
        onClose={() => { setPinModal(false); setPinTarget(null); }}
        onConfirm={handlePinConfirm}
        title={pinTarget ? `Aprobar NV ${pinTarget.nv} · Portón ${pinTarget.nlista} → Despacho` : 'Confirmar'}
        loading={pinLoading}
      />
    </div>
  );
}
