// pages/admin/PortonesInstaladosPage.jsx
//
// Padrón de portones instalados en clientes finales (pedido de Esteban,
// 2026-10-01): dirección de instalación con link de Google Maps, NV y tipo de
// portón (sistema, colores, revestimiento, orientación, lucera, puerta), para
// todos los canales. Lista de fichas con filtros, mapa y exportación a Excel.
// Solo lectura: ver Backend/server/lib/portonesInstaladosDb.js.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { fetchPortonesInstalados, getAdminToken } from '../../src/api';

const ARGENTINA_CENTER = [-38.4, -63.6];
const ARGENTINA_ZOOM = 4;
const POR_PAGINA = 50;

const CANALES = ['Directo', 'Distribuidor', 'Sin dato'];
const COLOR_CANAL = { Directo: '#16a34a', Distribuidor: '#2563eb', 'Sin dato': '#9ca3af' };
const NOMBRE_CANAL = { Directo: 'Venta directa', Distribuidor: 'Por distribuidor', 'Sin dato': 'Sin dato de canal' };

// Calidad de la dirección: el valor completo (filtro y Excel), una versión
// corta para la ficha y la explicación que se ve al pasar el mouse.
const CALIDADES = [
  { valor: 'Link de Maps cargado', corto: 'Ubicación cargada', color: '#16a34a', ayuda: 'El vendedor, el distribuidor o Logística cargó el link de Google Maps.' },
  { valor: 'Dirección con altura (sin link)', corto: 'Dirección sin link', color: '#2563eb', ayuda: 'Hay calle y altura pero no link: "Buscar en Maps" arma la búsqueda con ese texto.' },
  { valor: 'Solo localidad', corto: 'Solo localidad', color: '#9ca3af', ayuda: 'La dirección es solo una localidad: no alcanza para ubicar la casa.' },
  { valor: 'Revisar: link al local del distribuidor', corto: 'Revisar · link del distribuidor', color: '#d97706', ayuda: 'El link apunta al local del distribuidor, no a la casa del cliente.' },
  { valor: 'Revisar: misma dirección o link para varios clientes', corto: 'Revisar · dirección repetida', color: '#d97706', ayuda: 'La misma dirección o link aparece en clientes distintos: casi siempre es el distribuidor o un transporte, no la casa del cliente.' },
  { valor: 'Sin dirección', corto: 'Sin dirección', color: '#9ca3af', ayuda: 'No hay dirección cargada para esta NV.' },
];
const CALIDAD_POR_VALOR = Object.fromEntries(CALIDADES.map((c) => [c.valor, c]));

// Estado: color de la etiqueta y versión corta para la ficha (el texto
// completo queda en el filtro, en el tooltip y en el Excel).
const ESTADOS = {
  Despachado: { corto: 'Despachado', background: '#dcfce7', color: '#166534' },
  'En producción': { corto: 'En producción', background: '#fef9c3', color: '#854d0e' },
  'Sin pasar a planta': { corto: 'Sin pasar a planta', background: '#ffedd5', color: '#9a3412' },
  'En acopio (sin fabricar)': { corto: 'En acopio', background: '#e0f2fe', color: '#075985' },
  'Histórico (fabricado antes del tablero)': { corto: 'Histórico', background: '#f1f5f9', color: '#475569' },
};

// Columnas del Excel (la pantalla muestra fichas, no columnas).
const COLUMNAS = [
  { key: 'nv', label: 'NV', width: 8 },
  { key: 'fecha_nv', label: 'Fecha NV', width: 11 },
  { key: 'estado', label: 'Estado', width: 30 },
  { key: 'canal', label: 'Canal', width: 12 },
  { key: 'distribuidor', label: 'Distribuidor', width: 26 },
  { key: 'cliente', label: 'Cliente final', width: 32 },
  { key: 'direccion', label: 'Dirección de instalación', width: 40 },
  { key: 'maps_link', label: 'Google Maps', width: 16 },
  { key: 'calidad_direccion', label: 'Calidad de la dirección', width: 34 },
  { key: 'sistema', label: 'Sistema', width: 34 },
  { key: 'sistema_variante', label: 'Variante sistema', width: 24 },
  { key: 'color_sistema', label: 'Color sistema', width: 22 },
  { key: 'color_revestimiento', label: 'Color revestimiento', width: 22 },
  { key: 'tipo_revestimiento', label: 'Tipo de revestimiento', width: 40 },
  { key: 'orientacion_revestimiento', label: 'Orientación revestimiento', width: 14 },
  { key: 'lucera', label: 'Lucera', width: 26 },
  { key: 'puerta', label: 'Puerta', width: 16 },
  { key: 'origen_dato', label: 'Origen del dato', width: 16 },
];

