// src/components/LogisticaViajeSemanaModal.jsx
//
// Detalle de una semana: a la izquierda los portones sin asignar (despacho +
// instalación), a la derecha una columna por viaje creado. Arrastrás los
// chips de la izquierda a un viaje (o entre viajes, o de vuelta al pool).
// Mismo espíritu que la ventana de "Asociación de comprobantes" que mostró el
// usuario como referencia, pero con columnas dinámicas (una por viaje) en vez
// de una sola lista de destino.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchLogisticaViajesConfig,
  fetchLogisticaSemanaDetalle,
  crearLogisticaViaje,
  patchLogisticaViaje,
  borrarLogisticaViaje,
  asignarLogisticaPorton,
  desasignarLogisticaPorton,
  reordenarLogisticaViaje,
  toggleLogisticaViajeZona,
  recalcularLogisticaRutaViaje,
  fetchLogisticaPuntosExtra,
  createLogisticaPuntoExtra,
  asignarLogisticaParadaExtra,
  desasignarLogisticaParadaExtra,
  updateLogisticaParadaExtraViaje,
  cerrarLogisticaSemana,
  reabrirLogisticaSemana,
  probarAvisoWhatsappViaje,
} from '../api';
import { isoWeekStartEndFromLabel, weekTitleFromSelection, todayISO10 } from '../utils/isoWeek';
import LogisticaZonasModal from './modals/LogisticaZonasModal';
import LogisticaVehiculosModal from './modals/LogisticaVehiculosModal';
import LogisticaCuadrillasModal from './modals/LogisticaCuadrillasModal';
import LogisticaReglasCapacidadModal from './modals/LogisticaReglasCapacidadModal';
import LogisticaReglasEnvioModal from './modals/LogisticaReglasEnvioModal';
import LogisticaIaConfigModal from './modals/LogisticaIaConfigModal';
import PortonesMapaModal from './modals/PortonesMapaModal';
import LogisticaMensajeViajeModal from './modals/LogisticaMensajeViajeModal';
import LogisticaAdjuntosModal from './modals/LogisticaAdjuntosModal';
import { estadoViaje } from '../utils/estadoViaje';

// NV únicos (despacho e instalación del mismo NV son el mismo domicilio).
function uniqueNvs(items) {
  return Array.from(new Set((items || []).map((it) => Number(it.nv)).filter(Number.isInteger)));
}

function formatearHorario(totalMin) {
  const dias = Math.floor(totalMin / 1440);
  const minDia = totalMin % 1440;
  const hora = `${String(Math.floor(minDia / 60)).padStart(2, '0')}:${String(minDia % 60).padStart(2, '0')}`;
  return dias > 0 ? `${hora} (+${dias}d)` : hora;
}

// Horario estimado de llegada a cada parada, acumulando desde hora_salida -
// segmentosHoras viene de ruta_real (uno por tramo real entre paradas
// consecutivas, calculado con OpenRouteService), dedupeado por NV
// (despacho+instalación del mismo NV = mismo domicilio = mismo horario)
// igual que construirRutaViaje en el backend, así coinciden en orden con
// segmentosHoras. +Nd si el acumulado cruza medianoche (viajes largos, ej.
// 27hs totales, son reales en esta app).
//
// Una parada extra puede "comer" tiempo antes de seguir a la siguiente, de
// dos formas (independientes, se puede cargar una, otra, las dos o
// ninguna):
// - duracion_minutos: se SUMA al horario de llegada (ej. "retirar un cobro"
//   = 15 min) - sigue acumulando normal desde ahí, sin saltar de día.
// - hora_salida_siguiente: solo paradas de descanso/hospedaje - el reloj
//   SALTA (reemplaza, no suma) a ese horario al DÍA SIGUIENTE de la
//   llegada. Si está cargada, gana por sobre duracion_minutos para esa
//   parada.
function horariosPorParada(items, horaSalida, segmentosHoras) {
  const map = new Map();
  if (!horaSalida || !segmentosHoras?.length) return map;
  const [h, m] = horaSalida.split(':').map(Number);
  let minutosClock = h * 60 + m;

  const vistos = new Set();
  const deduped = [];
  for (const it of items || []) {
    const key = it.punto_extra_id != null ? `extra-${it.punto_extra_id}` : `nv-${it.nv}`;
    if (vistos.has(key)) continue;
    vistos.add(key);
    deduped.push({ key, it });
  }

  segmentosHoras.forEach((horasTramo, i) => {
    const entry = deduped[i];
    if (!entry) return;
    minutosClock += horasTramo * 60;
    const totalMin = Math.round(minutosClock);
    map.set(entry.key, formatearHorario(totalMin));
    const it = entry.it;
    if (it?.hora_salida_siguiente) {
      const dia = Math.floor(totalMin / 1440);
      const [hs, ms] = it.hora_salida_siguiente.split(':').map(Number);
      minutosClock = (dia + 1) * 1440 + hs * 60 + ms;
    } else if (it?.duracion_minutos) {
      minutosClock += Number(it.duracion_minutos);
    }
  });

  return map;
}

const DND_MIME = 'application/x-logistica-porton';

function medidasLabel(item) {
  const alto = Number(item.alto);
  const ancho = Number(item.ancho);
  if (!Number.isFinite(alto) || !Number.isFinite(ancho)) return '';
  return `${item.alto}x${item.ancho}`;
}

function TipoBadge({ tipo }) {
  const isDespacho = tipo === 'despacho';
  return (
    <span
      style={{
        fontSize: 10, fontWeight: 900, padding: '2px 7px', borderRadius: 999,
        background: isDespacho ? 'var(--brand-100)' : '#eef2ff',
        color: isDespacho ? 'var(--brand-700)' : '#3730a3',
        border: `1px solid ${isDespacho ? 'var(--brand)' : '#818cf8'}`,
        whiteSpace: 'nowrap',
      }}
    >
      {isDespacho ? 'Despacho' : 'Instalación'}
    </span>
  );
}

// Zonas que la RUTA de este viaje atraviesa (corredor completo, no solo las
// paradas - ver server/lib/logisticaRutaZonas.js), con toggle habilitar/
// deshabilitar - pedido del usuario para una integración futura con el
// Presupuestador (avisar cupo de entrega si el viaje llega antes que la
// producción). Se recalcula solo cuando cambian las paradas/el orden; el
// toggle es la única parte editable a mano.
function ZonaPills({ zonas, canEdit, onToggle }) {
  if (!zonas?.length) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {zonas.map((z) => (
        <button
          key={z.zona_id}
          type="button"
          disabled={!canEdit}
          onClick={() => onToggle(z.zona_id, !z.habilitada)}
          title={z.habilitada ? 'Zona habilitada - click para deshabilitar' : 'Zona deshabilitada - click para habilitar'}
          style={{
            fontSize: 10, padding: '2px 7px', borderRadius: 999, border: '1px solid var(--border)',
            background: z.habilitada ? 'var(--brand-100)' : 'var(--surface-muted, #f3f4f6)',
            color: z.habilitada ? 'var(--brand-700)' : 'inherit',
            opacity: z.habilitada ? 1 : 0.6,
            cursor: canEdit ? 'pointer' : 'default',
          }}
        >
          {z.habilitada ? '✓ ' : '· '}{z.zona_nombre}
        </button>
      ))}
    </div>
  );
}

