// src/components/ServicioTecnicoViajeSemanaModal.jsx
//
// Espejo de LogisticaViajeSemanaModal.jsx: dentro de una semana, arma viajes
// de Servicio Técnico (fecha + zona + cuadrilla + vehículo) y reparte en
// ellos los items pendientes (solicitudes de ST + mediciones), arrastrando
// desde el pool a cada columna de viaje. Sin peso/capacidad (no aplica al
// dominio: una visita técnica no "pesa" como un despacho de portones).
import React, { useCallback, useEffect, useState } from 'react';
import {
  fetchStSemanaDetalle, fetchStViajesConfig,
  crearStViaje, patchStViaje, borrarStViaje,
  asignarStItem, desasignarStItem, reordenarStViaje,
  cerrarStSemana, reabrirStSemana,
  fetchStLogisticaSombra,
} from '../api';
import { isoWeekStartEndFromLabel, weekTitleFromSelection, todayISO10 } from '../utils/isoWeek';
import ServicioTecnicoConfigModal from './modals/ServicioTecnicoConfigModal';

const DND_MIME = 'application/x-st-viaje-item';

const TIPO_COLOR = { solicitud: '#7c3aed', medicion: '#0891b2' };

function ItemChip({ item, draggable, onDragStart, busy, ordenNum }) {
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      style={{
        border: '1px solid var(--border)', borderLeft: `4px solid ${TIPO_COLOR[item.tipo]}`, borderRadius: 8, padding: '6px 8px',
        cursor: draggable ? 'grab' : 'default', opacity: busy ? 0.5 : 1, fontSize: 11, background: 'var(--surface)',
      }}
    >
      <div style={{ fontWeight: 800 }}>
        {ordenNum != null ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 15, height: 15, borderRadius: 999, background: '#dc2626', color: '#fff', fontSize: 9, fontWeight: 900, marginRight: 4, verticalAlign: 1 }}>
            {ordenNum}
          </span>
        ) : null}
        {item.tipo === 'solicitud' ? '🔧' : '📏'} {item.nv ? `NV ${item.nv}` : 'Sin NV'}
      </div>
      <div style={{ opacity: 0.8 }}>{item.nombre_cliente || item.descripcion || '—'}</div>
    </div>
  );
}