// Se muestra en "¿Cómo se arma este listado?" y en la hoja "Léeme" del Excel.
const EXPLICACION = [
  ['Qué es', 'Todos los portones vendidos (venta directa y por distribuidor) con su dirección de instalación, link de Google Maps y tipo de portón. Se arma en vivo con los datos ya cargados; esta pantalla no modifica nada.'],
  ['Cliente final', 'La persona donde se instala el portón. En el Presupuestador es obligatorio cargar su nombre, teléfono, dirección y link de Maps, venda un vendedor o un distribuidor.'],
  ['Canal', 'Venta directa = vendedores y cuentas propias "DE GRANDIS PORTONES". Por distribuidor = el titular de la cuenta es un distribuidor. Sin dato = NV del sistema anterior cuya cuenta no tiene nombre cargado.'],
  ['Estado', 'Despachado / En producción (tablero de planta) / Histórico (fabricado antes de que existiera el tablero, marzo 2026) / En acopio / Sin pasar a planta.'],
  ['Google Maps', '"Abrir mapa" = link cargado por el vendedor, el distribuidor o Logística. "Buscar en Maps" = búsqueda armada con el texto de la dirección (puede no ser exacta).'],
  ['Calidad de la dirección', 'Marca los casos dudosos: direcciones que son solo una localidad, links que apuntan al local del distribuidor, o una misma dirección o link repetido para clientes distintos (casi siempre es el distribuidor o un transporte, no la casa del cliente).'],
  ['Mapa', 'Muestra los portones cuya ubicación se conoce sin consultar servicios externos: coordenadas incluidas en el link, o ya ubicadas antes por Logística. El resto se abre desde la lista.'],
  ['Tipo de revestimiento', 'Presupuestador: sección del cotizador. Sistema anterior: primer tramo de la descripción de planta (ALUMINIO, PVC, MADERA, SIMIL ROBLE...). "Color del sistema" = portón para revestir: el único color es el del sistema.'],
  ['Datos faltantes', 'Las NV cargadas antes del Presupuestador tienen muchos datos vacíos (cliente, dirección, sistema): en esta base solo quedaron los datos de fabricación. Las ventas nuevas entran completas.'],
  ['Stock', 'Portón de stock de un distribuidor: todavía no tiene cliente final.'],
];

// Campos cuya cobertura se resume en la hoja "Resumen" del Excel.
const CAMPOS_COBERTURA = [
  ['Cliente final', 'cliente'],
  ['Dirección', 'direccion'],
  ['Link de Maps cargado', 'maps_url'],
  ['Sistema', 'sistema'],
  ['Color sistema', 'color_sistema'],
  ['Color revestimiento', 'color_revestimiento'],
  ['Tipo de revestimiento', 'tipo_revestimiento'],
  ['Orientación revestimiento', 'orientacion_revestimiento'],
  ['Lucera', 'lucera'],
  ['Puerta', 'puerta'],
];

