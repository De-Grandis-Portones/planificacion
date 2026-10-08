// pages/DisenoV2Page.jsx
//
// /diseno_v2 - nueva pantalla de Diseño, pensada para reemplazar en el futuro
// a /diseno (por ahora conviven, se desarrolla en paralelo - no tocar
// /diseno). Mientras está en Beta es solo para el scope programadores:admin
// (sección Programadores del índice), no pública como /diseno.
//
// Trabaja por lote = semana de producción (la misma que se carga en /a y que
// el tablero muestra como "Producción: Semana N° X"). Para el lote elegido
// arma la planilla "+4000" con los datos de Planta (ver
// src/utils/planilla4000.js) y se la pasa a la herramienta de diseño
// (public/diseno-v2/portones_v6.html, hecha aparte), que corre embebida en un
// iframe y genera los DXF, Excel, PDF y órdenes de trabajo de la semana.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import usePortones from '../src/hooks/usePortones';
import { getAdminToken } from '../src/api';
import { getCurrentScopes, hasAny } from '../src/utils/adminScopes';
import {
  toISODate10, isoWeekLabelFromDate, weekNumberFromLabel, isoWeekStartEndFromLabel,
  formatDMY, todayISO10,
} from '../src/utils/isoWeek';
import {
  matrizPlanilla4000, ENCABEZADOS, indiceDeColumna,
} from '../src/utils/planilla4000';

const BRAND = '#0a6a33';
const HERRAMIENTA_URL = '/diseno-v2/portones_v6.html';
const SCOPE_REQUERIDO = 'programadores:admin';

const ETAPAS_DISENO = [
  { key: 'diseno', label: 'Tubos' },
  { key: 'diseno_piernas', label: 'Piernas' },
  { key: 'diseno_revestimiento', label: 'Revest.' },
];

// Columnas de la +4000 que se muestran en "Ver planilla generada": las que
// usa la herramienta de diseño.
const COLUMNAS_VISTA = ['A', 'B', 'D', 'K', 'L', 'M', 'N', 'O', 'P', 'R', 'S', 'T', 'U', 'V', 'Y', 'Z',
  'AE', 'AF', 'AG', 'AJ', 'AL', 'AM', 'AN', 'AO', 'AP', 'AS', 'AT', 'AV', 'BA'];

// Misma fecha que usa el tablero para "Producción: Semana N° X"
// (StageColumn.getProdDate10): fecha_prod y, si falta, lo cargado en /a.
function fechaProduccion(p) {
  return toISODate10(p?.fecha_prod ?? p?.inicio_prod_imput ?? p?.Inicio_Prod_Imput ?? null);
}

function estadoDiseno(p, key) {
  const v = p?.[key];
  return v == null || v === '' ? null : String(v);
}

function tieneDisenoPendiente(p) {
  return ETAPAS_DISENO.some(({ key }) => {
    const e = estadoDiseno(p, key);
    return e && e !== 'Finalizado';
  });
}

function tituloSemana(label) {
  const { start, end } = isoWeekStartEndFromLabel(label);
  const fin = new Date(`${end}T00:00:00Z`);
  fin.setUTCDate(fin.getUTCDate() - 1);
  const fin10 = fin.toISOString().slice(0, 10);
  return `Semana ${weekNumberFromLabel(label)} · ${formatDMY(start)} al ${formatDMY(fin10)}`;
}

function formatoCelda(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number' && !Number.isInteger(v)) return v.toFixed(1);
  return String(v);
}

function BadgeEstado({ estado }) {
  if (!estado) return <span style={{ color: '#bbb' }} title="Esta etapa no aplica a este portón">—</span>;
  const colores = {
    Finalizado: ['#e3f4ea', '#0a6a33'],
    'En Proceso': ['#fff3d6', '#8a5a00'],
    Pendiente: ['#eef0f3', '#4a5563'],
  };
  const [bg, fg] = colores[estado] || ['#eef0f3', '#4a5563'];
  return (
    <span style={{ background: bg, color: fg, borderRadius: 10, padding: '2px 8px', fontSize: 12, whiteSpace: 'nowrap' }}>
      {estado}
    </span>
  );
}

