// src/components/chatProgramadores/ChatProgramadoresBoton.jsx — botón "💬 Chat"
// del encabezado (NonProductionLayout, al lado de "Tickets") con el contador
// de mensajes nuevos del Chat de Programadores. Solo con scope
// programadores:admin.
import { useLocation, useNavigate } from 'react-router-dom';
import { useChatProgramadores } from './chatContexto';
import { RUTA_CHAT } from './chatComun';

export default function ChatProgramadoresBoton() {
  const { habilitado, noLeidos } = useChatProgramadores();
  const nav = useNavigate();
  const { pathname } = useLocation();
  if (!habilitado) return null;
  const mostrarBadge = noLeidos > 0 && pathname !== RUTA_CHAT;
  return (
    <button
      type="button"
      className="btn"
      onClick={() => nav(RUTA_CHAT)}
      title={mostrarBadge ? `Chat de Programadores · ${noLeidos} mensaje${noLeidos === 1 ? '' : 's'} nuevo${noLeidos === 1 ? '' : 's'}` : 'Chat de Programadores'}
      style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px' }}
    >
      <span style={{ fontSize: 16, lineHeight: 1 }}>💬</span>
      Chat
      {mostrarBadge && (
        <span
          style={{
            position: 'absolute', top: -6, right: -6,
            minWidth: 16, height: 16, padding: '0 4px', borderRadius: 999,
            background: '#dc2626', color: '#fff', fontSize: 10, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
          }}
        >
          {noLeidos > 9 ? '9+' : noLeidos}
        </span>
      )}
    </button>
  );
}
