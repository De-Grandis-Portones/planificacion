// src/App.jsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect, useMemo, useState, useCallback } from 'react';
import usePortones from './hooks/usePortones';
import useIpanel from './hooks/useIpanels';
import usePrefabricados from './hooks/usePrefabricados';
import useServicioTecnico from './hooks/useServicioTecnico';
import {
  startStage, stopStage, startIpanelStage, stopIpanelStage, qcSummary,
  fetchPrefabricadoTipos, createPrefabricadoOrden, startPrefabricadoStage, stopPrefabricadoStage,
  startStStage, stopStStage, createPruebaLaserOrden,
} from './api';
import StageColumn from './components/StageColumn';
import InsumosCartButton from './components/InsumosCartButton';
import PruebaLaserModal from './components/modals/PruebaLaserModal';
import SessionExpiredOverlay from './components/SessionExpiredOverlay';

import StatusGatePage from '../src/components/StatusGatePage';
import CreateGatePage from '../pages/CreateGatePage';
import PlantaReadOnlyPage from '../pages/PlantaOnlyDearPage';
import IpanelReadOnlyPage from '../pages/IpanelReadOnlyPage';
import PlantaReadOnlySimplePage from '../pages/PlantaReadyOnlySimplePage';
import StatusIpanelsPage from '../pages/StatusIpanelsPage';
import PortonesStatsPage from '../pages/PortonesStatsPage';
import PublicNvStatusPage from '../pages/PublicNvStatusPage';

import AdminLoginPage from '../pages/admin/AdminLoginPage';
import AdminHomePage from '../pages/admin/AdminHomePage';
import WorkflowDesignerPage from '../pages/admin/WorkflowDesignerPage';
import SchedulingRulesPage from '../pages/admin/SchedulingRulesPage';
import SchedulingGanttPage from '../pages/admin/SchedulingGanttPage';
import SchedulingRulesNavPage from '../pages/admin/SchedulingRulesNavPage';
import ProgramadoresChatPage from '../pages/admin/ProgramadoresChatPage';
import AdminQcPage from '../pages/admin/AdminQcPage';
import AdminExcelInfoPage from '../pages/admin/AdminExcelInfoPage';
import PrefabricadosConfigPage from '../pages/admin/PrefabricadosConfigPage';
import ServicioTecnicoPage from '../pages/admin/ServicioTecnicoPage';
import ServicioTecnicoSolicitudesPage from '../pages/admin/ServicioTecnicoSolicitudesPage';
import InsumosComprasPage from '../pages/admin/InsumosComprasPage';
import InsumosConfigPage from '../pages/admin/InsumosConfigPage';
import InsumosEntregasPage from '../pages/admin/InsumosEntregasPage';
import IndiceProgramacionPage from '../pages/admin/IndiceProgramacionPage';
import LogisticaViajesPage from '../pages/admin/LogisticaViajesPage';
import LogisticaFechasPage from '../pages/admin/LogisticaFechasPage';
import LogisticaWhatsappPage from '../pages/admin/LogisticaWhatsappPage';
import ServicioTecnicoViajesPage from '../pages/admin/ServicioTecnicoViajesPage';
import ServicioTecnicoFechasPage from '../pages/admin/ServicioTecnicoFechasPage';
import AdminTicketsPage from '../pages/admin/AdminTicketsPage';
import AdminTicketsBoardPage from '../pages/admin/AdminTicketsBoardPage';
import ReunionesPage from '../pages/admin/ReunionesPage';

import PreproduccionValoresTable from '../src/components/PreproduccionValoresTable';
import IpanelPreproduccionValoresTable from '../src/components/IpanelPreproduccionValoresTable';
import UserAdminDashboard from './components/UserAdminDashboard';

import IndexPage from '../pages/IndexPage';
import RefabricacionPage from '../pages/RefabricacionPage';
import DespachoV2Page from '../pages/DespachoV2Page';
import NonProductionLayout from './components/NonProductionLayout';

const color = 'var(--brand)';

const STATUS = {
  PENDIENTE: 'Pendiente',
  EN_PROCESO: 'En Proceso',
  FINALIZADO: 'Finalizado',
};

function apiBase() {
  const v = import.meta.env.VITE_API_URL || import.meta.env.VITE_API_BASE || '';
  return String(v || '').replace(/\/$/, '');
}
function low(v) {
  return String(v ?? '').toLowerCase();
}

