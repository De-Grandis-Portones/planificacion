// pages/admin/ProgramadoresChatPage.jsx
//
// Chat de Programadores: un único grupo tipo WhatsApp entre los usuarios con
// scope programadores:admin (pedido del usuario: "una nueva sección en
// Programadores que sea tipo un chat de WhatsApp"). Todo el chat en sí está
// en ChatSala (compartido con el chat de cada proyecto); acá solo qué
// backend usa (routes/admin/programadoresChat.js) y de dónde salen los
// eventos en tiempo real (el canal que abre ChatProgramadoresProvider en
// NonProductionLayout).
import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchProgramadoresChat, enviarProgramadoresChat, marcarProgramadoresChatLeido,
  editarProgramadoresChat, eliminarProgramadoresChat, reaccionarProgramadoresChat,
} from '../../src/api';
import ChatSala from '../../src/components/chatProgramadores/ChatSala';
import { useChatProgramadores } from '../../src/components/chatProgramadores/chatContexto';

const API_CHAT = {
  listar: fetchProgramadoresChat,
  enviar: enviarProgramadoresChat,
  editar: editarProgramadoresChat,
  eliminar: eliminarProgramadoresChat,
  reaccionar: reaccionarProgramadoresChat,
  marcarLeido: marcarProgramadoresChatLeido,
};

export default function ProgramadoresChatPage() {
  const { suscribir, conectado } = useChatProgramadores();

  // Por el mismo canal llegan los eventos de los chats de proyectos: acá
  // solo los del grupo general.
  const suscribirGrupo = useCallback(
    (fn) => suscribir((ev) => { if (ev.tipo !== 'proyecto' && ev.tipo !== 'proyectos') fn(ev); }),
    [suscribir]
  );

  return (
    <div>
      <div className="header-row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Link className="btn" to="/index">← Inicio</Link>
        <h2 style={{ margin: 0 }}>Chat de Programadores</h2>
        <div />
      </div>
      <ChatSala
        api={API_CHAT}
        suscribir={suscribirGrupo}
        conectado={conectado}
        titulo="Programadores"
        icono="💻"
        textoSinAcceso={<>No tenés acceso a este chat: es solo para usuarios con el permiso <b>programadores:admin</b>.</>}
      />
    </div>
  );
}
