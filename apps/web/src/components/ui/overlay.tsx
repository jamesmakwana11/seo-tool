import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { X } from 'lucide-react';
import { Button, Field, Textarea } from './primitives';

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [open, onClose]);
}

/** Traps Tab focus inside the container and restores focus on close. */
function useFocusTrap(open: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || !ref.current) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = () => Array.from(el.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')).filter((x) => !x.hasAttribute('disabled'));
    (focusables().find((x) => x.dataset.autofocus !== undefined) ?? focusables()[0])?.focus();
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    el.addEventListener('keydown', h);
    return () => { el.removeEventListener('keydown', h); prev?.focus?.(); };
  }, [open]);
  return ref;
}

export function Dialog({ open, onClose, title, children, footer, size = 'md' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' }) {
  useEscape(open, onClose);
  const ref = useFocusTrap(open);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#252238]/30 p-0 backdrop-blur-[2px] sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} className={clsx('anim-pop flex max-h-[92vh] w-full flex-col rounded-t-panel border border-line bg-surface shadow-pop sm:rounded-panel', size === 'sm' ? 'sm:max-w-md' : size === 'md' ? 'sm:max-w-xl' : 'sm:max-w-3xl')}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button aria-label="Close" className="text-muted hover:text-ink" onClick={onClose}><X className="h-4 w-4" /></button>
        </div>
        <div className="overflow-y-auto px-4 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ open, onClose, title, children, footer, width = 'md' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: 'md' | 'lg' }) {
  useEscape(open, onClose);
  const ref = useFocusTrap(open);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-[#252238]/25 backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} className={clsx('anim-page flex h-full w-full flex-col border-l border-line bg-surface shadow-pop', width === 'md' ? 'max-w-lg' : 'max-w-3xl')}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button aria-label="Close" className="text-muted hover:text-ink" onClick={onClose}><X className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Confirmation dialog, optionally asking for a reason (required for destructive/audited actions). */
export function ConfirmDialog({
  open, onClose, onConfirm, title, body, confirmLabel = 'Confirm', danger, reason, reasonLabel = 'Reason', reasonMin = 3, loading,
}: {
  open: boolean; onClose: () => void; onConfirm: (reason: string) => void; title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean;
  reason?: 'required' | 'optional'; reasonLabel?: string; reasonMin?: number; loading?: boolean;
}) {
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  useEffect(() => { if (open) { setText(''); setTouched(false); } }, [open]);
  const invalid = reason === 'required' && text.trim().length < reasonMin;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={() => { setTouched(true); if (!invalid) onConfirm(text.trim()); }}>{confirmLabel}</Button>
        </>
      }
    >
      {body && <div className="mb-3 text-sm text-ink-soft">{body}</div>}
      {reason && (
        <Field label={reasonLabel} required={reason === 'required'} error={touched && invalid ? `Enter at least ${reasonMin} characters.` : undefined} htmlFor="confirm-reason">
          <Textarea id="confirm-reason" data-autofocus value={text} onChange={(e) => setText(e.target.value)} aria-invalid={touched && invalid} />
        </Field>
      )}
    </Dialog>
  );
}

/** Simple click-to-open menu. */
export function Menu({ trigger, items, align = 'right', placement = 'down', className }: { trigger: (open: () => void, isOpen: boolean) => ReactNode; items: { label: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }[]; align?: 'left' | 'right'; placement?: 'down' | 'up'; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open]);
  return (
    <div ref={ref} className={clsx('relative', className)}>
      {trigger(() => setOpen((o) => !o), open)}
      {open && (
        <div role="menu" className={clsx('anim-pop absolute z-40 min-w-[220px] rounded-panel border border-line bg-surface p-1 shadow-pop', placement === 'up' ? 'bottom-full mb-1.5' : 'mt-1.5', align === 'right' ? 'right-0' : 'left-0')}>
          {items.map((it, i) => (
            <button key={i} role="menuitem" disabled={it.disabled} onClick={() => { setOpen(false); it.onClick(); }} className={clsx('block w-full rounded-ctl px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-raised disabled:opacity-40', it.danger ? 'text-crit-ink' : 'text-ink hover:text-signal-dark')}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
