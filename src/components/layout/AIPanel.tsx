'use client';

import { ReactNode } from 'react';

export interface AITab {
  id: string;
  label: string;
}

/**
 * Desktop: fixed right column, always visible. Mobile: bottom sheet,
 * collapsed by default — opened via the "AI" tab in MobileNav. Same tab
 * strip and same content in both, so behavior never diverges by device.
 */
export function AIPanel({
  tabs,
  activeTab,
  onTabChange,
  openOnMobile,
  onCloseMobile,
  children,
  desktopStyle,
  onToggleExpand
}: {
  tabs: AITab[];
  activeTab: string;
  onTabChange: (id: string) => void;
  openOnMobile: boolean;
  onCloseMobile: () => void;
  children: ReactNode;
  // Desktop width is controlled by the parent (draggable + click-to-expand);
  // undefined falls back to the responsive default.
  desktopStyle?: React.CSSProperties;
  onToggleExpand?: () => void;
}) {
  const TabStrip = (
    <div className="flex gap-1 overflow-x-auto border-b border-line px-3 py-2">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onTabChange(t.id)}
          className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition ${
            activeTab === t.id ? 'bg-accent-soft text-accent-strong' : 'text-ink-soft hover:bg-black/5'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );

  return (
    <>
      {/* Desktop panel — persistent development workspace. Width is set by the
          parent via desktopStyle (drag handle + expand toggle); the responsive
          fallback keeps it sensible if no width is supplied. */}
      <aside
        style={desktopStyle}
        className={`relative hidden min-w-[22rem] max-w-[80vw] shrink-0 flex-col self-start border-l border-line bg-surface lg:sticky lg:top-0 lg:flex lg:h-dvh ${desktopStyle?.width ? '' : 'basis-1/2 xl:basis-[52%]'}`}
      >
        <div className="flex items-start justify-between border-b border-line px-4 py-3">
          <div className="min-w-0">
            <p className="font-display text-base text-ink">Development</p>
            <p className="mt-0.5 text-xs text-ink-faint">One question at a time — you stay the author.</p>
          </div>
          {onToggleExpand && (
            <button
              onClick={onToggleExpand}
              title="Expand / restore this panel"
              aria-label="Expand or restore the development panel"
              className="ml-2 hidden shrink-0 rounded-md border border-line px-2 py-1 text-sm leading-none text-ink-soft transition hover:border-accent hover:text-accent-strong lg:block"
            >
              ↔
            </button>
          )}
        </div>
        {TabStrip}
        <div className="flex-1 overflow-y-auto p-5 xl:p-6">{children}</div>
      </aside>

      {/* Mobile bottom sheet */}
      {openOnMobile && (
        <div className="fixed inset-0 z-40 flex flex-col justify-end lg:hidden">
          <div className="absolute inset-0 bg-black/30" onClick={onCloseMobile} />
          <div className="relative z-10 flex max-h-[80vh] flex-col rounded-t-2xl border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]">
            <div className="flex items-center justify-between px-4 pt-3">
              <div className="mx-auto h-1 w-10 rounded-full bg-line" />
            </div>
            <div className="flex items-center justify-between px-4 pt-2">
              <p className="font-display text-base text-ink">AI Assistant</p>
              <button onClick={onCloseMobile} className="rounded-md p-1.5 text-ink-soft hover:bg-black/5" aria-label="Close">
                ✕
              </button>
            </div>
            {TabStrip}
            <div className="flex-1 overflow-y-auto p-4">{children}</div>
          </div>
        </div>
      )}
    </>
  );
}
