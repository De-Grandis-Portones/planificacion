// src/components/LogisticaFechasMapaView.jsx
//
// Nueva vista principal de Planificación de Fechas: mapa embebido (no modal)
// con los portones pendientes de asignar a un viaje. Sin filtro de semana
// muestra TODOS los pendientes (cualquier semana, como ya hacía "Generar
// viaje con IA"); con una semana elegida, muestra TODOS los portones de esa
// semana - asignados (con la ruta de su viaje, coloreada por vehículo) y sin
// asignar (seleccionables) - para poder armar/consultar/ajustar viajes sin
// perder el contexto geográfico.
//
// Selección + recomendación de IA + confirmar y crear: mismo motor que
// LogisticaIaMapaModal.jsx (no se duplica la lógica de negocio, se adapta a
// vivir embebido en la página en vez de en un modal).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  fetchLogisticaPortonesSinViaje,
  fetchLogisticaSemanaMapa,
  fetchLogisticaSemanaPromesaMapa,
  fetchLogisticaSinFechaSalida,
  asignarLogisticaFechaSalida,
  toggleLogisticaViajeZona,
  fetchLogisticaViajesConfig,
  recomendarLogisticaViajeIa,
  planificarLogisticaRutasIa,
  crearLogisticaViaje,
  asignarLogisticaPorton,
  desasignarLogisticaPorton,
  reordenarLogisticaViaje,
  fetchLogisticaPuntosExtra,
  createLogisticaPuntoExtra,
  asignarLogisticaParadaExtra,
  desasignarLogisticaParadaExtra,
  updateLogisticaParadaExtraViaje,
} from '../api';
import { isoWeekStartEndFromLabel, weekNumberFromLabel, weekTitleFromSelection, todayISO10, buildWeekRange, isoWeekLabelFromDate } from '../utils/isoWeek';
import LogisticaZonasModal from './modals/LogisticaZonasModal';
import LogisticaIaConfigModal from './modals/LogisticaIaConfigModal';
import LogisticaPromesaConfigModal from './modals/LogisticaPromesaConfigModal';
import LogisticaMensajeViajeModal from './modals/LogisticaMensajeViajeModal';
import LogisticaVehiculosModal from './modals/LogisticaVehiculosModal';
import LogisticaCuadrillasModal from './modals/LogisticaCuadrillasModal';
import LogisticaChecklistModal from './modals/LogisticaChecklistModal';
import LogisticaParadasExtraModal from './modals/LogisticaParadasExtraModal';
import LogisticaWhatsappTemplatesModal from './modals/LogisticaWhatsappTemplatesModal';
import LogisticaAdjuntosModal from './modals/LogisticaAdjuntosModal';
import LogisticaViajeSemanaModal, { AgregarParadaExtra } from './LogisticaViajeSemanaModal';

const ARGENTINA_CENTER = [-38.4, -63.6];
const ARGENTINA_ZOOM = 4;

const COLOR_AMBOS = '#7c3aed';
const COLOR_DESPACHO = '#008241';
const COLOR_INSTALACION = '#2563eb';
const COLOR_SELECCIONADO = '#f59e0b';
const COLOR_ASIGNADO_SIN_PENDIENTE = '#9ca3af';
const COLOR_PROMESA_INFO = '#0891b2';
const COLOR_SIN_FECHA_SALIDA = '#f97316';

// Un color estable por vehículo (por posición en la lista de config, no por
// id crudo, para que el orden sea predecible) + gris para "sin vehículo".
const VEHICULO_PALETTE = ['#dc2626', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#0d9488'];
function colorPorVehiculo(vehiculoId, vehiculos) {
  if (vehiculoId == null) return '#6b7280';
  const idx = (vehiculos || []).findIndex((v) => v.id === vehiculoId);
  return VEHICULO_PALETTE[(idx >= 0 ? idx : 0) % VEHICULO_PALETTE.length];
}

function colorDe(item) {
  if (item.sin_fecha_salida) return COLOR_SIN_FECHA_SALIDA;
  if (item.despacho_pendiente && item.instalacion_pendiente) return COLOR_AMBOS;
  if (item.despacho_pendiente) return COLOR_DESPACHO;
  if (item.instalacion_pendiente) return COLOR_INSTALACION;
  // Modo "semana prometida": sabemos explícitamente que este NV todavía no
  // tiene despacho/instalación real (tiene_pendiente_real===false, no solo
  // "no aplica") - se distingue del gris de "ya asignado" del modo real.
  if (item.tiene_pendiente_real === false) return COLOR_PROMESA_INFO;
  return COLOR_ASIGNADO_SIN_PENDIENTE;
}

// Barrita de etapas de producción: Pendiente=rojo, En Proceso=amarillo,
// Finalizado=verde (pedido explícito del usuario).
function colorPorEstadoEtapa(estado) {
  if (estado === 'Finalizado') return '#16a34a';
  if (estado === 'En Proceso') return '#eab308';
  return '#dc2626';
}

// Tamaño de la etiqueta de semana cruzada y la barrita de etapas: crecen un
// poco al acercar el zoom (pedido del usuario) - a nivel base (como se veía
// antes) quedan igual que siempre, y hasta el doble bien acercado, donde hay
// más lugar en pantalla para leerlas cómodas.
const ZOOM_BASE = 12;
const ZOOM_TOPE = 17;
function escalaPorZoom(zoom) {
  if (zoom == null) return 1;
  const t = Math.min(1, Math.max(0, (zoom - ZOOM_BASE) / (ZOOM_TOPE - ZOOM_BASE)));
  return 1 + t;
}

// Semana cruzada a mostrar arriba del pin: en modo real, la semana
// prometida; en modo promesa, la semana real (despacho/instalación) - así
// se puede comparar sin cambiar de vista.
function semanaCruzadaLabel(it, modoSemana, weekNumberFromLabel) {
  if (modoSemana === 'promesa') {
    const partes = [];
    if (it.semana_real?.semana_despacho) partes.push(`D S${weekNumberFromLabel(it.semana_real.semana_despacho)}`);
    if (it.semana_real?.semana_instalacion) partes.push(`I S${weekNumberFromLabel(it.semana_real.semana_instalacion)}`);
    return partes.length ? `Real: ${partes.join(' / ')}` : '';
  }
  return it.semana_prometida ? `Prom: S${weekNumberFromLabel(it.semana_prometida)}` : '';
}

function agruparPorSemana(nvsSeleccionados, itemsByNv) {
  const pares = [];
  for (const nv of nvsSeleccionados) {
    const it = itemsByNv.get(nv);
    if (!it) continue;
    if (it.despacho_pendiente) pares.push({ nv, tipo: 'despacho', semana: it.semana_despacho, zona_id: it.zona?.zona_id ?? null });
    if (it.instalacion_pendiente) pares.push({ nv, tipo: 'instalacion', semana: it.semana_instalacion, zona_id: it.zona?.zona_id ?? null });
  }
  const counts = new Map();
  for (const p of pares) counts.set(p.semana, (counts.get(p.semana) || 0) + 1);
  let semana = null;
  let max = 0;
  for (const [wk, c] of counts) { if (c > max) { max = c; semana = wk; } }
  const incluidos = pares.filter((p) => p.semana === semana);
  const excluidos = pares.filter((p) => p.semana !== semana);
  return { semana, incluidos, excluidos };
}

// Horario propio de una parada extra, editable inline en la fila de la ruta
// (mismos dos campos que ParadaExtraChip en LogisticaViajeSemanaModal.jsx):
// duracion_minutos (cualquier parada, ej. "retirar un cobro" = 15 min, se
// SUMA al horario de llegada) y hora_salida_siguiente (solo descanso/
// hospedaje, la ruta SALTA a ese horario al día siguiente). Estado local
// para no perder lo que se está tipeando entre renders - se confirma con
// onBlur, no en cada tecla.
function ParadaHorarioInputs({ item, onGuardar }) {
  const [duracion, setDuracion] = useState(item.duracion_minutos ?? '');
  const [horaSalidaSig, setHoraSalidaSig] = useState(item.hora_salida_siguiente ?? '');
  useEffect(() => { setDuracion(item.duracion_minutos ?? ''); }, [item.duracion_minutos]);
  useEffect(() => { setHoraSalidaSig(item.hora_salida_siguiente ?? ''); }, [item.hora_salida_siguiente]);

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 9, alignItems: 'center', paddingLeft: 18 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 2 }} title="Cuánto tarda hacer esta parada (ej. retirar un cobro = 15 min) - se suma al horario de llegada">
        Dura (min)
        <input
          type="number" min="0" step="1" className="pp-input" style={{ width: 44, fontSize: 9, padding: '0 3px' }}
          value={duracion}
          onChange={(e) => setDuracion(e.target.value)}
          onBlur={() => onGuardar({ duracion_minutos: duracion === '' ? null : Number(duracion) })}
        />
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 2 }} title="Solo para descanso/hospedaje: la ruta retoma desde este horario AL DÍA SIGUIENTE de llegar acá">
        Sale día sig.
        <input
          type="time" className="pp-input" style={{ fontSize: 9, padding: '0 3px' }}
          value={horaSalidaSig}
          onChange={(e) => setHoraSalidaSig(e.target.value)}
          onBlur={() => onGuardar({ hora_salida_siguiente: horaSalidaSig || null })}
        />
      </label>
    </div>
  );
}

// Formato "HH:MM" con "(+Nd)" si el acumulado de minutos cruza medianoche
// (viajes largos, ej. 27hs totales, son reales en esta app).
function formatearHorario(totalMin) {
  const dias = Math.floor(totalMin / 1440);
  const minDia = totalMin % 1440;
  const hora = `${String(Math.floor(minDia / 60)).padStart(2, '0')}:${String(minDia % 60).padStart(2, '0')}`;
  return dias > 0 ? `${hora} (+${dias}d)` : hora;
}

function nvsEnOrdenSugerido(nvsList, ordenParadas) {
  if (!ordenParadas?.length) return nvsList;
  const ordenPorNv = new Map(ordenParadas.map((p) => [p.nv, p.orden]));
  return [...nvsList].sort((a, b) => {
    const oa = ordenPorNv.has(a) ? ordenPorNv.get(a) : Infinity;
    const ob = ordenPorNv.has(b) ? ordenPorNv.get(b) : Infinity;
    return oa - ob;
  });
}

// Normaliza los items "sin viaje" (una fila por NV, con flags
// despacho_pendiente/instalacion_pendiente) al mismo formato de fila-por-
// tipo que devuelve getSemanaMapa, para poder alimentar UNA sola lógica de
// agrupación/dibujo sea cual sea la fuente activa.
function expandirSinViaje(items) {
  const out = [];
  for (const it of items) {
    const base = { nv: it.nv, lat: it.lat, lng: it.lng, zona: it.zona, nombre: it.nombre, direccion: it.direccion, etapas: it.etapas, semana_prometida: it.semana_prometida };
    if (it.despacho_pendiente) out.push({ ...base, tipo: 'despacho', semana: it.semana_despacho, viaje_id: null });
    if (it.instalacion_pendiente) out.push({ ...base, tipo: 'instalacion', semana: it.semana_instalacion, viaje_id: null });
  }
  return out;
}

