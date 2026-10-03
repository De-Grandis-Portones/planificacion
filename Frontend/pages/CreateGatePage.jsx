// src/pages/CreateGatePage.jsx
import { useMemo, useState, useEffect } from 'react';
import usePortones from '../src/hooks/usePortones';
import useIpanels from '../src/hooks/useIpanels';
import {
  startStage, stopStage,
  startIpanelStage, stopIpanelStage,
  setFechaPlan, setFechaProd, setFechaNV,
  setPortonObservaciones,
  setIpanelFechaNV, setIpanelFechaProd, setIpanelFechaPlan,
} from '../src/api';
import { isAuthed, login, logout } from '../src/auth/createGateAuth';

const STAGES = [
  { key: 'diseno',               label: 'Diseño Tubos' },
  { key: 'diseno_piernas',       label: 'Diseño Piernas' },
  { key: 'diseno_revestimiento', label: 'Diseño Revestimiento' },
  { key: 'laser_dintel',         label: 'Laser tubos Dintel' },
  { key: 'laser_hojas',          label: 'Laser tubos Hojas' },
  { key: 'laser_brazos_espada',  label: 'Laser tubos Brazos y Espada' },

  // Corte
  { key: 'guillotina',           label: 'Corte (Piernas)' },
  { key: 'corte_revest',         label: 'Corte (Revestimiento)' },
  { key: 'corte_dintel',         label: 'Corte Dintel' },

  // Plegado
  { key: 'plegadora',            label: 'Plegado (Piernas)' },
  { key: 'plegado_revest',       label: 'Plegado (Revestimiento)' },
  { key: 'plegado_dintel',       label: 'Plegado Dintel' },

  // Prefabricados / Armados
  { key: 'armado_piernas',       label: 'Armado Piernas' },
  { key: 'armado_dintel',        label: 'Armado Dintel' },
  { key: 'armado_marco_piernas', label: 'Armado Marco Piernas' },
  { key: 'armado_hojas',         label: 'Armado Hojas' },
  { key: 'armado_primario',      label: 'Armado Primario' },

  // Sistema / pintura
  { key: 'inyeccion',            label: 'Inyección' },
  { key: 'revestimiento',        label: 'Revestimiento' },
  { key: 'pintura',              label: 'Pintura (Sistemas)' },
  { key: 'pintura_revestimiento',label: 'Pintura (Revestimiento)' },

  { key: 'armado_final',         label: 'Armado Final' },
  { key: 'despacho',             label: 'Despacho' },
];

const IP_STAGES = [
  { key: 'diseno',     label: 'Diseño' },
  { key: 'guillotina', label: 'Corte' },
  { key: 'plegado',    label: 'Plegado' },
  { key: 'pintura',    label: 'Pintura' },
  { key: 'inyeccion',  label: 'Inyección' },
];

const SEL_COL_W        = 44;   // selección
const NV_COL_W         = 170;
const FECHA_NV_COL_W   = 170;  // Fecha NV
const FECHA_PROD_COL_W = 170;  // Fecha producción
const FECHA_SAL_COL_W  = 190;  // Fecha salida (usa fecha_plan)

const GRID_GAP   = 6;
const CELL_MIN_H = 60;
const bordo      = '#008241ff';

const fmt = dt => (dt ? new Date(dt).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '');
const dateOnly = v => (v ? String(v).slice(0, 10) : '');
const isISODate10 = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

