import React, { useEffect } from 'react';

export default function BaseModal({ open, title, subtitle, onClose, children, wide }) {
  useEffect(() => {
    if (!open) return;

    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);

    // bloquea scroll del body mientras está abierto
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="pp-modalOverlay" onMouseDown={onClose}>
      <div className={wide ? 'pp-modal pp-modal--wide' : 'pp-modal'} onMouseDown={(e) => e.stopPropagation()}>
        <div className="pp-modal__header">
          <h3 className="pp-modal__title">{title}</h3>
          {subtitle ? <div className="pp-modal__sub">{subtitle}</div> : null}
          <button className="pp-modal__close" type="button" onClick={onClose} title="Cerrar">
            Cerrar
          </button>
        </div>

        <div className="pp-modal__body">{children}</div>
      </div>
    </div>
  );
}
