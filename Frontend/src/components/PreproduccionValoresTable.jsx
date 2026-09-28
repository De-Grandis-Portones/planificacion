// src/components/PreproduccionValoresTable.jsx
import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  fetchPreproduccionValores,
  updatePreproduccionValor,
  createPorton,
  fetchPortones,
  setFechaProd,
  setSistemaPorton,
} from '../api';

import LogisticaAuthModal from './modals/LogisticaAuthModal';
import AdminAuthModal from './modals/AdminAuthModal';
import LogisticaConsultasPanel from './LogisticaConsultasPanel';

// ✅ NUEVO: Presets por distribuidor (RazSoc) + reglas por Sistemas
import PreproduccionLogisticaPresets, {
  loadLogisticaPresets,
  resolveLogisticaPresetByDistribuidor,
  buildLogisticaRecommendationsFromPreset,
} from './PreproduccionLogisticaPresets';

import PreproduccionSistemaFechaSalidaRules, {
  loadSistemaFechaSalidaRules,
  resolveRecommendedFechaSalidaISO10,
} from './PreproduccionSistemaFechaSalidaRules';

// Semana ISO (AAAA-Www): compartida con la pantalla de Logística de Viajes,
// para que las dos calculen "semana" exactamente igual (ver src/utils/isoWeek.js).
import {
  isoWeekLabelFromDate,
  weekNumberFromLabel,
  weekTitleFromSelection,
  colorForWeekLabel,
} from '../utils/isoWeek';

import { getCurrentScopes, hasAny } from '../utils/adminScopes';

import {
  BLOCKED_NV_URL,
  parseBlockedNvText,
  getAny,
  getNvCanonicalFromRow,
  getSistemaFromRow,
} from '../utils/preproduccionRow';

// NV bloqueados (no deben aparecer) y helpers de fila: ahora en
// ../utils/preproduccionRow (import de arriba), compartidos con la pantalla
// de Planificación de Fechas.

// =====================
// Constantes
// =====================
const DAYS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sábado', 'domingo'];

// =====================
// Helpers
// =====================
function toStr(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// JWT/Scopes: ahora en ../utils/adminScopes (import de arriba), compartido
// con la pantalla de Logística de Viajes.

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

  // soporte extra: dd-mm-yyyy o d-m-yyyy
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;

  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    const yyyy = d.getUTCFullYear();
    const mm = pad2(d.getUTCMonth() + 1);
    const dd = pad2(d.getUTCDate());
    return `${yyyy}-${mm}-${dd}`;
  }

  return '';
}

function isISODate10(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());
}

function normalizeDate10(v) {
  return toISODate10(v) || '';
}

function formatDMY(date10) {
  const d = toISODate10(date10);
  if (!d) return '';
  const [yyyy, mm, dd] = d.split('-');
  return `${dd}/${mm}/${yyyy}`;
}

// getAny: ahora en ../utils/preproduccionRow (import de arriba).
function getCellValue(row, col) {
  const data = row?.data || {};
  if (col.patchKey) {
    const v = data[col.patchKey];
    if (v != null) return v;
  }
  if (col.sourceKeys?.length) {
    const v1 = getAny(data, col.sourceKeys);
    if (v1 != null) return v1;
    const v2 = getAny(row, col.sourceKeys);
    if (v2 != null) return v2;
  }
  return null;
}

function ciIncludes(haystack, needle) {
  return String(haystack || '').toLowerCase().includes(String(needle || '').toLowerCase());
}

// isoWeekLabelFromDate / weekNumberFromLabel / isoWeekStartEndFromLabel /
// weekTitleFromSelection ahora viven en ../utils/isoWeek (import de arriba),
// compartidas con la pantalla de Logística de Viajes.

function weekLabelFromRow(row, mode) {
  const d = row?.data || {};
  if (mode === 'produccion') return isoWeekLabelFromDate(d.inicio_prod_imput ?? d.Inicio_Prod_Imput ?? '');
  if (mode === 'despacho') return isoWeekLabelFromDate(d.fecha_salida_imput ?? d.Fecha_Salida_Imput ?? '');
  return '';
}

function toMmHeuristic(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return x < 50 ? Math.round(x * 1000) : Math.round(x);
}

function medidasDisplayFromRow(row) {
  const d = row?.data || {};
  const altoRaw = d.Alto ?? d.alto ?? d.Puerta_Alto ?? d.puerta_alto;
  const anchoRaw = d.Ancho ?? d.ancho ?? d.Puerta_Ancho ?? d.puerta_ancho;

  const altoMm = toMmHeuristic(altoRaw);
  const anchoMm = toMmHeuristic(anchoRaw);

  return altoMm != null && anchoMm != null ? `${altoMm}x${anchoMm}` : '';
}

// getNvCanonicalFromRow / getSistemaFromRow: ahora en ../utils/preproduccionRow.

function getNvIntFromRow(row) {
  const nvStr = getNvCanonicalFromRow(row);
  const nv = parseInt(String(nvStr || '').trim(), 10);
  return Number.isFinite(nv) ? nv : null;
}

// nv_tipo: prefijo con el que el Presupuestador nombra la orden en Odoo según
// el catálogo de origen (ver getReferenceFamilyPrefix/extractNvTipo en
// measurementFinalization.js) - "NV" es el portón normal (no lleva badge acá),
// el resto son los otros catálogos que también entran a Preproducción.
const NV_TIPO_LABELS = {
  PNV: 'Puerta',
  INV: 'iPanel',
  ONV: 'Otros',
  PLNV: 'Plegado',
};
function nvTipoLabel(nvTipo) {
  const t = String(nvTipo || 'NV').trim().toUpperCase();
  return NV_TIPO_LABELS[t] || null;
}

// =====================
// Corte para vista ADMIN:
// "no mostrar muy futuro": incluir todo lo pasado y hasta el VIERNES de la semana siguiente
// =====================
function nextWeekFridayCutoffISO10() {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayMon0 = (d.getUTCDay() + 6) % 7; // lunes=0
  const mondayThisWeek = new Date(d);
  mondayThisWeek.setUTCDate(d.getUTCDate() - dayMon0);

  const nextWeekFriday = new Date(mondayThisWeek);
  nextWeekFriday.setUTCDate(mondayThisWeek.getUTCDate() + 11);

  const yyyy = nextWeekFriday.getUTCFullYear();
  const mm = pad2(nextWeekFriday.getUTCMonth() + 1);
  const dd = pad2(nextWeekFriday.getUTCDate());
  return `${yyyy}-${mm}-${dd}`;
}

// =====================
// PDF field defs
// =====================
function getPdfFieldDefs() {
  return [
    { id: 'estado', label: 'ESTADO', type: 'text', patchKey: 'estado_imput' },
    { id: 'fecha_venta', label: 'Fecha Venta', type: 'text', sourceKeys: ['Fecha_NV', 'Fecha_Nv', 'fecha_nv'] },

    { id: 'fecha_medicion', label: 'Fecha Medición', type: 'date', patchKey: 'fecha_medicion_imput', sourceKeys: ['pq_fecha_medicion'] },
    { id: 'inicio_prod', label: 'Inicio Prod', type: 'date', patchKey: 'inicio_prod_imput' },
    { id: 'fecha_probable', label: 'Fecha Probable', type: 'day', patchKey: 'fecha_probable_imput' },
    { id: 'fecha_salida', label: 'Fecha Salida', type: 'date', patchKey: 'fecha_salida_imput' },
    { id: 'fecha_llegada', label: 'Fecha Llegada/Instalación', type: 'date', patchKey: 'fecha_llegada_imput' },

    { id: 'partida', label: 'Partida', type: 'text', sourceKeys: ['PARTIDA', 'Partida', 'partida'] },
    { id: 'nv', label: 'NV', type: 'text', sourceKeys: ['NV', 'nv'] },
    { id: 'nombre', label: 'Nombre', type: 'text', sourceKeys: ['Nombre'] },

    { id: 'distribuidor', label: 'Distribuidor', type: 'text', sourceKeys: ['RazSoc'] },

    { id: 'tipo', label: 'Tipo', type: 'text', patchKey: 'tipo_imput' },
    { id: 'color', label: 'Color', type: 'text', sourceKeys: ['Color', 'Color_Hoja'] },
    { id: 'revestimiento', label: 'Revestimiento', type: 'text', sourceKeys: ['Sistema'] },

    {
      id: 'condicion',
      label: 'Condición',
      type: 'text',
      sourceKeys: ['Tipo_embalaje', 'Tipo_Embalaje', 'tipo_embalaje'],
    },
    { id: 'direccion', label: 'Dirección', type: 'text', sourceKeys: ['Direccion', 'Dirección', 'direccion'] },

    { id: 'medidas', label: 'Medidas', type: 'calc_medidas' },

    { id: 'transporte', label: 'Transporte', type: 'text', patchKey: 'transporte_imput' },
    { id: 'instaladores', label: 'Instaladores', type: 'text', patchKey: 'instaladores_imput' },
    { id: 'observacion', label: 'Observación', type: 'text', patchKey: 'observacion_imput' },
  ];
}

// =====================
// Remito PDF
// =====================
const REMITOS_API = 'https://remitos-c77t.onrender.com/api';