// Igual que expandirSinViaje, pero para getSemanaPromesaMapa: además de los
// NV con despacho/instalación pendiente real (accionables, se expanden
// igual), agrega una fila "promesa" para los que todavía NO tienen fecha
// real - si no, expandirSinViaje los descartaría del todo y no aparecerían
// como pin en el mapa.
function expandirPromesa(items) {
  const out = [];
  for (const it of items) {
    const base = { nv: it.nv, lat: it.lat, lng: it.lng, zona: it.zona, nombre: it.nombre, direccion: it.direccion, fecha_prometida: it.fecha_prometida, tiene_pendiente_real: it.tiene_pendiente_real, etapas: it.etapas, semana_real: it.semana_real };
    if (it.despacho_pendiente) out.push({ ...base, tipo: 'despacho', semana: it.semana_despacho, viaje_id: null });
    if (it.instalacion_pendiente) out.push({ ...base, tipo: 'instalacion', semana: it.semana_instalacion, viaje_id: null });
    if (!it.despacho_pendiente && !it.instalacion_pendiente) out.push({ ...base, tipo: 'promesa', semana: null, viaje_id: null });
  }
  return out;
}

// NV sin "Fecha Salida" cargada todavía (ver lib/logisticaSinFechaSalida.js
// en el backend) - modo de solo consulta: sin fecha no hay con qué agrupar
// en un viaje, así que no son seleccionables ni tienen semana.
function expandirSinFechaSalida(items) {
  return items.map((it) => ({
    nv: it.nv, lat: it.lat, lng: it.lng, zona: it.zona, nombre: it.nombre, direccion: it.direccion,
    nv_tipo: it.nv_tipo, distribuidor: it.distribuidor, etapas: it.etapas, semana_prometida: it.semana_prometida,
    sin_fecha_salida: true, tipo: 'sin_fecha_salida', semana: null, viaje_id: null,
  }));
}

