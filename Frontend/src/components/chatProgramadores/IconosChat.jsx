// src/components/chatProgramadores/IconosChat.jsx — íconos del chat (barra
// de escribir, burbuja "enviando", archivos) como SVG en línea con
// currentColor, en lugar de emoji (pedido del usuario: nada de emoji en la
// interfaz; los emoji quedan solo como contenido: reacciones y el selector).
import { colorDeArchivo, extensionDe } from './chatComun';

function Svg({ size = 22, children }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block' }}
    >
      {children}
    </svg>
  );
}

export function IconoCarita({ size }) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
      <path d="M9 9.5h.01M15 9.5h.01" strokeWidth="2.6" />
    </Svg>
  );
}

export function IconoClip({ size }) {
  return (
    <Svg size={size}>
      <path d="m21 11.5-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" />
    </Svg>
  );
}

export function IconoEnviar({ size }) {
  return (
    <Svg size={size}>
      <path d="M4 12 20 4l-6 16-3-7z" />
      <path d="m11 13 9-9" />
    </Svg>
  );
}

export function IconoReloj({ size = 12 }) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Svg>
  );
}

// Recuadro de color con la extensión ("PDF", "XLSX"...) para los archivos.
export function BadgeArchivo({ nombre, size = 34 }) {
  const ext = (extensionDe(nombre) || 'arch').slice(0, 4).toUpperCase();
  return (
    <span
      aria-hidden="true"
      style={{
        width: size, height: Math.round(size * 1.18), flex: '0 0 auto', borderRadius: 6,
        background: colorDeArchivo(nombre), color: '#fff', display: 'inline-flex',
        alignItems: 'flex-end', justifyContent: 'center', paddingBottom: Math.round(size * 0.14),
        fontSize: Math.max(8, Math.round(size * 0.28)), fontWeight: 800, letterSpacing: 0.3,
      }}
    >
      {ext}
    </span>
  );
}
