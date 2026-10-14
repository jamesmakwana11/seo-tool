import type { ReactNode } from 'react';

/** Shared frame for login / recovery / reset screens. */
export function AuthFrame({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-canvas">
      <div className="hidden w-[42%] flex-col justify-between border-r border-line bg-raised p-10 text-ink lg:flex">
        <div className="flex items-center gap-2.5">
          <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden><rect width="32" height="32" rx="8" fill="#7650D8" /><circle cx="16" cy="16" r="8.5" fill="none" stroke="#FFFFFF" strokeWidth="2.6" strokeDasharray="38 16" strokeLinecap="round" /><circle cx="16" cy="16" r="2.8" fill="#FFFFFF" /></svg>
          <span className="text-lg font-semibold">SEO Sentinel</span>
        </div>
        <div className="max-w-md">
          <p className="text-[30px] font-semibold leading-[1.2] tracking-[-0.02em]">What broke on each of your websites today, how serious it is, and exactly what to do about it.</p>
          <p className="mt-4 text-sm leading-relaxed text-muted">Daily audits across technical, on-page, content, off-page, AEO, GEO and AI-content compliance — each finding turned into a Fix Card for the 1into2 SEO, Content or Development team.</p>
        </div>
        <p className="text-xs text-faint">Internal tool · DeoDap</p>
      </div>
      <div className="flex flex-1 items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-md rounded-panel border border-line bg-surface p-6 shadow-lift sm:p-8">
          <h1 className="text-xl font-semibold text-ink">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </div>
  );
}
