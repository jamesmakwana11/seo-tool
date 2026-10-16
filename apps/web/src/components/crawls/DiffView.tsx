import clsx from 'clsx';
import type { TextDiffView } from '@sentinel/shared';

/**
 * Line diff with old / new line numbers: removed lines on a red tint, added lines on a green tint, unchanged runs
 * collapsed to "…". Used for the rendered DOM, CSS / JS files and theme source.
 */
export function DiffView({ diff, label, maxHeight = 560 }: { diff: TextDiffView; label: string; maxHeight?: number }) {
  if (!diff.added && !diff.removed) return <p className="rounded-ctl border border-line bg-raised/40 px-3 py-2 text-sm text-muted">No line differs.</p>;
  return (
    <div>
      <p className="mb-2 text-xs text-muted">
        <span className="font-medium text-ok-ink">+{diff.added.toLocaleString('en-US')}</span> added ·{' '}
        <span className="font-medium text-crit-ink">−{diff.removed.toLocaleString('en-US')}</span> removed
        {diff.truncated && ' · the list is cut for display'}
        {diff.coarse && ' · a large region without common lines is shown as replaced'}
      </p>
      <div className="overflow-auto rounded-ctl border border-line bg-canvas font-mono text-[12px] leading-[1.55]" style={{ maxHeight }} role="table" aria-label={label}>
        <table className="w-full border-collapse">
          <tbody>
            {diff.lines.map((l, i) => (
              <tr key={i} className={clsx(l.op === '+' && 'bg-ok-tint', l.op === '-' && 'bg-crit-tint')}>
                <td className="w-12 select-none border-r border-line/70 px-2 text-right align-top text-faint">{l.op === '+' || l.op === '…' ? '' : (l.a ?? 0) + 1}</td>
                <td className="w-12 select-none border-r border-line/70 px-2 text-right align-top text-faint">{l.op === '-' || l.op === '…' ? '' : (l.b ?? 0) + 1}</td>
                <td className={clsx('w-5 select-none px-1 text-center align-top', l.op === '+' ? 'text-ok-ink' : l.op === '-' ? 'text-crit-ink' : 'text-faint')} aria-label={l.op === '+' ? 'added' : l.op === '-' ? 'removed' : undefined}>
                  {l.op === '…' ? '' : l.op === ' ' ? '' : l.op === '-' ? '−' : '+'}
                </td>
                <td className={clsx('whitespace-pre-wrap break-all px-2 align-top', l.op === '+' ? 'text-ok-ink' : l.op === '-' ? 'text-crit-ink' : l.op === '…' ? 'text-faint' : 'text-ink-soft')}>
                  {l.op === '…' ? '⋯ unchanged lines' : l.text || ' '}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
