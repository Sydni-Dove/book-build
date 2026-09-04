'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Button, Textarea } from '@/components/ui';
import type { DevelopmentNotesResult } from '@/lib/ai/prompts/develop';

type Turn = { role: 'assistant' | 'author'; text: string };
type InterviewExport = {
  fileName: string;
  contentType: string;
  content: string;
};

const NOTE_LABELS: Record<keyof DevelopmentNotesResult, string> = {
  location: 'Location',
  people_present: 'People present',
  emotional_state: "Character's emotional state",
  scene_objective: 'Scene objective',
  conflict: 'Conflict',
  revelations: 'Important revelations',
  possible_ending: 'Possible ending',
  continuity_considerations: 'Continuity considerations'
};

export function DevelopThisPanel({
  bookId,
  chapterId,
  sectionId,
  workingNoteId,
  initialSeedIdea = ''
}: {
  bookId: string;
  chapterId: string;
  sectionId?: string;
  workingNoteId?: string;
  initialSeedIdea?: string;
}) {
  const supabase = createClient();
  const [seedIdea, setSeedIdea] = useState(initialSeedIdea);
  const [interviewId, setInterviewId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [answer, setAnswer] = useState('');
  const [sufficient, setSufficient] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notes, setNotes] = useState<DevelopmentNotesResult | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);

  async function loadExport() {
    if (!interviewId) return null;
    const res = await fetch(`/api/ai/interviews/${interviewId}/export`);
    if (!res.ok) throw new Error((await res.json()).error);
    return (await res.json()) as InterviewExport;
  }

  async function copyConversation() {
    setExportStatus(null);
    try {
      const data = await loadExport();
      if (!data) return;
      await navigator.clipboard.writeText(data.content);
      setExportStatus('Conversation copied.');
    } catch (e) {
      setExportStatus(e instanceof Error ? e.message : 'Could not copy the conversation.');
    }
  }

  async function downloadConversation() {
    setExportStatus(null);
    try {
      const data = await loadExport();
      if (!data) return;
      const blob = new Blob([data.content], { type: data.contentType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = data.fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setExportStatus('Conversation downloaded.');
    } catch (e) {
      setExportStatus(e instanceof Error ? e.message : 'Could not download the conversation.');
    }
  }

  async function shareConversation() {
    setExportStatus(null);
    try {
      const data = await loadExport();
      if (!data) return;
      if (!navigator.share) {
        await copyConversation();
        setExportStatus('Sharing is not available here, so the conversation was copied.');
        return;
      }

      const file = new File([data.content], data.fileName, { type: data.contentType });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: 'Book Build interview', text: 'Book Build interview export', files: [file] });
      } else {
        await navigator.share({ title: 'Book Build interview', text: data.content });
      }
      setExportStatus('Share sheet opened.');
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setExportStatus(e instanceof Error ? e.message : 'Could not share the conversation.');
    }
  }

  function ExportConversationActions() {
    if (!interviewId) return null;

    return (
      <div className="rounded-lg border border-line bg-paper-sunken p-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="secondary" onClick={copyConversation} className="min-h-11 flex-1">
            Copy conversation
          </Button>
          <Button type="button" variant="secondary" onClick={downloadConversation} className="min-h-11 flex-1">
            Download
          </Button>
          <Button type="button" variant="secondary" onClick={shareConversation} className="min-h-11 flex-1">
            Share
          </Button>
        </div>
        {exportStatus && <p className="mt-2 text-xs text-ink-soft">{exportStatus}</p>}
      </div>
    );
  }

  async function start() {
    if (!seedIdea.trim() && !workingNoteId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ai/develop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId, chapterId, sectionId, seedIdea, workingNoteId })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const data = await res.json();
      setInterviewId(data.interviewId);
      setTurns([{ role: 'assistant', text: data.question }]);
      setSufficient(data.sufficient);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  async function sendAnswer() {
    if (!answer.trim() || !interviewId) return;
    setLoading(true);
    setError(null);
    const authorText = answer;
    setTurns((t) => [...t, { role: 'author', text: authorText }]);
    setAnswer('');
    try {
      const res = await fetch('/api/ai/develop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interviewId, authorAnswer: authorText })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const data = await res.json();
      setTurns((t) => [...t, { role: 'assistant', text: data.question }]);
      setSufficient(data.sufficient);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  async function finish() {
    if (!interviewId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ai/develop/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interviewId })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const data = await res.json();
      setNotes(data.notes);
      const allChecked: Record<string, boolean> = {};
      Object.keys(data.notes).forEach((k) => (allChecked[k] = true));
      setChecked(allChecked);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  async function addToCanon() {
    if (!notes || !interviewId) return;
    const rows = (Object.keys(notes) as (keyof DevelopmentNotesResult)[])
      .filter((k) => checked[k] && notes[k] && (Array.isArray(notes[k]) ? (notes[k] as string[]).length : true))
      .map((k) => {
        const value = notes[k];
        const text = Array.isArray(value) ? value.join('; ') : value;
        return {
          book_id: bookId,
          fact_type: 'development_note',
          subject_type: 'general' as const,
          fact: `${NOTE_LABELS[k]}: ${text}`,
          // Develop This is the Socratic "development" interview — distinct
          // from the Help Me Continue / Before You Continue flow, which
          // tags its own answers 'before_you_continue'.
          source_type: 'interview_answer' as const,
          source_id: interviewId,
          // The author checked this item and pressed "Add to Canon" — that
          // click is the explicit approval gate. manuscript_status and
          // reality_layer are left at their defaults (not_checked /
          // unclassified): nothing here has been checked against the
          // manuscript or classified as physical-vs-dream/vision yet.
          canon_status: 'author_canon' as const
        };
      });
    if (rows.length) await supabase.from('canon_facts').insert(rows);
  }

  function reset() {
    setSeedIdea('');
    setInterviewId(null);
    setTurns([]);
    setNotes(null);
    setSufficient(false);
    setExportStatus(null);
  }

  if (notes) {
    return (
      <div className="space-y-4">
        <p className="font-display text-base text-ink">What You've Established</p>
        <div className="space-y-2">
          {(Object.keys(notes) as (keyof DevelopmentNotesResult)[]).map((k) => {
            const value = notes[k];
            if (!value || (Array.isArray(value) && value.length === 0)) return null;
            return (
              <label key={k} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!!checked[k]}
                  onChange={(e) => setChecked((c) => ({ ...c, [k]: e.target.checked }))}
                  className="mt-1"
                />
                <span>
                  <span className="font-medium text-ink">{NOTE_LABELS[k]}: </span>
                  <span className="text-ink-soft">{Array.isArray(value) ? value.join('; ') : value}</span>
                </span>
              </label>
            );
          })}
        </div>
        <Button onClick={addToCanon} className="w-full">
          Add selected items to Canon
        </Button>
        <ExportConversationActions />
        <button onClick={reset} className="block text-xs text-ink-faint hover:text-accent-strong">
          Start a new development interview
        </button>
      </div>
    );
  }

  if (!interviewId) {
    return (
      <div className="space-y-3">
        <p className="font-display text-base text-ink">Develop This</p>
        <p className="text-sm text-ink-soft">Give me a rough idea for the scene — I'll ask one question at a time to help you think it through.</p>
        <Textarea
          value={seedIdea}
          onChange={(e) => setSeedIdea(e.target.value)}
          rows={3}
          placeholder="e.g. Daniella goes to the prophetic meeting with Selah."
        />
        {error && <p className="text-sm text-critical">{error}</p>}
        <Button onClick={start} disabled={loading || (!seedIdea.trim() && !workingNoteId)} className="w-full">
          {loading ? 'Thinking…' : 'Start'}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Editorial marginalia — the AI's voice reads like a note in the
          margin, not a chat bubble: a compact uppercase label carries the
          speaker instead of an avatar, and a colored left rule keeps it
          quiet on the page. */}
      <div className="flex flex-1 flex-col gap-3.5 overflow-y-auto">
        {turns.map((t, i) => (
          <div key={i} className={`border-l-2 py-px pl-3.5 ${t.role === 'assistant' ? 'border-accent' : 'border-gold'}`}>
            <span
              className={`mb-0.5 block text-[10px] font-extrabold uppercase tracking-wider ${
                t.role === 'assistant' ? 'text-accent-strong' : 'text-gold-strong'
              }`}
            >
              {t.role === 'assistant' ? 'Editor' : 'You'}
            </span>
            <span className={`text-[14.5px] leading-snug ${t.role === 'assistant' ? 'font-medium text-ink' : 'text-ink-soft'}`}>
              {t.text}
            </span>
          </div>
        ))}
      </div>
      {sufficient && (
        <p className="mt-2 rounded-md bg-confirmed-soft px-3 py-2 text-xs text-ink">
          There may be enough established now — keep going, or wrap up below.
        </p>
      )}
      {error && <p className="mt-2 text-sm text-critical">{error}</p>}
      <div className="mt-3 space-y-2 border-t border-line pt-3">
        <ExportConversationActions />
        <Textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={2} placeholder="Your answer…" />
        <div className="flex gap-2">
          <Button onClick={sendAnswer} disabled={loading || !answer.trim()} className="flex-1">
            {loading ? '…' : 'Answer'}
          </Button>
          <Button variant="secondary" onClick={finish} disabled={loading}>
            Finish Interview
          </Button>
        </div>
      </div>
    </div>
  );
}