function isoWeekLabelFromDate(dateLike) {
  const date10 = dateOnly(dateLike);
  if (!isISODate10(date10)) return '';

  const d = new Date(`${date10}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // lunes = 0
  d.setUTCDate(d.getUTCDate() - day + 3);

  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDay = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstDay + 3);

  const week = 1 + Math.round((d - firstThu) / (7 * 24 * 3600 * 1000));
  const year = d.getUTCFullYear();
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function getProductionDate(item) {
  return (
    item?.fecha_prod ||
    item?.inicio_prod_imput ||
    item?.Inicio_Prod_Imput ||
    item?.inicio_prod ||
    item?.Inicio_Prod ||
    item?.fecha_produccion ||
    item?.Fecha_Produccion ||
    ''
  );
}

function productionWeekLabel(item) {
  const label = isoWeekLabelFromDate(getProductionDate(item));
  if (!label) return 'Semana —';
  const week = Number(String(label).slice(-2));
  return Number.isFinite(week) ? `Semana ${week}` : label;
}

function productionWeekTitle(item) {
  const label = isoWeekLabelFromDate(getProductionDate(item));
  return label ? `Semana de producción: ${label}` : 'Sin semana de producción';
}

const cellBg = st => {
  const s = (st || '').toLowerCase();
  if (s === 'finalizado') return 'var(--state-done)';
  if (s === 'en proceso') return 'var(--state-process)';
  if (s === 'pendiente')  return 'var(--state-pending)';
  return 'var(--surface)';
};

const cellInk = st => {
  const s = (st || '').toLowerCase();
  if (s === 'finalizado') return 'var(--state-done-ink)';
  if (s === 'en proceso') return 'var(--state-process-ink)';
  if (s === 'pendiente')  return 'var(--state-pending-ink)';
  return 'var(--ink)';
};

const isFullyFinishedPorton = p =>
  STAGES.every(s => (p[s.key] == null) || (p[s.key] || '').toLowerCase() === 'finalizado');

const isFullyFinishedIpanel = i =>
  IP_STAGES.every(s => (i[s.key] || '').toLowerCase() === 'finalizado');

function PortonObsModal({ open, target, onClose, onSave }) {
  const [draft, setDraft] = useState(target?.observaciones || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(target?.observaciones || '');
  }, [target]);

  if (!open || !target) return null;

  const handleSaveClick = async () => {
    try {
      setSaving(true);
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position:'fixed',
        inset:0,
        background:'rgba(0,0,0,.45)',
        display:'grid',
        placeItems:'center',
        zIndex:9999
      }}
      onClick={onClose}
    >
      <div
        style={{
          background:'var(--surface)',
          padding:20,
          borderRadius:12,
          minWidth:320,
          maxWidth:520,
          boxShadow:'0 10px 30px rgba(0,0,0,.25)',
          display:'flex',
          flexDirection:'column',
          gap:10
        }}
        onClick={e => e.stopPropagation()}
      >
        <h3 style={{ margin:0 }}>
          Observaciones NV {target.nv}
          {target.nlista ? ` - Portón ${target.nlista}` : ''}
        </h3>
        <div style={{ fontSize:13, opacity:.8 }}>{productionWeekTitle(target)}</div>

        <textarea
          rows={6}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          className="btn"
          style={{ resize:'vertical', fontFamily:'inherit', lineHeight:1.3 }}
          placeholder="Escribí notas internas, aclaraciones, etc."
        />

        <div style={{ display:'flex', justifyContent:'space-between', gap:8, marginTop:6 }}>
          <button type="button" className="btn" onClick={() => setDraft('')}>
            Limpiar texto
          </button>
          <div style={{ display:'flex', gap:8 }}>
            <button type="button" className="btn" onClick={onClose} disabled={saving}>
              Cerrar
            </button>
            <button type="button" className="btn btn--brand" onClick={handleSaveClick} disabled={saving}>
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DateEditCell({ value, currentValue, onChange, onSave, onClear, saveTitle, clearTitle }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
      <input
        type="date"
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') onSave(); }}
        className="btn"
        style={{ height:34 }}
      />
      <div style={{ display:'flex', gap:6 }}>
        <button
          type="button"
          className="btn"
          onClick={onSave}
          disabled={(value || '') === (currentValue || '')}
          title={saveTitle}
        >
          Guardar
        </button>
        <button
          type="button"
          className="btn"
          onClick={onClear}
          disabled={!currentValue}
          title={clearTitle}
        >
          Quitar
        </button>
      </div>
    </div>
  );
}

export default function CreateGatePage() {
  const [authed, setAuthed] = useState(isAuthed());
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [authErr, setAuthErr] = useState('');

  if (!authed) {
    return (
      <div className="screen page" style={{ display:'grid', placeItems:'center', background:'#f7fff3', fontFamily:'system-ui,sans-serif' }}>
        <form
          onSubmit={(e) => { e.preventDefault(); if (login(user.trim(), pass)) { setAuthed(true); setAuthErr(''); setPass(''); } else setAuthErr('Usuario o contraseña inválidos'); }}
          style={{ width:340, display:'flex', flexDirection:'column', gap:10, border:`3px solid ${bordo}`, borderRadius:12, padding:18, background:'var(--surface)' }}
        >
          <h3 style={{ margin:0, color:bordo, textAlign:'center' }}>Acceso CreateGate</h3>
          <input placeholder="Usuario" value={user} onChange={e=>setUser(e.target.value)} autoFocus className="btn" />
          <input type="password" placeholder="Contraseña" value={pass} onChange={e=>setPass(e.target.value)} className="btn" />
          {authErr && <div style={{ color:'crimson', fontSize:13 }}>{authErr}</div>}
          <button type="submit" className="btn btn--brand" style={{ fontWeight:700, borderRadius:8 }}>Entrar</button>
        </form>
      </div>
    );
  }

  const {
    data: dataP, loading, err, replaceItem, refresh, refreshing
  } = usePortones({ pollMs: 300000 });

  const {
    data: dataI, loading: loadingI, err: errI, replaceItem: replaceI,
    refresh: refreshI, refreshing: refreshingI
  } = useIpanels({ pollMs: 300000 });

  const [onlyIpanels, setOnlyIpanels] = useState(false);
  const IP_STAGES_RENDER = useMemo(
    () => (onlyIpanels ? [...IP_STAGES, { key: 'despacho', label: 'Despacho' }] : IP_STAGES),
    [onlyIpanels]
  );

  const [fechaSalidaLocal, setFechaSalidaLocal] = useState({});
  const [fechaProdLocal, setFechaProdLocal] = useState({});
  const [fechaNVLocal, setFechaNVLocal] = useState({});

  const [fechaSalidaLocalI, setFechaSalidaLocalI] = useState({});
  const [fechaProdLocalI, setFechaProdLocalI] = useState({});
  const [fechaNVLocalI, setFechaNVLocalI] = useState({});

  const setLocalFechaSalida  = (id, ymd) => setFechaSalidaLocal(prev => ({ ...prev, [id]: ymd }));
  const setLocalFechaProd    = (id, ymd) => setFechaProdLocal(prev   => ({ ...prev, [id]: ymd }));
  const setLocalFechaNV      = (id, ymd) => setFechaNVLocal(prev     => ({ ...prev, [id]: ymd }));

  const setLocalFechaSalidaI = (id, ymd) => setFechaSalidaLocalI(prev => ({ ...prev, [id]: ymd }));
  const setLocalFechaProdI   = (id, ymd) => setFechaProdLocalI(prev   => ({ ...prev, [id]: ymd }));
  const setLocalFechaNVI     = (id, ymd) => setFechaNVLocalI(prev     => ({ ...prev, [id]: ymd }));

  const toYmdOrNull = val => (val && isISODate10(val) ? val : null);

  const guardarFechaSalida = async (p) => {
    const ymd = toYmdOrNull(fechaSalidaLocal[p.id] ?? dateOnly(p.fecha_plan));
    try {
      const { data: upd } = await setFechaPlan(p.id, ymd);
      replaceItem(upd);
      setLocalFechaSalida(p.id, dateOnly(upd.fecha_plan));
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const limpiarFechaSalida = async (p) => {
    try {
      const { data: upd } = await setFechaPlan(p.id, null);
      replaceItem(upd);
      setLocalFechaSalida(p.id, '');
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const guardarFechaProd = async (p) => {
    const ymd = toYmdOrNull(fechaProdLocal[p.id] ?? dateOnly(p.fecha_prod));
    try {
      const { data: upd } = await setFechaProd(p.id, ymd);
      replaceItem(upd);
      setLocalFechaProd(p.id, dateOnly(upd.fecha_prod));
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const limpiarFechaProd = async (p) => {
    try {
      const { data: upd } = await setFechaProd(p.id, null);
      replaceItem(upd);
      setLocalFechaProd(p.id, '');
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const guardarFechaNV = async (p) => {
    const ymd = toYmdOrNull(fechaNVLocal[p.id] ?? dateOnly(p.fecha_nv));
    try {
      const { data: upd } = await setFechaNV(p.id, ymd);
      replaceItem(upd);
      setLocalFechaNV(p.id, dateOnly(upd.fecha_nv));
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const limpiarFechaNV = async (p) => {
    try {
      const { data: upd } = await setFechaNV(p.id, null);
      replaceItem(upd);
      setLocalFechaNV(p.id, '');
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const guardarFechaSalidaI = async (i) => {
    const ymd = toYmdOrNull(fechaSalidaLocalI[i.id] ?? dateOnly(i.fecha_plan));
    try {
      const { data: upd } = await setIpanelFechaPlan(i.id, ymd);
      replaceI(upd);
      setLocalFechaSalidaI(i.id, dateOnly(upd.fecha_plan));
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const limpiarFechaSalidaI = async (i) => {
    try {
      const { data: upd } = await setIpanelFechaPlan(i.id, null);
      replaceI(upd);
      setLocalFechaSalidaI(i.id, '');
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const guardarFechaProdI = async (i) => {
    const ymd = toYmdOrNull(fechaProdLocalI[i.id] ?? dateOnly(i.fecha_prod));
    try {
      const { data: upd } = await setIpanelFechaProd(i.id, ymd);
      replaceI(upd);
      setLocalFechaProdI(i.id, dateOnly(upd.fecha_prod));
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const limpiarFechaProdI = async (i) => {
    try {
      const { data: upd } = await setIpanelFechaProd(i.id, null);
      replaceI(upd);
      setLocalFechaProdI(i.id, '');
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const guardarFechaNVI = async (i) => {
    const ymd = toYmdOrNull(fechaNVLocalI[i.id] ?? dateOnly(i.fecha_nv));
    try {
      const { data: upd } = await setIpanelFechaNV(i.id, ymd);
      replaceI(upd);
      setLocalFechaNVI(i.id, dateOnly(upd.fecha_nv));
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const limpiarFechaNVI = async (i) => {
    try {
      const { data: upd } = await setIpanelFechaNV(i.id, null);
      replaceI(upd);
      setLocalFechaNVI(i.id, '');
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const [selected, setSelected] = useState(new Set());
  const toggleSel = (id) => {
    setSelected(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const [obsOpen, setObsOpen] = useState(false);
  const [obsTarget, setObsTarget] = useState(null);

  const openObsModal = (p) => {
    setObsTarget(p);
    setObsOpen(true);
  };

  const closeObsModal = () => {
    setObsOpen(false);
    setObsTarget(null);
  };

  const handleSaveObs = async (texto) => {
    if (!obsTarget) return;
    try {
      await setPortonObservaciones(obsTarget.id, texto);
      await refresh();
      closeObsModal();
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const [q, setQ] = useState('');
  const [filter, setFilter] = useState(null);
  const [qIpanel, setQIpanel] = useState('');
  const [filterIpanel, setFilterIpanel] = useState(null);

  const baseListPortones = useMemo(() => {
    if (!Array.isArray(dataP)) return [];
    const hasFilter = filter !== null && filter !== '';
    if (hasFilter) {
      const n = Number(filter);
      if (!Number.isNaN(n)) return dataP.filter(p => p.nv === n || p.nlista === n);
    }
    return dataP.filter(p => !isFullyFinishedPorton(p));
  }, [dataP, filter]);

  const listPortones = useMemo(() => {
    const arr = [...baseListPortones];
    arr.sort((a, b) => {
      const da = dateOnly(a.fecha_plan);
      const db = dateOnly(b.fecha_plan);
      const hasA = !!da;
      const hasB = !!db;

      if (hasA && !hasB) return -1;
      if (!hasA && hasB) return 1;

      if (hasA && hasB) {
        const tA = new Date(`${da}T00:00:00`).getTime();
        const tB = new Date(`${db}T00:00:00`).getTime();
        if (tA !== tB) return tA - tB;
      }

      return ((a.nlista || 0) - (b.nlista || 0)) || ((a.nv || 0) - (b.nv || 0));
    });
    return arr;
  }, [baseListPortones]);

  const baseListIpanels = useMemo(() => {
    if (!Array.isArray(dataI)) return [];
    let base = dataI.filter(i => !isFullyFinishedIpanel(i));

    const hasFilter = filterIpanel !== null && filterIpanel !== '';
    if (hasFilter) {
      const n = Number(filterIpanel);
      if (!Number.isNaN(n)) base = base.filter(i => i.nv === n);
    }
    return base;
  }, [dataI, filterIpanel]);

  const listIpanels = useMemo(() => {
    const arr = [...baseListIpanels];
    arr.sort((a, b) => {
      const da = dateOnly(a.fecha_plan);
      const db = dateOnly(b.fecha_plan);
      const hasA = !!da;
      const hasB = !!db;

      if (hasA && !hasB) return -1;
      if (!hasA && hasB) return 1;

      if (hasA && hasB) {
        const tA = new Date(`${da}T00:00:00`).getTime();
        const tB = new Date(`${db}T00:00:00`).getTime();
        if (tA !== tB) return tA - tB;
      }

      return (a.nv || 0) - (b.nv || 0);
    });
    return arr;
  }, [baseListIpanels]);

  async function handleCellClickPorton(p, s) {
    const status = (p[s.key] || '').toLowerCase();
    try {
      if (status === 'pendiente') {
        if (confirm(`¿Iniciar "${s.label}" para NV ${p.nv}?`)) {
          const { data: upd } = await startStage(p.id, s.key);
          replaceItem(upd);
        }
      } else if (status === 'en proceso') {
        if (confirm(`¿Finalizar "${s.label}" para NV ${p.nv}?`)) {
          const { data: upd } = await stopStage(p.id, s.key);
          replaceItem(upd);
        }
      }
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  }

  async function handleCellClickIpanel(i, s) {
    const status = (i[s.key] || '').toLowerCase();
    try {
      if (status === 'pendiente') {
        if (confirm(`¿Iniciar "${s.label}" para NV ${i.nv}?`)) {
          const { data: upd } = await startIpanelStage(i.id, s.key);
          replaceI(upd);
        }
      } else if (status === 'en proceso') {
        if (confirm(`¿Finalizar "${s.label}" para NV ${i.nv}?`)) {
          const { data: upd } = await stopIpanelStage(i.id, s.key);
          replaceI(upd);
        }
      }
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  }

  async function handleExportXlsxAll(rows) {
    const xlsxMod = await import('xlsx');
    const XLSX = xlsxMod.default || xlsxMod;

    const header = [
      'NV', 'Lista', 'Semana producción',
      'Fecha NV',
      'Fecha producción',
      'Fecha salida',
      ...STAGES.flatMap(s => [
        `${s.label} - Estado`, `${s.label} - Inicio`, `${s.label} - Fin`
      ])
    ];

    const dataRows = rows.map(p => {
      const fila = [
        p.nv ?? '',
        p.nlista ?? '',
        productionWeekLabel(p),
        (p.fecha_nv   ? String(p.fecha_nv).slice(0,10)   : ''),
        (p.fecha_prod ? String(p.fecha_prod).slice(0,10) : ''),
        (p.fecha_plan ? String(p.fecha_plan).slice(0,10) : ''),
      ];
      for (const s of STAGES) {
        const st  = p[s.key] || '';
        const ini = p[`${s.key}_inicio`] ? fmt(p[`${s.key}_inicio`]) : '';
        const fin = p[`${s.key}_fin`]    ? fmt(p[`${s.key}_fin`])    : '';
        fila.push(st, ini, fin);
      }
      return fila;
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows]);
    ws['!cols'] = [
      { wch: 8 },   // NV
      { wch: 10 },  // Lista
      { wch: 18 },  // Semana producción
      { wch: 14 },  // Fecha NV
      { wch: 18 },  // Fecha producción
      { wch: 18 },  // Fecha salida
      ...STAGES.flatMap(() => [{ wch: 16 }, { wch: 20 }, { wch: 20 }])
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Portones');

    const pad = n => String(n).padStart(2, '0');
    const now = new Date();
    const fname = `portones_${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.xlsx`;
    XLSX.writeFile(wb, fname);
  }

  async function handleExportSelected() {
    const rows = listPortones.filter(p => selected.has(p.id));
    if (rows.length === 0) return;
    await handleExportXlsxAll(rows);
  }

  const stickyLeft0  = { position: 'sticky', left: 0, zIndex: 4, background: 'var(--surface)', boxShadow: '1px 0 0 rgba(0,0,0,.08)' };
  const stickyLeftNV = { position: 'sticky', left: SEL_COL_W, zIndex: 4, background: 'var(--surface)', boxShadow: '1px 0 0 rgba(0,0,0,.08)' };

  const cellBase   = { border: `2px solid ${bordo}`, padding: 8, borderRadius: 12, boxSizing: 'border-box' };
  const headerCell = { ...cellBase, background:'var(--surface)', fontWeight:700, textAlign:'center' };
  const nvCell     = { ...cellBase, background:'var(--surface)', minHeight:CELL_MIN_H, display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, paddingLeft:10, paddingRight:10 };
  const scrollStyle = {
    overflowX:'auto',
    overflowY:'auto',
    width:'100%',
    maxWidth:'100vw',
    height:'calc(100vh - 210px)',
    minHeight:320,
    position:'relative',
    scrollbarGutter:'stable both-edges',
    WebkitOverflowScrolling:'touch',
    overscrollBehavior:'contain',
    paddingBottom:12
  };

  return (
    <div className="screen page" style={{ fontFamily:'system-ui,sans-serif', maxWidth:'100vw' }}>
      <div className="page__header page__header--split">
        <div className="left-stack">
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            <button
              onClick={() => { refresh(); refreshI(); }}
              disabled={refreshing || refreshingI}
              className="btn"
            >
              {(refreshing || refreshingI) ? 'Actualizando…' : 'Refrescar'}
            </button>

            <button
              onClick={() => handleExportXlsxAll(listPortones)}
              disabled={loading || (listPortones?.length ?? 0) === 0}
              className="btn"
              title="Exporta Portones visibles en la grilla"
            >
              Exportar XLSX
            </button>

            <button
              onClick={handleExportSelected}
              disabled={loading || selected.size === 0}
              className="btn"
              title="Exporta solo los portones seleccionados"
            >
              Exportar seleccionados {selected.size > 0 ? `(${selected.size})` : ''}
            </button>

            <button onClick={()=>{ logout(); setAuthed(false); }} className="btn">
              Salir
            </button>
          </div>
        </div>
      </div>

      <br />

      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
        <label style={{ display:'flex', alignItems:'center', gap:6 }}>
          <input
            type="checkbox"
            checked={onlyIpanels}
            onChange={e => setOnlyIpanels(e.target.checked)}
          />
          Ver solo iPanels
        </label>
      </div>

      <br />

      {!onlyIpanels && (
        <form
          onSubmit={(e)=>{ e.preventDefault(); setFilter(q.trim()); }}
          className="page__header"
          style={{ display:'flex', gap:8, alignItems:'center', marginTop:-8, flexWrap:'wrap', paddingTop:0 }}
        >
          <input
            type="text"
            placeholder="Buscar por NV o NPortón (número)"
            value={q}
            onChange={(e)=>setQ(e.target.value)}
            className="btn"
            style={{ minWidth:260 }}
            inputMode="numeric"
          />
          <button type="submit" className="btn">Buscar</button>
          <button type="button" className="btn" onClick={()=>{ setQ(''); setFilter(null); }}>
            Limpiar
          </button>
        </form>
      )}

      {onlyIpanels && (
        <form
          onSubmit={(e)=>{ e.preventDefault(); setFilterIpanel(qIpanel.trim()); }}
          className="page__header"
          style={{ display:'flex', gap:8, alignItems:'center', marginTop:-8, flexWrap:'wrap', paddingTop:0 }}
        >
          <input
            type="text"
            placeholder="Buscar iPanel por NV (número)"
            value={qIpanel}
            onChange={(e)=>setQIpanel(e.target.value)}
            className="btn"
            style={{ minWidth:260 }}
            inputMode="numeric"
          />
          <button type="submit" className="btn">Buscar</button>
          <button type="button" className="btn" onClick={()=>{ setQIpanel(''); setFilterIpanel(null); }}>
            Limpiar
          </button>
        </form>
      )}

      {(loading || loadingI) && <div className="page__header">Cargando…</div>}
      {(err || errI) && <div className="page__header" style={{ color:'crimson' }}>Error: {err || errI}</div>}

      <div className="grid-scroll" style={scrollStyle}>
        {!onlyIpanels && (
          <div style={{ marginBottom:24, minWidth:'max-content' }}>
            <div
              style={{
                display:'grid',
                gridTemplateColumns: `${SEL_COL_W}px ${NV_COL_W}px ${FECHA_NV_COL_W}px ${FECHA_PROD_COL_W}px ${FECHA_SAL_COL_W}px repeat(${STAGES.length}, minmax(150px, 1fr))`,
                columnGap: GRID_GAP,
                rowGap: GRID_GAP,
                alignItems:'stretch',
                width:'max-content',
                padding:16
              }}
            >
              <div style={{ ...headerCell, position:'sticky', top:0, left:0, zIndex:6, background:'var(--surface)', textAlign:'center' }}>
                Sel
              </div>

              <div style={{ ...headerCell, position:'sticky', top:0, left:SEL_COL_W, zIndex:5, textAlign:'center', background:'var(--surface)' }}>
                NV / Lista / Semana
              </div>

              <div style={{ ...headerCell, position:'sticky', top:0, zIndex:5, background:'var(--surface)', textAlign:'center' }}>
                Fecha NV
              </div>

              <div style={{ ...headerCell, position:'sticky', top:0, zIndex:5, background:'var(--surface)', textAlign:'center' }}>
                Fecha producción
              </div>

              <div style={{ ...headerCell, position:'sticky', top:0, zIndex:5, background:'var(--surface)', textAlign:'center' }}>
                Fecha salida
              </div>

              {STAGES.map(s => (
                <div key={`h-${s.key}`} style={{ ...headerCell, position:'sticky', top:0, zIndex:5, background:'var(--surface)', textAlign:'center' }}>
                  <div>{s.label}</div>
                </div>
              ))}

              {listPortones.map(p => {
                const currentSalida = dateOnly(p.fecha_plan);
                const valSalida = fechaSalidaLocal[p.id] ?? currentSalida;

                const currentProd = dateOnly(p.fecha_prod);
                const valProd = fechaProdLocal[p.id] ?? currentProd;

                const currentNV = dateOnly(p.fecha_nv);
                const valNV = fechaNVLocal[p.id] ?? currentNV;

                return ([
                  <div key={`sel-${p.id}`} style={{ ...cellBase, ...stickyLeft0, minHeight:CELL_MIN_H, display:'grid', placeItems:'center' }}>
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={() => toggleSel(p.id)}
                      aria-label={`Seleccionar NV ${p.nv}`}
                      style={{ width:18, height:18 }}
                    />
                  </div>,

                  <div
                    key={`nv-${p.id}`}
                    style={{ ...nvCell, ...stickyLeftNV, cursor:'pointer' }}
                    onClick={() => openObsModal(p)}
                    title="Click para ver/editar observaciones"
                  >
                    <div style={{ display:'flex', flexDirection:'column', lineHeight:1.15 }}>
                      <strong>NV {p.nv}</strong>
                      <strong>{productionWeekLabel(p)}</strong>
                      <span style={{ fontSize:12, opacity:.8 }}>N° Portón {p.nlista}</span>
                      {p.observaciones && (
                        <span style={{ fontSize:11, marginTop:4, color:'#555' }}>
                          📝 {p.observaciones.slice(0, 40)}{p.observaciones.length > 40 ? '…' : ''}
                        </span>
                      )}
                    </div>
                  </div>,

                  <div key={`fnv-${p.id}`} style={{ ...cellBase, minHeight:CELL_MIN_H }}>
                    <DateEditCell
                      value={valNV}
                      currentValue={currentNV}
                      onChange={value => setLocalFechaNV(p.id, value)}
                      onSave={() => guardarFechaNV(p)}
                      onClear={() => limpiarFechaNV(p)}
                      saveTitle="Guardar fecha NV"
                      clearTitle="Quitar fecha NV"
                    />
                  </div>,

                  <div key={`fprod-${p.id}`} style={{ ...cellBase, minHeight:CELL_MIN_H }}>
                    <DateEditCell
                      value={valProd}
                      currentValue={currentProd}
                      onChange={value => setLocalFechaProd(p.id, value)}
                      onSave={() => guardarFechaProd(p)}
                      onClear={() => limpiarFechaProd(p)}
                      saveTitle="Guardar fecha de producción"
                      clearTitle="Quitar fecha de producción"
                    />
                  </div>,

                  <div key={`fplan-salida-${p.id}`} style={{ ...cellBase, minHeight:CELL_MIN_H }}>
                    <DateEditCell
                      value={valSalida}
                      currentValue={currentSalida}
                      onChange={value => setLocalFechaSalida(p.id, value)}
                      onSave={() => guardarFechaSalida(p)}
                      onClear={() => limpiarFechaSalida(p)}
                      saveTitle="Guardar fecha de salida"
                      clearTitle="Quitar fecha de salida"
                    />
                  </div>,

                  ...STAGES.map(s => {
                    const st  = p[s.key];
                    const ini = p[`${s.key}_inicio`];
                    const fin = p[`${s.key}_fin`];
                    const lower = (st || '').toLowerCase();
                    const clickable = lower === 'pendiente' || lower === 'en proceso';
                    return (
                      <div
                        key={`${p.id}-${s.key}`}
                        onClick={() => clickable && handleCellClickPorton(p, s)}
                        style={{
                          ...cellBase,
                          background: cellBg(st),
                          color: cellInk(st),
                          minHeight: CELL_MIN_H,
                          display:'flex',
                          flexDirection:'column',
                          justifyContent:'center',
                          cursor: clickable ? 'pointer' : 'default',
                          outline: clickable ? '2px dashed rgba(0,0,0,.12)' : 'none'
                        }}
                        title={[
                          `Estado: ${st || ''}`,
                          ini ? `Inicio: ${fmt(ini)}` : null,
                          fin ? `Fin: ${fmt(fin)}` : null,
                          clickable ? (lower === 'pendiente' ? 'Click: Iniciar' : 'Click: Finalizar') : 'Finalizado'
                        ].filter(Boolean).join('\n')}
                      >
                        <div style={{ fontSize:12, fontWeight:700 }}>{st || ''}</div>
                        <div style={{ fontSize:11 }}>{ini ? `Inicio: ${fmt(ini)}` : ''}</div>
                        <div style={{ fontSize:11 }}>{fin ? `Fin: ${fmt(fin)}` : ''}</div>
                      </div>
                    );
                  })
                ]);
              })}

              {listPortones.length === 0 && (
                <div style={{ gridColumn:`1 / span ${STAGES.length + 5}`, marginTop:12, opacity:.7 }}>
                  Sin resultados.
                </div>
              )}
            </div>
          </div>
        )}

        {onlyIpanels && (
          <div style={{ minWidth:'max-content' }}>
            <div
              style={{
                display:'grid',
                gridTemplateColumns: `${NV_COL_W}px ${FECHA_NV_COL_W}px ${FECHA_PROD_COL_W}px ${FECHA_SAL_COL_W}px repeat(${IP_STAGES_RENDER.length}, minmax(150px, 1fr))`,
                columnGap: GRID_GAP,
                rowGap: GRID_GAP,
                alignItems:'stretch',
                width:'max-content',
                padding:16
              }}
            >
              <div style={{ ...headerCell, position:'sticky', top:0, left:0, zIndex:6, background:'var(--surface)', textAlign:'center' }}>
                NV / Semana
              </div>

              <div style={{ ...headerCell, position:'sticky', top:0, zIndex:5, background:'var(--surface)', textAlign:'center' }}>Fecha NV</div>
              <div style={{ ...headerCell, position:'sticky', top:0, zIndex:5, background:'var(--surface)', textAlign:'center' }}>Fecha producción</div>
              <div style={{ ...headerCell, position:'sticky', top:0, zIndex:5, background:'var(--surface)', textAlign:'center' }}>Fecha salida</div>

              {IP_STAGES_RENDER.map(s => (
                <div key={`ip-h-${s.key}`} style={{ ...headerCell, position:'sticky', top:0, zIndex:5, background:'var(--surface)', textAlign:'center' }}>
                  <div>{s.label}</div>
                </div>
              ))}

              {listIpanels.map(i => {
                const currentNV = dateOnly(i.fecha_nv);
                const valNVI = fechaNVLocalI[i.id] ?? currentNV;

                const currentProd = dateOnly(i.fecha_prod);
                const valProdI = fechaProdLocalI[i.id] ?? currentProd;

                const currentSalida = dateOnly(i.fecha_plan);
                const valSalidaI = fechaSalidaLocalI[i.id] ?? currentSalida;

                return ([
                  <div key={`ip-nv-${i.id}`} style={{ ...nvCell, position:'sticky', left:0, zIndex:4, background:'var(--surface)', boxShadow:'1px 0 0 rgba(0,0,0,.08)' }}>
                    <div style={{ display:'flex', flexDirection:'column', lineHeight:1.15 }}>
                      <strong>NV {i.nv}</strong>
                      <strong>{productionWeekLabel(i)}</strong>
                    </div>
                  </div>,

                  <div key={`ip-fnv-${i.id}`} style={{ ...cellBase, minHeight:CELL_MIN_H }}>
                    <DateEditCell
                      value={valNVI}
                      currentValue={currentNV}
                      onChange={value => setLocalFechaNVI(i.id, value)}
                      onSave={() => guardarFechaNVI(i)}
                      onClear={() => limpiarFechaNVI(i)}
                      saveTitle="Guardar fecha NV"
                      clearTitle="Quitar fecha NV"
                    />
                  </div>,

                  <div key={`ip-fpr-${i.id}`} style={{ ...cellBase, minHeight:CELL_MIN_H }}>
                    <DateEditCell
                      value={valProdI}
                      currentValue={currentProd}
                      onChange={value => setLocalFechaProdI(i.id, value)}
                      onSave={() => guardarFechaProdI(i)}
                      onClear={() => limpiarFechaProdI(i)}
                      saveTitle="Guardar fecha de producción"
                      clearTitle="Quitar fecha de producción"
                    />
                  </div>,

                  <div key={`ip-fps-${i.id}`} style={{ ...cellBase, minHeight:CELL_MIN_H }}>
                    <DateEditCell
                      value={valSalidaI}
                      currentValue={currentSalida}
                      onChange={value => setLocalFechaSalidaI(i.id, value)}
                      onSave={() => guardarFechaSalidaI(i)}
                      onClear={() => limpiarFechaSalidaI(i)}
                      saveTitle="Guardar fecha de salida"
                      clearTitle="Quitar fecha de salida"
                    />
                  </div>,

                  ...IP_STAGES_RENDER.map(s => {
                    const st  = i[s.key];
                    const ini = i[`${s.key}_inicio`];
                    const fin = i[`${s.key}_fin`];
                    const lower = (st || '').toLowerCase();
                    const clickable = lower === 'pendiente' || lower === 'en proceso';
                    return (
                      <div
                        key={`ip-${i.id}-${s.key}`}
                        onClick={() => clickable && handleCellClickIpanel(i, s)}
                        style={{
                          ...cellBase,
                          background: cellBg(st),
                          color: cellInk(st),
                          minHeight: CELL_MIN_H,
                          display:'flex',
                          flexDirection:'column',
                          justifyContent:'center',
                          cursor: clickable ? 'pointer' : 'default',
                          outline: clickable ? '2px dashed rgba(0,0,0,.12)' : 'none'
                        }}
                        title={[
                          `Estado: ${st || ''}`,
                          ini ? `Inicio: ${fmt(ini)}` : null,
                          fin ? `Fin: ${fmt(fin)}` : null,
                          clickable ? (lower === 'pendiente' ? 'Click: Iniciar' : 'Click: Finalizar') : 'Finalizado'
                        ].filter(Boolean).join('\n')}
                      >
                        <div style={{ fontSize:12, fontWeight:700 }}>{st || ''}</div>
                        <div style={{ fontSize:11 }}>{ini ? `Inicio: ${fmt(ini)}` : ''}</div>
                        <div style={{ fontSize:11 }}>{fin ? `Fin: ${fmt(fin)}` : ''}</div>
                      </div>
                    );
                  })
                ]);
              })}

              {listIpanels.length === 0 && (
                <div style={{ gridColumn:`1 / span ${IP_STAGES_RENDER.length + 4}`, marginTop:12, opacity:.7 }}>
                  Sin resultados.
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <PortonObsModal
        open={obsOpen}
        target={obsTarget}
        onClose={closeObsModal}
        onSave={handleSaveObs}
      />
    </div>
  );
}
