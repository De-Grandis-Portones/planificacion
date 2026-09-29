// src/components/UserAvatar.jsx — círculo de color con iniciales para un
// username (ver src/utils/userAvatar.js). Usado donde se muestra quién está
// trabajando en un ticket/tarea (AdminTicketsBoardPage, AdminTicketsPage,
// AdminTicketDetailModal) para que se reconozca de un vistazo, no solo
// texto plano.
import { colorForUsername, initialsForUsername } from '../utils/userAvatar';

// `name` (opcional) es el nombre real: si viene, las iniciales y el tooltip
// salen de ahí; el color sigue atado al username para que no cambie.
export default function UserAvatar({ username, name, size = 18 }) {
  if (!username) return null;
  return (
    <span
      title={name || username}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: size, height: size, minWidth: size, borderRadius: '50%', flexShrink: 0,
        background: colorForUsername(username), color: '#fff',
        fontSize: Math.max(9, Math.round(size * 0.5)), fontWeight: 700, lineHeight: 1,
      }}
    >
      {initialsForUsername(name || username)}
    </span>
  );
}