function isFinalizadoByKey(item, key) {
  return low(item?.[key]) === low(STATUS.FINALIZADO);
}

function buildReqIndex(requirements) {
  const idx = new Map();
  for (const r of requirements || []) {
    const stageKey = String(r?.stage_key || '').trim();
    const type = String(r?.type || '').trim();
    const requiredKey = String(r?.required_key || '').trim();
    const gid = r?.group_id == null ? null : Number(r.group_id);

    if (!stageKey || !type || !requiredKey) continue;

    if (!idx.has(stageKey)) idx.set(stageKey, { all: new Set(), anyGroups: new Map() });
    const bucket = idx.get(stageKey);

    if (type === 'ALL') {
      bucket.all.add(requiredKey);
    } else if (type === 'ANY_GROUP') {
      const g = Number.isFinite(gid) ? gid : 0;
      if (!bucket.anyGroups.has(g)) bucket.anyGroups.set(g, new Set());
      bucket.anyGroups.get(g).add(requiredKey);
    }
  }
  return idx;
}

function canAppearInStage({ item, stageKey, reqIndex }) {
  const st = item?.[stageKey];
  if (st == null) return false;

  const stLow = low(st);
  if (stLow === low(STATUS.EN_PROCESO) || stLow === low(STATUS.FINALIZADO)) return true;
  if (stLow !== low(STATUS.PENDIENTE)) return true;

  if (!reqIndex) return true;
  const req = reqIndex.get(stageKey);
  if (!req) return true;

  for (const k of req.all) {
    if (!isFinalizadoByKey(item, k)) return false;
  }

  for (const [, set] of req.anyGroups.entries()) {
    const keys = Array.from(set);
    const ok = keys.some((k) => isFinalizadoByKey(item, k));
    if (!ok) return false;
  }

  return true;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function FullBleed({ children }) {
  return <div className="route-fullbleed">{children}</div>;
}

function Board({ stages, seccion }) {
  const { data: portones, loading, err, replaceItem, refresh, refreshing } = usePortones({ pollMs: 300000 });
  const { data: ipanels, loading: loadingIpanel, refresh: refreshIpanel } = useIpanel({ pollMs: 300000, onlyProduction: true });
  const { data: prefabricados, loading: loadingPrefab, refresh: refreshPrefab, replaceItem: replacePrefab } = usePrefabricados({ pollMs: 300000 });
  const { data: stOrdenes, loading: loadingSt, refresh: refreshSt, replaceItem: replaceSt } = useServicioTecnico({ pollMs: 300000 });
  // Base data (las 4 fuentes) recien se considera lista cuando terminaron
  // TODAS las cargas iniciales; se usa para no correr qcSummary de arriba
  // hasta ese momento y para no renderizar la grilla mientras alguna sigue
  // en vuelo (ver comentario grande antes del "if (loading ...)" mas abajo).
  const baseDataLoaded = !loading && !loadingIpanel && !loadingPrefab && !loadingSt;
  const [prefabTipos, setPrefabTipos] = useState([]);

  const [busyId, setBusyId] = useState(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState(null);

  const [wfPortones, setWfPortones] = useState(null);
  const [wfIpanel, setWfIpanel] = useState(null);

  const [qcSumPortones, setQcSumPortones] = useState({});
  const [qcSumIpanel, setQcSumIpanel] = useState({});
  const [qcSumPrefab, setQcSumPrefab] = useState({});
  const [qcSumSt, setQcSumSt] = useState({});
  const [qcSumOe, setQcSumOe] = useState({});
  const [qcSumRefab, setQcSumRefab] = useState({});
  const [qcSumPrueba, setQcSumPrueba] = useState({});
  const [pruebaLaserOpen, setPruebaLaserOpen] = useState(false);
  const [qcSummaryReady, setQcSummaryReady] = useState(false);

  const [wfReady, setWfReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadWorkflow(line) {
      const base = apiBase();
      const r = await fetch(`${base}/workflow/config?line=${encodeURIComponent(line)}`, { cache: 'no-store' });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`Error ${r.status} leyendo /workflow/config (${line}). ${t}`);
      }
      return r.json();
    }

    (async () => {
      try {
        const [p, i] = await Promise.all([loadWorkflow('portones'), loadWorkflow('ipanel')]);
        if (cancelled) return;
        setWfPortones(p?.ok ? p : null);
        setWfIpanel(i?.ok ? i : null);
      } catch (e) {
        console.warn('No se pudo cargar workflow public config:', e?.message || e);
        if (!cancelled) {
          setWfPortones(null);
          setWfIpanel(null);
        }
      } finally {
        if (!cancelled) setWfReady(true);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const reqIndexPortones = useMemo(
    () => (wfPortones?.requirements ? buildReqIndex(wfPortones.requirements) : null),
    [wfPortones]
  );
  const reqIndexIpanel = useMemo(() => (wfIpanel?.requirements ? buildReqIndex(wfIpanel.requirements) : null), [wfIpanel]);

  const filteredPortones = useMemo(() => {
    if (!Array.isArray(portones)) return [];
    if (filter == null || filter === '') return portones;
    const n = Number(filter);
    if (Number.isNaN(n)) return portones;
    return portones.filter((p) => p.nv === n || p.nlista === n || p.partida === n);
  }, [portones, filter]);

  const filteredIpanels = useMemo(() => {
    if (!Array.isArray(ipanels)) return [];
    if (filter == null || filter === '') return ipanels;
    const n = Number(filter);
    if (Number.isNaN(n)) return ipanels;
    return ipanels.filter((ip) => ip.nv === n || ip.partida === n);
  }, [ipanels, filter]);

  const filteredPrefab = useMemo(() => {
    if (!Array.isArray(prefabricados)) return [];
    if (filter == null || filter === '') return prefabricados;
    const n = Number(filter);
    if (Number.isNaN(n)) return prefabricados;
    return prefabricados.filter((p) => p.numero === n);
  }, [prefabricados, filter]);

  const filteredSt = useMemo(() => {
    if (!Array.isArray(stOrdenes)) return [];
    if (filter == null || filter === '') return stOrdenes;
    const n = Number(filter);
    if (Number.isNaN(n)) return stOrdenes;
    return stOrdenes.filter((s) => s.nv === n || s.numero === n);
  }, [stOrdenes, filter]);

  // Set completo (sin filtro de búsqueda) para "Hist. sección"/"Hist. portón":
  // deben poder encontrar un pedido de Prefabricados o una orden de Servicio
  // Técnico aunque el buscador de arriba esté filtrando por otro NV/partida.
  const allMergedItems = useMemo(() => ([
    ...(Array.isArray(portones) ? portones : []),
    ...(Array.isArray(prefabricados) ? prefabricados : []).map((item) => ({ ...item, __kind: 'prefabricado' })),
    ...(Array.isArray(stOrdenes) ? stOrdenes : []).map((item) => ({ ...item, __kind: 'servicio_tecnico' })),
  ]), [portones, prefabricados, stOrdenes]);

  const handleStart = async (id, stage) => {
    try {
      setBusyId(id);
      const { data: updated } = await startStage(id, stage);
      replaceItem(updated);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleStop = async (id, stage) => {
    try {
      setBusyId(id);
      const { data: updated } = await stopStage(id, stage);
      replaceItem(updated);
      return { ok: true, item: updated || null };
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
      return { ok: false };
    } finally {
      setBusyId(null);
    }
  };

  const handleStartIpanel = async (id, stage) => {
    try {
      setBusyId(id);
      await startIpanelStage(id, stage);
      await refreshIpanel();
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleStopIpanel = async (id, stage) => {
    try {
      setBusyId(id);
      const { data: updated } = await stopIpanelStage(id, stage);
      await refreshIpanel();
      return { ok: true, item: updated || null };
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
      return { ok: false };
    } finally {
      setBusyId(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await fetchPrefabricadoTipos();
        if (!cancelled) setPrefabTipos(Array.isArray(data) ? data : []);
      } catch (e) {
        console.warn('No se pudieron cargar tipos de prefabricado:', e?.message || e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleStartPrefab = async (id, stage) => {
    try {
      setBusyId(id);
      const { data: updated } = await startPrefabricadoStage(id, stage);
      replacePrefab(updated);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleStopPrefab = async (id, stage) => {
    try {
      setBusyId(id);
      const { data: updated } = await stopPrefabricadoStage(id, stage);
      replacePrefab(updated);
      return { ok: true, item: updated ? { ...updated, __kind: 'prefabricado' } : null };
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
      return { ok: false };
    } finally {
      setBusyId(null);
    }
  };

  const handleCreatePrefabOrden = async (tipoId, seccion, cantidad, referencia) => {
    await createPrefabricadoOrden({ tipo_id: tipoId, seccion, cantidad, referencia });
    await refreshPrefab();
  };

  const nextPruebaNumero = useMemo(() => {
    const existentes = (Array.isArray(stOrdenes) ? stOrdenes : []).filter((o) => o?.tipo === 'PRUEBA');
    const maxNumero = existentes.reduce((max, o) => Math.max(max, Number(o?.numero) || 0), 0);
    return maxNumero + 1;
  }, [stOrdenes]);

  const handleCreatePruebaLaser = async (detalle, pasoPorPlegadora) => {
    await createPruebaLaserOrden(detalle, pasoPorPlegadora);
    await refreshSt();
  };

  const handleStartSt = async (id, stage) => {
    try {
      setBusyId(id);
      const { data: updated } = await startStStage(id, stage);
      replaceSt(updated);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleStopSt = async (id, stage) => {
    try {
      setBusyId(id);
      const { data: updated } = await stopStStage(id, stage);
      replaceSt(updated);
      return { ok: true, item: updated ? { ...updated, __kind: 'servicio_tecnico' } : null };
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
      return { ok: false };
    } finally {
      setBusyId(null);
    }
  };

  const refreshQcSummary = useCallback(async () => {
    try {
      const pIds = (Array.isArray(portones) ? portones : [])
        .map((p) => Number(p?.nv))
        .filter((n) => Number.isInteger(n));

      const iIds = (Array.isArray(ipanels) ? ipanels : [])
        .map((p) => Number(p?.nv))
        .filter((n) => Number.isInteger(n));

      const prefIds = (Array.isArray(prefabricados) ? prefabricados : [])
        .map((p) => Number(p?.numero))
        .filter((n) => Number.isInteger(n));

      const stIds = (Array.isArray(stOrdenes) ? stOrdenes : [])
        .filter((p) => p?.tipo !== 'OE' && p?.tipo !== 'REFAB' && p?.tipo !== 'PRUEBA')
        .map((p) => Number(p?.nv))
        .filter((n) => Number.isInteger(n));

      const oeIds = (Array.isArray(stOrdenes) ? stOrdenes : [])
        .filter((p) => p?.tipo === 'OE')
        .map((p) => Number(p?.numero))
        .filter((n) => Number.isInteger(n));

      const refabIds = (Array.isArray(stOrdenes) ? stOrdenes : [])
        .filter((p) => p?.tipo === 'REFAB')
        .map((p) => Number(p?.nv))
        .filter((n) => Number.isInteger(n));

      const pruebaIds = (Array.isArray(stOrdenes) ? stOrdenes : [])
        .filter((p) => p?.tipo === 'PRUEBA')
        .map((p) => Number(p?.numero))
        .filter((n) => Number.isInteger(n));

      if (!pIds.length) setQcSumPortones({});
      if (!iIds.length) setQcSumIpanel({});
      if (!prefIds.length) setQcSumPrefab({});
      if (!stIds.length) setQcSumSt({});
      if (!oeIds.length) setQcSumOe({});
      if (!refabIds.length) setQcSumRefab({});
      if (!pruebaIds.length) setQcSumPrueba({});

      async function loadLine(line, ids) {
        const out = {};
        const parts = chunk(ids, 1000);
        const responses = await Promise.all(parts.map((part) => qcSummary({ line, item_ids: part })));
        for (const resp of responses) {
          const items = resp?.items || {};
          for (const k of Object.keys(items)) out[k] = items[k];
        }
        return out;
      }

      const [pMap, iMap, prefMap, stMap, oeMap, refabMap, pruebaMap] = await Promise.all([
        pIds.length ? loadLine('portones', pIds) : Promise.resolve({}),
        iIds.length ? loadLine('ipanel', iIds) : Promise.resolve({}),
        prefIds.length ? loadLine('prefabricados', prefIds) : Promise.resolve({}),
        stIds.length ? loadLine('servicio_tecnico', stIds) : Promise.resolve({}),
        oeIds.length ? loadLine('orden_externa', oeIds) : Promise.resolve({}),
        refabIds.length ? loadLine('refabricado', refabIds) : Promise.resolve({}),
        pruebaIds.length ? loadLine('prueba', pruebaIds) : Promise.resolve({}),
      ]);

      setQcSumPortones(pMap);
      setQcSumIpanel(iMap);
      setQcSumPrefab(prefMap);
      setQcSumSt(stMap);
      setQcSumOe(oeMap);
      setQcSumRefab(refabMap);
      setQcSumPrueba(pruebaMap);
    } catch (e) {
      console.warn('No se pudo cargar qcSummary:', e?.message || e);
    } finally {
      setQcSummaryReady(true);
    }
  }, [portones, ipanels, prefabricados, stOrdenes]);

  useEffect(() => {
    // Antes de que terminen las 4 cargas base, portones/ipanels/etc. todavía
    // son el array inicial ([]), así que un run acá saldría con ids vacíos y
    // marcaría qcSummaryReady=true de arriba, sin haber traído nunca el
    // resumen real — reabriendo la misma carrera que wfReady soluciona para
    // los requisitos de workflow.
    if (!baseDataLoaded) return;
    refreshQcSummary();
  }, [refreshQcSummary, baseDataLoaded]);

  // Esperamos también wfReady/qcSummaryReady (no solo baseDataLoaded):
  // canAppearInStage() trata reqIndex==null como "sin restricción" (fail-open
  // a propósito, para no bloquear al operador si /workflow/config falla), y
  // shouldHideFinalizado() no oculta nada mientras qcSummaryMap está vacío.
  // Si se renderiza antes de que esas dos cargas terminen, se ve primero de
  // más (pendientes que no cumplen requisito, finalizados ya aprobados) y
  // después se corrige solo — el "aparecen muchos y después quedan menos".
  if (!baseDataLoaded || !wfReady || !qcSummaryReady) return <div className="container">Cargando…</div>;
  if (err) return <div className="container" style={{ color: 'crimson' }}>Error: {err}</div>;

  return (
    <div className="container">
      <div className="header-row">
        <h2 className="h1" style={{ borderColor: color }}>DE GRANDIS PORTONES</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {seccion ? <InsumosCartButton seccion={seccion} /> : null}
          {seccion === 'diseno' ? (
            <button className="btn" onClick={() => setPruebaLaserOpen(true)}>
              Generar Prueba Laser Plano
            </button>
          ) : null}
          <button
            className="btn btn--brand"
            onClick={() => { refresh(); refreshIpanel(); refreshQcSummary(); refreshPrefab(); refreshSt(); }}
            disabled={refreshing}
          >
            {refreshing ? 'Actualizando…' : 'Refrescar'}
          </button>
        </div>
      </div>

      <PruebaLaserModal
        open={pruebaLaserOpen}
        onClose={() => setPruebaLaserOpen(false)}
        nextNumero={nextPruebaNumero}
        onCreate={handleCreatePruebaLaser}
      />

      <form
        onSubmit={(e) => { e.preventDefault(); setFilter(q.trim()); }}
        style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '10px 0', flexWrap: 'wrap' }}
      >
        <input
          type="text"
          placeholder="Buscar por NV / N° Portón (lista) / Partida"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="btn"
          style={{ minWidth: 260 }}
          inputMode="numeric"
        />
        <button className="btn btn--brand" type="submit">Buscar</button>
        <button className="btn" type="button" onClick={() => { setQ(''); setFilter(null); }}>
          Limpiar
        </button>
      </form>

      <div className="stage-grid">
        {stages.map((s) => {
          const m = s.mode || 'porton';

          if (m === 'ipanel') {
            const itemsForStage = filteredIpanels.filter((item) => canAppearInStage({ item, stageKey: s.key, reqIndex: reqIndexIpanel }));
            return (
              <StageColumn
                key={`ipanel-${s.key}-${s.label}`}
                title={s.label}
                stageKey={s.key}
                mode="ipanel"
                items={itemsForStage}
                onStart={handleStartIpanel}
                onStop={handleStopIpanel}
                disabledId={busyId}
                allItems={ipanels}
                qcSummaryMap={qcSumIpanel}
                onQcSaved={refreshQcSummary}
              />
            );
          }

          // Portones: se mezclan acá mismo los pedidos de Prefabricados y las
          // órdenes de Servicio Técnico que comparten esta misma clave de
          // sección física (misma columna, sin sumar columnas nuevas).
          const portonItems = filteredPortones.filter((item) => canAppearInStage({ item, stageKey: s.key, reqIndex: reqIndexPortones }));
          const prefabItems = filteredPrefab
            .filter((item) => canAppearInStage({ item, stageKey: s.key, reqIndex: null }))
            .map((item) => ({ ...item, __kind: 'prefabricado' }));
          const stItems = filteredSt
            .filter((item) => canAppearInStage({ item, stageKey: s.key, reqIndex: null }))
            .map((item) => ({ ...item, __kind: 'servicio_tecnico' }));

          return (
            <StageColumn
              key={`porton-${s.key}-${s.label}`}
              title={s.label}
              stageKey={s.key}
              mode="porton"
              items={[...portonItems, ...prefabItems, ...stItems]}
              onStart={handleStart}
              onStop={handleStop}
              onStartPrefab={handleStartPrefab}
              onStopPrefab={handleStopPrefab}
              onStartSt={handleStartSt}
              onStopSt={handleStopSt}
              disabledId={busyId}
              allItems={allMergedItems}
              qcSummaryMap={qcSumPortones}
              qcSummaryMapPrefab={qcSumPrefab}
              qcSummaryMapSt={qcSumSt}
              qcSummaryMapOe={qcSumOe}
              qcSummaryMapRefab={qcSumRefab}
              qcSummaryMapPrueba={qcSumPrueba}
              onQcSaved={refreshQcSummary}
              prefabTipos={prefabTipos}
              onCreatePrefabOrden={handleCreatePrefabOrden}
            />
          );
        })}
      </div>
    </div>
  );
}

const ONE = (key, label) => [{ key, label, mode: 'porton' }];

// Prefabricados y Servicio Técnico ya NO tienen columna propia: sus ítems se
// mezclan dentro de la misma columna de portones que comparte la clave de
// sección (ver merge en Board), para no sumar columnas nuevas en tablets con
// poco espacio. Solo se distinguen por el borde azul de la card.
const ROUTES = [
  {
    path: '/board',
    label: 'Producción · Tablero completo',
    stages: [
      { key: 'diseno', label: 'Diseño Tubos (Portones)', mode: 'porton' },
      { key: 'diseno_piernas', label: 'Diseño Piernas', mode: 'porton' },
      { key: 'diseno_revestimiento', label: 'Diseño Revestimiento', mode: 'porton' },
      { key: 'diseno', label: 'Diseño (iPanel)', mode: 'ipanel' },
      { key: 'laser_dintel', label: 'Laser tubos Dintel', mode: 'porton' },
      { key: 'laser_hojas', label: 'Laser tubos Hojas', mode: 'porton' },
      { key: 'laser_brazos_espada', label: 'Laser tubos Brazos y Espada', mode: 'porton' },
      { key: 'guillotina', label: 'Corte piernas', mode: 'porton' },
      { key: 'corte_revest', label: 'Corte revestimiento', mode: 'porton' },
      { key: 'guillotina', label: 'Corte Ipanel', mode: 'ipanel' },
      { key: 'plegadora', label: 'Plegado Piernas', mode: 'porton' },
      { key: 'plegado_revest', label: 'Plegado Revestimiento', mode: 'porton' },
      { key: 'plegado', label: 'Plegado Ipanel', mode: 'ipanel' },
      { key: 'armado_piernas', label: 'Prefabricados (Armado de piernas)', mode: 'porton' },
      { key: 'armado_marco_piernas', label: 'Armado de marcos piernas', mode: 'porton' },
      { key: 'armado_hojas', label: 'Armado de hoja', mode: 'porton' },
      { key: 'armado_primario', label: 'Armado Primario', mode: 'porton' },
      { key: 'revestimiento', label: 'Revestimiento', mode: 'porton' },
      { key: 'pintura', label: 'Pintura Sistemas (Portones)', mode: 'porton' },
      { key: 'pintura_revestimiento', label: 'Pintura Revestimiento (Portones)', mode: 'porton' },
      { key: 'pintura', label: 'Pintura (Ipanels)', mode: 'ipanel' },
      { key: 'inyeccion', label: 'Inyeccion (Portones)', mode: 'porton' },
      { key: 'inyeccion', label: 'Inyeccion Ipanel', mode: 'ipanel' },
      { key: 'armado_final', label: 'Armado Final', mode: 'porton' },
      { key: 'despacho', label: 'Despacho (Portones)', mode: 'porton' },
      { key: 'despacho', label: 'Despacho (iPanel)', mode: 'ipanel' },
    ],
  },
  {
    path: '/diseno',
    label: 'Producción · Diseño',
    stages: [
      { key: 'diseno', label: 'Diseño Tubos (Portones)', mode: 'porton' },
      { key: 'diseno_piernas', label: 'Diseño Piernas', mode: 'porton' },
      { key: 'diseno_revestimiento', label: 'Diseño Revestimiento', mode: 'porton' },
      { key: 'diseno', label: 'Diseño (iPanel)', mode: 'ipanel' },
    ],
  },
  {
    path: '/laser',
    label: 'Producción · Laser',
    stages: [
      { key: 'laser_dintel', label: 'Laser tubos Dintel', mode: 'porton' },
      { key: 'laser_hojas', label: 'Laser tubos Hojas', mode: 'porton' },
      { key: 'laser_brazos_espada', label: 'Laser tubos Brazos y Espada', mode: 'porton' },
    ],
  },
  {
    path: '/corte',
    label: 'Producción · Corte',
    stages: [
      { key: 'guillotina', label: 'Corte piernas', mode: 'porton' },
      { key: 'corte_revest', label: 'Corte revestimiento', mode: 'porton' },
      { key: 'guillotina', label: 'Corte Ipanel', mode: 'ipanel' },
    ],
  },
  {
    path: '/plegado',
    label: 'Producción · Plegado',
    stages: [
      { key: 'plegadora', label: 'Plegado Piernas', mode: 'porton' },
      { key: 'plegado_revest', label: 'Plegado Revestimiento', mode: 'porton' },
      { key: 'plegado', label: 'Plegado Ipanel', mode: 'ipanel' },
    ],
  },
  {
    path: '/prefabricados',
    label: 'Producción · Prefabricados / Armado',
    stages: [
      { key: 'armado_piernas', label: 'Prefabricados (Armado de piernas)', mode: 'porton' },
      { key: 'armado_marco_piernas', label: 'Armado de marcos piernas', mode: 'porton' },
      { key: 'armado_hojas', label: 'Armado de hoja', mode: 'porton' },
    ],
  },
  // Las 3 secciones de arriba, separadas cada una en su propia ruta (a pedido:
  // no romper /prefabricados, que sigue existiendo tal cual). "seccion" se fija
  // a mano en 'prefabricados' (en vez de derivarla del path, como el resto de
  // las rutas) para que las 3 compartan el mismo botón/carrito de pedidos de
  // insumos - son secciones físicas distintas pero un solo pedido de insumos.
  {
    path: '/armado-piernas',
    label: 'Producción · Armado de Piernas',
    stages: ONE('armado_piernas', 'Armado de Piernas'),
    seccion: 'prefabricados',
  },
  {
    path: '/armado-marco-piernas',
    label: 'Producción · Armado de Marco Piernas',
    stages: ONE('armado_marco_piernas', 'Armado de Marco Piernas'),
    seccion: 'prefabricados',
  },
  {
    path: '/armado-hojas',
    label: 'Producción · Armado de Hojas',
    stages: ONE('armado_hojas', 'Armado de Hojas'),
    seccion: 'prefabricados',
  },
  { path: '/armado-primario', label: 'Producción · Armado Primario', stages: ONE('armado_primario', 'Armado Primario') },
  {
    path: '/pintura',
    label: 'Producción · Pintura',
    stages: [
      { key: 'pintura', label: 'Pintura Sistemas (Portones)', mode: 'porton' },
      { key: 'pintura_revestimiento', label: 'Pintura Revestimiento (Portones)', mode: 'porton' },
      { key: 'pintura', label: 'Pintura (Ipanels)', mode: 'ipanel' },
    ],
  },
  {
    path: '/inyeccion',
    label: 'Producción · Inyección',
    stages: [
      { key: 'inyeccion', label: 'Inyeccion (Portones)', mode: 'porton' },
      { key: 'inyeccion', label: 'Inyeccion Ipanel', mode: 'ipanel' },
    ],
  },
  { path: '/revestimiento', label: 'Producción · Revestimiento', stages: ONE('revestimiento', 'Revestimiento') },
  { path: '/armado-final', label: 'Producción · Armado Final', stages: ONE('armado_final', 'Armado Final') },
  {
    path: '/despacho',
    label: 'Producción · Despacho',
    stages: [
      { key: 'despacho', label: 'Despacho (Portones)', mode: 'porton' },
      { key: 'despacho', label: 'Despacho (iPanel)', mode: 'ipanel' },
    ],
  },
];

export default function App() {
  return (
    <BrowserRouter>
      <SessionExpiredOverlay />
      <Routes>
        <Route path="/" element={<Navigate to="/admin/login" replace />} />
        <Route path="/admin/login" element={<AdminLoginPage />} />

        <Route element={<NonProductionLayout />}>
          <Route path="/index" element={<IndexPage routes={ROUTES} />} />

          <Route path="/admin" element={<AdminHomePage />} />
          <Route path="/admin/qc" element={<AdminQcPage />} />
          <Route path="/admin/tickets" element={<AdminTicketsPage />} />
          <Route path="/admin/tickets-tablero" element={<AdminTicketsBoardPage />} />
          <Route path="/admin/reuniones" element={<ReunionesPage />} />
          <Route path="/admin/workflow" element={<WorkflowDesignerPage />} />
          <Route path="/admin/scheduling" element={<SchedulingRulesPage />} />
          <Route path="/admin/scheduling/gantt" element={<SchedulingGanttPage />} />
          <Route path="/admin/scheduling/reglas" element={<SchedulingRulesNavPage />} />
          <Route path="/admin/programadores/chat" element={<ProgramadoresChatPage />} />
          <Route path="/admin/excel-info" element={<AdminExcelInfoPage />} />
          <Route path="/admin/prefabricados" element={<PrefabricadosConfigPage />} />
          <Route path="/admin/servicio-tecnico" element={<ServicioTecnicoPage />} />
          <Route path="/admin/servicio-tecnico-solicitudes" element={<ServicioTecnicoSolicitudesPage />} />
          <Route path="/admin/insumos" element={<InsumosComprasPage />} />
          <Route path="/admin/insumos/config" element={<InsumosConfigPage />} />
          <Route path="/admin/insumos/entregas" element={<InsumosEntregasPage />} />
          <Route path="/admin/indice-programacion" element={<IndiceProgramacionPage />} />
          <Route path="/admin/logistica-viajes" element={<LogisticaViajesPage />} />
          <Route
            path="/admin/logistica-fechas"
            element={
              <FullBleed>
                <LogisticaFechasPage />
              </FullBleed>
            }
          />
          <Route
            path="/admin/logistica-whatsapp"
            element={
              <FullBleed>
                <LogisticaWhatsappPage />
              </FullBleed>
            }
          />
          <Route path="/admin/servicio-tecnico-viajes" element={<ServicioTecnicoViajesPage />} />
          <Route
            path="/admin/servicio-tecnico-fechas"
            element={
              <FullBleed>
                <ServicioTecnicoFechasPage />
              </FullBleed>
            }
          />
          <Route path="/usuarios" element={<UserAdminDashboard />} />

          <Route
            path="/a"
            element={
              <FullBleed>
                <PreproduccionValoresTable />
              </FullBleed>
            }
          />

          <Route
            path="/i"
            element={
              <FullBleed>
                <IpanelPreproduccionValoresTable />
              </FullBleed>
            }
          />

          <Route path="/b" element={<UserAdminDashboard />} />
        </Route>

        {ROUTES.map((r) => (
          <Route
            key={r.path}
            path={r.path}
            element={<Board stages={r.stages} seccion={r.path === '/board' ? null : (r.seccion ?? r.path.slice(1))} />}
          />
        ))}

        <Route path="/estado-porton" element={<PublicNvStatusPage />} />
        <Route path="/ipanel" element={<IpanelReadOnlyPage />} />
        <Route path="/Diseño" element={<Navigate to="/diseno" replace />} />
        <Route path="/statusGate" element={<StatusGatePage />} />
        <Route path="/createGate" element={<CreateGatePage />} />
        <Route path="/planta" element={<PlantaReadOnlyPage />} />
        <Route path="/plantasimple" element={<PlantaReadOnlySimplePage />} />
        <Route path="/statusIpanels" element={<StatusIpanelsPage />} />
        <Route path="/stats/portones" element={<PortonesStatsPage />} />
        <Route path="/refabricacion" element={<RefabricacionPage />} />
        <Route path="/despacho_v2" element={<DespachoV2Page />} />

        <Route path="*" element={<Navigate to="/admin/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
