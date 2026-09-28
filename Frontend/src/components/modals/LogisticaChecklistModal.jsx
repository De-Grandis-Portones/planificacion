// src/components/modals/LogisticaChecklistModal.jsx
//
// CheckList configurable que la cuadrilla tiene que completar (todo en "OK")
// antes de poder arrancar un viaje en /despacho_v2 (pedido explícito del
// usuario) - dos listas independientes: "Solo despacho" (viaje sin ninguna
// parada de instalación) y "Con instalación" (al menos una). Mismo patrón
// de ABM que LogisticaCuadrillasModal.jsx.
import React, { useState } from 'react';
import {
  createLogisticaChecklistItem,
  updateLogisticaChecklistItem,
  deleteLogisticaChecklistItem,
} from '../../api';

const th = { textAlign: 'left', padding: 10, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
const td = { padding: 10, borderBottom: '1px solid var(--border)', verticalAlign: 'top' };

const TIPOS = [
  { key: 'solo_despacho', label: 'Solo despacho' },
  { key: 'con_instalacion', label: 'Con instalación' },
];

function SeccionTipo({ tipo, label, items, busy, onAgregar, onGuardar, onBorrar }) {
  const [texto, setTexto] = useState('');
  const ordenados = [...items].sort((a, b) => a.orden - b.orden || a.id - b.id);
  const siguienteOrden = ordenados.length ? Math.max(...ordenados.map((i) => i.orden)) + 1 : 0;

  const agregar = () => {
    const txt = texto.trim();
    if (!txt) return;
    onAgregar({ tipo, texto: txt, orden: siguienteOrden });
    setTexto('');
  };

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontWeight: 900, marginBottom: 6 }}>{label}</div>
      <div style={{ overflow: 'auto', border: '1px solid var(--border)', borderRadius: 12, marginBottom: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--surface-muted, #f9fafb)' }}>
              <th style={th}>Orden</th>
              <th style={th}>Ítem</th>
              <th style={th}>Activo</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {ordenados.map((it) => (
              <tr key={it.id}>
                <td style={{ ...td, width: 70 }}>
                  <input
                    type="number" className="pp-input" style={{ width: 56 }} defaultValue={it.orden}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v) && v !== it.orden) onGuardar(it.id, { orden: v });
                    }}
                  />
                </td>
                <td style={td}>
                  <input
                    className="pp-input" style={{ width: '100%', minWidth: 220 }} defaultValue={it.texto}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v && v !== it.texto) onGuardar(it.id, { texto: v });
                    }}
                  />
                </td>
                <td style={td}>
                  <button className="btn" disabled={busy} onClick={() => onGuardar(it.id, { activo: !it.activo })}>
                    {it.activo ? 'Sí' : 'No'}
                  </button>
                </td>
                <td style={td}>
                  <button className="btn" style={{ borderColor: '#ef4444', color: '#991b1b' }} disabled={busy} onClick={() => onBorrar(it.id)}>
                    Borrar
                  </button>
                </td>
              </tr>
            ))}
            {ordenados.length === 0 ? (
              <tr><td style={{ ...td, color: '#6b7280' }} colSpan={4}>Sin ítems configurados todavía - Play arranca directo, sin checklist.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          className="pp-input" style={{ flex: 1 }} placeholder="Ej: Verificar que los portones estén bien sujetos"
          value={texto} onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') agregar(); }}
        />
        <button className="btn btn--brand" disabled={busy || !texto.trim()} onClick={agregar}>Agregar</button>
      </div>
    </div>
  );
}

export default function LogisticaChecklistModal({ open, config, onClose, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  if (!open) return null;

  const items = config?.checklist_items || [];

  const withBusy = async (fn) => {
    setBusy(true);
    setErr('');
    try {
      await fn();
      await onChanged?.();
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  const agregar = (payload) => withBusy(() => createLogisticaChecklistItem(payload));
  const guardar = (id, patch) => withBusy(() => updateLogisticaChecklistItem(id, patch));
  const borrar = (id) => {
    if (!window.confirm('¿Borrar este ítem del checklist?')) return;
    withBusy(() => deleteLogisticaChecklistItem(id));
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div style={{ width: 'min(760px, 100%)', maxHeight: '90vh', overflowY: 'auto', background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)', boxShadow: '0 12px 32px rgba(0,0,0,0.18)', padding: 12 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontWeight: 900 }}>CheckList de arranque de viaje (/despacho_v2)</div>
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={onClose}>Cerrar</button>
        </div>
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 12 }}>
          La cuadrilla tiene que tildar todos los ítems activos antes de que el botón Play la deje arrancar el viaje.
          "Solo despacho" se muestra cuando el viaje no tiene ninguna parada de instalación; "Con instalación", cuando tiene al menos una.
        </div>

        {err ? <div style={{ color: 'crimson', fontWeight: 800, fontSize: 12, marginBottom: 8 }}>{err}</div> : null}

        {TIPOS.map((t) => (
          <SeccionTipo
            key={t.key}
            tipo={t.key}
            label={t.label}
            items={items.filter((i) => i.tipo === t.key)}
            busy={busy}
            onAgregar={agregar}
            onGuardar={guardar}
            onBorrar={borrar}
          />
        ))}
      </div>
    </div>
  );
}