// Sin sesión de admin -> login; con sesión pero sin el scope -> aviso (y no
// se carga nada).
export default function DisenoV2Page() {
  const nav = useNavigate();
  const token = String(getAdminToken() || '').trim();
  const conAcceso = !!token && hasAny(getCurrentScopes(), [SCOPE_REQUERIDO]);

  useEffect(() => {
    if (!token) nav('/admin/login', { replace: true });
  }, [token, nav]);

  if (!token) return null;
  if (!conAcceso) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
        <p>
          No tenés acceso a Diseño v2 (Beta): es solo para usuarios con el permiso <b>{SCOPE_REQUERIDO}</b>.
        </p>
        <Link to="/index">← Volver al inicio</Link>
      </div>
    );
  }
  return <DisenoV2 />;
}

function DisenoV2() {
  const { data: portones, loading, err, refresh, refreshing } = usePortones({ pollMs: 300000 });

  // ---- lotes (semanas de producción) ----
  const semanas = useMemo(() => {
    const m = new Map();
    for (const p of portones || []) {
      if (p?.tipo === 'refabricacion') continue;
      const label = isoWeekLabelFromDate(fechaProduccion(p));
      if (!label) continue;
      if (!m.has(label)) m.set(label, { label, portones: [] });
      m.get(label).portones.push(p);
    }
    return [...m.values()]
      .map((s) => ({ ...s, pendientes: s.portones.filter(tieneDisenoPendiente).length }))
      .filter((s) => s.pendientes > 0)
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [portones]);

  const [semana, setSemana] = useState('');
  useEffect(() => {
    if (semana || !semanas.length) return;
    const hoy = isoWeekLabelFromDate(todayISO10());
    const actual = semanas.find((s) => s.label >= hoy) || semanas[semanas.length - 1];
    setSemana(actual.label);
  }, [semanas, semana]);

  const lote = useMemo(() => {
    const s = semanas.find((x) => x.label === semana);
    return s ? [...s.portones].sort((a, b) => Number(a.nv) - Number(b.nv)) : [];
  }, [semanas, semana]);

  // Qué portones del lote van a la herramienta (por defecto, todos).
  const [excluidos, setExcluidos] = useState(() => new Set());
  useEffect(() => { setExcluidos(new Set()); }, [semana]);
  const incluidos = useMemo(() => lote.filter((p) => !excluidos.has(p.id)), [lote, excluidos]);

  const planilla = useMemo(() => matrizPlanilla4000(incluidos), [incluidos]);
  const avisosPorId = useMemo(() => {
    const m = new Map();
    for (const x of matrizPlanilla4000(lote).porPorton) m.set(x.porton.id, x);
    return m;
  }, [lote]);

  // ---- herramienta embebida ----
  const iframeRef = useRef(null);
  const [herramientaLista, setHerramientaLista] = useState(false);
  const [cargado, setCargado] = useState(null); // { semana, cantidad, hora }
  const [errorHerramienta, setErrorHerramienta] = useState('');
  const pendienteRef = useRef(null);

  useEffect(() => {
    const onMsg = (ev) => {
      if (ev.origin !== window.location.origin) return;
      if (ev.source !== iframeRef.current?.contentWindow) return;
      const d = ev.data || {};
      if (d.tipo === 'diseno:listo') setHerramientaLista(true);
      if (d.tipo === 'diseno:lote-cargado' && pendienteRef.current) {
        setCargado({ ...pendienteRef.current, hora: new Date() });
        pendienteRef.current = null;
        setErrorHerramienta('');
      }
      if (d.tipo === 'diseno:error') setErrorHerramienta(d.mensaje || 'error desconocido');
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const cargarEnHerramienta = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win || !incluidos.length) return;
    const nro = weekNumberFromLabel(semana);
    pendienteRef.current = { semana, cantidad: incluidos.length };
    win.postMessage({
      tipo: 'planta:cargar-lote',
      filas: planilla.filas,
      semana: nro,
      archivo: `Planta · Semana ${nro} (${incluidos.length} portones)`,
    }, window.location.origin);
  }, [incluidos, planilla, semana]);

  // La primera vez que están la herramienta y los datos, se carga sola. Después
  // solo con el botón, para no pisar lo que el diseñador tenga a medio hacer.
  const autoCargado = useRef(false);
  useEffect(() => {
    if (autoCargado.current || !herramientaLista || !semana || !incluidos.length) return;
    autoCargado.current = true;
    cargarEnHerramienta();
  }, [herramientaLista, semana, incluidos.length, cargarEnHerramienta]);

  const loteDesactualizado = cargado && (cargado.semana !== semana || cargado.cantidad !== incluidos.length);

  // ---- vista / descarga de la planilla generada ----
  const [verPlanilla, setVerPlanilla] = useState(false);
  const [abiertos, setAbiertos] = useState(() => new Set());

  const descargarPlanilla = useCallback(async () => {
    const XLSX = await import('xlsx');
    const ws = XLSX.utils.aoa_to_sheet(planilla.filas);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'PRINCIPAL');
    XLSX.writeFile(wb, `+4000 SEMANA ${weekNumberFromLabel(semana)} (Planta).xlsx`);
  }, [planilla, semana]);

  const toggle = (setFn, id) => setFn((prev) => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  // ---- render ----
  const btn = (primario) => ({
    background: primario ? BRAND : '#fff',
    color: primario ? '#fff' : BRAND,
    border: `1px solid ${BRAND}`,
    borderRadius: 8,
    padding: '8px 14px',
    fontWeight: 600,
    cursor: 'pointer',
  });

  return (
    <div style={{ minHeight: '100vh', background: '#f5f6f8', fontFamily: 'system-ui, sans-serif' }}>
      <header style={{ background: BRAND, color: '#fff', padding: '10px 18px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 18 }}>Diseño v2 <span style={{ fontWeight: 400, opacity: 0.8 }}>(Beta)</span></strong>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Lote:
          <select
            value={semana}
            onChange={(e) => setSemana(e.target.value)}
            style={{ padding: '6px 8px', borderRadius: 6, border: 'none', minWidth: 300 }}
          >
            {semanas.map((s) => (
              <option key={s.label} value={s.label}>
                {tituloSemana(s.label)} — {s.portones.length} portones ({s.pendientes} con diseño pendiente)
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={refresh} disabled={refreshing} style={{ ...btn(false), padding: '6px 10px' }}>
          {refreshing ? 'Actualizando…' : '↻ Actualizar'}
        </button>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 16 }}>
          <Link to="/diseno" style={{ color: '#fff' }}>Ir a /diseno (actual)</Link>
          <Link to="/index" style={{ color: '#fff' }}>Menú</Link>
        </span>
      </header>

      <main style={{ padding: 16, display: 'grid', gap: 16 }}>
        {loading && <div>Cargando portones…</div>}
        {err && <div style={{ color: '#b00020' }}>No se pudieron cargar los portones: {err}</div>}
        {!loading && !semanas.length && <div>No hay portones con diseño pendiente y semana de producción cargada.</div>}

        {!!lote.length && (
          <section style={{ background: '#fff', borderRadius: 10, padding: 14, boxShadow: '0 1px 3px rgba(0,0,0,.08)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>{tituloSemana(semana)}</h2>
              <span style={{ color: '#666' }}>{incluidos.length} de {lote.length} portones van a la herramienta</span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" style={btn(false)} onClick={() => setVerPlanilla((v) => !v)}>
                  {verPlanilla ? 'Ocultar planilla +4000' : 'Ver planilla +4000 generada'}
                </button>
                <button type="button" style={btn(false)} onClick={descargarPlanilla} disabled={!incluidos.length}>
                  ⤓ Descargar +4000 (.xlsx)
                </button>
                <button
                  type="button"
                  style={btn(true)}
                  onClick={cargarEnHerramienta}
                  disabled={!herramientaLista || !incluidos.length}
                  title={herramientaLista ? '' : 'La herramienta todavía se está abriendo'}
                >
                  Cargar lote en la herramienta ↓
                </button>
              </span>
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 14 }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '2px solid #e4e6ea' }}>
                    <th style={{ padding: 6 }}>Va</th>
                    <th style={{ padding: 6 }}>NV</th>
                    <th style={{ padding: 6 }}>Cliente</th>
                    <th style={{ padding: 6 }}>Ancho × Alto</th>
                    <th style={{ padding: 6 }}>Sistema</th>
                    {ETAPAS_DISENO.map((e) => <th key={e.key} style={{ padding: 6 }}>Diseño {e.label}</th>)}
                    <th style={{ padding: 6 }}>Datos +4000</th>
                  </tr>
                </thead>
                <tbody>
                  {lote.map((p) => {
                    const gen = avisosPorId.get(p.id);
                    const avisos = gen?.avisos || [];
                    const abierto = abiertos.has(p.id);
                    return (
                      <React.Fragment key={p.id}>
                        <tr style={{ borderBottom: '1px solid #eef0f3', opacity: excluidos.has(p.id) ? 0.45 : 1 }}>
                          <td style={{ padding: 6 }}>
                            <input type="checkbox" checked={!excluidos.has(p.id)} onChange={() => toggle(setExcluidos, p.id)} />
                          </td>
                          <td style={{ padding: 6, fontWeight: 600 }}>{p.nv}{p.tipo === 'puerta' ? ' (puerta)' : ''}</td>
                          <td style={{ padding: 6 }}>{p.nombre_cliente || p.Nombre || ''}</td>
                          <td style={{ padding: 6, whiteSpace: 'nowrap' }}>
                            {formatoCelda(gen?.valores?.AP)} × {formatoCelda(gen?.valores?.AM)}
                          </td>
                          <td style={{ padding: 6, fontSize: 13 }}>{String(p.Sistema || p.sistema || '').trim()}</td>
                          {ETAPAS_DISENO.map((e) => (
                            <td key={e.key} style={{ padding: 6 }}><BadgeEstado estado={estadoDiseno(p, e.key)} /></td>
                          ))}
                          <td style={{ padding: 6 }}>
                            <button
                              type="button"
                              onClick={() => toggle(setAbiertos, p.id)}
                              style={{ border: 'none', background: 'none', cursor: 'pointer', color: avisos.length ? '#8a5a00' : BRAND, padding: 0 }}
                              title="Ver de dónde sale cada dato"
                            >
                              {avisos.length ? `⚠ ${avisos.length} a revisar` : '✓ completos'} {abierto ? '▴' : '▾'}
                            </button>
                          </td>
                        </tr>
                        {abierto && (
                          <tr>
                            <td colSpan={9} style={{ padding: '6px 6px 12px 40px', background: '#fafbfc', fontSize: 13 }}>
                              <div style={{ marginBottom: 4, color: '#666' }}>Origen de los datos: {gen?.origen}</div>
                              {avisos.map((a) => <div key={a} style={{ color: '#8a5a00' }}>⚠ {a}</div>)}
                              <div style={{ marginTop: 6 }}>
                                <b>Descripción (L):</b> {gen?.valores?.L || '—'}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {verPlanilla && (
              <div style={{ overflowX: 'auto', marginTop: 14, border: '1px solid #e4e6ea', borderRadius: 8 }}>
                <table style={{ borderCollapse: 'collapse', fontSize: 12, whiteSpace: 'nowrap' }}>
                  <thead>
                    <tr style={{ background: '#f0f2f5' }}>
                      {COLUMNAS_VISTA.map((c) => (
                        <th key={c} style={{ padding: '4px 8px', textAlign: 'left', borderRight: '1px solid #e4e6ea' }}>
                          <div style={{ color: '#888' }}>{c}</div>
                          <div>{ENCABEZADOS[c] || ''}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {planilla.porPorton.map((x) => (
                      <tr key={x.porton.id} style={{ borderTop: '1px solid #eef0f3' }}>
                        {COLUMNAS_VISTA.map((c) => (
                          <td key={c} style={{ padding: '4px 8px', borderRight: '1px solid #f0f2f5', maxWidth: c === 'L' ? 420 : undefined, overflow: 'hidden', textOverflow: 'ellipsis' }} title={c === 'L' ? formatoCelda(x.fila[indiceDeColumna(c)]) : undefined}>
                            {formatoCelda(x.fila[indiceDeColumna(c)])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        <section style={{ background: '#fff', borderRadius: 10, boxShadow: '0 1px 3px rgba(0,0,0,.08)', overflow: 'hidden' }}>
          <div style={{ padding: '8px 14px', borderBottom: '1px solid #eef0f3', fontSize: 14, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <b>Herramienta de diseño</b>
            {!herramientaLista && <span style={{ color: '#666' }}>Abriendo…</span>}
            {herramientaLista && !cargado && <span style={{ color: '#666' }}>Lista, sin lote cargado</span>}
            {cargado && (
              <span style={{ color: BRAND }}>
                Cargado: {tituloSemana(cargado.semana)} · {cargado.cantidad} portones · {cargado.hora.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
            {loteDesactualizado && (
              <span style={{ color: '#8a5a00' }}>
                El lote de arriba cambió: tocá «Cargar lote en la herramienta» para pasarlo (se pierde lo que no hayas bajado).
              </span>
            )}
            {errorHerramienta && <span style={{ color: '#b00020' }}>Error en la herramienta: {errorHerramienta}</span>}
          </div>
          <iframe
            ref={iframeRef}
            src={HERRAMIENTA_URL}
            title="Herramienta de diseño de portones"
            // Respaldo del aviso 'diseno:listo': para cuando termina de cargar,
            // el puente del HTML ya está escuchando.
            onLoad={() => setHerramientaLista(true)}
            style={{ width: '100%', height: '88vh', border: 'none', display: 'block' }}
          />
        </section>
      </main>
    </div>
  );
}
