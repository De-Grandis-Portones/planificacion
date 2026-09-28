// src/components/chatProgramadores/chatContexto.js
//
// Contexto del canal en tiempo real del Chat de Programadores (lo arma
// ChatProgramadoresProvider.jsx, que vive en NonProductionLayout). Separado
// del provider para que ese archivo exporte solo componentes (fast refresh).
import { createContext, useContext } from 'react';

const SIN_CHAT = {
  habilitado: false,
  noLeidos: 0,
  conectado: false,
  suscribir: () => () => {},
  refrescarNoLeidos: () => {},
};

export const ChatProgramadoresContext = createContext(SIN_CHAT);

export function useChatProgramadores() {
  return useContext(ChatProgramadoresContext);
}
