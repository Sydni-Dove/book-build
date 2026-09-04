'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const DEBOUNCE_MS = 800;
const RETRY_MS = 5000;

export function wordCount(text: string) {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Shared debounced text autosave. Content lives in local
 * React state at all times — a failed request never erases what the author
 * typed. On failure we surface a quiet "Saved" -> "error" flip and retry on
 * an interval until it succeeds or the author edits again (which restarts
 * the normal debounce with the latest text anyway).
 */
function useDebouncedTextAutosave(
  initialContent: string,
  saveText: (text: string) => Promise<{ error: unknown | null }>
) {
  const [content, setContent] = useState(initialContent);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const retryRef = useRef<ReturnType<typeof setInterval>>();
  const latestContentRef = useRef(initialContent);

  const save = useCallback(
    async (text: string) => {
      setStatus('saving');
      const { error } = await saveText(text);

      if (error) {
        setStatus('error');
        if (!retryRef.current) {
          retryRef.current = setInterval(() => {
            save(latestContentRef.current);
          }, RETRY_MS);
        }
      } else {
        setStatus('saved');
        if (retryRef.current) {
          clearInterval(retryRef.current);
          retryRef.current = undefined;
        }
      }
    },
    [saveText]
  );

  useEffect(() => {
    latestContentRef.current = content;
    if (content === initialContent) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => save(content), DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  useEffect(() => {
    return () => {
      if (retryRef.current) clearInterval(retryRef.current);
    };
  }, []);

  return { content, setContent, status, wordCount: wordCount(content) };
}

export function useAutosave(sectionId: string, initialContent: string) {
  const supabase = createClient();
  const saveText = useCallback(
    async (text: string) => {
      const { error } = await supabase
        .from('writing_sections')
        .update({ content: text, word_count: wordCount(text) })
        .eq('id', sectionId);
      return { error };
    },
    [sectionId, supabase]
  );

  return useDebouncedTextAutosave(initialContent, saveText);
}

export function useWorkingNoteAutosave(
  noteId: string,
  initialContent: string,
  onSaved?: (content: string) => void
) {
  const supabase = createClient();
  const saveText = useCallback(
    async (text: string) => {
      const { error } = await supabase
        .from('working_notes')
        .update({ content: text })
        .eq('id', noteId);
      if (!error) onSaved?.(text);
      return { error };
    },
    [noteId, onSaved, supabase]
  );

  return useDebouncedTextAutosave(initialContent, saveText);
}
