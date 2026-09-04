'use client';

import { useEffect, useRef } from 'react';
import { useAutosave } from '@/hooks/useAutosave';
import type { WritingSection } from '@/lib/types/database';

const STATUS_LABEL: Record<string, string> = {
  idle: '',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Couldn’t save — retrying…'
};

export function SectionEditor({ section }: { section: WritingSection }) {
  const { content, setContent, status, wordCount } = useAutosave(section.id, section.content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [content]);

  return (
    <div>
      {/* Tap anywhere in the writing area to start typing (Word-like). A tall
          surface on phones gives a comfortable, easy-to-type page. */}
      <div className="min-h-[58vh] cursor-text sm:min-h-[20rem]" onClick={() => textareaRef.current?.focus()}>
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Write this section…"
          className="manuscript-textarea block w-full resize-none border-none bg-transparent p-0 text-ink outline-none placeholder:text-ink-faint"
          style={{ minHeight: '12rem' }}
        />
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-line pt-2 text-xs text-ink-faint">
        <span>{wordCount} words</span>
        <span className={status === 'error' ? 'text-critical' : ''}>{STATUS_LABEL[status]}</span>
      </div>
    </div>
  );
}