function PortonChip({ item, draggable, onDragStart, onDragEnd, ordenNum, horaLlegada, onAdjuntos }) {
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '8px 10px',
        background: 'var(--surface)',
        cursor: draggable ? 'grab' : 'default',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        position: 'relative',
      }}
      title={item.direccion || ''}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ fontWeight: 900, fontSize: 13 }}>
          {ordenNum != null ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, borderRadius: 999, background: '#dc2626', color: '#fff', fontSize: 9, fontWeight: 900, marginRight: 5, verticalAlign: 2 }}>
              {ordenNum}
            </span>
          ) : null}
          NV {item.nv}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {onAdjuntos ? (
            <button
              type="button" className="btn" style={{ padding: '1px 5px', fontSize: 10 }}
              onMouseDown={(e) => e.stopPropagation()} // no arrancar un drag del chip al clickear el botón
              onClick={(e) => { e.stopPropagation(); onAdjuntos(item.nv); }}
              title="Adjuntos (DNI, certificados, etc.)"
            >
              📎
            </button>
          ) : null}
          <TipoBadge tipo={item.tipo} />
        </div>
      </div>
      <div style={{ fontSize: 12, opacity: 0.85 }}>{item.nombre?.trim() || item.sistema || '—'}</div>
      <div style={{ fontSize: 11, opacity: 0.7, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {item.direccion?.trim() ? <span>{item.direccion.trim()}</span> : null}
        {medidasLabel(item) ? <span>{medidasLabel(item)}</span> : null}
        {item.peso > 1 ? <span style={{ fontWeight: 800 }}>pesa {item.peso}</span> : null}
      </div>
      {horaLlegada ? (
        <div style={{ fontSize: 11, fontWeight: 800, color: '#0a6a33' }}>🕒 Llegada estimada: {horaLlegada}</div>
      ) : null}
    </div>
  );
}

// Parada que no es un portón (ej. alojamiento de la cuadrilla) - se muestra
// mezclada en la misma lista ordenada, con su propio estilo (ámbar) para
// distinguirla de un vistazo. Se reordena con flechas en vez de arrastre
// (más simple que sumarla al mecanismo de drag&drop existente) pero entra
// en la MISMA secuencia de `orden` que los portones - ver reordenarViaje.
function ParadaExtraChip({ item, ordenNum, canEdit, onSubir, onBajar, onQuitar, onGuardarHorario, esPrimera, esUltima, horaLlegada }) {
  // Estado local (no controlado directo por `item`) para no perder lo que
  // el usuario está tipeando entre renders - se confirma con onBlur (no en
  // cada tecla) y se resincroniza si el dato del server cambia por otro
  // lado (ej. otra pestaña, o el reload tras guardar).
  const [duracion, setDuracion] = useState(item.duracion_minutos ?? '');
  const [horaSalidaSig, setHoraSalidaSig] = useState(item.hora_salida_siguiente ?? '');
  useEffect(() => { setDuracion(item.duracion_minutos ?? ''); }, [item.duracion_minutos]);
  useEffect(() => { setHoraSalidaSig(item.hora_salida_siguiente ?? ''); }, [item.hora_salida_siguiente]);

  return (
    <div
      style={{
        border: '1px solid #f59e0b', borderRadius: 10, padding: '8px 10px',
        background: 'rgba(245,158,11,0.08)', display: 'flex', flexDirection: 'column', gap: 4, position: 'relative',
      }}
      title={item.maps_url || ''}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ fontWeight: 900, fontSize: 13 }}>
          {ordenNum != null ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, borderRadius: 999, background: '#dc2626', color: '#fff', fontSize: 9, fontWeight: 900, marginRight: 5, verticalAlign: 2 }}>
              {ordenNum}
            </span>
          ) : null}
          🏨 {item.nombre}
        </span>
        {canEdit ? (
          <div style={{ display: 'flex', gap: 2 }}>
            <button type="button" className="btn" style={{ padding: '0 5px', fontSize: 10 }} disabled={esPrimera} onClick={onSubir} title="Mover arriba">▲</button>
            <button type="button" className="btn" style={{ padding: '0 5px', fontSize: 10 }} disabled={esUltima} onClick={onBajar} title="Mover abajo">▼</button>
            <button type="button" className="btn" style={{ padding: '0 5px', fontSize: 10, borderColor: '#ef4444', color: '#991b1b' }} onClick={onQuitar} title="Quitar del viaje">×</button>
          </div>
        ) : null}
      </div>
      {item.maps_url ? (
        <a href={item.maps_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: '#b45309' }}>Ver ubicación →</a>
      ) : null}

      {canEdit ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 3 }} title="Cuánto tarda hacer esta parada (ej. retirar un cobro = 15 min) - se suma al horario de llegada">
            Dura (min)
            <input
              type="number" min="0" step="1" className="pp-input" style={{ width: 52, fontSize: 10, padding: '1px 4px' }}
              value={duracion}
              onChange={(e) => setDuracion(e.target.value)}
              onBlur={() => onGuardarHorario({ duracion_minutos: duracion === '' ? null : Number(duracion) })}
            />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 3 }} title="Solo para descanso/hospedaje: la ruta retoma desde este horario AL DÍA SIGUIENTE de llegar acá">
            Sale día sig.
            <input
              type="time" className="pp-input" style={{ fontSize: 10, padding: '1px 4px' }}
              value={horaSalidaSig}
              onChange={(e) => setHoraSalidaSig(e.target.value)}
              onBlur={() => onGuardarHorario({ hora_salida_siguiente: horaSalidaSig || null })}
            />
          </label>
        </div>
      ) : (duracion || horaSalidaSig) ? (
        <div style={{ fontSize: 10, opacity: 0.75 }}>
          {duracion ? `⏱️ ${duracion} min en la parada` : ''}
          {horaSalidaSig ? `${duracion ? ' · ' : ''}🌅 sale ${horaSalidaSig} (día sig.)` : ''}
        </div>
      ) : null}

      {horaLlegada ? (
        <div style={{ fontSize: 11, fontWeight: 800, color: '#0a6a33' }}>🕒 Llegada estimada: {horaLlegada}</div>
      ) : null}
    </div>
  );
}