// Estilos propios de la pantalla (prefijo pi-): las fichas se reacomodan con
// media queries en vez de una tabla ancha con barras de desplazamiento.
const ESTILOS = `
.pi-wrap { display: flex; flex-direction: column; gap: 14px; }
.pi-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
.pi-sub { color: var(--muted); font-size: 13px; margin-top: 8px; }
.pi-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.pi-seg { display: inline-flex; padding: 3px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); }
.pi-seg button { border: 0; background: transparent; padding: 7px 18px; border-radius: 999px; font-weight: 700; cursor: pointer; color: var(--muted); font-size: 14px; }
.pi-seg button.is-on { background: var(--brand); color: #fff; }
.pi-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.pi-kpi { text-align: left; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); padding: 12px 14px; box-shadow: var(--shadow); font: inherit; color: inherit; }
.pi-kpi--btn { cursor: pointer; transition: border-color .15s, transform .15s, box-shadow .15s; }
.pi-kpi--btn:hover { border-color: var(--brand); transform: translateY(-1px); }
.pi-kpi.is-on { border-color: var(--brand); background: var(--brand-100); box-shadow: 0 0 0 1px var(--brand), var(--shadow); }
.pi-kpi__label { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; font-weight: 700; }
.pi-kpi__valor { font-size: 28px; font-weight: 800; margin-top: 2px; line-height: 1.15; }
.pi-kpi__extra { font-size: 11.5px; color: var(--muted); margin-top: 2px; }
.pi-info { border: 1px solid var(--border); border-radius: 14px; background: var(--surface); padding: 10px 14px; }
.pi-info summary { cursor: pointer; font-weight: 700; list-style: none; display: flex; align-items: center; gap: 8px; color: var(--brand-700); }
.pi-info summary::-webkit-details-marker { display: none; }
.pi-info dl { margin: 12px 0 4px; display: grid; grid-template-columns: minmax(140px, 190px) 1fr; gap: 8px 16px; font-size: 13px; }
.pi-info dt { font-weight: 700; }
.pi-info dd { margin: 0; color: var(--muted); }
.pi-filtros { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 12px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); }
.pi-buscar { position: relative; flex: 1 1 300px; min-width: 240px; }
.pi-buscar svg { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--muted); pointer-events: none; }
.pi-input, .pi-select { padding: 9px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font: inherit; font-size: 14px; }
.pi-input:focus, .pi-select:focus { outline: 2px solid var(--brand-100); border-color: var(--brand); }
.pi-buscar .pi-input { width: 100%; padding-left: 36px; box-sizing: border-box; }
.pi-select { max-width: 230px; }
.pi-check { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); padding: 0 4px; }
.pi-limpiar { border: 0; background: transparent; color: var(--brand-700); font-weight: 700; cursor: pointer; font-size: 13px; padding: 6px; }
.pi-barra { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; color: var(--muted); }
.pi-lista { display: flex; flex-direction: column; gap: 10px; }
.pi-card { display: grid; grid-template-columns: 130px minmax(170px, 1fr) minmax(210px, 1.15fr) minmax(260px, 1.6fr); gap: 20px; padding: 14px 18px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); transition: box-shadow .15s, border-color .15s; }
.pi-card:hover { box-shadow: var(--shadow); border-color: #c5ccd4; }
.pi-label { font-size: 10.5px; font-weight: 800; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px; }
.pi-nv { font-size: 18px; font-weight: 800; line-height: 1.2; }
.pi-fecha { font-size: 12px; color: var(--muted); margin: 2px 0 8px; }
.pi-pill { display: inline-block; font-size: 11px; font-weight: 700; padding: 3px 9px; border-radius: 999px; line-height: 1.35; }
.pi-cliente { font-weight: 700; font-size: 15px; line-height: 1.3; }
.pi-canal { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); margin-top: 5px; line-height: 1.3; }
.pi-dir { font-size: 14px; line-height: 1.35; }
.pi-vacio-txt { color: var(--muted); font-style: italic; font-weight: 400; }
.pi-dir-acciones { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
.pi-maps { display: inline-flex; align-items: center; gap: 5px; padding: 4px 11px 4px 9px; border-radius: 999px; background: var(--brand-100); color: var(--brand-700); font-size: 12px; font-weight: 700; text-decoration: none; transition: background .15s, color .15s; }
.pi-maps:hover { background: var(--brand); color: #fff; }
.pi-calidad { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--muted); cursor: help; }
.pi-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.pi-chip { display: inline-flex; align-items: baseline; gap: 6px; padding: 4px 9px; border-radius: 8px; background: var(--bg); border: 1px solid var(--border); font-size: 12.5px; line-height: 1.3; }
.pi-chip b { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; font-weight: 800; white-space: nowrap; }
.pi-stock { font-size: 10px; font-weight: 800; padding: 2px 7px; border-radius: 999px; background: #fef3c7; color: #92400e; margin-left: 6px; vertical-align: middle; cursor: help; }
.pi-pag { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.pi-pag button { min-width: 34px; height: 34px; padding: 0 10px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; font: inherit; font-weight: 700; font-size: 13px; }
.pi-pag button:hover:not(:disabled):not(.is-on) { border-color: var(--brand); }
.pi-pag button:disabled { opacity: .4; cursor: default; }
.pi-pag button.is-on { background: var(--brand); border-color: var(--brand); color: #fff; }
.pi-pag span { padding: 0 4px; color: var(--muted); }
.pi-vacio { padding: 48px 20px; text-align: center; color: var(--muted); border: 1px dashed var(--border); border-radius: 14px; background: var(--surface); }
.pi-mapa-card { border: 1px solid var(--border); border-radius: 14px; background: var(--surface); padding: 12px; box-shadow: var(--shadow); }
.pi-leyenda { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; font-size: 12.5px; color: var(--muted); padding: 0 4px 10px; }
.pi-leyenda span { display: inline-flex; align-items: center; gap: 6px; }
@media (max-width: 1150px) {
  .pi-card { grid-template-columns: 120px 1fr 1fr; }
  .pi-card .pi-col--porton { grid-column: 1 / -1; }
}
@media (max-width: 720px) {
  .pi-card { grid-template-columns: 1fr; gap: 12px; }
  .pi-info dl { grid-template-columns: 1fr; }
}
`;