function NuevoViajeForm({ semana, config, onCreate, onCancel, busy, initial, submitLabel }) {
  const { start, end } = isoWeekStartEndFromLabel(semana);
  const hoy = todayISO10();
  const [form, setForm] = useState(() => ({
    fecha: initial?.fecha || (hoy >= start && hoy <= end ? hoy : start),
    zona_id: initial?.zona_id ? String(initial.zona_id) : '',
    cuadrilla_id: initial?.cuadrilla_id ? String(initial.cuadrilla_id) : '',
    vehiculo_id: initial?.vehiculo_id ? String(initial.vehiculo_id) : '',
    nombre: initial?.nombre || '',
  }));

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 10, marginBottom: 10 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
          Fecha
          <input className="pp-input" type="date" min={start} max={end} value={form.fecha} onChange={(e) => setForm((f) => ({ ...f, fecha: e.target.value }))} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
          Zona
          <select className="pp-select" value={form.zona_id} onChange={(e) => setForm((f) => ({ ...f, zona_id: e.target.value }))}>
            <option value="">—</option>
            {(config?.zonas || []).map((z) => <option key={z.id} value={z.id}>{z.nombre}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
          Cuadrilla
          <select className="pp-select" value={form.cuadrilla_id} onChange={(e) => setForm((f) => ({ ...f, cuadrilla_id: e.target.value }))}>
            <option value="">—</option>
            {(config?.cuadrillas || []).filter((c) => c.activo).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
          Vehículo
          <select className="pp-select" value={form.vehiculo_id} onChange={(e) => setForm((f) => ({ ...f, vehiculo_id: e.target.value }))}>
            <option value="">—</option>
            {(config?.vehiculos || []).filter((v) => v.activo).map((v) => <option key={v.id} value={v.id}>{v.nombre}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
          Nombre
          <input className="pp-input" style={{ width: 160 }} value={form.nombre} onChange={(e) => setForm((f) => ({ ...f, nombre: e.target.value }))} placeholder="Opcional" />
        </label>
        <button className="btn" disabled={busy} onClick={onCancel}>Cancelar</button>
        <button
          className="btn btn--brand" disabled={busy || !form.fecha}
          onClick={() => onCreate({
            fecha: form.fecha,
            zona_id: form.zona_id ? Number(form.zona_id) : null,
            cuadrilla_id: form.cuadrilla_id ? Number(form.cuadrilla_id) : null,
            vehiculo_id: form.vehiculo_id ? Number(form.vehiculo_id) : null,
            nombre: form.nombre || null,
          })}
        >
          {submitLabel || 'Crear viaje'}
        </button>
      </div>
    </div>
  );
}

function ViajeColumn({ viaje, items, canEdit, onDrop, onReorder, onDragStartChip, onDesasignar, onEditar, onBorrar, busySet }) {
  const [over, setOver] = useState(false);
  const [dragOverIndex, setDragOverIndex] = useState(null);
  return (
    <div
      onDragOver={(e) => { if (!canEdit) return; e.preventDefault(); setOver(true); }}
      onDragLeave={() => { setOver(false); setDragOverIndex(null); }}
      onDrop={(e) => {
        if (!canEdit) return;
        e.preventDefault();
        setOver(false);
        setDragOverIndex(null);
        // Si soltó sobre un chip puntual, ese chip ya frenó la propagación
        // (más abajo) - esto solo cubre el área vacía de la columna.
        onDrop(viaje.id, e);
      }}
      style={{
        minWidth: 220, maxWidth: 220, display: 'flex', flexDirection: 'column', gap: 6,
        border: `1px solid ${over ? 'var(--brand)' : 'var(--border)'}`, borderRadius: 12, padding: 10,
        background: over ? 'var(--brand-100)' : 'var(--surface)',
      }}
    >
      <div>
        <div style={{ fontWeight: 900, fontSize: 12 }}>{viaje.nombre || `Viaje #${viaje.id}`}</div>
        <div style={{ fontSize: 10, opacity: 0.7 }}>
          {viaje.fecha} {viaje.zona_nombre ? `· ${viaje.zona_nombre}` : ''}
        </div>
        <div style={{ fontSize: 10, opacity: 0.7 }}>{viaje.vehiculo_nombre || 'sin vehículo'} · {viaje.cuadrilla_nombre || 'sin cuadrilla'}</div>
        {canEdit ? (
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
            <button className="btn" style={{ fontSize: 10, padding: '1px 6px' }} onClick={() => onEditar(viaje)}>Editar</button>
            <button className="btn" style={{ fontSize: 10, padding: '1px 6px', borderColor: '#ef4444', color: '#991b1b' }} onClick={() => onBorrar(viaje)}>Borrar</button>
          </div>
        ) : null}
      </div>
      {canEdit && items.length > 1 ? (
        <div style={{ fontSize: 9, opacity: 0.55 }}>Arrastrá para reordenar la ruta.</div>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minHeight: 40 }}>
        {items.length === 0 ? <div style={{ fontSize: 10, opacity: 0.5 }}>Arrastrá items acá.</div> : null}
        {items.map((it, idx) => (
          <div
            key={it.id}
            style={{ position: 'relative' }}
            onDragOver={(e) => { if (!canEdit) return; e.preventDefault(); setDragOverIndex(idx); }}
            onDrop={(e) => {
              if (!canEdit) return;
              e.preventDefault();
              e.stopPropagation();
              setOver(false);
              setDragOverIndex(null);
              onReorder(viaje.id, e, idx);
            }}
          >
            {dragOverIndex === idx ? <div style={{ height: 3, background: 'var(--brand)', borderRadius: 2, marginBottom: 3 }} /> : null}
            <ItemChip item={it} draggable={canEdit} busy={busySet.has(it.id)} onDragStart={(e) => onDragStartChip(e, it)} ordenNum={items.length > 1 ? idx + 1 : null} />
            {canEdit ? (
              <button
                onClick={() => onDesasignar(viaje.id, it)}
                style={{ position: 'absolute', top: 2, right: 2, border: 'none', background: 'none', cursor: 'pointer', color: '#991b1b', fontWeight: 900, fontSize: 12 }}
                title="Quitar del viaje"
              >×</button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

// Chip de solo lectura para un portón de Logística (despacho o instalación).
function LogisticaSombraChip({ item }) {
  return (
    <div
      style={{
        border: '1px dashed var(--border)', borderRadius: 8, padding: '5px 8px',
        fontSize: 11, background: 'var(--surface-muted, #f9fafb)', opacity: 0.9,
      }}
      title={item.direccion || ''}
    >
      <div style={{ fontWeight: 800 }}>
        {item.tipo === 'despacho' ? '📦' : '🔧'} NV {item.nv} <span style={{ fontWeight: 400, opacity: 0.7 }}>({item.tipo === 'despacho' ? 'despacho' : 'instalación'})</span>
      </div>
      <div style={{ opacity: 0.8 }}>{item.nombre?.trim() || item.direccion?.trim() || '—'}</div>
    </div>
  );
}

// Columna de un viaje de Logística, de solo lectura (sin drag, sin editar/borrar).
function LogisticaSombraColumn({ viaje, items }) {
  return (
    <div
      style={{
        minWidth: 210, maxWidth: 210, display: 'flex', flexDirection: 'column', gap: 6,
        border: '1px dashed var(--border)', borderRadius: 12, padding: 10, background: 'var(--surface)',
      }}
    >
      <div>
        <div style={{ fontWeight: 900, fontSize: 12 }}>🔒 {viaje.nombre?.trim() || `Viaje #${viaje.id}`}</div>
        <div style={{ fontSize: 10, opacity: 0.7 }}>
          {String(viaje.fecha).slice(0, 10)} {viaje.zona_nombre ? `· ${viaje.zona_nombre}` : ''}
        </div>
        <div style={{ fontSize: 10, opacity: 0.7 }}>{viaje.vehiculo_nombre || 'sin vehículo'} · {viaje.cuadrilla_nombre || 'sin cuadrilla'}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minHeight: 30 }}>
        {items.length === 0 ? <div style={{ fontSize: 10, opacity: 0.5 }}>Sin portones.</div> : null}
        {items.map((it) => <LogisticaSombraChip key={`${it.porton_id}-${it.tipo}`} item={it} />)}
      </div>
    </div>
  );
}

export default function ServicioTecnicoViajeSemanaModal({ semana, open, canEdit, onClose, onChanged }) {
  const [detalle, setDetalle] = useState(null);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [busySet, setBusySet] = useState(() => new Set());
  const [showNuevoViaje, setShowNuevoViaje] = useState(false);
  const [editandoViaje, setEditandoViaje] = useState(null);
  const [showConfig, setShowConfig] = useState(false);

  // "Sombra" de Logística: apagado por defecto, el usuario lo prende para ver
  // (solo lectura) lo que Logística ya planificó en la misma semana.
  const [showSombra, setShowSombra] = useState(false);
  const [sombra, setSombra] = useState(null);
  const [sombraLoading, setSombraLoading] = useState(false);
  const [sombraErr, setSombraErr] = useState('');

  const load = useCallback(async () => {
    if (!semana) return;
    setErr('');
    setLoading(true);
    try {
      const [d, c] = await Promise.all([fetchStSemanaDetalle(semana), fetchStViajesConfig()]);
      setDetalle(d?.detalle || null);
      setConfig(c?.config || null);
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [semana]);

  useEffect(() => { if (open) load(); }, [open, load]);

  const reloadDetalle = useCallback(async () => {
    if (!semana) return;
    const d = await fetchStSemanaDetalle(semana);
    setDetalle(d?.detalle || null);
  }, [semana]);
  const reloadConfig = useCallback(async () => {
    const c = await fetchStViajesConfig();
    setConfig(c?.config || null);
  }, []);

  const loadSombra = useCallback(async () => {
    if (!semana) return;
    setSombraErr('');
    setSombraLoading(true);
    try {
      const d = await fetchStLogisticaSombra(semana);
      setSombra(d?.detalle || null);
    } catch (e) {
      setSombraErr(e?.response?.data?.error || e.message);
    } finally {
      setSombraLoading(false);
    }
  }, [semana]);

  useEffect(() => {
    if (open && showSombra) loadSombra();
    if (!open || !showSombra) { setSombra(null); setSombraErr(''); }
  }, [open, showSombra, semana, loadSombra]);

  const [poolOver, setPoolOver] = useState(false);

  if (!open) return null;

  const cerrada = !!detalle?.cerrada;

  const runMutation = async (fn) => {
    setBusy(true);
    setErr('');
    try {
      const res = await fn();
      if (res?.detalle) setDetalle(res.detalle);
      else await reloadDetalle();
      onChanged?.();
      return true;
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const crearViaje = (payload) => runMutation(() => crearStViaje(semana, payload)).then((ok) => { if (ok) setShowNuevoViaje(false); });
  const guardarEdicionViaje = (payload) => runMutation(() => patchStViaje(editandoViaje.id, payload)).then((ok) => { if (ok) setEditandoViaje(null); });
  const borrarViaje = (viaje) => {
    if (!window.confirm(`¿Borrar "${viaje.nombre || `Viaje #${viaje.id}`}"? Los items quedan sin asignar.`)) return;
    runMutation(() => borrarStViaje(viaje.id));
  };

  const onDragStartChip = (e, item) => {
    e.dataTransfer.setData(DND_MIME, JSON.stringify({ tipo: item.tipo, id: item.id, solicitud_id: item.solicitud_id, quote_id: item.quote_id }));
    e.dataTransfer.effectAllowed = 'move';
  };

  // Reordena DENTRO de una misma columna (o asigna si viene de otro lado)
  // según en qué posición soltó - mismo criterio que Logística.
  const handleReorder = (viajeId, payload, targetIndex) => {
    if (!payload?.id) return;

    if (payload.viaje_id !== viajeId) {
      setBusySet((prev) => new Set(prev).add(payload.id));
      runMutation(() => asignarStItem(viajeId, { tipo: payload.tipo, solicitud_id: payload.solicitud_id, quote_id: payload.quote_id }))
        .finally(() => setBusySet((prev) => { const n = new Set(prev); n.delete(payload.id); return n; }));
      return;
    }

    const actuales = itemsByViaje.get(viajeId) || [];
    const origenIdx = actuales.findIndex((it) => it.id === payload.id);
    const sinArrastrado = actuales.filter((it) => it.id !== payload.id);

    let destino = targetIndex;
    if (origenIdx !== -1 && origenIdx < targetIndex) destino -= 1;
    destino = Math.max(0, Math.min(destino, sinArrastrado.length));
    if (origenIdx === destino) return;

    const reordenado = [...sinArrastrado];
    reordenado.splice(destino, 0, { id: payload.id, tipo: payload.tipo, solicitud_id: payload.solicitud_id, quote_id: payload.quote_id });

    setBusySet((prev) => new Set(prev).add(payload.id));
    runMutation(() => reordenarStViaje(viajeId, reordenado.map((it) => ({ tipo: it.tipo, solicitud_id: it.solicitud_id, quote_id: it.quote_id }))))
      .finally(() => setBusySet((prev) => { const n = new Set(prev); n.delete(payload.id); return n; }));
  };

  const onReorderDrop = (viajeId, e, targetIndex) => {
    const raw = e.dataTransfer.getData(DND_MIME);
    if (!raw) return;
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    handleReorder(viajeId, payload, targetIndex);
  };

  const onDropToViaje = (viajeId, e) => {
    const raw = e.dataTransfer.getData(DND_MIME);
    if (!raw) return;
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    if (payload.viaje_id === viajeId) {
      // Soltó en el área vacía de su propia columna: al final de la ruta.
      const actuales = itemsByViaje.get(viajeId) || [];
      handleReorder(viajeId, payload, actuales.length);
      return;
    }
    setBusySet((prev) => new Set(prev).add(payload.id));
    runMutation(() => asignarStItem(viajeId, { tipo: payload.tipo, solicitud_id: payload.solicitud_id, quote_id: payload.quote_id }))
      .finally(() => setBusySet((prev) => { const n = new Set(prev); n.delete(payload.id); return n; }));
  };

  const onDesasignar = (viajeId, item) => {
    setBusySet((prev) => new Set(prev).add(item.id));
    runMutation(() => desasignarStItem(viajeId, item.tipo, item.tipo === 'solicitud' ? item.solicitud_id : item.quote_id))
      .finally(() => setBusySet((prev) => { const n = new Set(prev); n.delete(item.id); return n; }));
  };

  const onDropToPool = (e) => {
    const raw = e.dataTransfer.getData(DND_MIME);
    if (!raw) return;
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    const item = (detalle?.items || []).find((it) => it.id === payload.id);
    if (!item || item.viaje_id == null) return;
    onDesasignar(item.viaje_id, item);
  };

  const pool = (detalle?.items || []).filter((it) => it.viaje_id == null);
  const itemsByViaje = new Map();
  for (const it of (detalle?.items || [])) {
    if (it.viaje_id == null) continue;
    if (!itemsByViaje.has(it.viaje_id)) itemsByViaje.set(it.viaje_id, []);
    itemsByViaje.get(it.viaje_id).push(it);
  }
  // orden = orden real de la ruta (primero el que queda arriba). Empate en 0
  // (items agregados antes de que existiera esta columna) se desempata por
  // id para que sea estable hasta que el usuario los reordene.
  for (const arr of itemsByViaje.values()) arr.sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0) || String(a.id).localeCompare(String(b.id)));

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div style={{ width: 'min(1500px, 100%)', height: 'min(920px, 96vh)', background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)', boxShadow: '0 12px 32px rgba(0,0,0,0.25)', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 900, fontSize: 16 }}>
            {semana ? weekTitleFromSelection(semana) : ''} {cerrada ? <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 800, padding: '2px 8px', borderRadius: 999, background: 'var(--brand)', color: '#fff' }}>Cerrada</span> : null}
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={showSombra} onChange={(e) => setShowSombra(e.target.checked)} />
              👁️ Ver plan de Logística (solo lectura)
            </label>
            {canEdit ? <button className="btn" onClick={() => setShowConfig(true)}>Vehículos / Cuadrillas</button> : null}
            <button className="btn" onClick={onClose}>Cerrar ventana</button>
          </div>
        </div>

        {err ? <div style={{ color: 'crimson', fontWeight: 800, fontSize: 12 }}>{err}</div> : null}

        {showSombra ? (
          <div style={{ flex: '0 0 auto', border: '1px solid var(--border)', borderRadius: 12, padding: 10, background: 'var(--surface-muted, #f9fafb)' }}>
            <div style={{ fontWeight: 900, fontSize: 12, marginBottom: 6 }}>
              🔒 Plan de Logística · {semana ? weekTitleFromSelection(semana) : ''} <span style={{ fontWeight: 400, opacity: 0.7 }}>(solo lectura)</span>
            </div>
            {sombraErr ? <div style={{ color: 'crimson', fontWeight: 800, fontSize: 11, marginBottom: 6 }}>{sombraErr}</div> : null}
            {sombraLoading ? (
              <div style={{ fontSize: 12, opacity: 0.7 }}>Cargando plan de Logística…</div>
            ) : !sombra || (sombra.viajes || []).length === 0 ? (
              <div style={{ fontSize: 12, opacity: 0.6 }}>Logística no tiene viajes planificados en esta semana.</div>
            ) : (
              <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 4 }}>
                {sombra.viajes.map((v) => (
                  <LogisticaSombraColumn
                    key={v.id} viaje={v}
                    items={(sombra.items || []).filter((it) => it.viaje_id === v.id)}
                  />
                ))}
              </div>
            )}
          </div>
        ) : null}

        {loading ? (
          <div style={{ opacity: 0.75 }}>Cargando…</div>
        ) : (
          <>
            {canEdit && !cerrada ? (
              showNuevoViaje ? (
                <NuevoViajeForm semana={semana} config={config} busy={busy} onCreate={crearViaje} onCancel={() => setShowNuevoViaje(false)} />
              ) : (
                <div><button className="btn btn--brand" onClick={() => setShowNuevoViaje(true)}>+ Nuevo viaje</button></div>
              )
            ) : null}

            {editandoViaje ? (
              <NuevoViajeForm
                key={editandoViaje.id} semana={semana} config={config} busy={busy} initial={editandoViaje}
                submitLabel="Guardar cambios" onCreate={guardarEdicionViaje} onCancel={() => setEditandoViaje(null)}
              />
            ) : null}

            <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', gap: 10 }}>
              <div
                onDragOver={(e) => { if (!canEdit) return; e.preventDefault(); setPoolOver(true); }}
                onDragLeave={() => setPoolOver(false)}
                onDrop={(e) => { if (!canEdit) return; e.preventDefault(); setPoolOver(false); onDropToPool(e); }}
                style={{
                  minWidth: 260, maxWidth: 260, display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto',
                  border: `1px solid ${poolOver ? 'var(--brand)' : 'var(--border)'}`, borderRadius: 12, padding: 10,
                  background: poolOver ? 'var(--brand-100)' : 'var(--surface-muted, #f9fafb)',
                }}
              >
                <div style={{ fontWeight: 900, fontSize: 12 }}>Sin viaje ({pool.length})</div>
                {pool.map((it) => (
                  <ItemChip key={it.id} item={it} draggable={canEdit} busy={busySet.has(it.id)} onDragStart={(e) => onDragStartChip(e, it)} />
                ))}
              </div>

              <div style={{ flex: '1 1 auto', display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 8 }}>
                {(detalle?.viajes || []).map((viaje) => (
                  <ViajeColumn
                    key={viaje.id} viaje={viaje} items={itemsByViaje.get(viaje.id) || []} canEdit={canEdit && !cerrada}
                    onDrop={onDropToViaje} onReorder={onReorderDrop} onDragStartChip={onDragStartChip} onDesasignar={onDesasignar}
                    onEditar={setEditandoViaje} onBorrar={borrarViaje} busySet={busySet}
                  />
                ))}
                {(detalle?.viajes || []).length === 0 ? <div style={{ fontSize: 12, opacity: 0.6, padding: 10 }}>Todavía no hay viajes en esta semana.</div> : null}
              </div>
            </div>

            {canEdit ? (
              <div style={{ flex: '0 0 auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                {cerrada ? (
                  <button className="btn" disabled={busy} onClick={() => runMutation(() => reabrirStSemana(semana))}>Reabrir semana</button>
                ) : (
                  <button
                    className="btn btn--brand" disabled={busy || pool.length > 0}
                    title={pool.length > 0 ? 'Asigná todos los items a un viaje antes de cerrar' : ''}
                    onClick={() => runMutation(() => cerrarStSemana(semana))}
                  >
                    Cerrar semana
                  </button>
                )}
              </div>
            ) : null}
          </>
        )}
      </div>

      <ServicioTecnicoConfigModal open={showConfig} config={config} onClose={() => setShowConfig(false)} onChanged={reloadConfig} />
    </div>
  );
}