// Agregar una parada extra a un viaje: elegir una ya cargada (catálogo
// reutilizable, ej. "Hotel San Vicente" que se vuelve a usar en otro viaje
// sin repegar la URL) o cargar una nueva.
// Exportado: también lo usa LogisticaFechasMapaView.jsx para agregar paradas
// directamente desde el panel del mapa, sin pasar por este modal.
export function AgregarParadaExtra({ puntosExtra, busy, onElegir, onCrear, onCancelar }) {
  const [modo, setModo] = useState(puntosExtra?.length ? 'elegir' : 'nuevo');
  const [seleccionado, setSeleccionado] = useState('');
  const [nombre, setNombre] = useState('');
  const [mapsUrl, setMapsUrl] = useState('');

  return (
    <div style={{ border: '1px dashed #f59e0b', borderRadius: 10, padding: 8, background: 'rgba(245,158,11,0.06)', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {puntosExtra?.length > 0 ? (
        <div style={{ display: 'flex', gap: 4 }}>
          <button type="button" className="btn" style={{ fontSize: 10, padding: '2px 6px', ...(modo === 'elegir' ? { background: 'var(--brand)', color: '#fff' } : {}) }} onClick={() => setModo('elegir')}>Elegir existente</button>
          <button type="button" className="btn" style={{ fontSize: 10, padding: '2px 6px', ...(modo === 'nuevo' ? { background: 'var(--brand)', color: '#fff' } : {}) }} onClick={() => setModo('nuevo')}>+ Nueva</button>
        </div>
      ) : null}

      {modo === 'elegir' ? (
        <>
          <select className="pp-select" style={{ fontSize: 11 }} value={seleccionado} onChange={(e) => setSeleccionado(e.target.value)}>
            <option value="">— Elegir —</option>
            {puntosExtra.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </select>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn" style={{ fontSize: 11 }} disabled={busy} onClick={onCancelar}>Cancelar</button>
            <button type="button" className="btn btn--brand" style={{ fontSize: 11 }} disabled={busy || !seleccionado} onClick={() => onElegir(Number(seleccionado))}>Agregar</button>
          </div>
        </>
      ) : (
        <>
          <input className="pp-input" style={{ fontSize: 11 }} placeholder="Nombre (ej: Hotel San Vicente)" value={nombre} onChange={(e) => setNombre(e.target.value)} />
          <input className="pp-input" style={{ fontSize: 11 }} placeholder="Link de Google Maps" value={mapsUrl} onChange={(e) => setMapsUrl(e.target.value)} />
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn" style={{ fontSize: 11 }} disabled={busy} onClick={onCancelar}>Cancelar</button>
            <button type="button" className="btn btn--brand" style={{ fontSize: 11 }} disabled={busy || !nombre.trim() || !mapsUrl.trim()} onClick={() => onCrear(nombre.trim(), mapsUrl.trim())}>
              {busy ? 'Cargando…' : 'Crear y agregar'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function NuevoViajeForm({ semana, config, onCreate, onCancel, busy, initial, submitLabel }) {
  const { start, end } = isoWeekStartEndFromLabel(semana);
  const today = todayISO10();
  const [fecha, setFecha] = useState(() => {
    const initFecha = initial?.fecha ? String(initial.fecha).slice(0, 10) : '';
    if (initFecha) return initFecha;
    return today >= start && today <= end ? today : start;
  });
  const [zonaId, setZonaId] = useState(() => (initial?.zona_id != null ? String(initial.zona_id) : ''));
  const [cuadrillaId, setCuadrillaId] = useState(() => (initial?.cuadrilla_id != null ? String(initial.cuadrilla_id) : ''));
  const [vehiculoId, setVehiculoId] = useState(() => (initial?.vehiculo_id != null ? String(initial.vehiculo_id) : ''));
  const [nombre, setNombre] = useState(() => initial?.nombre || '');
  const [horaSalida, setHoraSalida] = useState(() => initial?.hora_salida || '');
  const [fondoEfectivo, setFondoEfectivo] = useState(() => (initial?.fondo_efectivo != null ? String(initial.fondo_efectivo) : ''));

  const zonasActivas = (config?.zonas || []).filter((z) => z.activo !== false);
  const cuadrillasActivas = (config?.cuadrillas || []).filter((c) => c.activo !== false);
  const vehiculosActivos = (config?.vehiculos || []).filter((v) => v.activo !== false);

  return (
    <div
      style={{
        border: '1px dashed var(--brand)', borderRadius: 12, padding: 12,
        background: 'var(--brand-100)', display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end',
      }}
    >
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
        Fecha
        <input type="date" className="pp-input" min={start} max={end} value={fecha} onChange={(e) => setFecha(e.target.value)} />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
        Zona
        <select className="pp-select" value={zonaId} onChange={(e) => setZonaId(e.target.value)}>
          <option value="">(sin zona)</option>
          {zonasActivas.map((z) => <option key={z.id} value={z.id}>{z.nombre}</option>)}
        </select>
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
        Cuadrilla
        <select className="pp-select" value={cuadrillaId} onChange={(e) => setCuadrillaId(e.target.value)}>
          <option value="">(sin cuadrilla)</option>
          {cuadrillasActivas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
        </select>
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
        Vehículo
        <select className="pp-select" value={vehiculoId} onChange={(e) => setVehiculoId(e.target.value)}>
          <option value="">(sin vehículo)</option>
          {vehiculosActivos.map((v) => <option key={v.id} value={v.id}>{v.nombre} (cap. {v.capacidad_portones})</option>)}
        </select>
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
        Nombre (opcional)
        <input className="pp-input" value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Ej: Viaje 1" />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
        Hora de salida (opcional)
        <input type="time" className="pp-input" value={horaSalida} onChange={(e) => setHoraSalida(e.target.value)} />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
        Fondo en efectivo (opcional)
        <input type="number" min="0" step="0.01" className="pp-input" placeholder="$" value={fondoEfectivo} onChange={(e) => setFondoEfectivo(e.target.value)} />
      </label>

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="btn btn--brand"
          disabled={busy || !fecha}
          onClick={() =>
            onCreate({
              fecha,
              zona_id: zonaId ? Number(zonaId) : null,
              cuadrilla_id: cuadrillaId ? Number(cuadrillaId) : null,
              vehiculo_id: vehiculoId ? Number(vehiculoId) : null,
              nombre: nombre.trim() || null,
              hora_salida: horaSalida || null,
              fondo_efectivo: fondoEfectivo || null,
            })
          }
        >
          {submitLabel || 'Crear viaje'}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>Cancelar</button>
      </div>
    </div>
  );
}

function ViajeColumn({ viaje, items, canEdit, cerrada, onDropItem, onReorder, onEditar, onBorrar, onDragStartChip, onDragEndChip, onVerMapa, onMensaje, onAdjuntosViaje, onAdjuntosNv, onToggleZona, puntosExtra, agregandoParada, onAbrirAgregarParada, onCerrarAgregarParada, agregandoParadaBusy, onElegirParada, onCrearParada, onQuitarParada, onMoverParada, onGuardarHorarioParada, onRecalcularRuta, recalculando, onProbarAviso, probandoAviso }) {
  const [over, setOver] = useState(false);
  const [dragOverIndex, setDragOverIndex] = useState(null);
  const capacidad = Number(viaje.vehiculo_capacidad || 0);
  const usado = Number(viaje.peso_despacho_usado || 0);
  const puedeReordenar = canEdit && !cerrada && items.length > 1;
  const horarios = horariosPorParada(items, viaje.hora_salida, viaje.ruta_real?.segmentos_horas);
  const estado = estadoViaje(viaje);

  return (
    <div
      onDragOver={(e) => { if (!canEdit || cerrada) return; e.preventDefault(); setOver(true); }}
      onDragLeave={() => { setOver(false); setDragOverIndex(null); }}
      onDrop={(e) => {
        if (!canEdit || cerrada) return;
        e.preventDefault();
        setOver(false);
        setDragOverIndex(null);
        // Si soltó sobre un chip puntual, ese chip ya frenó la propagación
        // (más abajo) y esto no llega a ejecutarse - esto solo cubre soltar
        // en el área vacía de la columna (manda al final).
        onDropItem(viaje.id, e);
      }}
      style={{
        minWidth: 260, maxWidth: 260, display: 'flex', flexDirection: 'column', gap: 8,
        border: `1px solid ${over ? 'var(--brand)' : estado.border}`,
        borderRadius: 12, padding: 10,
        background: over ? 'var(--brand-100)' : estado.bg,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: 13 }}>{viaje.nombre?.trim() || `Viaje #${viaje.id}`}</div>
          <div style={{ fontSize: 10, fontWeight: 800, color: estado.fg }}>● {estado.label}</div>
          <div style={{ fontSize: 11, opacity: 0.75 }}>
            {String(viaje.fecha).slice(0, 10).split('-').reverse().join('/')}
            {viaje.hora_salida ? ` · sale ${viaje.hora_salida}` : ''}
          </div>
          <button
            type="button"
            className="btn"
            style={{ padding: '1px 6px', fontSize: 10, marginTop: 4 }}
            disabled={items.length === 0}
            onClick={() => onVerMapa(viaje, items)}
          >
            🗺️ Mapa
          </button>
          <button
            type="button"
            className="btn"
            style={{ padding: '1px 6px', fontSize: 10, marginTop: 4, marginLeft: 4 }}
            disabled={items.length === 0}
            onClick={() => onMensaje(viaje)}
          >
            📋 Mensaje
          </button>
          <button
            type="button"
            className="btn"
            style={{ padding: '1px 6px', fontSize: 10, marginTop: 4, marginLeft: 4 }}
            onClick={() => onAdjuntosViaje(viaje)}
            title="Adjuntos del viaje (manifiesto, etc.)"
          >
            📎 Adjuntos
          </button>
          {canEdit ? (
            <button
              type="button"
              className="btn"
              style={{ padding: '1px 6px', fontSize: 10, marginTop: 4, marginLeft: 4 }}
              disabled={recalculando === viaje.id}
              onClick={() => onRecalcularRuta(viaje.id)}
              title="Recalcular zonas y ruta real - normalmente no hace falta, se recalculan solas al cambiar paradas"
            >
              {recalculando === viaje.id ? '⏳…' : '🔄 Recalcular'}
            </button>
          ) : null}
          <button
            type="button"
            className="btn"
            style={{ padding: '1px 6px', fontSize: 10, marginTop: 4, marginLeft: 4 }}
            disabled={probandoAviso === viaje.id}
            onClick={() => onProbarAviso(viaje)}
            title="Modo de pruebas: manda el aviso 'en camino' (fotos + collage) a un teléfono cualquiera"
          >
            {probandoAviso === viaje.id ? '⏳…' : '🧪 Probar aviso'}
          </button>
        </div>
        {canEdit && !cerrada ? (
          <div style={{ display: 'flex', gap: 4 }}>
            <button type="button" className="btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => onEditar(viaje)}>Editar</button>
            <button
              type="button"
              className="btn"
              style={{ padding: '2px 8px', fontSize: 11, borderColor: '#ef4444', color: '#991b1b' }}
              onClick={() => onBorrar(viaje)}
            >
              Borrar
            </button>
          </div>
        ) : null}
      </div>

      <div style={{ fontSize: 11, opacity: 0.8 }}>
        {viaje.zona_nombre || '(sin zona)'} · {viaje.cuadrilla_nombre || '(sin cuadrilla)'}
      </div>
      <div style={{ fontSize: 11, opacity: 0.8 }}>
        {viaje.vehiculo_nombre ? (
          <span style={{ fontWeight: usado > capacidad ? 900 : 400, color: usado > capacidad ? '#b91c1c' : undefined }}>
            {viaje.vehiculo_nombre}: {usado}/{capacidad} despacho
          </span>
        ) : (
          <span style={{ color: '#b91c1c' }}>Sin vehículo (no puede sumar despacho)</span>
        )}
      </div>

      {viaje.ruta_real ? (
        <div style={{ fontSize: 11, opacity: 0.75 }}>
          🚚 {viaje.ruta_real.distancia_km} km · ~{viaje.ruta_real.duracion_horas}h por calle
        </div>
      ) : null}

      <ZonaPills zonas={viaje.zonas} canEdit={canEdit} onToggle={(zonaId, habilitada) => onToggleZona(viaje.id, zonaId, habilitada)} />

      {puedeReordenar ? (
        <div style={{ fontSize: 10, opacity: 0.55 }}>Arrastrá para reordenar la ruta (1º arriba = primera parada). Las paradas 🏨 se reordenan con las flechas.</div>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 60 }}>
        {items.length === 0 ? (
          <div style={{ fontSize: 11, opacity: 0.5, padding: 8, textAlign: 'center' }}>Arrastrá portones acá, o agregá una parada abajo</div>
        ) : (
          items.map((it, idx) => (
            <div
              key={it.punto_extra_id != null ? `extra-${it.punto_extra_id}` : `${it.porton_id}-${it.tipo}`}
              onDragOver={(e) => {
                if (!canEdit || cerrada) return;
                e.preventDefault();
                setDragOverIndex(idx);
              }}
              onDrop={(e) => {
                if (!canEdit || cerrada) return;
                e.preventDefault();
                e.stopPropagation();
                setOver(false);
                setDragOverIndex(null);
                onReorder(viaje.id, e, idx);
              }}
            >
              {dragOverIndex === idx ? (
                <div style={{ height: 3, background: 'var(--brand)', borderRadius: 2, marginBottom: 4 }} />
              ) : null}
              {it.punto_extra_id != null ? (
                <ParadaExtraChip
                  item={it}
                  canEdit={canEdit && !cerrada}
                  ordenNum={items.length > 1 ? idx + 1 : null}
                  esPrimera={idx === 0}
                  esUltima={idx === items.length - 1}
                  onSubir={() => onMoverParada(viaje.id, it.punto_extra_id, -1)}
                  onBajar={() => onMoverParada(viaje.id, it.punto_extra_id, 1)}
                  onQuitar={() => onQuitarParada(viaje.id, it.punto_extra_id)}
                  onGuardarHorario={(patch) => onGuardarHorarioParada(viaje.id, it.punto_extra_id, patch)}
                  horaLlegada={horarios.get(`extra-${it.punto_extra_id}`)}
                />
              ) : (
                <PortonChip
                  item={it}
                  draggable={canEdit && !cerrada}
                  onDragStart={(e) => onDragStartChip(e, it)}
                  onDragEnd={onDragEndChip}
                  ordenNum={items.length > 1 ? idx + 1 : null}
                  horaLlegada={horarios.get(`nv-${it.nv}`)}
                  onAdjuntos={onAdjuntosNv}
                />
              )}
            </div>
          ))
        )}
      </div>

      {canEdit && !cerrada ? (
        agregandoParada ? (
          <AgregarParadaExtra
            puntosExtra={puntosExtra}
            busy={agregandoParadaBusy}
            onElegir={(puntoExtraId) => onElegirParada(viaje.id, puntoExtraId)}
            onCrear={(nombre, mapsUrl) => onCrearParada(viaje.id, nombre, mapsUrl)}
            onCancelar={onCerrarAgregarParada}
          />
        ) : (
          <button type="button" className="btn" style={{ fontSize: 11 }} onClick={() => onAbrirAgregarParada(viaje.id)}>
            🏨 + Parada (alojamiento, etc.)
          </button>
        )
      ) : null}
    </div>
  );
}

export default function LogisticaViajeSemanaModal({ semana, open, canEdit, onClose, onChanged }) {
  const [detalle, setDetalle] = useState(null);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const [showNuevoViaje, setShowNuevoViaje] = useState(false);
  const [editandoViaje, setEditandoViaje] = useState(null);
  const [showZonas, setShowZonas] = useState(false);
  const [showVehiculos, setShowVehiculos] = useState(false);
  const [showCuadrillas, setShowCuadrillas] = useState(false);
  const [showReglas, setShowReglas] = useState(false);
  const [showReglasEnvio, setShowReglasEnvio] = useState(false);
  const [showIaConfig, setShowIaConfig] = useState(false);
  const [mapa, setMapa] = useState(null); // { nvs, titulo } | null
  const [mensajeViaje, setMensajeViaje] = useState(null); // { viajeId, titulo } | null
  const [adjuntos, setAdjuntos] = useState(null); // { viajeId, titulo, cuadrillaId } | { nv, titulo, cuadrillaId } | null

  // Paradas que no son un portón (ej. alojamiento) - catálogo reutilizable +
  // qué viaje tiene abierto el picker para agregar una.
  const [puntosExtra, setPuntosExtra] = useState([]);
  const [agregandoParadaViajeId, setAgregandoParadaViajeId] = useState(null);
  const [agregandoParadaBusy, setAgregandoParadaBusy] = useState(false);

  const load = useCallback(async () => {
    if (!semana) return;
    setErr('');
    setLoading(true);
    try {
      const [d, c, pe] = await Promise.all([fetchLogisticaSemanaDetalle(semana), fetchLogisticaViajesConfig(), fetchLogisticaPuntosExtra()]);
      setDetalle(d?.detalle || null);
      setConfig(c?.config || null);
      setPuntosExtra((pe?.puntos || []).filter((p) => p.activo !== false));
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [semana]);

  useEffect(() => {
    if (open && semana) load();
    if (!open) {
      setShowNuevoViaje(false);
      setEditandoViaje(null);
      setDetalle(null);
      setErr('');
      setAgregandoParadaViajeId(null);
    }
  }, [open, semana, load]);

  // Recarga liviana solo del detalle (no del config), para no perder el
  // scroll/estado de los sub-modales de config innecesariamente.
  const reloadDetalle = useCallback(async () => {
    if (!semana) return;
    const d = await fetchLogisticaSemanaDetalle(semana);
    setDetalle(d?.detalle || null);
  }, [semana]);

  // Refresca config (zonas/vehículos/cuadrillas/reglas) sin tocar el detalle.
  const reloadConfig = useCallback(async () => {
    const c = await fetchLogisticaViajesConfig();
    setConfig(c?.config || null);
  }, []);

  const pool = useMemo(() => (detalle?.items || []).filter((it) => it.viaje_id == null), [detalle]);
  const itemsPorViaje = useMemo(() => {
    const map = new Map();
    for (const it of detalle?.items || []) {
      if (it.viaje_id == null) continue;
      if (!map.has(it.viaje_id)) map.set(it.viaje_id, []);
      map.get(it.viaje_id).push(it);
    }
    // Paradas extra (ej. alojamiento) - viven en detalle.viajes[].paradas_extra
    // (logisticaParadasExtra.js), no en detalle.items (que es portón-por-
    // semana) - se mezclan acá con el MISMO shape mínimo para que ViajeColumn
    // las intercale con los portones en una sola lista ordenada por `orden`.
    for (const v of detalle?.viajes || []) {
      for (const p of v.paradas_extra || []) {
        if (!map.has(v.id)) map.set(v.id, []);
        map.get(v.id).push({ punto_extra_id: p.punto_extra_id, nombre: p.nombre, maps_url: p.maps_url, lat: p.lat, lng: p.lng, orden: p.orden, duracion_minutos: p.duracion_minutos, hora_salida_siguiente: p.hora_salida_siguiente });
      }
    }
    // Orden = orden real de la ruta (primero el que queda arriba en la
    // columna). Portones agregados antes de que existiera esta columna de
    // orden quedan todos en 0 (empate) - se desempata por porton_id/
    // punto_extra_id para que al menos sea estable entre renders, hasta que
    // el usuario los reordene.
    for (const arr of map.values()) {
      arr.sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0) || String(a.porton_id ?? `x${a.punto_extra_id}`).localeCompare(String(b.porton_id ?? `x${b.punto_extra_id}`)));
    }
    return map;
  }, [detalle]);

  const cerrada = !!detalle?.cerrada;
  const counts = detalle?.counts || { despacho_total: 0, despacho_asignados: 0, instalacion_total: 0, instalacion_asignados: 0 };
  const faltan = (counts.despacho_total - counts.despacho_asignados) + (counts.instalacion_total - counts.instalacion_asignados);
  const puedeCerrar = canEdit && !cerrada && faltan === 0 && (counts.despacho_total + counts.instalacion_total) > 0;

  // Devuelve true/false según éxito, para que los que cierran un form al
  // terminar (crear/editar viaje) no lo cierren si la mutación falló (el
  // usuario perdería lo que tenía cargado).
  const runMutation = useCallback(async (fn) => {
    setBusy(true);
    setErr('');
    try {
      const res = await fn();
      if (res?.detalle) setDetalle(res.detalle);
      onChanged?.();
      return true;
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }, [onChanged]);

  const onDragStartChip = (e, item) => {
    e.dataTransfer.setData(DND_MIME, JSON.stringify({ porton_id: item.porton_id, tipo: item.tipo, viaje_id: item.viaje_id ?? null }));
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragEndChip = () => {};

  // Reordena DENTRO de una misma columna (o inserta ahí si viene de otro
  // lado) según en qué posición soltó. targetIndex se calcula contra el
  // array YA ordenado por `orden` (itemsPorViaje) que ve el chip sobre el
  // que soltó.
  const handleReorder = useCallback((viajeId, payload, targetIndex) => {
    if (!payload?.porton_id || !payload?.tipo) return;

    if (payload.viaje_id !== viajeId) {
      // Viene de otra columna o del pool: se asigna (entra al final); si el
      // usuario quiere una posición puntual, lo reordena después con un
      // segundo arrastre dentro de la misma columna.
      runMutation(() => asignarLogisticaPorton(viajeId, payload.porton_id, payload.tipo));
      return;
    }

    const actuales = itemsPorViaje.get(viajeId) || [];
    const origenIdx = actuales.findIndex((it) => it.porton_id === payload.porton_id && it.tipo === payload.tipo);
    const sinArrastrado = actuales.filter((it) => !(it.porton_id === payload.porton_id && it.tipo === payload.tipo));

    // Si el arrastrado estaba ANTES de donde soltó, al sacarlo el resto se
    // corre un lugar - hay que compensar para que caiga justo donde soltó.
    let destino = targetIndex;
    if (origenIdx !== -1 && origenIdx < targetIndex) destino -= 1;
    destino = Math.max(0, Math.min(destino, sinArrastrado.length));

    if (origenIdx === destino) return; // no cambió nada

    const reordenado = [...sinArrastrado];
    reordenado.splice(destino, 0, { porton_id: payload.porton_id, tipo: payload.tipo });

    // sinArrastrado puede traer paradas extra intercaladas (itemsPorViaje las
    // mezcla con los portones) - hay que preservar su punto_extra_id acá, si
    // no el reorden las manda todas con {porton_id:undefined, tipo:undefined}
    // y el backend las ignora (quedan pisadas en su orden viejo).
    runMutation(() => reordenarLogisticaViaje(viajeId, reordenado.map((it) => (
      it.punto_extra_id != null ? { punto_extra_id: it.punto_extra_id } : { porton_id: it.porton_id, tipo: it.tipo }
    ))));
  }, [itemsPorViaje, runMutation]);

  // Wrapper para el onDrop de un chip puntual (llega con el DragEvent crudo,
  // no con el payload ya parseado como handleDrop/handleReorder esperan).
  const onReorderDrop = useCallback((viajeId, e, targetIndex) => {
    const raw = e.dataTransfer.getData(DND_MIME);
    if (!raw) return;
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    handleReorder(viajeId, payload, targetIndex);
  }, [handleReorder]);

  const handleDrop = useCallback((targetViajeId, e) => {
    const raw = e.dataTransfer.getData(DND_MIME);
    if (!raw) return;
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    if (!payload?.porton_id || !payload?.tipo) return;

    if (payload.viaje_id === targetViajeId) {
      // Soltó en el área vacía de su propia columna (no sobre un chip
      // puntual): lo manda al final de la ruta.
      const actuales = itemsPorViaje.get(targetViajeId) || [];
      handleReorder(targetViajeId, payload, actuales.length);
      return;
    }

    runMutation(() => asignarLogisticaPorton(targetViajeId, payload.porton_id, payload.tipo));
  }, [runMutation, itemsPorViaje, handleReorder]);

  const [poolOver, setPoolOver] = useState(false);
  const handleDropToPool = useCallback((e) => {
    const raw = e.dataTransfer.getData(DND_MIME);
    if (!raw) return;
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    if (!payload?.porton_id || !payload?.tipo || payload.viaje_id == null) return;

    runMutation(() => desasignarLogisticaPorton(payload.viaje_id, payload.porton_id, payload.tipo));
  }, [runMutation]);

  const crearViaje = (payload) => {
    runMutation(() => crearLogisticaViaje(semana, payload)).then((ok) => { if (ok) setShowNuevoViaje(false); });
  };

  const guardarEdicionViaje = (payload) => {
    runMutation(() => patchLogisticaViaje(editandoViaje.id, payload)).then((ok) => { if (ok) setEditandoViaje(null); });
  };

  const borrarViaje = (viaje) => {
    if (!window.confirm(`¿Borrar "${viaje.nombre?.trim() || `Viaje #${viaje.id}`}"? Sus portones vuelven a "sin asignar".`)) return;
    runMutation(() => borrarLogisticaViaje(viaje.id));
  };

  const onCerrarSemana = () => {
    if (!window.confirm(`¿Cerrar la semana ${weekTitleFromSelection(semana)}? El tablero de viajes queda de solo lectura (se puede reabrir después).`)) return;
    runMutation(() => cerrarLogisticaSemana(semana));
  };

  const onReabrirSemana = () => {
    runMutation(() => reabrirLogisticaSemana(semana));
  };

  const onToggleZona = (viajeId, zonaId, habilitada) => {
    runMutation(() => toggleLogisticaViajeZona(viajeId, zonaId, habilitada));
  };

  // Zonas/ruta real normalmente se recalculan solos con cualquier cambio de
  // paradas u orden - esto es para los casos que NO disparan eso solos (ej.
  // redibujar una zona después de crear el viaje, o cargarle recién el link
  // de Maps a un NV que antes no tenía ubicación resuelta).
  const [recalculando, setRecalculando] = useState(null); // viajeId en curso, o null
  const onRecalcularRuta = async (viajeId) => {
    setRecalculando(viajeId);
    await runMutation(() => recalcularLogisticaRutaViaje(viajeId));
    setRecalculando(null);
  };

  // Modo de pruebas: manda el aviso "en camino" (collage de fotos + cuadrilla
  // + vehículo) a un teléfono cualquiera, para ver cómo sale antes de que se
  // dispare en producción con el cliente real - pedido explícito del usuario.
  const [probandoAviso, setProbandoAviso] = useState(null); // viajeId en curso, o null
  const onProbarAviso = async (viaje) => {
    const telefono = window.prompt('Teléfono de prueba (con o sin 549, ej. 3572400170):', '3572400170');
    if (!telefono?.trim()) return;
    setProbandoAviso(viaje.id);
    setErr('');
    try {
      const r = await probarAvisoWhatsappViaje(viaje.id, { telefono: telefono.trim() });
      if (r?.ok) window.alert('Aviso de prueba enviado ✅');
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setProbandoAviso(null);
    }
  };

  // Paradas que no son un portón (ej. alojamiento) - se tratan igual que un
  // portón para la ruta (misma secuencia de `orden`, cuentan para zonas y
  // mensaje) pero se agregan/reordenan distinto: elegir del catálogo o
  // cargar una nueva, y flechas en vez de arrastre.
  const abrirAgregarParada = (viajeId) => setAgregandoParadaViajeId(viajeId);
  const cerrarAgregarParada = () => setAgregandoParadaViajeId(null);

  const elegirParada = async (viajeId, puntoExtraId) => {
    setAgregandoParadaBusy(true);
    const ok = await runMutation(() => asignarLogisticaParadaExtra(viajeId, puntoExtraId));
    setAgregandoParadaBusy(false);
    if (ok) setAgregandoParadaViajeId(null);
  };

  const crearParada = async (viajeId, nombre, mapsUrl) => {
    setAgregandoParadaBusy(true);
    setErr('');
    try {
      const { punto } = await createLogisticaPuntoExtra({ nombre, maps_url: mapsUrl });
      setPuntosExtra((prev) => [...prev, punto].sort((a, b) => a.nombre.localeCompare(b.nombre)));
      const ok = await runMutation(() => asignarLogisticaParadaExtra(viajeId, punto.id));
      if (ok) setAgregandoParadaViajeId(null);
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setAgregandoParadaBusy(false);
    }
  };

  const quitarParada = (viajeId, puntoExtraId) => {
    runMutation(() => desasignarLogisticaParadaExtra(viajeId, puntoExtraId));
  };

  // Horario propio de una parada extra - duracion_minutos (cualquier
  // parada, ej. "retirar un cobro" = 15 min) y/o hora_salida_siguiente
  // (solo descanso/hospedaje, la ruta retoma desde ahí al día siguiente).
  const guardarHorarioParada = (viajeId, puntoExtraId, patch) => {
    runMutation(() => updateLogisticaParadaExtraViaje(viajeId, puntoExtraId, patch));
  };

  // Sube/baja una parada extra un lugar dentro de la MISMA lista mezclada
  // (portones + paradas) reenviando el orden completo - reusa el mismo
  // endpoint que el arrastre de portones (reordenarViaje ya acepta items
  // mixtos, ver Backend/server/lib/logisticaViajesDb.js).
  const moverParada = (viajeId, puntoExtraId, direccion) => {
    const items = itemsPorViaje.get(viajeId) || [];
    const idx = items.findIndex((it) => it.punto_extra_id === puntoExtraId);
    const destino = idx + direccion;
    if (idx === -1 || destino < 0 || destino >= items.length) return;
    const reordenado = [...items];
    [reordenado[idx], reordenado[destino]] = [reordenado[destino], reordenado[idx]];
    const payload = reordenado.map((it) => (it.punto_extra_id != null ? { punto_extra_id: it.punto_extra_id } : { porton_id: it.porton_id, tipo: it.tipo }));
    runMutation(() => reordenarLogisticaViaje(viajeId, payload));
  };

  if (!open) return null;

  return (
    <div
      style={{
        // 9999 (no un valor bajo cualquiera): Leaflet pone sus controles
        // propios (zoom, etc.) en z-index 1000 - un modal con z-index menor
        // a eso queda atrás del mapa de fondo cuando la página que lo abre
        // tiene uno (ej. Planificación de Fechas). Mismo valor que usa el
        // resto de los modales de la app.
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12,
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div
        style={{
          width: 'min(1500px, 100%)', height: 'min(920px, 96vh)', background: 'var(--surface)',
          borderRadius: 14, border: '1px solid var(--border)', boxShadow: '0 12px 32px rgba(0,0,0,0.25)',
          padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 900, fontSize: 16 }}>
            {semana ? weekTitleFromSelection(semana) : ''} {cerrada ? <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 800, padding: '2px 8px', borderRadius: 999, background: 'var(--brand)', color: '#fff' }}>Cerrada</span> : null}
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn"
              disabled={!detalle || uniqueNvs(detalle.items).length === 0}
              onClick={() => setMapa({ nvs: uniqueNvs(detalle.items), titulo: `Mapa · ${weekTitleFromSelection(semana)}` })}
            >
              🗺️ Ver mapa de la semana
            </button>
            {canEdit ? (
              <>
                <button className="btn" onClick={() => setShowZonas(true)}>Zonas</button>
                <button className="btn" onClick={() => setShowVehiculos(true)}>Vehículos</button>
                <button className="btn" onClick={() => setShowCuadrillas(true)}>Cuadrillas</button>
                <button className="btn" onClick={() => setShowReglas(true)}>Reglas de capacidad</button>
                <button className="btn" onClick={() => setShowReglasEnvio(true)}>Reglas de envío</button>
                <button className="btn" onClick={() => setShowIaConfig(true)}>🤖 Config IA</button>
              </>
            ) : null}
            <button className="btn" onClick={onClose}>Cerrar ventana</button>
          </div>
        </div>

        {err ? <div style={{ color: 'crimson', fontWeight: 800, fontSize: 12 }}>{err}</div> : null}

        {loading ? (
          <div style={{ opacity: 0.75 }}>Cargando…</div>
        ) : (
          <>
            {canEdit && !cerrada ? (
              showNuevoViaje ? (
                <NuevoViajeForm semana={semana} config={config} busy={busy} onCreate={crearViaje} onCancel={() => setShowNuevoViaje(false)} />
              ) : (
                <div>
                  <button className="btn btn--brand" onClick={() => setShowNuevoViaje(true)}>+ Nuevo viaje</button>
                </div>
              )
            ) : null}

            {editandoViaje ? (
              <NuevoViajeForm
                key={editandoViaje.id}
                semana={semana}
                config={config}
                busy={busy}
                initial={editandoViaje}
                submitLabel="Guardar cambios"
                onCreate={guardarEdicionViaje}
                onCancel={() => setEditandoViaje(null)}
              />
            ) : null}

            <div style={{ flex: 1, display: 'flex', gap: 12, overflow: 'hidden' }}>
              <div
                onDragOver={(e) => { if (!canEdit || cerrada) return; e.preventDefault(); setPoolOver(true); }}
                onDragLeave={() => setPoolOver(false)}
                onDrop={(e) => { if (!canEdit || cerrada) return; e.preventDefault(); setPoolOver(false); handleDropToPool(e); }}
                style={{
                  minWidth: 280, maxWidth: 280, display: 'flex', flexDirection: 'column', gap: 8,
                  border: `1px solid ${poolOver ? 'var(--brand)' : 'var(--border)'}`,
                  borderRadius: 12, padding: 10, background: poolOver ? 'var(--brand-100)' : 'var(--surface-muted, #f9fafb)',
                  overflowY: 'auto',
                }}
              >
                <div style={{ fontWeight: 900, fontSize: 13 }}>Sin asignar ({pool.length})</div>
                {pool.length === 0 ? (
                  <div style={{ fontSize: 11, opacity: 0.6 }}>Todo repartido.</div>
                ) : (
                  pool.map((it) => (
                    <PortonChip
                      key={`${it.porton_id}-${it.tipo}`}
                      item={it}
                      draggable={canEdit && !cerrada}
                      onDragStart={(e) => onDragStartChip(e, it)}
                      onDragEnd={onDragEndChip}
                      onAdjuntos={(nvChip) => setAdjuntos({ nv: nvChip, titulo: `NV ${nvChip}` })}
                    />
                  ))
                )}
              </div>

              <div style={{ flex: 1, display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 4 }}>
                {(detalle?.viajes || []).map((v) => (
                  <ViajeColumn
                    key={v.id}
                    viaje={v}
                    items={itemsPorViaje.get(v.id) || []}
                    canEdit={canEdit}
                    cerrada={cerrada}
                    onDropItem={handleDrop}
                    onReorder={onReorderDrop}
                    onEditar={setEditandoViaje}
                    onBorrar={borrarViaje}
                    onDragStartChip={onDragStartChip}
                    onDragEndChip={onDragEndChip}
                    onVerMapa={(viaje, items) => {
                      // items ya viene mezclado (portones + paradas extra) y
                      // ordenado por `orden` real de la ruta (itemsPorViaje) -
                      // se arma la secuencia mixta [{nv}|{punto_extra_id}]
                      // deduplicando NV (despacho+instalación = mismo punto).
                      const vistos = new Set();
                      const rutaOrden = items.filter((it) => {
                        if (it.punto_extra_id != null) return true;
                        if (vistos.has(it.nv)) return false;
                        vistos.add(it.nv);
                        return true;
                      }).map((it) => (it.punto_extra_id != null ? { punto_extra_id: it.punto_extra_id } : { nv: it.nv }));
                      setMapa({
                        nvs: uniqueNvs(items),
                        rutaOrden,
                        paradasExtra: items.filter((it) => it.punto_extra_id != null),
                        rutaReal: viaje.ruta_real || null,
                        horaSalida: viaje.hora_salida || null,
                        titulo: `Mapa · ${viaje.nombre?.trim() || `Viaje #${viaje.id}`}`,
                      });
                    }}
                    onMensaje={(viaje) => setMensajeViaje({ viajeId: viaje.id, titulo: viaje.nombre?.trim() || `Viaje #${viaje.id}` })}
                    onAdjuntosViaje={(viaje) => setAdjuntos({ viajeId: viaje.id, titulo: viaje.nombre?.trim() || `Viaje #${viaje.id}`, cuadrillaId: viaje.cuadrilla_id })}
                    onAdjuntosNv={(nv) => setAdjuntos({ nv, titulo: `NV ${nv}`, cuadrillaId: v.cuadrilla_id })}
                    onToggleZona={onToggleZona}
                    onRecalcularRuta={onRecalcularRuta}
                    recalculando={recalculando}
                    onProbarAviso={onProbarAviso}
                    probandoAviso={probandoAviso}
                    puntosExtra={puntosExtra}
                    agregandoParada={agregandoParadaViajeId === v.id}
                    onAbrirAgregarParada={abrirAgregarParada}
                    onCerrarAgregarParada={cerrarAgregarParada}
                    agregandoParadaBusy={agregandoParadaBusy}
                    onElegirParada={elegirParada}
                    onCrearParada={crearParada}
                    onQuitarParada={quitarParada}
                    onMoverParada={moverParada}
                    onGuardarHorarioParada={guardarHorarioParada}
                  />
                ))}
                {(detalle?.viajes || []).length === 0 ? (
                  <div style={{ opacity: 0.6, fontSize: 12, padding: 10 }}>Todavía no hay viajes creados para esta semana.</div>
                ) : null}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <div style={{ fontSize: 12, opacity: 0.8 }}>
                Despacho: {counts.despacho_asignados}/{counts.despacho_total} · Instalación: {counts.instalacion_asignados}/{counts.instalacion_total}
              </div>
              <div style={{ marginLeft: 'auto' }}>
                {cerrada ? (
                  canEdit ? <button className="btn" disabled={busy} onClick={onReabrirSemana}>Reabrir semana</button> : null
                ) : (
                  <button className="btn btn--brand" disabled={!puedeCerrar || busy} onClick={onCerrarSemana} title={faltan > 0 ? `Faltan ${faltan} por asignar` : ''}>
                    Cerrar semana{faltan > 0 ? ` (faltan ${faltan})` : ''}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <LogisticaZonasModal open={showZonas} config={config} onClose={() => setShowZonas(false)} onChanged={reloadConfig} />
      <LogisticaVehiculosModal open={showVehiculos} config={config} onClose={() => setShowVehiculos(false)} onChanged={reloadConfig} />
      <LogisticaCuadrillasModal open={showCuadrillas} config={config} onClose={() => setShowCuadrillas(false)} onChanged={reloadConfig} />
      <LogisticaReglasCapacidadModal open={showReglas} config={config} onClose={() => setShowReglas(false)} onChanged={() => { reloadConfig(); reloadDetalle(); }} />
      <LogisticaReglasEnvioModal open={showReglasEnvio} config={config} onClose={() => setShowReglasEnvio(false)} onChanged={reloadConfig} />
      <LogisticaIaConfigModal open={showIaConfig} onClose={() => setShowIaConfig(false)} />
      <PortonesMapaModal open={!!mapa} nvs={mapa?.nvs} rutaOrden={mapa?.rutaOrden} paradasExtra={mapa?.paradasExtra} rutaReal={mapa?.rutaReal} horaSalida={mapa?.horaSalida} titulo={mapa?.titulo} onClose={() => setMapa(null)} />
      <LogisticaMensajeViajeModal open={!!mensajeViaje} viajeId={mensajeViaje?.viajeId} titulo={mensajeViaje?.titulo} onClose={() => setMensajeViaje(null)} />
      <LogisticaAdjuntosModal open={!!adjuntos} viajeId={adjuntos?.viajeId} nv={adjuntos?.nv} titulo={adjuntos?.titulo} canEdit={canEdit} cuadrillaId={adjuntos?.cuadrillaId} onClose={() => setAdjuntos(null)} />
    </div>
  );
}
