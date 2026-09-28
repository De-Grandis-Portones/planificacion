import { Outlet, useNavigate } from 'react-router-dom';
import { clearAdminToken } from '../api';
import TicketWidget from './TicketWidget';
import WhatsappToastWatcher from './WhatsappToastWatcher';
import ChatProgramadoresProvider from './chatProgramadores/ChatProgramadoresProvider';
import ChatProgramadoresBoton from './chatProgramadores/ChatProgramadoresBoton';

export default function NonProductionLayout() {
  const nav = useNavigate();

  // "Menú": vuelve al índice (hub)
  const goMenu = () => {
    nav('/index', { replace: false });
  };

  // "Cerrar Sesión": mismo comportamiento que el botón "Salir" en /admin/workflow
  const logout = () => {
    // Igual que /admin/workflow
    clearAdminToken();
    nav('/admin/login');
  };

  // ChatProgramadoresProvider: canal en tiempo real del Chat de Programadores
  // (botón con contador, avisos y "(N)" en el título en todas las pantallas
  // admin). No hace nada sin el scope programadores:admin.
  return (
    <ChatProgramadoresProvider>
      <div className="container">
        <div className="header-row" style={{ alignItems: 'center' }}>
          <div />

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button className="btn btn--brand" type="button" onClick={goMenu}>
              Menú
            </button>
            <TicketWidget />
            <ChatProgramadoresBoton />
            <button className="btn" type="button" onClick={logout}>
              Cerrar Sesión
            </button>
          </div>
        </div>

        <Outlet />
        <WhatsappToastWatcher />
      </div>
    </ChatProgramadoresProvider>
  );
}