function normalizar(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function valoresUnicos(rows, key) {
  return Array.from(new Set(rows.map((r) => r[key]).filter(Boolean)))
    .sort((a, b) => String(a).localeCompare(String(b), 'es'));
}

function contarPor(rows, key) {
  const m = {};
  for (const r of rows) m[r[key]] = (m[r[key]] || 0) + 1;
  return m;
}

const tieneDato = (v) => v !== null && v !== undefined && String(v).trim() !== '';
const fmt = (n) => Number(n || 0).toLocaleString('es-AR');
const pct = (parte, total) => (total ? Math.round((100 * parte) / total) : 0);

// Los links vienen de datos cargados a mano: solo se aceptan http(s), para que
// un "javascript:..." mal cargado nunca termine en un href.
function linkSeguro(url) {
  return /^https?:\/\//i.test(String(url || '').trim()) ? String(url).trim() : null;
}

// Mucho dato viene TODO EN MAYÚSCULAS o todo en minúsculas (sistema anterior,
// distribuidores, carga a mano): para mostrarlo se pasa a "Tipo Título" con los
// conectores en minúscula y respetando siglas. Lo que ya mezcla mayúsculas y
// minúsculas se deja como lo escribieron. Solo afecta lo que se ve, no el Excel.
const SIGLAS = new Set(['PVC', 'WPC', 'SA', 'SRL', 'SAS', 'DG', 'PB', 'NV', 'CBA', 'II', 'III']);
const CONECTORES = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'o', 'con', 'para', 'por', 'en', 'sin', 'a', 'al']);
function lindo(s) {
  // Basura al final: apellido cargado como "." -> "Karina ." -> "Karina".
  const t = String(s ?? '').trim().replace(/(\s+[.\-_,;:]+)+$/, '');
  if (!t || (/[a-záéíóúñü]/.test(t) && /[A-ZÁÉÍÓÚÑÜ]/.test(t))) return t;
  const bajo = t.toLowerCase();
  let primera = true;
  return bajo.replace(/[^\s\-/(),.]+/g, (w, offset) => {
    const esPrimera = primera;
    primera = false;
    // "AL PVC" (aluminio, en "Para revestir con AL PVC otros") es sigla; el "al" suelto no.
    if (SIGLAS.has(w.toUpperCase()) || (w === 'al' && /^\s*pvc/.test(bajo.slice(offset + w.length)))) return w.toUpperCase();
    // Letra suelta pegada a un punto = abreviatura ("S.A", "S.R.L"), o al final =
    // identificador ("Casa A", "Torre B"): mayúscula.
    if (w.length === 1 && (bajo[offset + 1] === '.' || bajo[offset - 1] === '.' || !/[a-z0-9áéíóúñü]/.test(bajo.slice(offset + 1)))) return w.toUpperCase();
    if (!esPrimera && CONECTORES.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
}

function fechaCorta(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

function Punto({ color }) {
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 999, background: color, flex: '0 0 auto' }} />;
}

function IconoPin({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </svg>
  );
}

function IconoLupa() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

function IconoInfo() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

function FichaPorton({ r }) {
  const calidad = CALIDAD_POR_VALOR[r.calidad_direccion];
  const estado = ESTADOS[r.estado] || { background: '#f1f5f9', color: '#475569' };
  const href = linkSeguro(r.maps_link);
  // "Sistema de portón Clásico" -> "Clásico", y solo si el sistema no lo dice ya.
  const variante = String(r.sistema_variante || '').replace(/^Sistema de port[oó]n\s*/i, '');
  const sistema = [
    lindo(r.sistema),
    variante && !normalizar(r.sistema).includes(normalizar(variante)) ? variante : '',
  ].filter(Boolean).join(' · ');
  const chips = [
    ['Sistema', sistema],
    ['Color sistema', lindo(r.color_sistema)],
    ['Color revest.', lindo(r.color_revestimiento)],
    ['Revestimiento', lindo(r.tipo_revestimiento)],
    ['Orientación', r.orientacion_revestimiento],
    ['Lucera', r.lucera],
    ['Puerta', r.puerta],
  ].filter(([, v]) => tieneDato(v));

  return (
    <article className="pi-card">
      <div>
        <div className="pi-nv">NV {r.nv}</div>
        <div className="pi-fecha">{fechaCorta(r.fecha_nv) || 'Sin fecha'}</div>
        <span className="pi-pill" title={r.estado} style={{ background: estado.background, color: estado.color }}>{estado.corto || r.estado}</span>
      </div>

      <div>
        <div className="pi-label">Cliente final</div>
        <div className="pi-cliente">
          {tieneDato(r.cliente) ? lindo(r.cliente) : <span className="pi-vacio-txt">Sin nombre cargado</span>}
          {r.es_stock && <span className="pi-stock" title="Portón de stock del distribuidor: todavía no tiene cliente final">STOCK</span>}
        </div>
        <div className="pi-canal">
          <Punto color={COLOR_CANAL[r.canal] || COLOR_CANAL['Sin dato']} />
          <span>{NOMBRE_CANAL[r.canal] || r.canal}{r.distribuidor ? ` · ${lindo(r.distribuidor)}` : ''}</span>
        </div>
      </div>

      <div>
        <div className="pi-label">Dirección de instalación</div>
        <div className="pi-dir">{tieneDato(r.direccion) ? lindo(r.direccion) : <span className="pi-vacio-txt">Sin dirección cargada</span>}</div>
        {(href || (calidad && r.calidad_direccion !== 'Sin dirección')) && (
          <div className="pi-dir-acciones">
            {href && (
              <a className="pi-maps" href={href} target="_blank" rel="noopener noreferrer">
                <IconoPin /> {r.maps_url ? 'Abrir mapa' : 'Buscar en Maps'}
              </a>
            )}
            {calidad && r.calidad_direccion !== 'Sin dirección' && (
              <span className="pi-calidad" title={calidad.ayuda}><Punto color={calidad.color} />{calidad.corto}</span>
            )}
          </div>
        )}
      </div>

      <div className="pi-col--porton">
        <div className="pi-label">Portón</div>
        {chips.length > 0 ? (
          <div className="pi-chips">
            {chips.map(([label, valor]) => <span key={label} className="pi-chip"><b>{label}</b>{valor}</span>)}
          </div>
        ) : (
          <div className="pi-vacio-txt" style={{ fontSize: 13 }}>Sin datos del portón</div>
        )}
      </div>
    </article>
  );
}

// 1 … 4 5 6 … 33: primera, última, la actual y sus vecinas.
function paginasVisibles(actual, total) {
  const orden = [...new Set([1, total, actual - 1, actual, actual + 1])]
    .filter((p) => p >= 1 && p <= total)
    .sort((a, b) => a - b);
  const out = [];
  orden.forEach((p, i) => {
    if (i > 0 && p - orden[i - 1] > 1) out.push(`gap-${p}`);
    out.push(p);
  });
  return out;
}

function Paginacion({ actual, total, onIr }) {
  if (total <= 1) return null;
  return (
    <nav className="pi-pag" aria-label="Páginas">
      <button type="button" onClick={() => onIr(actual - 1)} disabled={actual <= 1} aria-label="Página anterior">‹</button>
      {paginasVisibles(actual, total).map((p) => (typeof p === 'string'
        ? <span key={p}>…</span>
        : <button key={p} type="button" className={p === actual ? 'is-on' : ''} onClick={() => onIr(p)} aria-current={p === actual ? 'page' : undefined}>{p}</button>))}
      <button type="button" onClick={() => onIr(actual + 1)} disabled={actual >= total} aria-label="Página siguiente">›</button>
    </nav>
  );
}

// Popup/tooltip del mapa armados con nodos DOM (textContent), no con HTML: los
// nombres y direcciones son texto libre cargado a mano.
function popupPorton(p) {
  const cont = document.createElement('div');
  const titulo = document.createElement('div');
  titulo.style.fontWeight = '800';
  titulo.style.marginBottom = '4px';
  titulo.textContent = `NV ${p.nv} · ${lindo(p.cliente) || 'sin nombre'}`;
  cont.appendChild(titulo);
  const filas = [
    ['Canal', [NOMBRE_CANAL[p.canal] || p.canal, lindo(p.distribuidor)].filter(Boolean).join(' · ')],
    ['Dirección', lindo(p.direccion)],
    ['Sistema', lindo(p.sistema)],
    ['Revestimiento', [lindo(p.tipo_revestimiento), lindo(p.color_revestimiento)].filter(Boolean).join(' · ')],
    ['Estado', p.estado],
  ];
  for (const [label, valor] of filas) {
    if (!tieneDato(valor)) continue;
    const fila = document.createElement('div');
    fila.style.fontSize = '12px';
    const b = document.createElement('b');
    b.textContent = `${label}: `;
    fila.appendChild(b);
    fila.appendChild(document.createTextNode(valor));
    cont.appendChild(fila);
  }
  const href = linkSeguro(p.maps_link);
  if (href) {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'Abrir en Google Maps';
    a.style.display = 'inline-block';
    a.style.marginTop = '6px';
    cont.appendChild(a);
  }
  return cont;
}

function MapaPortones({ puntos }) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const capaRef = useRef(null);

  // Init del mapa (una sola vez).
  useEffect(() => {
    if (!elRef.current || mapRef.current) return undefined;
    const map = L.map(elRef.current).setView(ARGENTINA_CENTER, ARGENTINA_ZOOM);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    capaRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      capaRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const capa = capaRef.current;
    if (!map || !capa) return;
    capa.clearLayers();
    for (const p of puntos) {
      const marker = L.circleMarker([p.lat, p.lng], {
        radius: 7, color: '#fff', weight: 1.5, fillColor: COLOR_CANAL[p.canal] || COLOR_CANAL['Sin dato'], fillOpacity: 0.9,
      });
      const tip = document.createElement('span');
      tip.textContent = `NV ${p.nv} — ${lindo(p.cliente) || 'sin nombre'}`;
      marker.bindTooltip(tip, { direction: 'top' });
      marker.bindPopup(() => popupPorton(p), { minWidth: 220 });
      marker.addTo(capa);
    }
    if (puntos.length > 0) {
      map.fitBounds(L.latLngBounds(puntos.map((p) => [p.lat, p.lng])), { padding: [40, 40], maxZoom: 12 });
    }
  }, [puntos]);

  return <div ref={elRef} style={{ height: '68vh', minHeight: 420, borderRadius: 10 }} />;
}

async function exportarExcel(rows) {
  const xlsxMod = await import('xlsx');
  const XLSX = xlsxMod.default || xlsxMod;

  // Hoja Portones: lo filtrado en pantalla, con el link de Maps clickeable.
  const header = [...COLUMNAS.map((c) => c.label), 'Stock (sin cliente final)', 'Cuenta sistema anterior'];
  const aoa = [header, ...rows.map((r) => [
    ...COLUMNAS.map((c) => {
      if (c.key === 'maps_link') return linkSeguro(r.maps_link) ? (r.maps_url ? 'Abrir mapa' : 'Buscar dirección') : '';
      return r[c.key] ?? '';
    }),
    r.es_stock ? 'Sí' : '',
    r.id_cuenta || '',
  ])];
  const wsP = XLSX.utils.aoa_to_sheet(aoa);
  const colMaps = COLUMNAS.findIndex((c) => c.key === 'maps_link');
  rows.forEach((r, i) => {
    const href = linkSeguro(r.maps_link);
    if (!href) return;
    const ref = XLSX.utils.encode_cell({ r: i + 1, c: colMaps });
    if (wsP[ref]) wsP[ref].l = { Target: href };
  });
  wsP['!cols'] = [...COLUMNAS.map((c) => ({ wch: c.width })), { wch: 10 }, { wch: 12 }];
  wsP['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: header.length - 1 } }) };

  // Hoja Resumen: cobertura de cada dato y calidad de la dirección, por canal.
  const grupos = CANALES.map((c) => rows.filter((r) => r.canal === c));
  const pctTxt = (g, k) => (g.length ? `${pct(g.filter((r) => tieneDato(r[k])).length, g.length)}%` : '-');
  const resumen = [
    ['Portones instalados · Clientes finales'],
    [],
    ['Cobertura de cada dato (% de portones que lo tienen cargado)'],
    ['Dato', ...CANALES, 'Total'],
    ['Cantidad de portones', ...grupos.map((g) => g.length), rows.length],
    ...CAMPOS_COBERTURA.map(([label, k]) => [label, ...grupos.map((g) => pctTxt(g, k)), pctTxt(rows, k)]),
    [],
    ['Calidad de la dirección (cantidad de portones)'],
    ['Calidad', ...CANALES, 'Total'],
    ...CALIDADES.map(({ valor }) => [valor, ...grupos.map((g) => g.filter((r) => r.calidad_direccion === valor).length), rows.filter((r) => r.calidad_direccion === valor).length]),
    [],
    ['Estado', ...CANALES, 'Total'],
    ...valoresUnicos(rows, 'estado').map((e) => [e, ...grupos.map((g) => g.filter((r) => r.estado === e).length), rows.filter((r) => r.estado === e).length]),
  ];
  const wsR = XLSX.utils.aoa_to_sheet(resumen);
  wsR['!cols'] = [{ wch: 50 }, { wch: 12 }, { wch: 13 }, { wch: 10 }, { wch: 8 }];

  const wsL = XLSX.utils.aoa_to_sheet([['Tema', 'Explicación'], ...EXPLICACION]);
  wsL['!cols'] = [{ wch: 24 }, { wch: 150 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsP, 'Portones');
  XLSX.utils.book_append_sheet(wb, wsR, 'Resumen');
  XLSX.utils.book_append_sheet(wb, wsL, 'Léeme');

  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  XLSX.writeFile(wb, `portones_instalados_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.xlsx`);
}

export default function PortonesInstaladosPage() {
  const nav = useNavigate();
  const barraRef = useRef(null);
  const [rows, setRows] = useState([]);
  const [generadoAt, setGeneradoAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [vista, setVista] = useState('lista'); // 'lista' | 'mapa'
  const [exportando, setExportando] = useState(false);

  const [q, setQ] = useState('');
  const [canal, setCanal] = useState('');
  const [estado, setEstado] = useState('');
  const [calidad, setCalidad] = useState('');
  const [sistema, setSistema] = useState('');
  const [ocultarStock, setOcultarStock] = useState(false);
  const [pagina, setPagina] = useState(1);

  const cargar = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const data = await fetchPortonesInstalados();
      setRows(Array.isArray(data?.portones) ? data.portones : []);
      setGeneradoAt(data?.generado_at || null);
    } catch (e) {
      const status = e?.response?.status;
      setErr(status === 403
        ? 'No tenés permiso para ver esta pantalla. Pedile a un administrador que te habilite Preproducción, Servicio Técnico o Programadores.'
        : (e?.response?.data?.error || e?.message || 'Error cargando los portones'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!getAdminToken()) {
      nav('/admin/login', { replace: true });
      return;
    }
    cargar();
  }, [cargar, nav]);

  // Cualquier cambio de filtro vuelve a la primera página.
  const conFiltro = (setter) => (valor) => {
    setter(valor);
    setPagina(1);
  };

  const indexados = useMemo(() => rows.map((r) => ({
    r,
    texto: normalizar([r.nv, r.cliente, r.direccion, r.distribuidor, r.sistema, r.color_sistema, r.color_revestimiento, r.tipo_revestimiento].join(' ')),
  })), [rows]);

  // Todos los filtros menos el canal: así las tarjetas de canal muestran
  // cuántos hay de cada uno y sirven para elegir entre ellos.
  const sinCanal = useMemo(() => {
    const aguja = normalizar(q.trim());
    return indexados
      .filter(({ r, texto }) => (!aguja || texto.includes(aguja))
        && (!estado || r.estado === estado)
        && (!calidad || r.calidad_direccion === calidad)
        && (!sistema || r.sistema === sistema)
        && (!ocultarStock || !r.es_stock))
      .map(({ r }) => r);
  }, [indexados, q, estado, calidad, sistema, ocultarStock]);

  const filtrados = useMemo(() => (canal ? sinCanal.filter((r) => r.canal === canal) : sinCanal), [sinCanal, canal]);
  const porCanal = useMemo(() => contarPor(sinCanal, 'canal'), [sinCanal]);
  const puntos = useMemo(() => filtrados.filter((r) => r.lat != null && r.lng != null), [filtrados]);
  const conLink = useMemo(() => filtrados.filter((r) => r.maps_url).length, [filtrados]);
  const opcionesEstado = useMemo(() => valoresUnicos(rows, 'estado'), [rows]);
  const opcionesSistema = useMemo(() => valoresUnicos(rows, 'sistema'), [rows]);

  const totalPaginas = Math.max(1, Math.ceil(filtrados.length / POR_PAGINA));
  const paginaActual = Math.min(pagina, totalPaginas);
  const desde = (paginaActual - 1) * POR_PAGINA;
  const visibles = filtrados.slice(desde, desde + POR_PAGINA);

  const hayFiltros = q || canal || estado || calidad || sistema || ocultarStock;
  const limpiarFiltros = () => {
    setQ(''); setCanal(''); setEstado(''); setCalidad(''); setSistema(''); setOcultarStock(false); setPagina(1);
  };

  const irAPagina = (p) => {
    setPagina(p);
    barraRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  async function handleExportar() {
    if (!filtrados.length) return;
    setExportando(true);
    try {
      await exportarExcel(filtrados);
    } finally {
      setExportando(false);
    }
  }

  return (
    <div className="pi-wrap">
      <style>{ESTILOS}</style>

      <div className="pi-head">
        <div>
          <h2 className="h1">Portones instalados · Clientes finales</h2>
          <div className="pi-sub">
            Dirección de instalación, NV y tipo de portón de todo lo vendido, en venta directa y por distribuidor.
            {generadoAt && ` Datos al ${new Date(generadoAt).toLocaleString('es-AR')}.`}
          </div>
        </div>
        <div className="pi-actions">
          <div className="pi-seg" role="tablist" aria-label="Vista">
            <button type="button" role="tab" aria-selected={vista === 'lista'} className={vista === 'lista' ? 'is-on' : ''} onClick={() => setVista('lista')}>Lista</button>
            <button type="button" role="tab" aria-selected={vista === 'mapa'} className={vista === 'mapa' ? 'is-on' : ''} onClick={() => setVista('mapa')}>Mapa</button>
          </div>
          <button type="button" className="btn btn--brand" onClick={handleExportar} disabled={exportando || loading || !filtrados.length}>
            {exportando ? 'Generando…' : 'Exportar Excel'}
          </button>
          <button type="button" className="btn" onClick={cargar} disabled={loading}>{loading ? 'Cargando…' : 'Actualizar'}</button>
        </div>
      </div>

      <div className="pi-kpis">
        <div className="pi-kpi">
          <div className="pi-kpi__label">Portones</div>
          <div className="pi-kpi__valor">{fmt(sinCanal.length)}</div>
          <div className="pi-kpi__extra">{sinCanal.length === rows.length ? 'en total' : `de ${fmt(rows.length)} en total`}</div>
        </div>
        {CANALES.map((c) => (
          <button
            key={c}
            type="button"
            className={`pi-kpi pi-kpi--btn${canal === c ? ' is-on' : ''}`}
            onClick={() => conFiltro(setCanal)(canal === c ? '' : c)}
            title={canal === c ? 'Clic para ver todos los canales' : `Clic para ver solo ${NOMBRE_CANAL[c].toLowerCase()}`}
          >
            <div className="pi-kpi__label"><Punto color={COLOR_CANAL[c]} />{NOMBRE_CANAL[c]}</div>
            <div className="pi-kpi__valor">{fmt(porCanal[c] || 0)}</div>
            <div className="pi-kpi__extra">{pct(porCanal[c] || 0, sinCanal.length)}% de los portones</div>
          </button>
        ))}
        <div className="pi-kpi">
          <div className="pi-kpi__label"><IconoPin size={12} />Con link de Maps</div>
          <div className="pi-kpi__valor">{fmt(conLink)}</div>
          <div className="pi-kpi__extra">{pct(conLink, filtrados.length)}% de los mostrados</div>
        </div>
      </div>

      <details className="pi-info">
        <summary><IconoInfo />¿Cómo se arma este listado?</summary>
        <dl>
          {EXPLICACION.map(([tema, texto]) => (
            <div key={tema} style={{ display: 'contents' }}>
              <dt>{tema}</dt>
              <dd>{texto}</dd>
            </div>
          ))}
        </dl>
      </details>

      <div className="pi-filtros">
        <div className="pi-buscar">
          <IconoLupa />
          <input
            type="search"
            className="pi-input"
            value={q}
            onChange={(e) => conFiltro(setQ)(e.target.value)}
            placeholder="Buscar por NV, cliente, dirección, distribuidor o color"
            aria-label="Buscar"
          />
        </div>
        <select className="pi-select" value={canal} onChange={(e) => conFiltro(setCanal)(e.target.value)} aria-label="Canal">
          <option value="">Todos los canales</option>
          {CANALES.map((c) => <option key={c} value={c}>{NOMBRE_CANAL[c]}</option>)}
        </select>
        <select className="pi-select" value={estado} onChange={(e) => conFiltro(setEstado)(e.target.value)} aria-label="Estado">
          <option value="">Todos los estados</option>
          {opcionesEstado.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <select className="pi-select" value={calidad} onChange={(e) => conFiltro(setCalidad)(e.target.value)} aria-label="Calidad de la dirección">
          <option value="">Cualquier dirección</option>
          {CALIDADES.map((c) => <option key={c.valor} value={c.valor}>{c.valor}</option>)}
        </select>
        <select className="pi-select" value={sistema} onChange={(e) => conFiltro(setSistema)(e.target.value)} aria-label="Sistema">
          <option value="">Todos los sistemas</option>
          {opcionesSistema.map((v) => <option key={v} value={v}>{lindo(v)}</option>)}
        </select>
        <label className="pi-check">
          <input type="checkbox" checked={ocultarStock} onChange={(e) => conFiltro(setOcultarStock)(e.target.checked)} />
          Ocultar stock de distribuidores
        </label>
        {hayFiltros && <button type="button" className="pi-limpiar" onClick={limpiarFiltros}>Limpiar filtros</button>}
      </div>

      {err && <div style={{ color: 'crimson', fontWeight: 700 }}>{err}</div>}

      {loading && !rows.length ? (
        <div className="pi-vacio">Cargando portones…</div>
      ) : vista === 'mapa' ? (
        <div className="pi-mapa-card">
          <div className="pi-leyenda">
            {CANALES.map((c) => <span key={c}><Punto color={COLOR_CANAL[c]} />{NOMBRE_CANAL[c]}</span>)}
            <span style={{ marginLeft: 'auto' }}>{fmt(puntos.length)} de {fmt(filtrados.length)} portones con ubicación conocida</span>
          </div>
          <MapaPortones puntos={puntos} />
        </div>
      ) : (
        <>
          <div className="pi-barra" ref={barraRef} style={{ scrollMarginTop: 12 }}>
            <span>
              {filtrados.length
                ? <>Mostrando <b>{fmt(desde + 1)}–{fmt(desde + visibles.length)}</b> de <b>{fmt(filtrados.length)}</b> portones · más nuevas primero</>
                : 'Sin resultados'}
            </span>
            <Paginacion actual={paginaActual} total={totalPaginas} onIr={irAPagina} />
          </div>

          {visibles.length ? (
            <div className="pi-lista">
              {visibles.map((r) => <FichaPorton key={r.nv} r={r} />)}
            </div>
          ) : (
            <div className="pi-vacio">
              No hay portones con estos filtros.
              {hayFiltros && <div style={{ marginTop: 10 }}><button type="button" className="btn" onClick={limpiarFiltros}>Limpiar filtros</button></div>}
            </div>
          )}

          {totalPaginas > 1 && (
            <div className="pi-barra">
              <span>Página {paginaActual} de {totalPaginas}</span>
              <Paginacion actual={paginaActual} total={totalPaginas} onIr={irAPagina} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