export default function LogisticaFechasMapaView({ canEdit, onCreated }) {
  const nav = useNavigate();

  // Arranca en la semana en curso (pedido del usuario) - '' sigue siendo una
  // opción válida desde el selector ("Pendientes de asignar (todas)"), solo
  // que ya no es el default al entrar a la página.
  const [semanaFiltro, setSemanaFiltro] = useState(() => isoWeekLabelFromDate(todayISO10()));
  // 'real' = fecha_salida_imput/fecha_llegada_imput (lo de siempre); 'promesa'
  // = semana de producción ya reservada por el Presupuestador + margen
  // configurable (ver LogisticaPromesaConfigModal) - requiere semana elegida.
  const [modoSemana, setModoSemana] = useState('real');
  const [showPromesaConfig, setShowPromesaConfig] = useState(false);
  const [rawItems, setRawItems] = useState([]); // fila por (nv,tipo)
  // Solo aplica en modo real sin semana elegida (el pool de "pendientes de
  // cualquier semana"): filtra ESE pool a una semana en particular, sin
  // perder la vista de "todas" - pedido del usuario porque 99 pendientes
  // juntos era demasiado para mirar de un vistazo.
  const [semanaPendientesFiltro, setSemanaPendientesFiltro] = useState('');
  const [viajesSemana, setViajesSemana] = useState([]); // solo con filtro activo
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState(() => new Set());

  const [recomendando, setRecomendando] = useState(false);
  const [recomendacion, setRecomendacion] = useState(null);

  const [vista, setVista] = useState('seleccion'); // 'seleccion' | 'planes'
  const [planificando, setPlanificando] = useState(false);
  const [planes, setPlanes] = useState(null);

  const [confirmando, setConfirmando] = useState(false);
  const [confirmForm, setConfirmForm] = useState(null);
  const [creando, setCreando] = useState(false);
  const [resultado, setResultado] = useState(null);

  // Panel de acciones/config del costado - colapsado por defecto para que el
  // mapa ocupe todo el ancho (pedido explícito del usuario); el botón ⚙️ lo
  // despliega cuando hace falta seleccionar/crear un viaje o configurar algo.
  const [panelAbierto, setPanelAbierto] = useState(false);
  const [showZonas, setShowZonas] = useState(false);
  const [showIaConfig, setShowIaConfig] = useState(false);
  const [showVehiculos, setShowVehiculos] = useState(false);
  const [showCuadrillas, setShowCuadrillas] = useState(false);
  const [showChecklist, setShowChecklist] = useState(false);
  const [showParadasExtra, setShowParadasExtra] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [mensajeViaje, setMensajeViaje] = useState(null); // { viajeId, titulo } | null
  const [adjuntos, setAdjuntos] = useState(null); // { viajeId, titulo, cuadrillaId } | { nv, titulo, cuadrillaId } | null
  const [semanaModalAbierta, setSemanaModalAbierta] = useState(false); // abre LogisticaViajeSemanaModal (mismo popup que en Logística de Viajes) - ahora solo para fecha/zona/cuadrilla/vehículo/borrar; reordenar y agregar/quitar paradas ya se hace acá mismo

  // Editar la ruta de un viaje directamente en el panel del mapa (sin abrir
  // el popup completo) - pedido explícito del usuario ("quiero editarlo
  // directamente en ese mapa"). Catálogo de paradas extra (reutilizable
  // entre viajes) + qué viaje tiene abierto el picker para agregar una.
  const [puntosExtra, setPuntosExtra] = useState([]);
  const [agregandoParadaViajeId, setAgregandoParadaViajeId] = useState(null);
  const [agregandoParadaBusy, setAgregandoParadaBusy] = useState(false);
  // Arrastre nativo de una parada de la ruta a otra posición (mismo viaje) -
  // qué item se está arrastrando y sobre cuál está pasando ahora, para poder
  // dibujar la línea indicadora de "acá cae" mientras se arrastra.
  const [dragRuta, setDragRuta] = useState(null); // { viajeId, idx } | null
  const [dragOverRuta, setDragOverRuta] = useState(null); // { viajeId, idx } | null
  // Con más de un viaje en la semana, "Rutas de la semana" muestra solo el
  // elegido (pedido del usuario, para no scrollear entre varias tarjetas
  // largas) - pestañas arriba para cambiar. Se resuelve contra la lista
  // actual más abajo (viajeActivoId), no acá, para no tener que resetearlo a
  // mano cada vez que cambia la semana o se borra el viaje elegido.
  const [viajeSeleccionadoId, setViajeSeleccionadoId] = useState(null);

  // Asignar "Fecha Salida" desde el mapa (modo 'sin_fecha_salida') - mismo
  // campo que /a, para varios NV a la vez elegidos por cercanía geográfica.
  const [fechaSalidaAsignar, setFechaSalidaAsignar] = useState('');
  const [asignandoFechaSalida, setAsignandoFechaSalida] = useState(false);
  const [resultadoFechaSalida, setResultadoFechaSalida] = useState(null); // { actualizados } | null

  const [rutaOrdenParadas, setRutaOrdenParadas] = useState(null); // ruta sugerida por la IA (preview, antes de crear)
  const [rutaActivaKey, setRutaActivaKey] = useState(null);
  const limpiarRutaSugerida = () => { setRutaOrdenParadas(null); setRutaActivaKey(null); };

  const mapElRef = useRef(null);
  const mapRef = useRef(null);
  const markersLayerRef = useRef(null);
  const rutaSugeridaLayerRef = useRef(null);
  const rutasViajesLayerRef = useRef(null);
  const infoExtraLayerRef = useRef(null); // etiqueta de semana cruzada + barrita de etapas
  const markersByNvRef = useRef(new Map());
  const depositoMarkerRef = useRef(null); // punto de partida fijo (De Grandis Portones)
  const [zoom, setZoom] = useState(ARGENTINA_ZOOM);

  // Espejo de `selected` en un ref: el selector de portones superpuestos
  // (más abajo) lo lee al abrir el popup sin depender de que el efecto de
  // "Pines" se vuelva a ejecutar (si `selected` estuviera en sus deps,
  // cada click recrearía todos los marcadores y cerraría el popup solo).
  const selectedRef = useRef(selected);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  const reloadConfig = () => {
    fetchLogisticaViajesConfig().then((c) => setConfig(c?.config || null)).catch(() => {});
  };

  const load = useCallback(async () => {
    setErr('');
    if (modoSemana === 'promesa' && !semanaFiltro) { setRawItems([]); setViajesSemana([]); return; }
    setLoading(true);
    try {
      const [configRes, dataRes, peRes] = await Promise.all([
        fetchLogisticaViajesConfig(),
        modoSemana === 'sin_fecha_salida'
          ? fetchLogisticaSinFechaSalida()
          : modoSemana === 'promesa'
            ? fetchLogisticaSemanaPromesaMapa(semanaFiltro)
            : (semanaFiltro ? fetchLogisticaSemanaMapa(semanaFiltro) : fetchLogisticaPortonesSinViaje()),
        // Catálogo de paradas extra (ej. hoteles) - liviano, se pide siempre
        // para no bloquear el panel de "Rutas de la semana" con un segundo
        // request cuando el usuario abre "+ Parada".
        fetchLogisticaPuntosExtra().catch(() => null),
      ]);
      setConfig(configRes?.config || null);
      setPuntosExtra((peRes?.puntos || []).filter((p) => p.activo !== false));
      if (modoSemana === 'sin_fecha_salida') {
        setRawItems(expandirSinFechaSalida(Array.isArray(dataRes?.items) ? dataRes.items : []));
        setViajesSemana([]);
      } else if (modoSemana === 'promesa') {
        setRawItems(expandirPromesa(Array.isArray(dataRes?.items) ? dataRes.items : []));
        setViajesSemana([]);
      } else if (semanaFiltro) {
        // getSemanaMapa no devuelve `semana` por item (es implícito: son
        // todos de la semana que pedimos) - se la taggeamos acá para que
        // agruparPorSemana/itemsByNv puedan armar el viaje.
        const itemsConSemana = (dataRes?.detalle?.items || []).map((it) => ({ ...it, semana: semanaFiltro }));
        setRawItems(itemsConSemana);
        setViajesSemana(dataRes?.detalle?.viajes || []);
      } else {
        setRawItems(expandirSinViaje(Array.isArray(dataRes?.items) ? dataRes.items : []));
        setViajesSemana([]);
      }
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [semanaFiltro, modoSemana]);

  useEffect(() => {
    setSelected(new Set());
    setRecomendacion(null);
    setConfirmando(false);
    setResultado(null);
    setVista('seleccion');
    setPlanes(null);
    setSemanaPendientesFiltro('');
    setFechaSalidaAsignar('');
    setResultadoFechaSalida(null);
    limpiarRutaSugerida();
    load();
  }, [load]);

  // Al pasar a "semana prometida" sin ninguna semana elegida todavía, arranca
  // en la actual (no tiene sentido un "sin filtro" ahí - podrían ser cientos
  // de semanas futuras).
  useEffect(() => {
    if (modoSemana === 'promesa' && !semanaFiltro) setSemanaFiltro(isoWeekLabelFromDate(todayISO10()));
  }, [modoSemana, semanaFiltro]);

  // Semanas presentes en el pool de pendientes (modo real, sin semana
  // elegida) con cuánto pesa cada una - para poder filtrar el "todas" a una
  // semana en particular en vez de mirar el pool entero de una.
  const semanasPendientesConteo = useMemo(() => {
    if (semanaFiltro || modoSemana !== 'real') return [];
    const counts = new Map();
    for (const it of rawItems) {
      if (!it.semana) continue;
      counts.set(it.semana, (counts.get(it.semana) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [rawItems, semanaFiltro, modoSemana]);

  const rawItemsVisibles = useMemo(() => {
    if (!semanaFiltro && modoSemana === 'real' && semanaPendientesFiltro) {
      return rawItems.filter((it) => it.semana === semanaPendientesFiltro);
    }
    return rawItems;
  }, [rawItems, semanaFiltro, modoSemana, semanaPendientesFiltro]);

  // Resumen por NV (une despacho/instalación) - mismo shape que ya usaba
  // LogisticaIaMapaModal, así toda la lógica de selección/agrupación/creación
  // se reutiliza tal cual sea cual sea la fuente de datos activa.
  const itemsByNv = useMemo(() => {
    const map = new Map();
    for (const it of rawItemsVisibles) {
      if (!map.has(it.nv)) {
        map.set(it.nv, {
          nv: it.nv, lat: it.lat, lng: it.lng, zona: it.zona, nombre: it.nombre, direccion: it.direccion,
          despacho_pendiente: false, instalacion_pendiente: false, semana_despacho: null, semana_instalacion: null,
          fecha_prometida: it.fecha_prometida ?? null, tiene_pendiente_real: it.tiene_pendiente_real ?? null,
          etapas: it.etapas ?? null, semana_prometida: it.semana_prometida ?? null, semana_real: it.semana_real ?? null,
          sin_fecha_salida: it.sin_fecha_salida ?? false, distribuidor: it.distribuidor ?? null, nv_tipo: it.nv_tipo ?? null,
        });
      }
      const acc = map.get(it.nv);
      if (it.tipo === 'despacho' && it.viaje_id == null) { acc.despacho_pendiente = true; acc.semana_despacho = it.semana; }
      if (it.tipo === 'instalacion' && it.viaje_id == null) { acc.instalacion_pendiente = true; acc.semana_instalacion = it.semana; }
    }
    return map;
  }, [rawItemsVisibles]);

  const items = useMemo(() => Array.from(itemsByNv.values()), [itemsByNv]);
  const conUbicacion = useMemo(() => items.filter((i) => i.lat != null && i.lng != null), [items]);
  const sinUbicacion = items.length - conUbicacion.length;

  // Viajes de la semana filtrada, con su lista de NV únicos en orden real
  // (dedup despacho/instalación del mismo NV) para dibujar la ruta.
  const rutasPorViaje = useMemo(() => {
    if (!semanaFiltro) return [];
    const porViaje = new Map();
    for (const it of rawItems) {
      if (it.viaje_id == null) continue;
      if (!porViaje.has(it.viaje_id)) porViaje.set(it.viaje_id, []);
      porViaje.get(it.viaje_id).push(it);
    }
    return Array.from(porViaje.entries()).map(([viajeId, rows]) => {
      const viaje = viajesSemana.find((v) => v.id === viajeId) || {};
      // NV únicos con su orden más chico (despacho e instalación del mismo
      // NV son el mismo punto, solo hace falta una vez en la ruta).
      const ordenPorNv = new Map();
      for (const r of rows) {
        if (!ordenPorNv.has(r.nv) || (r.orden ?? 0) < ordenPorNv.get(r.nv)) ordenPorNv.set(r.nv, r.orden ?? 0);
      }
      const nvsEnOrden = Array.from(ordenPorNv.entries()).sort((a, b) => a[1] - b[1]).map(([nv]) => nv);
      // Paradas que no son un portón (ej. alojamiento) - viven en
      // viaje.paradas_extra (logisticaParadasExtra.js), no en rawItems (que
      // es portón-por-semana). Se combinan acá con los NV, en orden real de
      // ruta (misma secuencia de `orden`), para dibujar la línea/numeritos
      // tratándolas "tal cual un portón".
      const puntosRuta = [
        ...Array.from(ordenPorNv.entries()).map(([nv, orden]) => ({ tipo: 'nv', nv, orden })),
        ...(viaje.paradas_extra || []).map((p) => ({ tipo: 'extra', ...p })),
      ].sort((a, b) => a.orden - b.orden);
      return { viajeId, viaje, nvsEnOrden, puntosRuta, color: colorPorVehiculo(viaje.vehiculo_id, config?.vehiculos) };
    });
  }, [rawItems, viajesSemana, semanaFiltro, config]);

  // Igual criterio que itemsPorViaje en LogisticaViajeSemanaModal.jsx (portón
  // por (nv,tipo), no deduplicado - despacho e instalación del mismo NV
  // pueden tener su propio lugar en la ruta) - se usa para poder reordenar/
  // quitar/agregar paradas directamente en el panel del mapa, sin abrir ese
  // popup. Distinto de puntosRuta (que sí dedupea por NV, solo para dibujar
  // UN pin por domicilio).
  const itemsPorViajeMapa = useMemo(() => {
    const map = new Map();
    for (const it of rawItems) {
      if (it.viaje_id == null) continue;
      if (!map.has(it.viaje_id)) map.set(it.viaje_id, []);
      map.get(it.viaje_id).push(it);
    }
    for (const v of viajesSemana) {
      for (const p of v.paradas_extra || []) {
        if (!map.has(v.id)) map.set(v.id, []);
        map.get(v.id).push({ punto_extra_id: p.punto_extra_id, nombre: p.nombre, maps_url: p.maps_url, orden: p.orden, duracion_minutos: p.duracion_minutos, hora_salida_siguiente: p.hora_salida_siguiente });
      }
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0) || String(a.porton_id ?? `x${a.punto_extra_id}`).localeCompare(String(b.porton_id ?? `x${b.punto_extra_id}`)));
    }
    return map;
  }, [rawItems, viajesSemana]);

  // Viaje que se muestra en "Rutas de la semana" - el elegido si sigue
  // existiendo en esta semana, si no el primero (cubre cambio de semana,
  // viaje borrado, o primera carga sin nada elegido todavía).
  const viajeActivoId = useMemo(() => {
    if (viajeSeleccionadoId != null && rutasPorViaje.some((r) => r.viajeId === viajeSeleccionadoId)) return viajeSeleccionadoId;
    return rutasPorViaje[0]?.viajeId ?? null;
  }, [viajeSeleccionadoId, rutasPorViaje]);

  // Init del mapa (una sola vez)
  useEffect(() => {
    if (!mapElRef.current || mapRef.current) return;
    const map = L.map(mapElRef.current).setView(ARGENTINA_CENTER, ARGENTINA_ZOOM);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    markersLayerRef.current = L.layerGroup().addTo(map);
    infoExtraLayerRef.current = L.layerGroup().addTo(map);
    rutasViajesLayerRef.current = L.layerGroup().addTo(map);
    rutaSugeridaLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    setZoom(map.getZoom());
    map.on('zoomend', () => setZoom(map.getZoom()));
    return () => {
      map.remove();
      mapRef.current = null;
      markersLayerRef.current = null;
      infoExtraLayerRef.current = null;
      rutasViajesLayerRef.current = null;
      rutaSugeridaLayerRef.current = null;
      markersByNvRef.current = new Map();
    };
  }, []);

  // Punto de partida fijo de todos los viajes (De Grandis Portones) - se
  // muestra siempre, no depende del filtro de semana ni se limpia con los
  // demás layers. Coordenadas vienen del config (mismo endpoint que zonas/
  // vehículos/cuadrillas) para no duplicarlas también acá.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !config?.deposito) return;
    if (depositoMarkerRef.current) { depositoMarkerRef.current.remove(); depositoMarkerRef.current = null; }
    const { lat, lng, nombre } = config.deposito;
    // SVG en vez de emoji 🏰: el emoji rendereaba distinto según fuente/SO
    // (se vio como un cuadrito negro irreconocible) - un ícono dibujado a
    // mano se ve igual en cualquier lado. Silueta simple de castillo
    // (muralla + almenas + entrada), más grande y con más contraste que la
    // versión anterior (pedido explícito: "se ve muy chico").
    const castilloSvg = `<svg width="20" height="20" viewBox="0 0 16 16" style="flex:0 0 auto;">
      <rect x="1" y="7" width="14" height="8" fill="#fbbf24"/>
      <rect x="1" y="4" width="2" height="3" fill="#fbbf24"/>
      <rect x="4" y="2" width="2" height="5" fill="#fbbf24"/>
      <rect x="7" y="4" width="2" height="3" fill="#fbbf24"/>
      <rect x="10" y="2" width="2" height="5" fill="#fbbf24"/>
      <rect x="13" y="4" width="2" height="3" fill="#fbbf24"/>
      <rect x="6" y="10" width="4" height="5" fill="#1e293b"/>
    </svg>`;
    const icon = L.divIcon({
      className: '',
      // width:max-content (no solo iconSize:[1,1]) para que el fondo se
      // ajuste al contenido real, no al tamaño chico que le asigna Leaflet
      // al contenedor - antes el fondo quedaba recortado al ancho del
      // ícono y el texto se salía sin fondo detrás.
      html: `<div style="display:flex;align-items:center;gap:6px;background:#1e293b;color:#fff;border-radius:8px;padding:5px 10px;font-size:13px;font-weight:900;white-space:nowrap;border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.45);width:max-content;">${castilloSvg}${nombre}</div>`,
      iconSize: [220, 34], iconAnchor: [-14, 20],
    });
    const marker = L.marker([lat, lng], { icon, interactive: false, zIndexOffset: 1200 }).addTo(map);
    depositoMarkerRef.current = marker;
  }, [config]);

  // Pines
  useEffect(() => {
    const map = mapRef.current;
    const layer = markersLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    markersByNvRef.current = new Map();

    // Cuando 2+ portones caen prácticamente en el mismo punto (misma
    // dirección, o muy cerca), Leaflet solo deja clickear el que quedó
    // arriba en el z-order - los de abajo quedan inalcanzables. Se agrupan
    // por cercanía en PÍXELES (mismo criterio que la etiqueta de semana
    // cruzada más abajo) y, si hay más de uno, el click abre un selector en
    // vez de tildar directo - así se puede elegir cuál (o cuáles).
    const UMBRAL_SUPERPUESTOS_PX = 16;
    const clustersSuperpuestos = [];
    conUbicacion.forEach((it) => {
      const pt = map.latLngToContainerPoint([it.lat, it.lng]);
      let cluster = clustersSuperpuestos.find((c) => Math.hypot(c.x - pt.x, c.y - pt.y) < UMBRAL_SUPERPUESTOS_PX);
      if (!cluster) { cluster = { x: pt.x, y: pt.y, items: [] }; clustersSuperpuestos.push(cluster); }
      cluster.items.push(it);
    });
    const clusterPorNv = new Map();
    for (const c of clustersSuperpuestos) for (const it of c.items) clusterPorNv.set(it.nv, c);

    const abrirSelectorSuperpuestos = (marker, items) => {
      const cont = document.createElement('div');
      cont.style.cssText = 'min-width:220px;max-width:280px;display:flex;flex-direction:column;gap:4px;';
      const titulo = document.createElement('div');
      titulo.style.cssText = 'font-weight:900;font-size:12px;margin-bottom:2px;';
      titulo.textContent = `${items.length} portones en este punto:`;
      cont.appendChild(titulo);
      items.forEach((it) => {
        const puedeElegir = canEdit && (it.despacho_pendiente || it.instalacion_pendiente || it.sin_fecha_salida);
        // selectedRef (no el `selected` del closure del efecto, que puede
        // haber quedado viejo si el popup se reabre sin que "Pines" se
        // vuelva a correr) para el estado inicial; de ahí en más se togglea
        // local en cada click, sin releer React (evita quedar stale entre
        // clicks sucesivos dentro del mismo popup abierto).
        let isSel = selectedRef.current.has(it.nv);
        const row = document.createElement('div');
        const pintar = () => {
          row.style.cssText = `display:flex;align-items:center;gap:6px;padding:5px 7px;border-radius:6px;border:1px solid var(--border);${puedeElegir ? 'cursor:pointer;' : 'opacity:.6;'}background:${isSel ? 'var(--brand-100, #e0f2ea)' : 'transparent'};`;
          row.innerHTML = `<span style="display:inline-block;width:9px;height:9px;border-radius:999px;background:${colorDe(it)};flex:0 0 auto;"></span><span style="font-weight:800;font-size:12px;">${isSel ? '✓ ' : ''}NV ${it.nv}</span><span style="font-size:11px;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${it.nombre || ''}</span>`;
        };
        pintar();
        if (puedeElegir) {
          row.onclick = () => {
            isSel = !isSel;
            setSelected((prev) => {
              const next = new Set(prev);
              if (next.has(it.nv)) next.delete(it.nv); else next.add(it.nv);
              return next;
            });
            pintar();
          };
        }
        cont.appendChild(row);
      });
      marker.bindPopup(cont, { closeButton: true, minWidth: 220 }).openPopup();
    };

    conUbicacion.forEach((it) => {
      const seleccionable = canEdit && (it.despacho_pendiente || it.instalacion_pendiente || it.sin_fecha_salida);
      const marker = L.circleMarker([it.lat, it.lng], {
        radius: 10, color: '#fff', weight: 2, fillColor: colorDe(it), fillOpacity: 0.9,
        // interactive siempre true (así se puede ver el tooltip al pasar el
        // mouse aunque ya esté asignado - "consultar" es un caso de uso
        // explícito), el click a seleccionar se ata aparte solo si aplica.
      });
      const estadoExtra = it.sin_fecha_salida ? ` · SIN FECHA DE SALIDA${it.distribuidor ? ` · Dist: ${it.distribuidor}` : ''}`
        : it.despacho_pendiente ? ' · despacho pendiente'
        : it.instalacion_pendiente ? ' · instalación pendiente'
        : it.tiene_pendiente_real === false ? ' · prometido, sin fecha real todavía'
        : ' · ya asignado';
      const cluster = clusterPorNv.get(it.nv);
      const superpuesto = cluster && cluster.items.length > 1;
      marker.bindTooltip(`NV ${it.nv} — ${it.nombre || 'sin nombre'}${estadoExtra}${superpuesto ? ` · +${cluster.items.length - 1} más acá` : ''}`, { direction: 'top' });
      if (superpuesto) {
        marker.on('click', () => abrirSelectorSuperpuestos(marker, cluster.items));
      } else if (seleccionable) {
        marker.on('click', () => {
          setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(it.nv)) next.delete(it.nv); else next.add(it.nv);
            return next;
          });
        });
      }
      marker.addTo(layer);
      markersByNvRef.current.set(it.nv, marker);
    });

    if (conUbicacion.length > 0) {
      const bounds = L.latLngBounds(conUbicacion.map((it) => [it.lat, it.lng]));
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
    }
  }, [conUbicacion, canEdit]);

  // Etiqueta de semana cruzada (arriba del pin) + barrita de etapas de
  // producción (al lado, de abajo hacia arriba: diseño -> pintura sistema ->
  // armado final, roja/amarilla/verde según Pendiente/En Proceso/Finalizado).
  useEffect(() => {
    const map = mapRef.current;
    const layer = infoExtraLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    const escala = escalaPorZoom(zoom);

    // Cuando dos o más pines caen muy cerca en pantalla (misma dirección o
    // casi, ej. despacho e instalación de NV distintos en la misma cuadra),
    // sus etiquetas se pisan y quedan ilegibles - se agrupan por cercanía en
    // PÍXELES (no en metros, así el criterio es el mismo en cualquier zoom)
    // y se apilan una arriba de la otra en vez de superponerse.
    const UMBRAL_PX = 24;
    const clusters = [];
    conUbicacion.forEach((it) => {
      const pt = map.latLngToContainerPoint([it.lat, it.lng]);
      let cluster = clusters.find((c) => Math.hypot(c.x - pt.x, c.y - pt.y) < UMBRAL_PX);
      if (!cluster) { cluster = { x: pt.x, y: pt.y, nvs: [] }; clusters.push(cluster); }
      cluster.nvs.push(it.nv);
    });
    const stackIndexByNv = new Map();
    for (const c of clusters) c.nvs.forEach((nv, i) => stackIndexByNv.set(nv, i));

    conUbicacion.forEach((it) => {
      const stackIdx = stackIndexByNv.get(it.nv) || 0;
      const label = semanaCruzadaLabel(it, modoSemana, weekNumberFromLabel);
      if (label) {
        const fontSize = 9 * escala;
        const padY = 1 * escala;
        const padX = 4 * escala;
        const alturaEtiqueta = 13 * escala; // separación entre etiquetas apiladas del mismo cluster
        const labelIcon = L.divIcon({
          className: '',
          html: `<div style="background:#fff;color:#111;border:1px solid #999;border-radius:4px;padding:${padY}px ${padX}px;font-size:${fontSize}px;font-weight:800;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,.35);">${label}</div>`,
          iconSize: [1, 1], iconAnchor: [-4 * escala, 20 * escala + stackIdx * alturaEtiqueta],
        });
        L.marker([it.lat, it.lng], { icon: labelIcon, interactive: false, zIndexOffset: 800 }).addTo(layer);
      }

      if (it.etapas) {
        const segs = [
          colorPorEstadoEtapa(it.etapas.armado_final), // arriba
          colorPorEstadoEtapa(it.etapas.pintura),       // medio
          colorPorEstadoEtapa(it.etapas.diseno),        // abajo (empieza acá)
        ];
        const segSize = 6 * escala;
        const gap = 1 * escala;
        const barAlto = segSize * 3 + gap * 2;
        const barIcon = L.divIcon({
          className: '',
          html: `<div style="display:flex;flex-direction:column;gap:${gap}px;">${segs.map((c) => `<div style="width:${segSize}px;height:${segSize}px;background:${c};border:1px solid rgba(0,0,0,.25);"></div>`).join('')}</div>`,
          // Anchor a la DERECHA del ícono (valor positivo) para que el
          // dibujo quede a la IZQUIERDA del pin - así no se pisa con la
          // etiqueta de semana cruzada, que va arriba/derecha. El offset
          // también escala con el tamaño para que no se meta debajo del pin
          // al agrandarse con el zoom, y se corre más a la izquierda por
          // cada barrita apilada del mismo cluster para que tampoco se pisen
          // entre sí.
          iconSize: [segSize, barAlto], iconAnchor: [12 + segSize + stackIdx * (segSize + 4), barAlto / 2],
        });
        const marker = L.marker([it.lat, it.lng], { icon: barIcon, interactive: false, zIndexOffset: 700 });
        marker.bindTooltip(`Diseño: ${it.etapas.diseno}<br>Pintura sistema: ${it.etapas.pintura}<br>Armado final: ${it.etapas.armado_final}`, { direction: 'left' });
        marker.addTo(layer);
      }
    });
  }, [conUbicacion, modoSemana, zoom]);

  // Selección resaltada
  useEffect(() => {
    for (const [nv, marker] of markersByNvRef.current.entries()) {
      const it = itemsByNv.get(nv);
      const isSel = selected.has(nv);
      marker.setStyle({
        fillColor: isSel ? COLOR_SELECCIONADO : colorDe(it),
        radius: isSel ? 13 : 10,
        weight: isSel ? 3 : 2,
      });
    }
  }, [selected, itemsByNv]);

  // Rutas YA guardadas de los viajes de la semana filtrada, coloreadas por
  // vehículo (distinto de la ruta SUGERIDA por la IA, que es solo un preview
  // antes de crear - ver el efecto de abajo).
  useEffect(() => {
    const map = mapRef.current;
    const layer = rutasViajesLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    for (const { puntosRuta, color, viaje, viajeId } of rutasPorViaje) {
      // Reloj de llegada tramo a tramo (en el mismo orden que puntosRuta -
      // construirRutaViaje en el backend dedupea/ordena con el mismo
      // criterio) - null si el viaje no tiene hora_salida u ruta_real
      // todavía, ahí simplemente no se agrega el horario al tooltip. Una
      // parada extra puede correr el reloj: duracion_minutos lo SUMA
      // (cualquier parada, ej. "retirar un cobro" = 15 min);
      // hora_salida_siguiente lo hace SALTAR (reemplaza, no suma) al día
      // siguiente - solo descanso/hospedaje, gana por sobre
      // duracion_minutos si están las dos cargadas.
      const segmentosHoras = viaje.ruta_real?.segmentos_horas;
      let minutosClock = null;
      if (viaje.hora_salida && segmentosHoras?.length) {
        const [h, m] = viaje.hora_salida.split(':').map(Number);
        minutosClock = h * 60 + m;
      }
      let segIdx = 0;
      // Todo viaje sale del depósito (De Grandis Portones) - lo agregamos
      // como primer punto de la línea, sin numerito (el numerito 1 sigue
      // siendo la primera parada real).
      const puntos = config?.deposito ? [[config.deposito.lat, config.deposito.lng]] : [];
      let numParada = 0;
      puntosRuta.forEach((p) => {
        const esExtra = p.tipo === 'extra';
        const it = esExtra ? p : itemsByNv.get(p.nv);
        if (!it || it.lat == null || it.lng == null) return;
        puntos.push([it.lat, it.lng]);
        numParada += 1;

        let horaLlegada = null;
        if (minutosClock != null && segmentosHoras[segIdx] != null) {
          minutosClock += segmentosHoras[segIdx] * 60;
          const totalMin = Math.round(minutosClock);
          horaLlegada = formatearHorario(totalMin);
          if (esExtra && p.hora_salida_siguiente) {
            const dia = Math.floor(totalMin / 1440);
            const [hs, ms] = p.hora_salida_siguiente.split(':').map(Number);
            minutosClock = (dia + 1) * 1440 + hs * 60 + ms;
          } else if (esExtra && p.duracion_minutos) {
            minutosClock += Number(p.duracion_minutos);
          }
          segIdx += 1;
        }

        const icon = L.divIcon({
          className: '',
          html: `<div style="background:${esExtra ? '#f59e0b' : color};color:#fff;border-radius:999px;width:18px;height:18px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:900;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4)">${esExtra ? '🏨' : numParada}</div>`,
          iconSize: [18, 18], iconAnchor: [9, 9],
        });
        const m = L.marker([it.lat, it.lng], { icon, zIndexOffset: 900 });
        const etiqueta = esExtra ? p.nombre : `parada ${numParada}`;
        m.bindTooltip(`${viaje.nombre?.trim() || `Viaje #${viajeId}`} · ${etiqueta}${horaLlegada ? ` · 🕒 ${horaLlegada}` : ''}`, { direction: 'top' });
        m.addTo(layer);
      });
      // Ruta real por calle (OpenRouteService, perfil camión), si ya se
      // calculó para este viaje - si no, cae a la línea recta de siempre
      // entre las paradas (mismo criterio que el resto de la app).
      const geometria = viaje.ruta_real?.geometria;
      if (geometria?.length >= 2) {
        L.polyline(geometria, { color, weight: 4, opacity: 0.8 }).addTo(layer);
      } else if (puntos.length >= 2) {
        L.polyline(puntos, { color, weight: 3, opacity: 0.75, dashArray: '2 6' }).addTo(layer);
      }
    }
  }, [rutasPorViaje, itemsByNv, config]);

  // Ruta SUGERIDA por la IA (preview antes de crear) - línea punteada roja +
  // numerito, se dibuja por encima de todo lo demás.
  useEffect(() => {
    const layer = rutaSugeridaLayerRef.current;
    const map = mapRef.current;
    if (!layer || !map) return;
    layer.clearLayers();
    if (!rutaOrdenParadas || rutaOrdenParadas.length === 0) return;

    const ordenados = [...rutaOrdenParadas].sort((a, b) => a.orden - b.orden);
    const puntos = config?.deposito ? [[config.deposito.lat, config.deposito.lng]] : [];
    ordenados.forEach((p, i) => {
      const it = itemsByNv.get(p.nv);
      if (!it || it.lat == null || it.lng == null) return;
      puntos.push([it.lat, it.lng]);
      const icon = L.divIcon({
        className: '',
        html: `<div style="background:#dc2626;color:#fff;border-radius:999px;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4)">${i + 1}</div>`,
        iconSize: [20, 20], iconAnchor: [10, 10],
      });
      L.marker([it.lat, it.lng], { icon, interactive: false, zIndexOffset: 1000 }).addTo(layer);
    });
    if (puntos.length >= 2) {
      const polyline = L.polyline(puntos, { color: '#dc2626', weight: 3, opacity: 0.8, dashArray: '8 6' }).addTo(layer);
      map.fitBounds(polyline.getBounds(), { padding: [60, 60], maxZoom: 13 });
    }
  }, [rutaOrdenParadas, itemsByNv, config]);

  const rutaSinUbicacionNvs = useMemo(() => {
    if (!rutaOrdenParadas) return [];
    return rutaOrdenParadas.filter((p) => { const it = itemsByNv.get(p.nv); return !it || it.lat == null || it.lng == null; }).map((p) => p.nv);
  }, [rutaOrdenParadas, itemsByNv]);

  const generarRecomendacion = async () => {
    setRecomendando(true);
    setErr('');
    try {
      const data = await recomendarLogisticaViajeIa(Array.from(selected));
      setRecomendacion(data);
      setRutaOrdenParadas(data?.recomendacion?.orden_paradas || null);
      setRutaActivaKey('recomendacion');
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setRecomendando(false);
    }
  };

  const abrirConfirmacion = (nvsList, opts = {}) => {
    const { semana, incluidos, excluidos } = agruparPorSemana(nvsList, itemsByNv);
    if (!semana) { setErr('Ninguno de los portones de esta propuesta tiene semana asignada.'); return; }

    const { start, end } = isoWeekStartEndFromLabel(semana);
    const hoy = todayISO10();
    const fechaDefault = hoy >= start && hoy <= end ? hoy : start;

    const vehiculoSugerido = (config?.vehiculos || []).find(
      (v) => v.activo && opts.vehiculoSugerido && v.nombre.trim().toLowerCase() === String(opts.vehiculoSugerido).trim().toLowerCase()
    );

    const zonaCounts = new Map();
    for (const p of incluidos) if (p.zona_id) zonaCounts.set(p.zona_id, (zonaCounts.get(p.zona_id) || 0) + 1);
    let zonaId = null, zonaMax = 0;
    for (const [zid, c] of zonaCounts) if (c > zonaMax) { zonaMax = c; zonaId = zid; }

    setConfirmForm({
      semana, incluidos, excluidos, fecha: fechaDefault,
      zona_id: zonaId ? String(zonaId) : '',
      cuadrilla_id: '',
      vehiculo_id: vehiculoSugerido ? String(vehiculoSugerido.id) : '',
      nombre: opts.nombreSugerido || `Viaje · Semana ${weekNumberFromLabel(semana)}`,
      fondo_efectivo: '',
    });
    setConfirmando(true);
  };

  const planificarTodo = async () => {
    setPlanificando(true);
    setErr('');
    try {
      const data = await planificarLogisticaRutasIa();
      setPlanes(data);
      setVista('planes');
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setPlanificando(false);
    }
  };

  const crear = async () => {
    setCreando(true);
    setErr('');
    try {
      const { semana, incluidos, excluidos, fecha, zona_id, cuadrilla_id, vehiculo_id, nombre, fondo_efectivo } = confirmForm;
      const crearRes = await crearLogisticaViaje(semana, {
        fecha, zona_id: zona_id ? Number(zona_id) : null,
        cuadrilla_id: cuadrilla_id ? Number(cuadrilla_id) : null,
        vehiculo_id: vehiculo_id ? Number(vehiculo_id) : null,
        nombre: nombre || null,
        fondo_efectivo: fondo_efectivo || null,
      });
      const detalle = crearRes?.detalle;
      const viaje = (detalle?.viajes || []).reduce((max, v) => (max == null || v.id > max.id ? v : max), null);
      if (!viaje) throw new Error('El viaje se creó pero no lo pude encontrar para asignar los portones');

      let asignados = 0;
      const fallidos = [];
      for (const p of incluidos) {
        const item = (detalle.items || []).find((it) => it.nv === p.nv && it.tipo === p.tipo);
        if (!item) { fallidos.push(p); continue; }
        try { await asignarLogisticaPorton(viaje.id, item.porton_id, p.tipo); asignados += 1; }
        catch { fallidos.push(p); }
      }

      setResultado({ viajeId: viaje.id, semana, asignados, excluidos, fallidos });
      setConfirmando(false);
      setRecomendacion(null);
      setVista('seleccion');
      setPlanes(null);
      setSelected(new Set());
      limpiarRutaSugerida();
      onCreated?.();
      // Los portones recién asignados tienen que desaparecer del pool "sin
      // viaje" (vista sin filtro) o aparecer con su ruta nueva (vista de esa
      // semana) - en ambos casos hace falta recargar.
      load();
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setCreando(false);
    }
  };

  const toggleZona = async (viajeId, zonaId, habilitada) => {
    try {
      await toggleLogisticaViajeZona(viajeId, zonaId, habilitada);
      load();
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    }
  };

  // Edición de la ruta directamente en el panel del mapa - mismo mecanismo
  // (reordenarLogisticaViaje acepta la lista mixta completa) que usa
  // LogisticaViajeSemanaModal, disponible de dos formas: arrastrar la parada
  // a la posición nueva, o las flechas ▲▼ para ajustes finos de a un lugar.
  const aplicarNuevoOrdenRuta = async (viajeId, itemsEnNuevoOrden) => {
    const payload = itemsEnNuevoOrden.map((it) => (it.punto_extra_id != null ? { punto_extra_id: it.punto_extra_id } : { porton_id: it.porton_id, tipo: it.tipo }));
    try {
      await reordenarLogisticaViaje(viajeId, payload);
      load();
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    }
  };

  const moverItemRuta = (viajeId, idx, direccion) => {
    const items = itemsPorViajeMapa.get(viajeId) || [];
    const destino = idx + direccion;
    if (destino < 0 || destino >= items.length) return;
    const reordenado = [...items];
    [reordenado[idx], reordenado[destino]] = [reordenado[destino], reordenado[idx]];
    aplicarNuevoOrdenRuta(viajeId, reordenado);
  };

  // Splice: sacar de origenIdx e insertar en destinoIdx - si destinoIdx cae
  // en o después del último lugar, splice lo deja al final (no hace falta
  // "soltar en el área vacía" como sí necesita el drag&drop de la columna
  // del modal completo, acá siempre se suelta sobre una parada puntual).
  const arrastrarItemRuta = (viajeId, origenIdx, destinoIdx) => {
    if (origenIdx === destinoIdx) return;
    const items = itemsPorViajeMapa.get(viajeId) || [];
    const reordenado = [...items];
    const [movido] = reordenado.splice(origenIdx, 1);
    reordenado.splice(destinoIdx, 0, movido);
    aplicarNuevoOrdenRuta(viajeId, reordenado);
  };

  const quitarPortonRuta = async (viajeId, portonId, tipo) => {
    try {
      await desasignarLogisticaPorton(viajeId, portonId, tipo);
      load();
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    }
  };

  const quitarParadaExtraRuta = async (viajeId, puntoExtraId) => {
    try {
      await desasignarLogisticaParadaExtra(viajeId, puntoExtraId);
      load();
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    }
  };

  // Horario propio de una parada extra - duracion_minutos (cualquier
  // parada, ej. "retirar un cobro" = 15 min) y/o hora_salida_siguiente
  // (solo descanso/hospedaje, la ruta retoma desde ahí al día siguiente).
  const guardarHorarioParadaRuta = async (viajeId, puntoExtraId, patch) => {
    try {
      await updateLogisticaParadaExtraViaje(viajeId, puntoExtraId, patch);
      load();
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    }
  };

  const elegirParadaRuta = async (viajeId, puntoExtraId) => {
    setAgregandoParadaBusy(true);
    setErr('');
    try {
      await asignarLogisticaParadaExtra(viajeId, puntoExtraId);
      setAgregandoParadaViajeId(null);
      load();
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setAgregandoParadaBusy(false);
    }
  };

  const crearParadaRuta = async (viajeId, nombre, mapsUrl) => {
    setAgregandoParadaBusy(true);
    setErr('');
    try {
      const { punto } = await createLogisticaPuntoExtra({ nombre, maps_url: mapsUrl });
      setPuntosExtra((prev) => [...prev, punto].sort((a, b) => a.nombre.localeCompare(b.nombre)));
      await asignarLogisticaParadaExtra(viajeId, punto.id);
      setAgregandoParadaViajeId(null);
      load();
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setAgregandoParadaBusy(false);
    }
  };

  const asignarFechaSalida = async () => {
    if (!fechaSalidaAsignar || selected.size === 0) return;
    setAsignandoFechaSalida(true);
    setErr('');
    try {
      const items = Array.from(selected)
        .map((nv) => itemsByNv.get(nv))
        .filter(Boolean)
        .map((it) => ({ nv: it.nv, nv_tipo: it.nv_tipo }));
      const data = await asignarLogisticaFechaSalida(items, fechaSalidaAsignar);
      setResultadoFechaSalida({ actualizados: data?.actualizados ?? items.length });
      setSelected(new Set());
      setFechaSalidaAsignar('');
      // Los NV recién asignados dejan de tener "Fecha Salida" vacía, así que
      // tienen que desaparecer de este pool.
      load();
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setAsignandoFechaSalida(false);
    }
  };

  const rec = recomendacion?.recomendacion;

  const semanasDisponibles = useMemo(() => {
    const base = buildWeekRange(12, 30);
    const actual = isoWeekLabelFromDate(todayISO10());
    return Array.from(new Set([...base, actual])).sort();
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div className="btn" style={{ display: 'inline-flex', padding: 2, gap: 2 }}>
          <button
            type="button" className="btn" onClick={() => setModoSemana('real')}
            style={{ border: 'none', background: modoSemana === 'real' ? 'var(--brand)' : 'transparent', color: modoSemana === 'real' ? '#fff' : undefined }}
          >
            Fecha real
          </button>
          <button
            type="button" className="btn" onClick={() => setModoSemana('promesa')}
            style={{ border: 'none', background: modoSemana === 'promesa' ? 'var(--brand)' : 'transparent', color: modoSemana === 'promesa' ? '#fff' : undefined }}
          >
            Fecha prometida
          </button>
          <button
            type="button" className="btn" onClick={() => setModoSemana('sin_fecha_salida')}
            style={{ border: 'none', background: modoSemana === 'sin_fecha_salida' ? 'var(--brand)' : 'transparent', color: modoSemana === 'sin_fecha_salida' ? '#fff' : undefined }}
          >
            Sin fecha de salida
          </button>
        </div>
        {modoSemana !== 'sin_fecha_salida' ? (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700 }}>
            Semana
            <select className="pp-select" value={semanaFiltro} onChange={(e) => setSemanaFiltro(e.target.value)}>
              {modoSemana === 'real' ? <option value="">— Pendientes de asignar (todas) —</option> : null}
              {semanasDisponibles.map((wk) => (
                <option key={wk} value={wk}>Semana {weekNumberFromLabel(wk)} — {weekTitleFromSelection(wk).replace(/^Semana \d+ /, '')}</option>
              ))}
            </select>
          </label>
        ) : null}
        {modoSemana === 'real' && !semanaFiltro && semanasPendientesConteo.length > 0 ? (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700 }}>
            Filtrar pendientes por semana
            <select className="pp-select" value={semanaPendientesFiltro} onChange={(e) => setSemanaPendientesFiltro(e.target.value)}>
              <option value="">— Todas —</option>
              {semanasPendientesConteo.map(([wk, count]) => (
                <option key={wk} value={wk}>Semana {weekNumberFromLabel(wk)} ({count})</option>
              ))}
            </select>
          </label>
        ) : null}
        <div style={{ fontSize: 11, opacity: 0.7 }}>
          {loading ? 'Cargando…' : modoSemana === 'sin_fecha_salida'
            ? `${conUbicacion.length} de ${items.length} portones sin fecha de salida con ubicación${sinUbicacion ? ` (+${sinUbicacion} sin ubicación)` : ''}`
            : modoSemana === 'promesa'
              ? `${conUbicacion.length} de ${items.length} portones prometidos para esta semana con ubicación${sinUbicacion ? ` (+${sinUbicacion} sin ubicación)` : ''} · ${selected.size} seleccionado${selected.size === 1 ? '' : 's'}`
              : semanaFiltro
                ? `${conUbicacion.length} de ${items.length} portones de la semana con ubicación${sinUbicacion ? ` (+${sinUbicacion} sin ubicación)` : ''} · ${rutasPorViaje.length} viaje${rutasPorViaje.length === 1 ? '' : 's'} · ${selected.size} seleccionado${selected.size === 1 ? '' : 's'}`
                : `${conUbicacion.length} portones sin viaje con ubicación${sinUbicacion ? ` (+${sinUbicacion} sin ubicación resuelta)` : ''} · ${selected.size} seleccionado${selected.size === 1 ? '' : 's'}`}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, fontSize: 11, alignItems: 'center', flexWrap: 'wrap' }}>
          {modoSemana === 'sin_fecha_salida' ? (
            <>
              <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 999, background: COLOR_SIN_FECHA_SALIDA, marginRight: 3 }} />sin fecha de salida</span>
              <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 999, background: COLOR_SELECCIONADO, marginRight: 3 }} />seleccionado</span>
            </>
          ) : (
            <>
              <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 999, background: COLOR_DESPACHO, marginRight: 3 }} />despacho</span>
              <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 999, background: COLOR_INSTALACION, marginRight: 3 }} />instalación</span>
              <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 999, background: COLOR_AMBOS, marginRight: 3 }} />ambos</span>
              <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 999, background: COLOR_SELECCIONADO, marginRight: 3 }} />seleccionado</span>
              {modoSemana === 'promesa'
                ? <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 999, background: COLOR_PROMESA_INFO, marginRight: 3 }} />prometido, sin fecha real</span>
                : semanaFiltro ? <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 999, background: COLOR_ASIGNADO_SIN_PENDIENTE, marginRight: 3 }} />ya asignado</span> : null}
            </>
          )}
        </div>
        {canEdit ? (
          <button
            type="button"
            className="btn"
            title={panelAbierto ? 'Ocultar panel de acciones/config' : 'Mostrar panel de acciones/config'}
            style={panelAbierto ? { background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' } : undefined}
            onClick={() => setPanelAbierto((v) => !v)}
          >
            ⚙️ {panelAbierto ? 'Ocultar panel' : 'Panel'}
          </button>
        ) : null}
      </div>

      {err ? <div style={{ color: 'crimson', fontWeight: 800, fontSize: 12 }}>{err}</div> : null}

      <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', gap: 10 }}>
        <div style={{ flex: '1 1 auto', minWidth: 0, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)', position: 'relative' }}>
          <div ref={mapElRef} style={{ width: '100%', height: '100%' }} />
          {rutaOrdenParadas?.length > 0 ? (
            <div style={{ position: 'absolute', bottom: 10, left: 10, zIndex: 1000, background: 'var(--surface)', border: '1px solid var(--border)', padding: '6px 10px', borderRadius: 8, fontSize: 11, boxShadow: '0 1px 4px rgba(0,0,0,.25)', maxWidth: 280 }}>
              🔴 Línea punteada = orden sugerido por la IA (todavía no creado). Distancia en línea recta, no la ruta real por calle.
              {rutaSinUbicacionNvs.length > 0 ? (
                <div style={{ marginTop: 4, color: '#92400e' }}>NV {rutaSinUbicacionNvs.join(', ')} sin ubicación resuelta, no aparece{rutaSinUbicacionNvs.length === 1 ? '' : 'n'} en la línea.</div>
              ) : null}
            </div>
          ) : null}
        </div>

        {semanaFiltro && rutasPorViaje.length > 0 ? (
          <div style={{ width: 260, flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto' }}>
            <div style={{ fontWeight: 900, fontSize: 13 }}>Rutas de la semana</div>

            {rutasPorViaje.length > 1 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {rutasPorViaje.map(({ viajeId, viaje, color }) => {
                  const activo = viajeActivoId === viajeId;
                  return (
                    <button
                      key={viajeId}
                      type="button"
                      onClick={() => setViajeSeleccionadoId(viajeId)}
                      title={viaje.nombre?.trim() || `Viaje #${viajeId}`}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: activo ? 800 : 600,
                        padding: '3px 8px', borderRadius: 999, cursor: 'pointer',
                        border: `1px solid ${activo ? color : 'var(--border)'}`,
                        background: activo ? color : 'var(--surface)',
                        color: activo ? '#fff' : 'inherit',
                      }}
                    >
                      <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 999, background: activo ? '#fff' : color, flex: '0 0 auto' }} />
                      {viaje.nombre?.trim() || `Viaje #${viajeId}`}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {rutasPorViaje.filter(({ viajeId }) => viajeId === viajeActivoId).map(({ viajeId, viaje, color, puntosRuta }) => {
              const itemsRuta = itemsPorViajeMapa.get(viajeId) || [];
              return (
                <div key={viajeId} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 999, background: color, flex: '0 0 auto' }} />
                    <span style={{ fontWeight: 800, fontSize: 12, flex: 1 }}>{viaje.nombre?.trim() || `Viaje #${viajeId}`}</span>
                    <button
                      type="button" className="btn" style={{ fontSize: 9, padding: '1px 5px', flex: '0 0 auto' }}
                      onClick={() => setSemanaModalAbierta(true)}
                      title={canEdit ? 'Editar fecha, zona, cuadrilla, vehículo, hora de salida o borrar el viaje' : 'Ver todos los detalles del viaje'}
                    >
                      ⚙️
                    </button>
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.75 }}>
                    {viaje.vehiculo_nombre || 'sin vehículo'} · {puntosRuta.length} parada{puntosRuta.length === 1 ? '' : 's'}
                    {viaje.hora_salida ? ` · sale ${viaje.hora_salida}` : ''}
                    {viaje.ruta_real ? ` · ${viaje.ruta_real.distancia_km} km · ${viaje.ruta_real.duracion_horas}h por calle` : ''}
                  </div>
                  {viaje.zonas?.length > 0 ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {viaje.zonas.map((z) => (
                        <button
                          key={z.zona_id}
                          type="button"
                          disabled={!canEdit}
                          onClick={() => toggleZona(viajeId, z.zona_id, !z.habilitada)}
                          title={(z.habilitada ? 'Zona habilitada' : 'Zona deshabilitada') + ' - la ruta pasa por acá · click para cambiar'}
                          style={{
                            fontSize: 9, padding: '1px 6px', borderRadius: 999, border: '1px solid var(--border)',
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
                  ) : null}

                  {canEdit && itemsRuta.length > 1 ? (
                    <div style={{ fontSize: 9, opacity: 0.55 }}>Arrastrá una parada a su nuevo lugar, o usá ▲▼ para ajustes finos.</div>
                  ) : null}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {itemsRuta.map((it, idx) => {
                      const esExtra = it.punto_extra_id != null;
                      const key = esExtra ? `extra-${it.punto_extra_id}` : `${it.porton_id}-${it.tipo}`;
                      const esDragOver = dragOverRuta?.viajeId === viajeId && dragOverRuta?.idx === idx;
                      return (
                        <div key={key}>
                          {esDragOver ? <div style={{ height: 3, background: 'var(--brand)', borderRadius: 2, marginBottom: 2 }} /> : null}
                          <div
                            draggable={canEdit}
                            onDragStart={(e) => { setDragRuta({ viajeId, idx }); e.dataTransfer.effectAllowed = 'move'; }}
                            onDragEnd={() => { setDragRuta(null); setDragOverRuta(null); }}
                            onDragOver={(e) => {
                              if (!canEdit || !dragRuta || dragRuta.viajeId !== viajeId) return;
                              e.preventDefault();
                              if (dragOverRuta?.idx !== idx) setDragOverRuta({ viajeId, idx });
                            }}
                            onDrop={(e) => {
                              if (!canEdit) return;
                              e.preventDefault();
                              e.stopPropagation();
                              const origen = dragRuta;
                              setDragRuta(null);
                              setDragOverRuta(null);
                              if (!origen || origen.viajeId !== viajeId || origen.idx === idx) return;
                              arrastrarItemRuta(viajeId, origen.idx, idx);
                            }}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 4, borderRadius: 6, padding: '3px 5px',
                              border: `1px solid ${esExtra ? '#f59e0b' : 'var(--border)'}`,
                              background: esExtra ? 'rgba(245,158,11,0.08)' : 'transparent',
                              cursor: canEdit ? 'grab' : 'default',
                            }}
                          >
                            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, height: 14, borderRadius: 999, background: '#dc2626', color: '#fff', fontSize: 8, fontWeight: 900, flex: '0 0 auto' }}>
                              {idx + 1}
                            </span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 10, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {esExtra ? `🏨 ${it.nombre}` : `NV ${it.nv}${it.tipo ? ` · ${it.tipo === 'despacho' ? 'Desp.' : 'Inst.'}` : ''}`}
                              </div>
                              {!esExtra && it.nombre ? (
                                <div style={{ fontSize: 9, opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.nombre}</div>
                              ) : null}
                            </div>
                            {!esExtra && it.telefono ? (
                              <button
                                type="button" className="btn" style={{ padding: '0 4px', fontSize: 10, flex: '0 0 auto' }}
                                onClick={() => nav(`/admin/logistica-whatsapp?telefono=${encodeURIComponent(it.telefono)}`)}
                                title="Abrir chat de WhatsApp con el cliente"
                              >
                                💬
                              </button>
                            ) : null}
                            {!esExtra ? (
                              <button
                                type="button" className="btn" style={{ padding: '0 4px', fontSize: 10, flex: '0 0 auto' }}
                                onClick={() => setAdjuntos({ nv: it.nv, titulo: `NV ${it.nv}`, cuadrillaId: viaje.cuadrilla_id })}
                                title="Adjuntos (DNI, certificados, etc.)"
                              >
                                📎
                              </button>
                            ) : null}
                            {canEdit ? (
                              <>
                                <div style={{ display: 'flex', flexDirection: 'column', flex: '0 0 auto' }}>
                                  <button type="button" className="btn" disabled={idx === 0} onClick={() => moverItemRuta(viajeId, idx, -1)} style={{ padding: '0 3px', fontSize: 8, lineHeight: '10px' }} title="Subir">▲</button>
                                  <button type="button" className="btn" disabled={idx === itemsRuta.length - 1} onClick={() => moverItemRuta(viajeId, idx, 1)} style={{ padding: '0 3px', fontSize: 8, lineHeight: '10px' }} title="Bajar">▼</button>
                                </div>
                                <button
                                  type="button" className="btn" style={{ padding: '0 4px', fontSize: 10, flex: '0 0 auto', borderColor: '#ef4444', color: '#991b1b' }}
                                  onClick={() => (esExtra ? quitarParadaExtraRuta(viajeId, it.punto_extra_id) : quitarPortonRuta(viajeId, it.porton_id, it.tipo))}
                                  title="Quitar del viaje"
                                >
                                  ×
                                </button>
                              </>
                            ) : null}
                          </div>
                          {esExtra && canEdit ? (
                            <ParadaHorarioInputs item={it} onGuardar={(patch) => guardarHorarioParadaRuta(viajeId, it.punto_extra_id, patch)} />
                          ) : null}
                        </div>
                      );
                    })}
                  </div>

                  {canEdit ? (
                    agregandoParadaViajeId === viajeId ? (
                      <AgregarParadaExtra
                        puntosExtra={puntosExtra}
                        busy={agregandoParadaBusy}
                        onElegir={(puntoExtraId) => elegirParadaRuta(viajeId, puntoExtraId)}
                        onCrear={(nombre, mapsUrl) => crearParadaRuta(viajeId, nombre, mapsUrl)}
                        onCancelar={() => setAgregandoParadaViajeId(null)}
                      />
                    ) : (
                      <button type="button" className="btn" style={{ fontSize: 10 }} onClick={() => setAgregandoParadaViajeId(viajeId)}>
                        🏨 + Parada
                      </button>
                    )
                  ) : null}

                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      type="button" className="btn" style={{ fontSize: 10, padding: '1px 6px' }}
                      onClick={() => setMensajeViaje({ viajeId, titulo: viaje.nombre?.trim() || `Viaje #${viajeId}` })}
                    >
                      📋 Mensaje
                    </button>
                    <button
                      type="button" className="btn" style={{ fontSize: 10, padding: '1px 6px' }}
                      onClick={() => setAdjuntos({ viajeId, titulo: viaje.nombre?.trim() || `Viaje #${viajeId}`, cuadrillaId: viaje.cuadrilla_id })}
                      title="Adjuntos del viaje (manifiesto, etc.)"
                    >
                      📎 Adjuntos
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}

        {panelAbierto && canEdit && modoSemana === 'sin_fecha_salida' ? (
          <div style={{ width: 340, flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <button type="button" className="btn" onClick={() => setShowZonas(true)}>Zonas</button>
              <button type="button" className="btn" onClick={() => setShowIaConfig(true)}>🤖 Config IA</button>
              <button type="button" className="btn" onClick={() => setShowPromesaConfig(true)}>📅 Config promesa</button>
              <button type="button" className="btn" onClick={() => setShowCuadrillas(true)}>👷 Cuadrillas</button>
              <button type="button" className="btn" onClick={() => setShowChecklist(true)}>✅ CheckList</button>
              <button type="button" className="btn" onClick={() => setShowVehiculos(true)}>🚚 Vehículos</button>
              <button type="button" className="btn" onClick={() => setShowParadasExtra(true)}>🏨 Paradas estándar</button>
              <button type="button" className="btn" onClick={() => setShowTemplates(true)}>📄 Templates WhatsApp</button>
            </div>
            <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12, fontSize: 12, opacity: 0.85 }}>
              Son NV sin "Fecha Salida" cargada todavía en /a (mismo filtro "Sin fecha" de esa
              columna). Hacé click en los pines para seleccionar los que quieras agrupar por
              cercanía y cargarles la misma fecha de una - equivale a editar esa columna en /a,
              uno por uno.
            </div>

            {resultadoFechaSalida ? (
              <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12, background: 'var(--surface-muted, #f9fafb)' }}>
                <div style={{ fontWeight: 900, marginBottom: 6 }}>✅ Fecha de salida cargada</div>
                <div style={{ fontSize: 12, marginBottom: 8 }}>
                  {resultadoFechaSalida.actualizados} NV actualizado{resultadoFechaSalida.actualizados === 1 ? '' : 's'}.
                </div>
                <button className="btn btn--brand" onClick={() => setResultadoFechaSalida(null)}>Listo</button>
              </div>
            ) : (
              <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12 }}>
                {selected.size > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 10 }}>
                    {Array.from(selected).map((nv) => (
                      <span key={nv} style={{ fontSize: 11, padding: '2px 7px', borderRadius: 999, background: 'var(--surface-muted, #f3f4f6)', border: '1px solid var(--border)' }}>NV {nv}</span>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 10 }}>Ningún NV seleccionado todavía.</div>
                )}
                <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, marginBottom: 10 }}>
                  Fecha de salida
                  <input className="pp-input" type="date" value={fechaSalidaAsignar} onChange={(e) => setFechaSalidaAsignar(e.target.value)} />
                </label>
                <button
                  className="btn btn--brand" style={{ width: '100%' }}
                  disabled={selected.size === 0 || !fechaSalidaAsignar || asignandoFechaSalida}
                  onClick={asignarFechaSalida}
                >
                  {asignandoFechaSalida ? 'Cargando…' : `Cargar fecha de salida (${selected.size})`}
                </button>
              </div>
            )}
          </div>
        ) : panelAbierto && canEdit ? (
          <div style={{ width: 340, flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <button type="button" className="btn" onClick={() => setShowZonas(true)}>Zonas</button>
              <button type="button" className="btn" onClick={() => setShowIaConfig(true)}>🤖 Config IA</button>
              <button type="button" className="btn" onClick={() => setShowPromesaConfig(true)}>📅 Config promesa</button>
              <button type="button" className="btn" onClick={() => setShowCuadrillas(true)}>👷 Cuadrillas</button>
              <button type="button" className="btn" onClick={() => setShowChecklist(true)}>✅ CheckList</button>
              <button type="button" className="btn" onClick={() => setShowVehiculos(true)}>🚚 Vehículos</button>
              <button type="button" className="btn" onClick={() => setShowParadasExtra(true)}>🏨 Paradas estándar</button>
              <button type="button" className="btn" onClick={() => setShowTemplates(true)}>📄 Templates WhatsApp</button>
            </div>
            {resultado ? (
              <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12, background: 'var(--surface-muted, #f9fafb)' }}>
                <div style={{ fontWeight: 900, marginBottom: 6 }}>✅ Viaje creado</div>
                <div style={{ fontSize: 12, marginBottom: 6 }}>
                  Semana {weekNumberFromLabel(resultado.semana)} · {resultado.asignados} portón{resultado.asignados === 1 ? '' : 'es'} asignado{resultado.asignados === 1 ? '' : 's'}.
                </div>
                {resultado.excluidos.length > 0 ? (
                  <div style={{ fontSize: 11, color: '#92400e', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: 8, marginBottom: 6 }}>
                    {resultado.excluidos.length} quedaron afuera por estar en otra semana: NV {resultado.excluidos.map((p) => p.nv).join(', ')}.
                  </div>
                ) : null}
                {resultado.fallidos.length > 0 ? (
                  <div style={{ fontSize: 11, color: '#991b1b', marginBottom: 6 }}>{resultado.fallidos.length} no se pudieron asignar.</div>
                ) : null}
                <button className="btn btn--brand" onClick={() => setResultado(null)}>Listo</button>
              </div>
            ) : confirmando && confirmForm ? (
              <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12 }}>
                <div style={{ fontWeight: 900, marginBottom: 8 }}>Crear viaje — Semana {weekNumberFromLabel(confirmForm.semana)}</div>
                <div style={{ fontSize: 11, opacity: 0.75, marginBottom: 8 }}>
                  {confirmForm.incluidos.length} portón{confirmForm.incluidos.length === 1 ? '' : 'es'} de esta semana.
                  {confirmForm.excluidos.length > 0 ? ` ${confirmForm.excluidos.length} quedan afuera (otra semana): NV ${confirmForm.excluidos.map((p) => p.nv).join(', ')}.` : ''}
                </div>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, marginBottom: 8 }}>
                  Fecha
                  <input className="pp-input" type="date" value={confirmForm.fecha} onChange={(e) => setConfirmForm((f) => ({ ...f, fecha: e.target.value }))} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, marginBottom: 8 }}>
                  Zona
                  <select className="pp-select" value={confirmForm.zona_id} onChange={(e) => setConfirmForm((f) => ({ ...f, zona_id: e.target.value }))}>
                    <option value="">—</option>
                    {(config?.zonas || []).filter((z) => z.activo).map((z) => <option key={z.id} value={z.id}>{z.nombre}</option>)}
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, marginBottom: 8 }}>
                  Cuadrilla
                  <select className="pp-select" value={confirmForm.cuadrilla_id} onChange={(e) => setConfirmForm((f) => ({ ...f, cuadrilla_id: e.target.value }))}>
                    <option value="">—</option>
                    {(config?.cuadrillas || []).filter((c) => c.activo).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, marginBottom: 8 }}>
                  Vehículo
                  <select className="pp-select" value={confirmForm.vehiculo_id} onChange={(e) => setConfirmForm((f) => ({ ...f, vehiculo_id: e.target.value }))}>
                    <option value="">—</option>
                    {(config?.vehiculos || []).filter((v) => v.activo).map((v) => <option key={v.id} value={v.id}>{v.nombre}</option>)}
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, marginBottom: 10 }}>
                  Nombre
                  <input className="pp-input" value={confirmForm.nombre} onChange={(e) => setConfirmForm((f) => ({ ...f, nombre: e.target.value }))} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, marginBottom: 10 }}>
                  Fondo en efectivo para la cuadrilla (opcional)
                  <input
                    className="pp-input" type="number" min="0" step="0.01" placeholder="$"
                    value={confirmForm.fondo_efectivo}
                    onChange={(e) => setConfirmForm((f) => ({ ...f, fondo_efectivo: e.target.value }))}
                  />
                </label>

                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn" disabled={creando} onClick={() => setConfirmando(false)}>Volver</button>
                  <button className="btn btn--brand" disabled={creando} onClick={crear}>{creando ? 'Creando…' : 'Confirmar y crear'}</button>
                </div>
              </div>
            ) : rec ? (
              <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontWeight: 900 }}>Recomendación de la IA</div>
                <div style={{ fontSize: 12 }}>{rec.resumen}</div>
                <div style={{ fontSize: 12 }}><b>Semana sugerida:</b> {rec.semana_sugerida}</div>
                <div style={{ fontSize: 12 }}><b>Tiempo estimado:</b> {rec.tiempo_total_estimado_horas}h</div>
                {rec.vehiculo_sugerido ? <div style={{ fontSize: 12 }}><b>Vehículo sugerido:</b> {rec.vehiculo_sugerido}</div> : null}

                <div style={{ fontSize: 12, fontWeight: 800, marginTop: 4 }}>Orden de paradas 🔴 (dibujado en el mapa)</div>
                <ol style={{ margin: 0, paddingLeft: 18, fontSize: 11 }}>
                  {rec.orden_paradas.sort((a, b) => a.orden - b.orden).map((p) => (
                    <li key={p.nv} style={{ marginBottom: 4 }}>NV {p.nv} — {p.motivo}</li>
                  ))}
                </ol>

                {rec.alertas?.length > 0 ? (
                  <div style={{ fontSize: 11, color: '#92400e', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: 8 }}>
                    {rec.alertas.map((a, i) => <div key={i}>⚠️ {a}</div>)}
                  </div>
                ) : null}

                <details style={{ fontSize: 11, opacity: 0.8 }}>
                  <summary style={{ cursor: 'pointer' }}>Razonamiento completo</summary>
                  {rec.razonamiento}
                </details>

                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  <button className="btn" onClick={() => { setRecomendacion(null); limpiarRutaSugerida(); }}>Descartar</button>
                  <button className="btn btn--brand" onClick={() => abrirConfirmacion(nvsEnOrdenSugerido(Array.from(selected), rec.orden_paradas), { vehiculoSugerido: rec.vehiculo_sugerido })}>
                    Crear viaje con esta recomendación
                  </button>
                </div>
              </div>
            ) : vista === 'planes' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => { setVista('seleccion'); limpiarRutaSugerida(); }}>← Volver a selección manual</button>

                {planes?.sin_zona?.cantidad > 0 ? (
                  <div style={{ fontSize: 11, color: '#92400e', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: 8 }}>
                    {planes.sin_zona.cantidad} portón{planes.sin_zona.cantidad === 1 ? '' : 'es'} con ubicación pero sin zona clasificada: NV {planes.sin_zona.nvs.join(', ')}.
                  </div>
                ) : null}
                {planes?.sin_ubicacion > 0 ? (
                  <div style={{ fontSize: 11, opacity: 0.7 }}>{planes.sin_ubicacion} portones sin ubicación resuelta, no evaluados.</div>
                ) : null}

                {(planes?.planes || []).map((plan) => (
                  <div key={plan.zona} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 10 }}>
                    <div style={{ fontWeight: 900, marginBottom: 6 }}>📍 {plan.zona} ({plan.total_en_zona} pendientes{plan.truncado ? ', mostrando solo una parte' : ''})</div>
                    {plan.error ? (
                      <div style={{ fontSize: 11, color: '#991b1b' }}>Error: {plan.error}</div>
                    ) : (plan.viajes_propuestos || []).length === 0 ? (
                      <div style={{ fontSize: 11, opacity: 0.7 }}>La IA no propuso viajes para esta zona.</div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {plan.viajes_propuestos.map((viaje, i) => {
                          const key = `${plan.zona}::${i}`;
                          const rutaActiva = rutaActivaKey === key;
                          return (
                            <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 8, background: 'var(--surface-muted, #f9fafb)' }}>
                              <div style={{ fontWeight: 800, fontSize: 12 }}>{viaje.nombre}</div>
                              <div style={{ fontSize: 11, opacity: 0.8 }}>
                                {viaje.nvs.length} portón{viaje.nvs.length === 1 ? '' : 'es'} · Semana {viaje.semana_sugerida} · {viaje.tiempo_total_estimado_horas}h
                                {viaje.vehiculo_sugerido ? ` · ${viaje.vehiculo_sugerido}` : ''}
                              </div>
                              {viaje.alertas?.length > 0 ? (
                                <div style={{ fontSize: 10, color: '#92400e', marginTop: 4 }}>{viaje.alertas.map((a, j) => <div key={j}>⚠️ {a}</div>)}</div>
                              ) : null}
                              <details style={{ fontSize: 10, opacity: 0.8, marginTop: 4 }}>
                                <summary style={{ cursor: 'pointer' }}>Ver detalle</summary>
                                <div style={{ marginTop: 4 }}>NV: {viaje.nvs.join(', ')}</div>
                                <div style={{ marginTop: 4 }}>{viaje.razonamiento}</div>
                              </details>
                              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                                <button
                                  className="btn" style={{ fontSize: 11, padding: '3px 9px', ...(rutaActiva ? { background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' } : {}) }}
                                  onClick={() => { if (rutaActiva) { limpiarRutaSugerida(); } else { setRutaOrdenParadas(viaje.orden_paradas); setRutaActivaKey(key); } }}
                                >
                                  {rutaActiva ? '🗺️ Ocultar ruta' : '🗺️ Ver ruta'}
                                </button>
                                <button
                                  className="btn btn--brand" style={{ fontSize: 11, padding: '3px 9px' }}
                                  onClick={() => abrirConfirmacion(nvsEnOrdenSugerido(viaje.nvs, viaje.orden_paradas), { vehiculoSugerido: viaje.vehiculo_sugerido, nombreSugerido: viaje.nombre })}
                                >
                                  Crear este viaje
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12 }}>
                <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 10 }}>
                  {modoSemana === 'promesa'
                    ? 'Hacé click en los pines de colores para seleccionarlos. Los pines celestes todavía no tienen fecha real imputada en /a (solo consulta, para planificar con anticipación).'
                    : 'Hacé click en los pines pendientes para seleccionarlos. Los pines grises ya están en un viaje (solo consulta).'}
                </div>

                {selected.size > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 10 }}>
                    {Array.from(selected).map((nv) => (
                      <span key={nv} style={{ fontSize: 11, padding: '2px 7px', borderRadius: 999, background: 'var(--surface-muted, #f3f4f6)', border: '1px solid var(--border)' }}>NV {nv}</span>
                    ))}
                  </div>
                ) : null}

                <button className="btn btn--brand" style={{ width: '100%', marginBottom: 8 }} disabled={selected.size === 0} onClick={() => abrirConfirmacion(Array.from(selected))}>
                  Crear viaje con esta selección ({selected.size})
                </button>
                <div style={{ fontSize: 10, opacity: 0.6, marginTop: -4, marginBottom: 12 }}>
                  Armalo vos: elegís fecha, zona, cuadrilla y vehículo a mano en el paso siguiente.
                </div>

                <button className="btn" style={{ width: '100%', marginBottom: 4 }} disabled={selected.size === 0 || recomendando} onClick={generarRecomendacion}>
                  {recomendando ? 'Pensando…' : `🤖 Que la IA recomiende (${selected.size})`}
                </button>
                <div style={{ fontSize: 10, opacity: 0.6, marginBottom: 12 }}>
                  Te sugiere orden de paradas, semana y vehículo antes de crear — revisás y confirmás igual.
                </div>

                <button className="btn" style={{ width: '100%' }} disabled={planificando} onClick={planificarTodo}>
                  {planificando ? 'Planificando (puede tardar unos minutos)…' : '🗺️ Planificar todas las zonas automáticamente'}
                </button>
                <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4 }}>
                  Mira TODOS los portones pendientes (cualquier semana), no solo lo que estás filtrando acá.
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>

      <LogisticaZonasModal open={showZonas} config={config} onClose={() => setShowZonas(false)} onChanged={reloadConfig} />
      <LogisticaIaConfigModal open={showIaConfig} onClose={() => setShowIaConfig(false)} />
      <LogisticaPromesaConfigModal open={showPromesaConfig} onClose={() => setShowPromesaConfig(false)} onChanged={load} />
      <LogisticaVehiculosModal open={showVehiculos} config={config} onClose={() => setShowVehiculos(false)} onChanged={reloadConfig} />
      <LogisticaCuadrillasModal open={showCuadrillas} config={config} onClose={() => setShowCuadrillas(false)} onChanged={reloadConfig} />
      <LogisticaChecklistModal open={showChecklist} config={config} onClose={() => setShowChecklist(false)} onChanged={reloadConfig} />
      <LogisticaParadasExtraModal open={showParadasExtra} puntosExtra={puntosExtra} onClose={() => setShowParadasExtra(false)} onChanged={load} />
      <LogisticaWhatsappTemplatesModal open={showTemplates} onClose={() => setShowTemplates(false)} />
      <LogisticaMensajeViajeModal open={!!mensajeViaje} viajeId={mensajeViaje?.viajeId} titulo={mensajeViaje?.titulo} onClose={() => setMensajeViaje(null)} />
      <LogisticaAdjuntosModal open={!!adjuntos} viajeId={adjuntos?.viajeId} nv={adjuntos?.nv} titulo={adjuntos?.titulo} canEdit={canEdit} cuadrillaId={adjuntos?.cuadrillaId} onClose={() => setAdjuntos(null)} />
      <LogisticaViajeSemanaModal
        semana={semanaFiltro}
        open={semanaModalAbierta}
        canEdit={canEdit}
        onClose={() => setSemanaModalAbierta(false)}
        onChanged={load}
      />
    </div>
  );
}
