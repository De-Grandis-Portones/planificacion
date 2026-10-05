// pages/admin/AdminHomePage.jsx
import { Link, useNavigate } from 'react-router-dom';
import { clearAdminToken } from '../../src/api';

export default function AdminHomePage() {
  const nav = useNavigate();

  const logout = () => {
    clearAdminToken();
    nav('/admin/login');
  };

  return (
    <div className="container" style={{ maxWidth: 900 }}>
      <div className="header-row" style={{ alignItems: 'center' }}>
        <h2 className="h1">Panel Admin</h2>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn" to="/">Inicio</Link>
          <button className="btn" type="button" onClick={logout}>
            Salir
          </button>
        </div>
      </div>

      <div
        style={{
          marginTop: 14,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 14,
        }}
      >
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 12,
            padding: 14,
            background: 'var(--surface)',
          }}
        >
          <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 8 }}>
            Usuarios y Motivos QC
          </div>
          <div style={{ opacity: 0.75, marginBottom: 12 }}>
            Alta/edición de usuarios QC, scopes por etapa y ABM de motivos.
          </div>
          <Link className="btn btn--brand" to="/admin/qc">
            Ir a Usuarios QC
          </Link>
        </div>

        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 12,
            padding: 14,
            background: 'var(--surface)',
          }}
        >
          <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 8 }}>
            Workflow Designer
          </div>
          <div style={{ opacity: 0.75, marginBottom: 12 }}>
            Configuración de etapas, edges y requisitos del workflow.
          </div>
          <Link className="btn btn--brand" to="/admin/workflow">
            Ir a Workflow
          </Link>
        </div>

        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 12,
            padding: 14,
            background: 'var(--surface)',
          }}
        >
          <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 8 }}>
            Prefabricados
          </div>
          <div style={{ opacity: 0.75, marginBottom: 12 }}>
            ABM de tipos de prefabricado: nombre, sección solicitante y workflow.
          </div>
          <Link className="btn btn--brand" to="/admin/prefabricados">
            Ir a Prefabricados
          </Link>
        </div>

        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 12,
            padding: 14,
            background: 'var(--surface)',
          }}
        >
          <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 8 }}>
            Servicio Técnico y Órdenes Externas
          </div>
          <div style={{ opacity: 0.75, marginBottom: 12 }}>
            Crear órdenes ST (por NV) u OE (correlativas, sin NV), con workflow a medida.
          </div>
          <Link className="btn btn--brand" to="/admin/servicio-tecnico">
            Ir a Servicio Técnico / Ord. Externas
          </Link>
        </div>

        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 12,
            padding: 14,
            background: 'var(--surface)',
          }}
        >
          <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 8 }}>
            Compras · Pedidos de Insumos
          </div>
          <div style={{ opacity: 0.75, marginBottom: 12 }}>
            Ver/editar pedidos diarios de insumos por sección, histórico, y mapeo de categorías Odoo↔sección.
          </div>
          <Link className="btn btn--brand" to="/admin/insumos">
            Ir a Compras
          </Link>
        </div>

        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 12,
            padding: 14,
            background: 'var(--surface)',
          }}
        >
          <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 8 }}>
            Planificación de Fechas
          </div>
          <div style={{ opacity: 0.75, marginBottom: 12 }}>
            Asignar en qué semana despacha/instala cada portón arrastrándolo (mismo dato que fecha
            salida/llegada en /a).
          </div>
          <Link className="btn btn--brand" to="/admin/logistica-fechas">
            Ir a Planificación de Fechas
          </Link>
        </div>

        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 12,
            padding: 14,
            background: 'var(--surface)',
          }}
        >
          <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 8 }}>
            Logística de Viajes
          </div>
          <div style={{ opacity: 0.75, marginBottom: 12 }}>
            Armado de viajes (fecha, zona, cuadrilla, vehículo) por semana y reparto de portones de
            despacho/instalación.
          </div>
          <Link className="btn btn--brand" to="/admin/logistica-viajes">
            Ir a Logística de Viajes
          </Link>
        </div>

      </div>

      <div style={{ marginTop: 14, fontSize: 12, opacity: 0.7 }}>
        Desde acá siempre podés volver a Inicio o cerrar sesión.
      </div>
    </div>
  );
}