async function openRemitoPdf(row) {
  const d = row?.data || {};
  const nvNum = Number(row?.nv ?? getAny(d, ['NV', 'nv']));
  if (!Number.isInteger(nvNum) || nvNum <= 0) {
    alert('No se encontró el número de NV');
    return;
  }
  try {
    // 1. Buscar remito por NV (con fallback a Supabase para ONV/PLNV/PNV)
    const searchRes = await fetch(`${REMITOS_API}/remitos/search-by-nv?nv=${nvNum}`, { signal: AbortSignal.timeout(30000) });
    if (!searchRes.ok) {
      const body = await searchRes.json().catch(() => ({}));
      throw new Error(body?.error || `Error ${searchRes.status} buscando remito`);
    }
    const searchData = await searchRes.json();
    const item = searchData?.items?.[0];
    if (!item) throw new Error('La NV no tiene remito aún.');

    const { tipo, sucursal, numero } = item;

    // 2. Descargar PDF
    const pdfRes = await fetch(`${REMITOS_API}/remitos/${tipo}/${sucursal}/${numero}/pdf`, { signal: AbortSignal.timeout(30000) });
    if (!pdfRes.ok) {
      const body = await pdfRes.json().catch(() => ({}));
      throw new Error(body?.error || `Error ${pdfRes.status} generando PDF`);
    }
    const blob = await pdfRes.blob();
    const blobUrl = URL.createObjectURL(blob);
    const w = window.open(blobUrl, '_blank');
    if (!w) {
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `remito_NV${nvNum}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  } catch (err) {
    console.error('Error generando remito:', err);
    alert(`Error generando el remito: ${err.message}`);
  }
}

// =====================
// Print
// =====================
function openPdfPrintWindow({ title, rows, cols }) {
  const safeCols = (cols || []).filter((c) => c && c.id && c.label);

  const css = `
    <style>
      * { box-sizing: border-box; }
      body { font-family: Arial, sans-serif; margin: 16px; color: #111; }
      h1 { font-size: 16px; margin: 0 0 10px 0; }
      .muted { color: #666; font-size: 11px; margin-bottom: 10px; }
      table { width: 100%; border-collapse: collapse; margin: 6px 0 10px 0; }
      th, td { border: 1px solid #ddd; padding: 6px; font-size: 11px; vertical-align: top; }
      th { background: #f4f4f4; text-align: left; }
      @media print { body { margin: 10mm; } table { page-break-inside: avoid; } }
    </style>
  `;

  const now = new Date();
  const stamp = `${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;

  const cellForPdf = (r, col) => {
    const d = r?.data || {};

    if (col.type === 'date') {
      const dateVal = col.patchKey === 'fecha_medicion_imput'
        ? (d.fecha_medicion_imput ?? d.pq_fecha_medicion ?? '')
        : (d[col.patchKey] ?? '');
      return formatDMY(toISODate10(dateVal));
    }
    if (col.type === 'calc_medidas') return medidasDisplayFromRow(r);
    if (col.type === 'day') return toStr(d[col.patchKey] ?? '');
    if (col.patchKey) return toStr(d[col.patchKey] ?? '');
    if (col.sourceKeys?.length) return toStr(getAny(d, col.sourceKeys) ?? '');
    return '';
  };

  const thead = safeCols.map((c) => `<th>${toStr(c.label)}</th>`).join('');
  const tbody = (rows || [])
    .map((r) => `<tr>${safeCols.map((c) => `<td>${toStr(cellForPdf(r, c))}</td>`).join('')}</tr>`)
    .join('');

  const html = `
    <html>
      <head>
        <meta charset="utf-8" />
        <title>${toStr(title || 'Preproducción - PDF')}</title>
        ${css}
      </head>
      <body>
        <h1>${toStr(title || 'Preproducción')}</h1>
        <div class="muted">Generado: ${stamp} · Registros: ${(rows || []).length} · Columnas: ${safeCols.length}</div>
        ${
          (rows || []).length
            ? `<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`
            : `<div class="muted">Sin datos para imprimir.</div>`
        }
      </body>
    </html>
  `;

  try {
    const w = window.open('about:blank', '_blank');
    if (w && w.document) {
      w.document.open();
      w.document.write(html);
      w.document.close();
      w.focus();
      setTimeout(() => {
        try {
          w.print();
        } catch {
          tryPrintInIframe(html);
          try {
            w.close();
          } catch {}
        }
      }, 250);
      return;
    }
  } catch {}

  tryPrintInIframe(html);

  function tryPrintInIframe(docHtml) {
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.setAttribute('aria-hidden', 'true');
    document.body.appendChild(iframe);

    const idoc = iframe.contentWindow?.document;
    if (!idoc) {
      alert('No se pudo generar el PDF (bloqueo del navegador).');
      try {
        document.body.removeChild(iframe);
      } catch {}
      return;
    }

    idoc.open();
    idoc.write(docHtml);
    idoc.close();

    setTimeout(() => {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } finally {
        setTimeout(() => {
          try {
            document.body.removeChild(iframe);
          } catch {}
        }, 500);
      }
    }, 250);
  }
}

// =====================
// Column config
// =====================
const BASE_COLS = [
  { id: 'estado', label: 'ESTADO', patchKey: 'estado_imput' },

  { id: 'fecha_venta', label: 'Fecha Venta', type: 'date', sourceKeys: ['Fecha_NV', 'Fecha_Nv', 'fecha_nv'] },

  { id: 'fecha_medicion', label: 'Fecha Medición', type: 'date', patchKey: 'fecha_medicion_imput', sourceKeys: ['pq_fecha_medicion'] },
  { id: 'inicio_prod', label: 'Inicio Prod', type: 'date', patchKey: 'inicio_prod_imput' },
  { id: 'fecha_probable', label: 'Fecha Probable', type: 'day', patchKey: 'fecha_probable_imput' },
  { id: 'fecha_salida', label: 'Fecha Salida', type: 'date', patchKey: 'fecha_salida_imput' },
  { id: 'semana_produccion', label: 'Semana Producción', type: 'week_produccion' },
  { id: 'semana_despacho', label: 'Semana Despacho', type: 'week_despacho' },
  { id: 'fecha_llegada', label: 'Fecha Llegada/Instalación', type: 'date', patchKey: 'fecha_llegada_imput' },

  { id: 'partida', label: 'Partida', sourceKeys: ['PARTIDA', 'Partida', 'partida'] },
  { id: 'nv', label: 'NV', sourceKeys: ['NV', 'nv'] },

  { id: 'nombre', label: 'Nombre', sourceKeys: ['Nombre'] },
  { id: 'contacto', label: 'Contacto', type: 'contacto' },
  { id: 'documentacion', label: 'Documentación', type: 'documentacion' },
  { id: 'distribuidor', label: 'Distribuidor', sourceKeys: ['RazSoc'] },

  { id: 'tipo', label: 'Tipo', patchKey: 'tipo_imput' },

  { id: 'color', label: 'Color', sourceKeys: ['Color', 'Color_Hoja'] },
  { id: 'revestimiento', label: 'Revestimiento', sourceKeys: ['Sistema'] },

  { id: 'condicion', label: 'Condición', sourceKeys: ['Tipo_embalaje', 'Tipo_Embalaje', 'tipo_embalaje'] },
  { id: 'direccion', label: 'Dirección', sourceKeys: ['Direccion', 'Dirección', 'direccion'] },

  { id: 'medidas', label: 'Medidas', type: 'calc_medidas' },

  { id: 'transporte', label: 'Transporte', patchKey: 'transporte_imput' },
  { id: 'instaladores', label: 'Instaladores', patchKey: 'instaladores_imput' },
  { id: 'observacion', label: 'Observación', patchKey: 'observacion_imput' },

  { id: 'auth_admin', label: 'Aut. Admin', type: 'bool', patchKey: 'auth_admin' },
];

const ACTION_COL = { id: 'acciones', label: 'Acciones', type: 'actions' };

function loadVisibleColsFromStorage(allCols) {
  try {
    const raw = localStorage.getItem('pp_visible_cols_v5');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const out = {};
    for (const c of allCols) out[c.id] = parsed[c.id] !== false;
    return out;
  } catch {
    return null;
  }
}

function saveVisibleColsToStorage(map) {
  try {
    localStorage.setItem('pp_visible_cols_v5', JSON.stringify(map));
  } catch {}
}

function loadPdfFieldsFromStorage(fieldDefs) {
  try {
    const raw = localStorage.getItem('pp_pdf_fields_v4');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    const out = {};
    for (const f of fieldDefs) out[f.id] = parsed[f.id] !== false;
    return out;
  } catch {
    return null;
  }
}

function savePdfFieldsToStorage(map) {
  try {
    localStorage.setItem('pp_pdf_fields_v4', JSON.stringify(map));
  } catch {}
}

export default function PreproduccionValoresTable() {
  // ===== Scopes / accessMode =====
  const userScopes = useMemo(() => getCurrentScopes(), []);

  const isFull = useMemo(() => hasAny(userScopes, ['preproduccion:full']), [userScopes]);
  const isAdmin = useMemo(() => !isFull && hasAny(userScopes, ['preproduccion:admin']), [userScopes, isFull]);
  const isLimited = useMemo(
    () => !isFull && !isAdmin && hasAny(userScopes, ['preproduccion:comercial_view']),
    [userScopes, isFull, isAdmin]
  );

  const accessMode = isFull ? 'full' : isAdmin ? 'admin' : isLimited ? 'limited' : 'none';

  // Menú "abrir en WhatsApp Web / Mensajes Logística" al clickear el ícono de
  // WhatsApp de una fila - pedido explícito del usuario. Un solo estado para
  // toda la tabla (no por fila): el teléfono de la fila cuyo menú está
  // abierto, o null si ninguno.
  const [waMenuTelefono, setWaMenuTelefono] = useState(null);
  // Posición en coordenadas de viewport (fixed) del menú, calculada al abrir -
  // el menú se renderiza en un portal a <body> para no quedar recortado por
  // el overflow/scroll horizontal de la tabla (pasaba en la última fila).
  const [waMenuPos, setWaMenuPos] = useState(null);

  // Cerrar el menú si se scrollea (la tabla tiene scroll horizontal propio,
  // y un menú "fixed" quedaría flotando desalineado del ícono si no se cierra).
  useEffect(() => {
    if (!waMenuTelefono) return;
    const cerrar = () => { setWaMenuTelefono(null); setWaMenuPos(null); };
    window.addEventListener('scroll', cerrar, true);
    window.addEventListener('resize', cerrar);
    return () => {
      window.removeEventListener('scroll', cerrar, true);
      window.removeEventListener('resize', cerrar);
    };
  }, [waMenuTelefono]);

  // Limited (comercial_view)
  const LIMITED_COL_IDS = useMemo(
    () => new Set(['fecha_venta', 'nv', 'nombre', 'distribuidor', 'fecha_salida', 'inicio_prod']),
    []
  );
  const LIMITED_LABEL_OVERRIDES = useMemo(
    () => ({
      distribuidor: 'Distribuidor',
      inicio_prod: 'Fecha Producción',
      fecha_salida: 'Fecha salida',
    }),
    []
  );

  // Admin (preproduccion:admin): campos + autorización admin
  const ADMIN_COL_IDS = useMemo(
    () =>
      new Set([
        'fecha_venta',
        'nv',
        'nombre',
        'distribuidor',
        'fecha_salida',
        'semana_despacho',
        'fecha_llegada',
        'auth_admin',
      ]),
    []
  );
  const ADMIN_LABEL_OVERRIDES = useMemo(
    () => ({
      distribuidor: 'Distribuidor',
      fecha_salida: 'Fecha salida',
      semana_despacho: 'Semana despacho',
      auth_admin: 'Aut. Admin',
    }),
    []
  );

  const ALL_COLS = useMemo(() => {
    if (accessMode === 'limited') {
      return BASE_COLS.filter((c) => LIMITED_COL_IDS.has(c.id)).map((c) =>
        LIMITED_LABEL_OVERRIDES[c.id] ? { ...c, label: LIMITED_LABEL_OVERRIDES[c.id] } : c
      );
    }
    if (accessMode === 'admin') {
      return BASE_COLS.filter((c) => ADMIN_COL_IDS.has(c.id)).map((c) =>
        ADMIN_LABEL_OVERRIDES[c.id] ? { ...c, label: ADMIN_LABEL_OVERRIDES[c.id] } : c
      );
    }
    return [...BASE_COLS, ACTION_COL];
  }, [accessMode, LIMITED_COL_IDS, LIMITED_LABEL_OVERRIDES, ADMIN_COL_IDS, ADMIN_LABEL_OVERRIDES]);

  const PDF_DEFS = useMemo(() => getPdfFieldDefs(), []);

  // Sin permisos
  if (accessMode === 'none') {
    return (
      <div style={{ padding: 16 }}>
        <div style={{ background: '#fff5f5', border: '1px solid #fecaca', padding: 12, borderRadius: 12 }}>
          No tenés permisos para ver Preproducción. Pedí que te asignen: <b>preproduccion:full</b>,{' '}
          <b>preproduccion:admin</b> o <b>preproduccion:comercial_view</b>.
        </div>
      </div>
    );
  }

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(() => new Set());

  // ✅ NUEVO: Draft local SOLO para inicio_prod_imput (Fecha Producción), por row.id
  const [draftInicioProdById, setDraftInicioProdById] = useState(() => ({}));

  const setDraftInicioProd = useCallback((rowId, value) => {
    setDraftInicioProdById((p) => ({ ...p, [rowId]: value }));
  }, []);

  const clearDraftInicioProd = useCallback((rowId) => {
    setDraftInicioProdById((p) => {
      const n = { ...p };
      delete n[rowId];
      return n;
    });
  }, []);

  const getInicioProdEffective = useCallback(
    (row) => {
      const id = row?.id;
      const d = row?.data || {};
      const serverVal = normalizeDate10(d.inicio_prod_imput ?? d.Inicio_Prod_Imput ?? '');

      if (!id) return serverVal;

      const draft = draftInicioProdById[id];

      // si el draft existe (aunque sea vacío), manda el draft
      if (draft != null) {
        const s = String(draft);
        return s.trim() === '' ? '' : normalizeDate10(s);
      }

      return serverVal;
    },
    [draftInicioProdById]
  );

  // ====== NV bloqueados (desde TXT) ======
  const [blockedNvSet, setBlockedNvSet] = useState(() => new Set());
  const [blockedNvState, setBlockedNvState] = useState('idle'); // idle|loading|ok|error

  useEffect(() => {
    let cancelled = false;

    async function loadBlocked() {
      setBlockedNvState('loading');
      try {
        const resp = await fetch(BLOCKED_NV_URL, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const txt = await resp.text();
        const set = parseBlockedNvText(txt);

        if (!cancelled) {
          setBlockedNvSet(set);
          setBlockedNvState('ok');
        }
      } catch {
        if (!cancelled) {
          setBlockedNvSet(new Set());
          setBlockedNvState('error');
        }
      }
    }

    loadBlocked();
    return () => {
      cancelled = true;
    };
  }, []);

  // ====== Estado basado en PORTONES (solo full) ======
  const [portonesNvSet, setPortonesNvSet] = useState(() => new Set());
  const [portonesNvToId, setPortonesNvToId] = useState(() => new Map());
  const [portonesNvToDespacho, setPortonesNvToDespacho] = useState(() => new Map());
  const [portonesIndexState, setPortonesIndexState] = useState('idle'); // idle|loading|ok|error

  // Switch "ocultar ya despachados": por defecto oculta los portones con la
  // etapa Despacho Finalizado (ya salieron), tal como el análogo del reporte
  // semanal en Información Excel.
  const [mostrarDespachados, setMostrarDespachados] = useState(false);

  // Filtros:
  const [filters, setFilters] = useState(() => {
    const o = {};
    for (const c of ALL_COLS) {
      if (c.type === 'date') o[c.id] = { from: '', to: '', has: false, empty: false };
      else o[c.id] = '';
    }
    return o;
  });

  // Columnas visibles:
  const [showColsPanel, setShowColsPanel] = useState(false);
  const colsPanelRef = useRef(null);

  const [visibleCols, setVisibleCols] = useState(() => {
    const initial = {};
    for (const c of ALL_COLS) initial[c.id] = true;

    if (accessMode !== 'full') return initial;

    const stored = loadVisibleColsFromStorage(ALL_COLS);
    if (stored) return stored;

    return initial;
  });

  useEffect(() => {
    if (accessMode !== 'full') return;
    saveVisibleColsToStorage(visibleCols);
  }, [visibleCols, accessMode]);

  // Panel PDF (solo full)
  const [showPdfPanel, setShowPdfPanel] = useState(false);
  const pdfPanelRef = useRef(null);
  const [pdfMode, setPdfMode] = useState('produccion');
  const [pdfWeek, setPdfWeek] = useState('');

  const [pdfFields, setPdfFields] = useState(() => {
    const stored = loadPdfFieldsFromStorage(PDF_DEFS);
    if (stored) return stored;
    const init = {};
    for (const f of PDF_DEFS) init[f.id] = true;
    return init;
  });
  useEffect(() => {
    if (accessMode !== 'full') return;
    savePdfFieldsToStorage(pdfFields);
  }, [pdfFields, PDF_DEFS, accessMode]);

  // ✅ panel presets logística + reglas sistema->fecha salida (solo full)
  const [showLogisticaPresets, setShowLogisticaPresets] = useState(false);
  const [showSistemaRules, setShowSistemaRules] = useState(false);

  // Consultas de Logística a Técnica/Comercial (ver LogisticaConsultasPanel.jsx)
  const [showConsultas, setShowConsultas] = useState(false);

  const [logisticaPresets, setLogisticaPresets] = useState(() => loadLogisticaPresets());
  const [sistemaRules, setSistemaRules] = useState(() => loadSistemaFechaSalidaRules());

  const closeLogisticaPresets = () => {
    setShowLogisticaPresets(false);
    setLogisticaPresets(loadLogisticaPresets());
  };
  const closeSistemaRules = () => {
    setShowSistemaRules(false);
    setSistemaRules(loadSistemaFechaSalidaRules());
  };

  // ===== Modales =====
  const [adminModalOpen, setAdminModalOpen] = useState(false);
  const [adminModalRow, setAdminModalRow] = useState(null);
  const [adminModalBusy, setAdminModalBusy] = useState(false);

  const openAdminModal = (row) => {
    const d = row?.data || {};
    if (Boolean(d.auth_admin)) return;
    setAdminModalRow(row);
    setAdminModalOpen(true);
  };
  const closeAdminModal = () => {
    if (adminModalBusy) return;
    setAdminModalOpen(false);
    setAdminModalRow(null);
  };

  // Logística: solo full
  const [logModalOpen, setLogModalOpen] = useState(false);
  const [logModalRow, setLogModalRow] = useState(null);
  const [logModalBusy, setLogModalBusy] = useState(false);

  const openLogModal = (row) => {
    setLogModalRow(row);
    setLogModalOpen(true);
  };
  const closeLogModal = () => {
    if (logModalBusy) return;
    setLogModalOpen(false);
    setLogModalRow(null);
  };

  // Paginado
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);

  useEffect(() => {
    const onDocClick = (e) => {
      if (showColsPanel) {
        const el = colsPanelRef.current;
        if (el && !el.contains(e.target)) setShowColsPanel(false);
      }
      if (showPdfPanel) {
        const el = pdfPanelRef.current;
        if (el && !el.contains(e.target)) setShowPdfPanel(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [showColsPanel, showPdfPanel]);

  const visibleColsList = useMemo(() => ALL_COLS.filter((c) => visibleCols[c.id] !== false), [ALL_COLS, visibleCols]);

  const refreshPortonesNvIndex = useCallback(async () => {
    setPortonesIndexState('loading');
    try {
      const rr = await fetchPortones();
      const list = Array.isArray(rr?.data) ? rr.data : rr?.data ? [rr.data] : [];

      const set = new Set();
      const map = new Map();
      // Un NV puede tener varios portones (varias partidas/hojas). Solo lo
      // consideramos "ya despachado" si TODOS los portones de ese NV tienen
      // la etapa Despacho en Finalizado - si queda alguno pendiente, el NV
      // sigue siendo relevante y no se oculta.
      const despachoAllFinalizedByNv = new Map();
      for (const it of list) {
        const nv = parseInt(String(it?.nv ?? it?.NV ?? it?.nlista ?? it?.NLista ?? '').trim(), 10);
        if (Number.isFinite(nv)) {
          set.add(nv);
          const id = it?.id ?? it?.ID ?? null;
          if (id != null) map.set(nv, id);
          const despacho = String(it?.despacho ?? it?.Despacho ?? '').trim().toLowerCase();
          const finalizado = despacho === 'finalizado';
          const prev = despachoAllFinalizedByNv.has(nv) ? despachoAllFinalizedByNv.get(nv) : true;
          despachoAllFinalizedByNv.set(nv, prev && finalizado);
        }
      }
      setPortonesNvSet(set);
      setPortonesNvToId(map);
      setPortonesNvToDespacho(despachoAllFinalizedByNv);
      setPortonesIndexState('ok');
    } catch {
      setPortonesNvSet(new Set());
      setPortonesNvToId(new Map());
      setPortonesNvToDespacho(new Map());
      setPortonesIndexState('error');
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const res = await fetchPreproduccionValores();
      const list = Array.isArray(res?.data) ? res.data : res?.data ? [res.data] : [];
      setRows(list);

      // ✅ NUEVO: al recargar, limpiamos borradores locales
      setDraftInicioProdById({});
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || 'Error cargando preproducción');
    } finally {
      setLoading(false);
    }

    // El índice de portones (para "Enviado" y para el switch de despacho) se
    // usa en cualquier modo con acceso a la página, no solo full.
    if (accessMode !== 'none') {
      await refreshPortonesNvIndex();
    }
  }, [refreshPortonesNvIndex, accessMode]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * onPatch con options:
   * - options.skipPortonesSync: evita que el patch de inicio_prod_imput dispare la sync automática a PORTONES.
   *   Esto es clave para que sendToProduccion controle el orden y haga la sync exactamente una vez.
   */
  const onPatch = useCallback(
    async (id, patch, options = {}) => {
      if (!id) return;
      setSaving((prev) => new Set(prev).add(id));
      try {
        const res = await updatePreproduccionValor(id, patch);
        const updated = res?.data;
        setRows((prev) => prev.map((r) => (r.id === id ? updated : r)));

        // Sync automática a PORTONES cuando se planifica producción (inicio_prod_imput),
        // a menos que se pida explícitamente skipPortonesSync.
        try {
          const skipPortonesSync = Boolean(options?.skipPortonesSync);

          if (
            accessMode === 'full' &&
            !skipPortonesSync &&
            patch &&
            Object.prototype.hasOwnProperty.call(patch, 'inicio_prod_imput')
          ) {
            const rawFecha = patch?.inicio_prod_imput;
            const fecha10 = toISODate10(rawFecha);

            const d = updated?.data && typeof updated.data === 'object' ? updated.data : {};
            const nv = Number(d?.NV ?? d?.nv ?? updated?.nv ?? updated?.NV);

            if (Number.isInteger(nv)) {
              const existingId = portonesNvToId?.get(nv) ?? null;

              // Sistema es clave para las condiciones de workflow (porta los mismos strings
              // que se usan en condition_json). Lo mantenemos sincronizado.
              const sistemaStr = getSistemaFromRow(updated) ?? getSistemaFromRow({ data: d }) ?? null;

              if (existingId != null) {
                await setFechaProd(existingId, fecha10 || null);
                if (sistemaStr) {
                  try {
                    await setSistemaPorton(existingId, sistemaStr);
                  } catch {}
                }
              } else {
                const partida = Number(d?.PARTIDA ?? d?.partida);
                const payload = {
                  nv,
                  nlista: Number(d?.NLista ?? d?.nlista) || nv,
                  partida: Number.isInteger(partida) ? partida : 800,
                  fecha_prod: fecha10 || null,
                  sistema: sistemaStr,
                  nv_tipo: updated?.nv_tipo || 'NV',
                };

                const cr = await createPorton(payload);
                const created = cr?.data || null;
                const createdId = created?.id ?? created?.ID ?? null;

                if (createdId != null && sistemaStr) {
                  // Doble seguro: si por algún motivo el insert no tomó el sistema
                  // (o vino null), lo fijamos por endpoint.
                  try {
                    await setSistemaPorton(createdId, sistemaStr);
                  } catch {}
                }

                setPortonesNvSet((prev) => {
                  const n = new Set(prev);
                  n.add(nv);
                  return n;
                });
                if (createdId != null) {
                  setPortonesNvToId((prev) => {
                    const m = new Map(prev);
                    m.set(nv, createdId);
                    return m;
                  });
                }
              }
            }
          }
        } catch (e) {
          console.warn('No se pudo sincronizar fecha_prod en PORTONES:', e?.message || e);
        }

        return updated;
      } catch (e) {
        const msg = e?.response?.data?.error || e?.message || 'Error guardando';
        alert(msg);
        throw e;
      } finally {
        setSaving((prev) => {
          const n = new Set(prev);
          n.delete(id);
          return n;
        });
      }
    },
    [accessMode, portonesNvToId]
  );

  const submitAdminAuth = useCallback(
    async (patch) => {
      const id = adminModalRow?.id;
      if (!id) return;
      setAdminModalBusy(true);
      try {
        await onPatch(id, patch);
        closeAdminModal();
      } finally {
        setAdminModalBusy(false);
      }
    },
    [adminModalRow, onPatch]
  );

  const submitLogisticaAuth = useCallback(
    async (patch) => {
      const id = logModalRow?.id;
      if (!id) return;
      setLogModalBusy(true);
      try {
        await onPatch(id, patch);
        closeLogModal();
      } finally {
        setLogModalBusy(false);
      }
    },
    [logModalRow, onPatch]
  );

  // ====== EXCLUSIÓN GLOBAL por NV ======
  const rowsAfterNvExclusion = useMemo(() => {
    return (rows || []).filter((r) => {
      const nv = getNvCanonicalFromRow(r);
      return nv ? !blockedNvSet.has(nv) : true;
    });
  }, [rows, blockedNvSet]);

  // ====== Ocultar ya despachados (switch, ver mostrarDespachados) ======
  const rowsAfterDespachoFilter = useMemo(() => {
    if (mostrarDespachados) return rowsAfterNvExclusion;
    return (rowsAfterNvExclusion || []).filter((row) => {
      const nv = getNvIntFromRow(row);
      if (nv == null) return true;
      return portonesNvToDespacho.get(nv) !== true;
    });
  }, [rowsAfterNvExclusion, mostrarDespachados, portonesNvToDespacho]);

  // ====== Corte ADMIN por fecha salida (<= viernes semana siguiente) ======
  const rowsAfterAccessWindow = useMemo(() => {
    if (accessMode !== 'admin') return rowsAfterDespachoFilter;

    const cutoff = nextWeekFridayCutoffISO10();
    const colFechaSalida = ALL_COLS.find((c) => c.id === 'fecha_salida');

    return (rowsAfterDespachoFilter || []).filter((row) => {
      const raw = colFechaSalida
        ? getCellValue(row, colFechaSalida)
        : row?.data?.fecha_salida_imput ?? row?.data?.Fecha_Salida_Imput;
      const date10 = toISODate10(raw);
      if (!isISODate10(date10)) return false;
      return date10 <= cutoff;
    });
  }, [rowsAfterDespachoFilter, accessMode, ALL_COLS]);

  // ✅ lista de distribuidores (RazSoc)
  const distributorsList = useMemo(() => {
    const map = new Map();
    const base = rowsAfterAccessWindow || [];
    for (const r of base) {
      const d = r?.data || {};
      const rs = String(d.RazSoc ?? d.razsoc ?? '').trim();
      if (!rs) continue;
      const k = rs.toLowerCase();
      if (!map.has(k)) map.set(k, rs);
    }
    return Array.from(map.values()).sort((a, b) => a.localeCompare(b));
  }, [rowsAfterAccessWindow]);

  // ✅ recomendaciones por distribuidor para el modal logística
  const logisticaRecommendations = useMemo(() => {
    if (!logModalRow) return null;
    const d = logModalRow?.data || {};
    const razSoc = d.RazSoc ?? d.razsoc ?? '';
    const preset = resolveLogisticaPresetByDistribuidor(razSoc, logisticaPresets);
    return buildLogisticaRecommendationsFromPreset(preset);
  }, [logModalRow, logisticaPresets]);

  // ====== Estado acciones (solo full) ======
  // - "Enviado" depende de fecha_envio_produccion
  // - "Pendiente" si falta Fecha Producción
  // - "Listo" cuando ya tiene Fecha Producción
  const getAccionesStatus = useCallback((row) => {
    const d = row?.data || {};

    const alreadySent = Boolean(
      d.fecha_envio_produccion ?? d.Fecha_Envio_Produccion ?? d.fecha_envio_prod ?? d.Fecha_Envio_Prod
    );
    const prodDate10 = getInicioProdEffective(row);

    if (alreadySent) return 'produccion';
    if (!prodDate10) return 'pendiente';
    return 'listo';
  }, [getInicioProdEffective]);

  // =====================
  // Date filter: intervalo + con fecha + sin fecha
  // =====================
  function matchDateFilter(cellDateLike, filterObj) {
    const cell = normalizeDate10(cellDateLike);

    const from = normalizeDate10(filterObj?.from);
    const to = normalizeDate10(filterObj?.to);
    const wantHas = Boolean(filterObj?.has);
    const wantEmpty = Boolean(filterObj?.empty);

    const hasRange = Boolean(from || to);
    const hasDate = Boolean(cell);

    if (!hasRange && !wantHas && !wantEmpty) return true;

    let inRange = false;
    if (hasRange) {
      if (hasDate) {
        inRange = true;
        if (from && cell < from) inRange = false;
        if (to && cell > to) inRange = false;
      }
    }

    let ok = false;
    if (hasRange) ok = ok || inRange;
    if (wantEmpty) ok = ok || !hasDate;
    if (wantHas && !hasRange) ok = ok || hasDate;

    return ok;
  }

  const filteredRows = useMemo(() => {
    const active = Object.entries(filters).filter(([colId, v]) => {
      if (visibleCols[colId] === false) return false;
      const col = ALL_COLS.find((c) => c.id === colId);
      if (!col) return false;

      if (col.type === 'date') {
        const obj = v && typeof v === 'object' ? v : { from: '', to: '', has: false, empty: false };
        return (
          String(obj.from || '').trim() !== '' ||
          String(obj.to || '').trim() !== '' ||
          Boolean(obj.has) ||
          Boolean(obj.empty)
        );
      }
      return String(v || '').trim() !== '';
    });

    const base = rowsAfterAccessWindow;
    if (!active.length) return base;

    return base.filter((row) => {
      return active.every(([colId, fval]) => {
        const col = ALL_COLS.find((c) => c.id === colId);
        if (!col) return true;

        if (col.type === 'contacto') return true;

        if (col.type === 'actions') {
          const needle = String(fval || '').toLowerCase().trim();
          if (!needle) return true;
          const st = getAccionesStatus(row);
          if (needle === 'pendiente') return st === 'pendiente';
          if (needle === 'listo') return st === 'listo';
          if (needle === 'produccion') return st === 'produccion';
          return true;
        }

        if (col.type === 'calc_medidas') return ciIncludes(medidasDisplayFromRow(row), fval);

        if (col.type === 'week_produccion') {
          const w = weekNumberFromLabel(weekLabelFromRow(row, 'produccion'));
          return ciIncludes(w, fval);
        }
        if (col.type === 'week_despacho') {
          const w = weekNumberFromLabel(weekLabelFromRow(row, 'despacho'));
          return ciIncludes(w, fval);
        }

        const raw = getCellValue(row, col);

        if (col.type === 'date') {
          const obj = fval && typeof fval === 'object' ? fval : { from: '', to: '', has: false, empty: false };
          return matchDateFilter(raw, obj);
        }

        if (col.type === 'bool') {
          const b = Boolean(raw);
          const needle = String(fval).toLowerCase().trim();
          if (!needle) return true;

          if (needle === 'autorizado') return b === true;
          if (needle === 'autorizar') return b === false;

          if (['si', 'sí', 'true', '1'].includes(needle)) return b === true;
          if (['no', 'false', '0'].includes(needle)) return b === false;

          return true;
        }

        return ciIncludes(toStr(raw), fval);
      });
    });
  }, [rowsAfterAccessWindow, filters, ALL_COLS, visibleCols, getAccionesStatus]);

  useEffect(() => setPage(1), [filters, pageSize]);

  const total = filteredRows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount);
  const startIdx = (safePage - 1) * pageSize;
  const endIdx = Math.min(total, startIdx + pageSize);
  const pagedRows = useMemo(() => filteredRows.slice(startIdx, endIdx), [filteredRows, startIdx, endIdx]);

  // ===== Reset SOLO autorizaciones (FULL) =====
  const resetAutorizaciones = useCallback(
    async (row) => {
      if (accessMode !== 'full') return;

      const id = row?.id;
      if (!id) return;

      const ok = window.confirm('Esto va a quitar la autorización de Admin y reiniciar la Fecha Producción / envío a producción para este NV.\n\n¿Continuar?');
      if (!ok) return;

      // ✅ NUEVO: si había borrador local de fecha prod, lo limpiamos
      clearDraftInicioProd(id);

      await onPatch(id, {
        auth_admin: false,
        auth_logistica: false,
        auth_admin_at: null,
        auth_logistica_at: null,
        // Reinicia la fecha de producción y libera el envío a producción.
        inicio_prod_imput: null,
        fecha_envio_produccion: null,
      });
    },
    [accessMode, onPatch, clearDraftInicioProd]
  );

  // ✅ CORREGIDO:
  // - Permite enviar aunque el NV ya exista en PORTONES (no es "enviado" automáticamente)
  // - Requiere Fecha Producción
  // - Persiste:
  //   1) preproduccion_valores.inicio_prod_imput
  //   2) portones.fecha_prod (update si existe / create si no existe)
  //   3) marca fecha_envio_produccion (flag)
  const sendToProduccion = useCallback(
    async (row) => {
      if (accessMode !== 'full') return;

      const id = row?.id;
      if (!id) return;

      const d = row?.data || {};

      // La habilitación depende solo de que exista Fecha Producción.

      const nv = getNvIntFromRow(row);
      if (nv == null) {
        alert('No se pudo enviar: NV inválido.');
        return;
      }

      const sistemaStr = getSistemaFromRow(row);

      const dateOrNull = (v) => {
        const x = normalizeDate10(v);
        return x ? x : null;
      };

      // ✅ NUEVO: si hay borrador local, lo usamos; si no, caemos al server value
      const draftProd = draftInicioProdById[id];
      const prodDate10 = dateOrNull(draftProd != null ? draftProd : d.inicio_prod_imput ?? d.Inicio_Prod_Imput ?? null);

      // ✅ OPCIÓN 3: bloquear envío si falta fecha producción
      if (!prodDate10) {
        alert('No se puede enviar: falta Fecha Producción (inicio_prod_imput).');
        return;
      }

      try {
        // 1) Persistir en preproducción (sin sync automática a portones, porque la controlamos abajo)
        await onPatch(id, { inicio_prod_imput: prodDate10 }, { skipPortonesSync: true });

        // ✅ NUEVO: ya se persistió, borrador deja de tener sentido
        clearDraftInicioProd(id);

        // 2) Persistir en PORTONES.fecha_prod
        const existingId = portonesNvToId?.get(nv) ?? null;

        if (existingId != null) {
          await setFechaProd(existingId, prodDate10);
          if (sistemaStr) {
            try {
              await setSistemaPorton(existingId, sistemaStr);
            } catch {}
          }
        } else {
          const payload = {
            nv,
            nlista: nv,
            partida: 800,
            fecha_plan: dateOrNull(d.fecha_salida_imput ?? d.Fecha_Salida_Imput ?? null),
            fecha_prod: prodDate10,
            fecha_nv: dateOrNull(getAny(d, ['Fecha_NV', 'fecha_nv', 'Fecha_Venta', 'fecha_venta'])),
            fecha_med: dateOrNull(d.fecha_medicion_imput ?? d.Fecha_Medicion_Imput ?? null),
            sistema: sistemaStr,
            nv_tipo: row?.nv_tipo || 'NV',
          };

          const cr = await createPorton(payload);
          const created = cr?.data || null;
          const createdId = created?.id ?? created?.ID ?? null;

          if (createdId != null && sistemaStr) {
            try {
              await setSistemaPorton(createdId, sistemaStr);
            } catch {}
          }

          setPortonesNvSet((prev) => {
            const next = new Set(prev);
            next.add(nv);
            return next;
          });

          if (createdId != null) {
            setPortonesNvToId((prev) => {
              const m = new Map(prev);
              m.set(nv, createdId);
              return m;
            });
          }
        }

        // 3) Marcar como enviado (flag)
        await onPatch(id, { fecha_envio_produccion: new Date().toISOString() });
      } catch (e) {
        const status = e?.response?.status;
        const msg = e?.response?.data?.error || e?.message || 'Error enviando a producción';

        const isDuplicate =
          status === 409 ||
          String(msg).toLowerCase().includes('duplicate') ||
          String(msg).toLowerCase().includes('unique') ||
          String(msg).toLowerCase().includes('portones_nv_nlista_uniq');

        // Si fue duplicado al crear, igual podés seguir marcando enviado.
        if (isDuplicate) {
          setPortonesNvSet((prev) => {
            const next = new Set(prev);
            next.add(nv);
            return next;
          });
          // Intento marcar enviado igual (sin bloquear)
          try {
            await onPatch(id, { fecha_envio_produccion: new Date().toISOString() });
          } catch {}
          return;
        }

        alert(msg);
      }
    },
    [onPatch, portonesNvToId, accessMode, draftInicioProdById, clearDraftInicioProd]
  );

  // ======= PDF helpers =======
  const pdfWeeksList = useMemo(() => {
    const set = new Set();
    for (const r of filteredRows) {
      const lab = weekLabelFromRow(r, pdfMode);
      if (lab) set.add(lab);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [filteredRows, pdfMode]);

  const pdfSelectedRows = useMemo(() => {
    return filteredRows.filter((r) => (!pdfWeek ? true : weekLabelFromRow(r, pdfMode) === pdfWeek));
  }, [filteredRows, pdfMode, pdfWeek]);

  const printPdf = useCallback(() => {
    const colsOrdered = PDF_DEFS.filter((f) => pdfFields[f.id] !== false);

    if (pdfSelectedRows.length === 0) {
      alert('No hay registros para esa semana. Revisá formato de fechas o filtros.');
      return;
    }
    if (colsOrdered.length === 0) {
      alert('Seleccioná al menos un campo para imprimir.');
      return;
    }

    const title = pdfWeek ? weekTitleFromSelection(pdfWeek) : `Preproducción - Semanas (${pdfMode})`;
    openPdfPrintWindow({ title, rows: pdfSelectedRows, cols: colsOrdered });
  }, [PDF_DEFS, pdfFields, pdfSelectedRows, pdfWeek, pdfMode]);

  const toggleAllCols = (nextVisible) => {
    const map = {};
    for (const c of ALL_COLS) map[c.id] = nextVisible;
    setVisibleCols(map);
  };

  const toggleAllPdfFields = (nextVisible) => {
    const map = {};
    for (const f of PDF_DEFS) map[f.id] = nextVisible;
    setPdfFields(map);
  };

  // ============================================================
  // ✅ Scrollbar horizontal SIEMPRE visible (espejo sticky)
  // ============================================================
  const tableWrapRef = useRef(null);
  const xscrollRef = useRef(null);
  const xscrollSpacerRef = useRef(null);

  useEffect(() => {
    const tw = tableWrapRef.current;
    const xs = xscrollRef.current;
    const sp = xscrollSpacerRef.current;
    if (!tw || !xs || !sp) return;

    let raf = 0;

    const syncSpacer = () => {
      const w = tw.scrollWidth;
      sp.style.width = `${w}px`;
      xs.scrollLeft = tw.scrollLeft;
    };

    const onTwScroll = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        xs.scrollLeft = tw.scrollLeft;
      });
    };

    const onXsScroll = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        tw.scrollLeft = xs.scrollLeft;
      });
    };

    tw.addEventListener('scroll', onTwScroll, { passive: true });
    xs.addEventListener('scroll', onXsScroll, { passive: true });

    let ro = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(() => syncSpacer());
      ro.observe(tw);
      const t = tw.querySelector('table');
      if (t) ro.observe(t);
    }

    window.addEventListener('resize', syncSpacer);

    syncSpacer();

    return () => {
      tw.removeEventListener('scroll', onTwScroll);
      xs.removeEventListener('scroll', onXsScroll);
      window.removeEventListener('resize', syncSpacer);
      if (ro) ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [visibleColsList.length, pagedRows.length, total]);

  const renderDateFilter = (colId) => {
    const curr =
      filters[colId] && typeof filters[colId] === 'object'
        ? filters[colId]
        : { from: '', to: '', has: false, empty: false };

    const from = curr.from || '';
    const to = curr.to || '';
    const has = Boolean(curr.has);
    const empty = Boolean(curr.empty);

    const setObj = (next) => setFilters((p) => ({ ...p, [colId]: { ...curr, ...next } }));

    return (
      <div className="pp-dateFilterBox">
        <div className="pp-dateRow">
          <div>
            <div className="pp-dateLabel">Desde</div>
            <input type="date" value={from} onChange={(e) => setObj({ from: e.target.value })} className="pp-input" />
          </div>
          <div>
            <div className="pp-dateLabel">Hasta</div>
            <input type="date" value={to} onChange={(e) => setObj({ to: e.target.value })} className="pp-input" />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 6 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={has} onChange={(e) => setObj({ has: e.target.checked })} />
            <span style={{ fontSize: 12 }}>Con fecha</span>
          </label>

          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={empty} onChange={(e) => setObj({ empty: e.target.checked })} />
            <span style={{ fontSize: 12 }}>Sin fecha</span>
          </label>
        </div>

        <button
          type="button"
          className="btn"
          style={{ marginTop: 8 }}
          onClick={() => setFilters((p) => ({ ...p, [colId]: { from: '', to: '', has: false, empty: false } }))}
        >
          Limpiar
        </button>
      </div>
    );
  };

  const renderCell = (row, col) => {
    const data = row?.data || {};
    const id = row.id;
    const isBusy = saving.has(id);

    // ===== NV: si no es un portón normal, mostrar de dónde viene (Puerta/
    // iPanel/Otros/Plegado) al lado del número - antes de cualquier rama de
    // accessMode, para que se vea igual en los 3 modos =====
    if (col.id === 'nv') {
      const raw = getCellValue(row, col);
      const origen = nvTipoLabel(row?.nv_tipo);
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span>{toStr(raw)}</span>
          {origen ? <span className="pp-badge pp-badge--muted">{origen}</span> : null}
        </span>
      );
    }

    // ===== limited: SOLO LECTURA =====
    if (accessMode === 'limited') {
      const raw = getCellValue(row, col);
      if (col.id === 'fecha_venta') return <span>{formatDMY(toISODate10(raw))}</span>;
      if (col.type === 'date') return <span>{formatDMY(toISODate10(raw))}</span>;
      return <span>{toStr(raw)}</span>;
    }

    // ===== admin: lectura + SOLO autoriza administración =====
    if (accessMode === 'admin') {
      if (col.type === 'bool' && col.patchKey === 'auth_admin') {
        const ok = Boolean(data.auth_admin);
        if (ok) return <span className="pp-badge pp-badge--ok">Autorizado</span>;
        return (
          <button
            type="button"
            className="pp-btnCell pp-btnCell--brand"
            onClick={() => openAdminModal(row)}
            disabled={isBusy}
            title="Autorizar administración"
          >
            Autorizar
          </button>
        );
      }

      if (col.type === 'week_despacho') {
        return <span>{weekNumberFromLabel(weekLabelFromRow(row, 'despacho'))}</span>;
      }

      const raw = getCellValue(row, col);
      if (col.id === 'fecha_venta') return <span>{formatDMY(toISODate10(raw))}</span>;
      if (col.type === 'date') return <span>{formatDMY(toISODate10(raw))}</span>;
      return <span>{toStr(raw)}</span>;
    }

    // ===== Íconos de contacto (WhatsApp + Google Maps) - todos los modos =====
    if (col.type === 'contacto') {
      const phone = String(data.pq_phone ?? data.cliente_telefono ?? '').trim().replace(/\D/g, '');
      const mapsUrl = String(data.pq_maps_url ?? data.cliente_maps_url ?? '').trim();
      const localidad = String(data.pq_localidad ?? data.cliente_localidad ?? '').trim();
      if (!phone && !mapsUrl) return null;
      return (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {phone ? (
            <>
              <div style={{ position: 'relative', display: 'inline-flex' }}>
                <button
                  type="button"
                  onClick={(e) => {
                    if (waMenuTelefono === phone) {
                      setWaMenuTelefono(null);
                      setWaMenuPos(null);
                      return;
                    }
                    const rect = e.currentTarget.getBoundingClientRect();
                    const menuAlto = 76; // alto aproximado del menú de 2 opciones
                    const abrirHaciaArriba = rect.bottom + menuAlto > window.innerHeight;
                    setWaMenuPos({
                      left: rect.left,
                      top: abrirHaciaArriba ? rect.top - menuAlto - 4 : rect.bottom + 4,
                    });
                    setWaMenuTelefono(phone);
                  }}
                  title={`WhatsApp: +54 ${phone}`}
                  style={{ display: 'inline-flex', alignItems: 'center', color: '#25D366', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-label="WhatsApp">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                  </svg>
                </button>
                {waMenuTelefono === phone && waMenuPos ? createPortal(
                  <>
                    <div style={{ position: 'fixed', inset: 0, zIndex: 999 }} onMouseDown={() => { setWaMenuTelefono(null); setWaMenuPos(null); }} />
                    <div
                      style={{
                        position: 'fixed', top: waMenuPos.top, left: waMenuPos.left, zIndex: 1000,
                        background: 'var(--surface, #fff)', border: '1px solid var(--border, #d1d5db)', borderRadius: 8,
                        boxShadow: '0 4px 14px rgba(0,0,0,0.18)', minWidth: 200, overflow: 'hidden',
                      }}
                    >
                      <a
                        href={`https://wa.me/54${phone}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => { setWaMenuTelefono(null); setWaMenuPos(null); }}
                        style={{ display: 'block', padding: '8px 12px', fontSize: 12, color: 'inherit', textDecoration: 'none', whiteSpace: 'nowrap' }}
                        onMouseDown={(e) => e.stopPropagation()}
                      >
                        🟢 Abrir en WhatsApp Web
                      </a>
                      <button
                        type="button"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => {
                          setWaMenuTelefono(null);
                          setWaMenuPos(null);
                          const digitos = phone.startsWith('54') ? phone.slice(2) : phone;
                          const telefonoCanonico = digitos.startsWith('9') ? `54${digitos}` : `549${digitos.replace(/^0/, '')}`;
                          window.open(`/admin/logistica-whatsapp?telefono=${encodeURIComponent(telefonoCanonico)}`, '_blank');
                        }}
                        style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', fontSize: 12, background: 'none', border: 'none', borderTop: '1px solid var(--border, #e5e7eb)', cursor: 'pointer', whiteSpace: 'nowrap' }}
                      >
                        💬 Abrir en Mensajes Logística
                      </button>
                    </div>
                  </>,
                  document.body
                ) : null}
              </div>
              <span style={{ fontSize: 12, color: '#374151', userSelect: 'all', letterSpacing: 0.2 }}>
                {phone}
              </span>
            </>
          ) : null}
          {mapsUrl ? (
            <a
              href={mapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Ver en Google Maps"
              style={{ display: 'inline-flex', alignItems: 'center', color: '#EA4335', textDecoration: 'none' }}
            >
              <svg width="18" height="20" viewBox="0 0 24 24" fill="currentColor" aria-label="Google Maps">
                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />
              </svg>
            </a>
          ) : null}
          {mapsUrl && localidad ? (
            <span style={{ fontSize: 12, color: '#374151' }}>{localidad}</span>
          ) : null}
        </div>
      );
    }

    // ===== Documentación (remito) =====
    if (col.type === 'documentacion') {
      return (
        <button
          type="button"
          className="pp-btnCell"
          onClick={() => openRemitoPdf(row)}
          title="Descargar remito (sin precios)"
        >
          Remito
        </button>
      );
    }

    // ===== full: comportamiento completo =====
    if (col.type === 'actions') {
      const st = getAccionesStatus(row);
      const alreadySent = st === 'produccion';

      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {alreadySent ? (
            <span className="pp-badge pp-badge--ok">Enviado</span>
          ) : st === 'listo' ? (
            <button
              onClick={() => sendToProduccion(row)}
              disabled={isBusy}
              className="btn btn--brand pp-btnCell"
              title="Enviar a producción (requiere Fecha Producción)"
            >
              Enviar a producción
            </button>
          ) : (
            <span className="pp-badge pp-badge--pending" title="Falta Fecha Producción">
              Pendiente
            </span>
          )}

          {/* Reset SOLO autorizaciones - FULL */}
          {accessMode === 'full' ? (
            <button
              type="button"
              className="pp-btnCell"
              disabled={isBusy}
              onClick={() => resetAutorizaciones(row)}
              title="Quitar autorizaciones (Admin y Logística)"
              style={{ borderColor: '#ef4444', color: '#991b1b', background: '#fff5f5' }}
            >
              Reset auth
            </button>
          ) : null}
        </div>
      );
    }

    if (col.type === 'week_produccion') return <span>{weekNumberFromLabel(weekLabelFromRow(row, 'produccion'))}</span>;
    if (col.type === 'week_despacho') return <span>{weekNumberFromLabel(weekLabelFromRow(row, 'despacho'))}</span>;
    if (col.type === 'calc_medidas') return <span>{medidasDisplayFromRow(row)}</span>;

    if (col.type === 'bool' && col.patchKey) {
      if (col.patchKey === 'auth_admin') {
        const ok = Boolean(data.auth_admin);
        if (ok) return <span className="pp-badge pp-badge--ok">Autorizado</span>;
        return (
          <button
            type="button"
            className="pp-btnCell pp-btnCell--brand"
            onClick={() => openAdminModal(row)}
            disabled={isBusy}
            title="Autorizar administración"
          >
            Autorizar
          </button>
        );
      }

      if (col.patchKey === 'auth_logistica') {
        const ok = Boolean(data.auth_logistica);
        return (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {ok ? (
              <>
                <span className="pp-badge pp-badge--ok">Autorizado</span>
                <button
                  type="button"
                  className="pp-btnCell"
                  onClick={() => openLogModal(row)}
                  disabled={isBusy}
                  title="Ver / Editar datos de autorización logística"
                >
                  Ver / Editar
                </button>
              </>
            ) : (
              <button
                type="button"
                className="pp-btnCell pp-btnCell--brand"
                onClick={() => openLogModal(row)}
                disabled={isBusy}
                title="Autorizar logística (requiere completar datos obligatorios)"
              >
                Autorizar
              </button>
            )}
          </div>
        );
      }

      const checked = Boolean(data[col.patchKey]);
      return (
        <input
          type="checkbox"
          checked={checked}
          disabled={isBusy}
          onChange={(e) => onPatch(id, { [col.patchKey]: e.target.checked })}
        />
      );
    }

    if (col.patchKey) {
      const v = data[col.patchKey] ?? '';

      if (col.type === 'date') {
        const isFechaSalida = col.patchKey === 'fecha_salida_imput';
        const isInicioProd = col.patchKey === 'inicio_prod_imput';
        const isFechaMedicion = col.patchKey === 'fecha_medicion_imput';

        if (isFechaMedicion) {
          const fromPres = Boolean(data.pq_fecha_medicion);
          const effectiveDate = normalizeDate10(fromPres ? data.pq_fecha_medicion : v);
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, whiteSpace: 'nowrap', color: '#374151' }}>
                {formatDMY(effectiveDate) || '—'}
              </span>
              {fromPres ? (
                <span
                  title="Fecha provista por el Presupuestador"
                  style={{ fontSize: 10, color: '#6b7280', background: '#f3f4f6', padding: '1px 5px', borderRadius: 4, whiteSpace: 'nowrap' }}
                >
                  Pres.
                </span>
              ) : null}
            </div>
          );
        }

        const sistemas = String(data.Sistemas ?? data.sistemas ?? data.Sistema ?? data.sistema ?? data.SISTEMAS ?? '').trim();

        const recommended = isFechaSalida ? resolveRecommendedFechaSalidaISO10(sistemas, sistemaRules) : '';
        const current = normalizeDate10(v);
        const showRecommend = Boolean(isFechaSalida && recommended && recommended !== current);

        // ✅ para inicio_prod_imput usamos draft local
        const dateValue = isInicioProd ? getInicioProdEffective(row) : normalizeDate10(v);

        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="date"
              value={dateValue}
              disabled={isBusy}
              onChange={(e) => {
                const next = e.target.value;

                if (isInicioProd) {
                  // ✅ SOLO estado local (no patch)
                  setDraftInicioProd(id, next);
                  return;
                }

                // comportamiento existente para el resto de fechas
                setRows((prev) =>
                  prev.map((r) => (r.id === id ? { ...r, data: { ...(r.data || {}), [col.patchKey]: next } } : r))
                );
                // Persistir ya en el change (no solo en blur): un <input type="date">
                // no siempre dispara blur al cambiarlo o al borrarlo con el botón "x"
                // del selector nativo (pasa en Chrome), así que confiar solo en onBlur
                // dejaba el cambio sin guardar y la fila volvía a la fecha vieja al
                // refrescar la tabla.
                onPatch(id, { [col.patchKey]: normalizeDate10(next) || null });
              }}
              onBlur={() => {
                if (isInicioProd) {
                  // ✅ no persistimos nada acá
                  return;
                }
                onPatch(id, { [col.patchKey]: normalizeDate10(data[col.patchKey] ?? '') || null });
              }}
              className="pp-input"
              style={{ width: 150 }}
            />

            {showRecommend ? (
              <button
                type="button"
                className="pp-btnCell"
                disabled={isBusy}
                title={`Recomendar ${formatDMY(recommended)} según Sistemas`}
                onClick={async () => {
                  const next = recommended;
                  setRows((prev) =>
                    prev.map((r) => (r.id === id ? { ...r, data: { ...(r.data || {}), [col.patchKey]: next } } : r))
                  );
                  await onPatch(id, { [col.patchKey]: next || null });
                }}
              >
                Recomendar
              </button>
            ) : null}

            {/* Indicador visual opcional para borrador de fecha prod */}
            {isInicioProd && draftInicioProdById[id] != null ? (
              <span className="pp-badge pp-badge--pending" title="Fecha Producción en borrador (aún no enviada)">
                Borrador
              </span>
            ) : null}
          </div>
        );
      }

      if (col.type === 'day') {
        const curr = String(v || '').toLowerCase();
        return (
          <select
            value={curr}
            disabled={isBusy}
            onChange={(e) => {
              const next = e.target.value;
              setRows((prev) =>
                prev.map((r) => (r.id === id ? { ...r, data: { ...(r.data || {}), [col.patchKey]: next } } : r))
              );
              onPatch(id, { [col.patchKey]: next || null });
            }}
            className="pp-select"
            style={{ width: 170 }}
          >
            <option value="">(vacío)</option>
            {DAYS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        );
      }

      return (
        <input
          type="text"
          value={String(v ?? '')}
          disabled={isBusy}
          onChange={(e) => {
            const next = e.target.value;
            setRows((prev) =>
              prev.map((r) => (r.id === id ? { ...r, data: { ...(r.data || {}), [col.patchKey]: next } } : r))
            );
          }}
          onBlur={() => onPatch(id, { [col.patchKey]: (data[col.patchKey] ?? '').toString().trim() || null })}
          className="pp-input"
          style={{ width: 220 }}
        />
      );
    }

    const raw = getCellValue(row, col);
    if (col.type === 'date') return <span>{normalizeDate10(raw)}</span>;
    return <span>{toStr(raw)}</span>;
  };

  return (
    <div className="pp-page">
      <div className="pp-card">
        <div className="pp-headerRow">
          <h2 className="pp-title">
            Preproducción {accessMode === 'limited' ? <span style={{ fontSize: 12, fontWeight: 700 }}>(Vista)</span> : null}
            {accessMode === 'admin' ? (
              <span style={{ fontSize: 12, fontWeight: 700 }}>(Administración)</span>
            ) : null}
          </h2>

          <button onClick={load} disabled={loading} className="btn">
            Recargar
          </button>

          <a
            href={`${import.meta.env.VITE_PRESUPUESTADOR_URL || ''}/aprobacion/tecnica/portones-estado`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn"
            style={{ textDecoration: 'none' }}
          >
            Estado Portones
          </a>

          <button onClick={() => setShowConsultas(true)} className="btn">
            Consultas (Técnica / Comercial)
          </button>

          <Link to="/admin/logistica-fechas" className="btn" style={{ textDecoration: 'none' }}>
            Planificación de Fechas
          </Link>

          <Link to="/admin/logistica-viajes" className="btn" style={{ textDecoration: 'none' }}>
            Viajes de Logística
          </Link>

          <label className="btn" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={mostrarDespachados}
              onChange={(e) => setMostrarDespachados(e.target.checked)}
            />
            Mostrar ya despachados
          </label>

          {accessMode === 'full' ? (
            <>
              <button onClick={() => setShowLogisticaPresets(true)} disabled={loading} className="btn">
                Presets Logística
              </button>
              <button onClick={() => setShowSistemaRules(true)} disabled={loading} className="btn">
                Reglas Sistema→Salida
              </button>
            </>
          ) : null}

          {accessMode === 'full' && portonesIndexState === 'error' ? (
            <div className="pp-warnInline">
              No se pudo cargar <b>Portones</b>. El estado "Enviado" puede ser incorrecto hasta recargar.
            </div>
          ) : null}

          {accessMode === 'full' && blockedNvState === 'error' ? (
            <div className="pp-warnInline">
              No se pudo cargar <b>blocked_nvs.txt</b>. No se aplicaron exclusiones por NV.
            </div>
          ) : null}

          {/* Panel Columnas (solo full) */}
          {accessMode === 'full' ? (
            <div className="pp-panelWrap" ref={colsPanelRef}>
              <button onClick={() => setShowColsPanel((p) => !p)} className="btn" disabled={loading}>
                Columnas
              </button>

              {showColsPanel ? (
                <div className="pp-panel">
                  <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 8 }}>Mostrar/Ocultar columnas (Tabla)</div>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <button className="btn" onClick={() => toggleAllCols(true)}>
                      Mostrar todas
                    </button>
                    <button
                      className="btn"
                      style={{ borderColor: '#ef4444', background: '#fff5f5', color: '#991b1b' }}
                      onClick={() => toggleAllCols(false)}
                    >
                      Ocultar todas
                    </button>
                  </div>

                  {ALL_COLS.map((c) => (
                    <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px' }}>
                      <input
                        type="checkbox"
                        checked={visibleCols[c.id] !== false}
                        onChange={(e) => setVisibleCols((p) => ({ ...p, [c.id]: e.target.checked }))}
                      />
                      <span style={{ fontSize: 12 }}>{c.label}</span>
                    </label>
                  ))}

                  <div style={{ marginTop: 8, fontSize: 11, color: '#6b7280' }}>Se guarda en este navegador.</div>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Panel PDF (solo full) */}
          {accessMode === 'full' ? (
            <div style={{ position: 'relative' }} ref={pdfPanelRef}>
              <button
                onClick={() => setShowPdfPanel((p) => !p)}
                className="btn"
                disabled={loading || filteredRows.length === 0}
              >
                PDF
              </button>

              {showPdfPanel ? (
                <div
                  style={{
                    position: 'absolute',
                    top: 40,
                    left: 0,
                    width: 380,
                    maxHeight: 460,
                    overflow: 'auto',
                    background: '#fff',
                    border: '1px solid #e5e7eb',
                    borderRadius: 12,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.08)',
                    padding: 10,
                    zIndex: 5,
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 8 }}>PDF: semana y campos</div>

                  <div style={{ display: 'grid', gap: 8, marginBottom: 10 }}>
                    <label style={{ fontSize: 12 }}>
                      Semana según
                      <select
                        value={pdfMode}
                        onChange={(e) => setPdfMode(e.target.value)}
                        className="pp-select"
                        style={{ marginTop: 6, width: '100%' }}
                      >
                        <option value="produccion">Producción (Inicio Prod)</option>
                        <option value="despacho">Despacho (Fecha Salida)</option>
                      </select>
                    </label>

                    <label style={{ fontSize: 12 }}>
                      Semana a imprimir
                      <select
                        value={pdfWeek}
                        onChange={(e) => setPdfWeek(e.target.value)}
                        className="pp-select"
                        style={{ marginTop: 6, width: '100%' }}
                      >
                        <option value="">Todas</option>
                        {pdfWeeksList.map((w) => (
                          <option key={w} value={w}>
                            {w} {weekTitleFromSelection(w) ? `· ${weekTitleFromSelection(w)}` : ''}
                          </option>
                        ))}
                      </select>
                      <div style={{ fontSize: 12, color: '#374151', marginTop: 6 }}>
                        Filas a imprimir: <b>{pdfSelectedRows.length}</b>
                      </div>
                    </label>
                  </div>

                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <button className="btn" onClick={() => toggleAllPdfFields(true)}>
                      Campos: todos
                    </button>
                    <button
                      className="btn"
                      style={{ borderColor: '#ef4444', background: '#fff5f5', color: '#991b1b' }}
                      onClick={() => toggleAllPdfFields(false)}
                    >
                      Campos: ninguno
                    </button>
                  </div>

                  {PDF_DEFS.map((f) => (
                    <label
                      key={`pdf_${f.id}`}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px' }}
                    >
                      <input
                        type="checkbox"
                        checked={pdfFields[f.id] !== false}
                        onChange={(e) => setPdfFields((p) => ({ ...p, [f.id]: e.target.checked }))}
                      />
                      <span style={{ fontSize: 12 }}>{f.label}</span>
                    </label>
                  ))}

                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button className="btn btn--brand" onClick={printPdf} disabled={pdfSelectedRows.length === 0}>
                      Imprimir PDF
                    </button>
                    <button className="btn" onClick={() => setShowPdfPanel(false)}>
                      Cerrar
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {accessMode === 'admin' ? (
            <div style={{ fontSize: 12, color: '#374151' }}>
              Mostrando hasta: <b>{formatDMY(nextWeekFridayCutoffISO10())}</b>
            </div>
          ) : null}

          <div style={{ marginLeft: 'auto', fontSize: 12, color: '#374151' }}>{loading ? 'Cargando…' : `Registros: ${total}`}</div>
        </div>

        {err ? (
          <div className="pp-errorBox" style={{ marginBottom: 10 }}>
            <b>Error:</b> {err}
          </div>
        ) : null}

        {/* TABLA FULL-BLEED + SCROLLBAR SIEMPRE VISIBLE */}
        <div className="pp-bleed">
          <div className="pp-tableWrap pp-tableWrap--edge" ref={tableWrapRef}>
            <table className="pp-table">
              <thead>
                <tr>
                  {visibleColsList.map((c) => (
                    <th
                      key={c.id}
                      className="pp-th"
                      style={{
                        textAlign: 'left',
                        whiteSpace: 'nowrap',
                        color: '#111827',
                      }}
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>

                <tr>
                  {visibleColsList.map((c) => (
                    <th key={`${c.id}_filter`} className="pp-th pp-th--filter">
                      {c.type === 'contacto' ? null : c.type === 'actions' ? (
                        <select
                          value={filters[c.id] || ''}
                          onChange={(e) => setFilters((p) => ({ ...p, [c.id]: e.target.value }))}
                          className="pp-select"
                          style={{ width: '100%' }}
                        >
                          <option value="">(todos)</option>
                          <option value="pendiente">Pendiente</option>
                          <option value="listo">Listo</option>
                          <option value="produccion">Enviado</option>
                        </select>
                      ) : c.type === 'day' ? (
                        <select
                          value={filters[c.id] || ''}
                          onChange={(e) => setFilters((p) => ({ ...p, [c.id]: e.target.value }))}
                          className="pp-select"
                          style={{ width: '100%' }}
                        >
                          <option value="">(todos)</option>
                          {DAYS.map((d) => (
                            <option key={d} value={d}>
                              {d}
                            </option>
                          ))}
                        </select>
                      ) : c.type === 'date' ? (
                        renderDateFilter(c.id)
                      ) : c.type === 'bool' ? (
                        <select
                          value={filters[c.id] || ''}
                          onChange={(e) => setFilters((p) => ({ ...p, [c.id]: e.target.value }))}
                          className="pp-select"
                          style={{ width: '100%' }}
                        >
                          <option value="">(todos)</option>
                          <option value="autorizar">Autorizar</option>
                          <option value="autorizado">Autorizado</option>
                        </select>
                      ) : (
                        <input
                          value={filters[c.id] || ''}
                          onChange={(e) => setFilters((p) => ({ ...p, [c.id]: e.target.value }))}
                          placeholder="Filtrar…"
                          className="pp-input"
                        />
                      )}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {pagedRows.map((row) => {
                  // Pedido explícito del usuario: portones con la misma
                  // semana de despacho se pintan del mismo pastel, y ese
                  // color va cambiando de semana a semana (ver
                  // colorForWeekLabel en utils/isoWeek.js) - así se ve de
                  // un vistazo dónde corta una semana y empieza la otra.
                  // Clase + variable CSS en vez de background inline directo:
                  // el rayado cebra de nth-child(even) (y su versión con
                  // !important en force-light.css, para forzar tema claro)
                  // le ganan a un inline style común - ver la regla
                  // .pp-row-semana en theme.css, con más especificidad para
                  // ganarles a ambas siempre, sin importar fila par o impar.
                  const colorSemana = colorForWeekLabel(weekLabelFromRow(row, 'despacho'));
                  return (
                    <tr
                      key={row.id}
                      className={colorSemana ? 'pp-row-semana' : undefined}
                      style={colorSemana ? { '--row-semana-bg': colorSemana } : undefined}
                    >
                      {visibleColsList.map((col) => (
                        <td key={`${row.id}_${col.id}`}>
                          {renderCell(row, col)}
                        </td>
                      ))}
                    </tr>
                  );
                })}

                {!loading && pagedRows.length === 0 ? (
                  <tr>
                    <td colSpan={visibleColsList.length || 1} style={{ padding: 12, color: '#6b7280', fontSize: 12 }}>
                      No hay filas para mostrar (revisá filtros o datos).
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          {/* Scrollbar espejo */}
          <div className="pp-xscroll" ref={xscrollRef} aria-hidden="true">
            <div className="pp-xscroll__spacer" ref={xscrollSpacerRef} />
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 12, color: '#374151' }}>
            Mostrando <b>{total ? startIdx + 1 : 0}</b>–<b>{endIdx}</b> de <b>{total}</b>
          </div>

          <label style={{ fontSize: 12, color: '#111827' }}>
            Tamaño
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="pp-select"
              style={{ width: 110, marginLeft: 8 }}
            >
              {[10, 25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>

          <button className="btn" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1}>
            Anterior
          </button>

          <div style={{ fontSize: 12, color: '#374151' }}>
            Página <b>{safePage}</b> / <b>{pageCount}</b>
          </div>

          <button className="btn" onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={safePage >= pageCount}>
            Siguiente
          </button>
        </div>

        <div style={{ marginTop: 8, fontSize: 11, color: '#6b7280' }}>
          Fechas: podés usar <b>Desde/Hasta</b> (intervalo), y/o <b>Con fecha</b>, y/o <b>Sin fecha</b>. Si combinás
          intervalo + "Sin fecha" trae <i>intervalo OR sin fecha</i>.
        </div>
      </div>

      {/* paneles (solo full) */}
      {accessMode === 'full' ? (
        <>
          <PreproduccionLogisticaPresets
            open={showLogisticaPresets}
            onClose={closeLogisticaPresets}
            distributors={distributorsList}
          />
          <PreproduccionSistemaFechaSalidaRules open={showSistemaRules} onClose={closeSistemaRules} />
        </>
      ) : null}

      {showConsultas ? <LogisticaConsultasPanel onClose={() => setShowConsultas(false)} /> : null}

      {/* Modales */}
      {accessMode === 'full' || accessMode === 'admin' ? (
        <AdminAuthModal
          open={adminModalOpen}
          row={adminModalRow}
          busy={adminModalBusy}
          onClose={closeAdminModal}
          onSubmit={submitAdminAuth}
        />
      ) : null}

      {accessMode === 'full' ? (
        <LogisticaAuthModal
          open={logModalOpen}
          row={logModalRow}
          busy={logModalBusy}
          onClose={closeLogModal}
          onSubmit={submitLogisticaAuth}
          recommendations={logisticaRecommendations}
        />
      ) : null}
    </div>
  );
}
