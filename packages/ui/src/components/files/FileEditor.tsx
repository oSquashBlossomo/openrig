// Whole-file text editor for the Files workspace.
//
// Save replaces the WHOLE file with the draft, guarded by the full-file
// mtime + contentHash CAS. The CAS proves the disk has not changed since the
// read; it cannot prove the read was the whole file. So the editor is only
// offered for reads that are complete, valid UTF-8 (assessFileEditability),
// and it re-checks the newest cached read at click time.
//
// Line endings: the textarea always holds the LF projection of the raw base
// (HTML textarea values are LF). prepareFileTextWrite serializes the draft
// back against the RAW base: uniform LF/CRLF/CR files keep their separator;
// an unchanged mixed file returns its original bytes; a changed mixed file
// needs a deliberate, visible whole-draft choice for this base. Native
// typing/paste/IME/undo stay in control: no beforeinput ranges, no custom
// undo stack, no silent normalization.
//
// Drafts live in the per-QueryClient draft store, so leaving the file, root,
// route or host never saves or discards them implicitly.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useFilesWrite, type FilesReadResponse, type FileWriteResult } from "../../hooks/useFiles.js";
import {
  analyzeFileText,
  prepareFileTextWrite,
  type FileLineEnding,
  type FileLineEndingCounts,
  type FileTextAnalysis,
} from "../../lib/files-text-draft.js";
import { fileOriginAdmission, fileTargetKey } from "./file-source.js";
import { useKnownSelectedHost } from "./useFileAdmission.js";
import { isDraftDirty, useFileDraft, useFileDraftStore, type FileDraft, type FileDraftBase } from "./file-drafts.js";

export type FileEditability =
  | { editable: true }
  | { editable: false; reason: "truncated" | "binary" | "unverified"; detail: string };

const utf8Encoder = new TextEncoder();

/** Whether a read is the complete, exact text of the file, so that a
 *  whole-file save of an edited copy loses nothing it did not change.
 *  Unknown metadata counts as unverified rather than complete. */
export function assessFileEditability(read: FilesReadResponse): FileEditability {
  if (read.truncated === true) {
    const shownKb = Math.round((read.truncatedAtBytes ?? 0) / 1024);
    const totalKb = Math.round((read.totalBytes ?? read.size) / 1024);
    return {
      editable: false,
      reason: "truncated",
      detail: `this view is a truncated ${shownKb} KB preview of a ${totalKb} KB file. Saving it would replace the whole file and drop everything after the preview. Edit the full file in an external editor.`,
    };
  }
  if (read.binary === true) {
    return {
      editable: false,
      reason: "binary",
      detail: "this file is binary or not valid UTF-8. The text editor would re-encode its bytes on save. Edit it with an external tool.",
    };
  }
  const unverified = (why: string): FileEditability => ({
    editable: false,
    reason: "unverified",
    detail: `${why} Reload the file or edit it in an external editor.`,
  });
  if (read.truncated !== false || read.binary !== false) {
    return unverified("the daemon did not confirm this read is the complete UTF-8 text of the file.");
  }
  if (typeof read.content !== "string" || !read.mtime || !read.contentHash) {
    return unverified("the read is missing its content or change-detection fields.");
  }
  const returnedBytes = utf8Encoder.encode(read.content).length;
  if (returnedBytes !== read.totalBytes || returnedBytes !== read.size) {
    return unverified(`the returned text is ${returnedBytes} bytes but the file reports ${read.totalBytes ?? "unknown"} bytes read and ${read.size} bytes on disk.`);
  }
  try { analyzeFileText(read.content); }
  catch { return unverified("the returned text is not valid Unicode."); }
  return { editable: true };
}

export function EditUnavailableNotice({ editability }: { editability: Extract<FileEditability, { editable: false }> }) {
  return (
    <div
      data-testid="files-edit-unavailable"
      data-reason={editability.reason}
      role="status"
      className="mx-4 mt-4 border border-outline-variant bg-background px-3 py-2 font-mono text-[10px] text-on-surface"
    >
      Read-only: {editability.detail}
    </div>
  );
}

interface EditorBase extends FileDraftBase {
  analysis: FileTextAnalysis;
}

function baseFromRead(read: FilesReadResponse): EditorBase | null {
  try {
    const analysis = analyzeFileText(read.content);
    return { raw: read.content, lfText: analysis.lfText, mtime: read.mtime, contentHash: read.contentHash, analysis };
  } catch {
    return null;
  }
}

const ENDING_LABEL: Record<FileLineEnding, string> = { lf: "LF", crlf: "CRLF", cr: "CR" };

function countsText(counts: FileLineEndingCounts): string {
  return `${counts.lf} LF · ${counts.crlf} CRLF · ${counts.cr} CR`;
}

function sameBase(base: FileDraftBase, read: FilesReadResponse): boolean {
  return base.mtime === read.mtime && base.contentHash === read.contentHash && base.raw === read.content;
}

export function FileEditor({ root, path, read, originInstance }: {
  root: string;
  path: string;
  read: FilesReadResponse;
  /** Exact origin of this file; defaults to the known selection at mount. */
  originInstance?: string | null;
}) {
  const known = useKnownSelectedHost();
  // Attribution is captured once: a later host switch must not re-key or
  // re-attribute a retained draft.
  const [origin] = useState<string | null>(() => (originInstance !== undefined ? originInstance : known ?? null));
  const key = fileTargetKey({ originInstance: origin, root, path });
  const store = useFileDraftStore();
  const draft = useFileDraft(store, key);
  const editability = useMemo(() => assessFileEditability(read), [read]);
  const readBase = useMemo(() => baseFromRead(read), [read]);
  const write = useFilesWrite();
  const qc = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const choiceRef = useRef<HTMLFieldSetElement>(null);
  const [composing, setComposing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savedIndicator, setSavedIndicator] = useState(false);

  // After OUR write lands, the refreshed read carries exactly the bytes we
  // wrote: rebase onto it, keeping any typing made while the write was
  // pending. Any other new read leaves the draft on its original base.
  useEffect(() => {
    if (!draft?.saved || !readBase) return;
    if (read.contentHash !== draft.saved.contentHash || read.content !== draft.saved.raw) return;
    if (draft.draftLf === readBase.lfText) store.delete(key);
    else store.set({ ...draft, base: { raw: readBase.raw, lfText: readBase.lfText, mtime: readBase.mtime, contentHash: readBase.contentHash }, saved: undefined, mixedChoice: undefined, conflict: undefined });
  }, [draft, read, readBase, store, key]);

  const draftBase = useMemo(() => (draft ? baseFromRead({ ...read, content: draft.base.raw, mtime: draft.base.mtime, contentHash: draft.base.contentHash }) : null), [draft, read]);

  // Defend the editor itself, not only the toolbar gate: a direct render or
  // a refetch onto an unsafe read never exposes a draft or a save.
  if (!editability.editable || !readBase) {
    return (
      <div data-testid="files-editor" data-readonly="true">
        <EditUnavailableNotice editability={editability.editable ? { editable: false, reason: "unverified", detail: "the returned text is not valid Unicode. Reload the file or edit it in an external editor." } : editability} />
      </div>
    );
  }

  const base: EditorBase = draftBase ?? readBase;
  const value = draft?.draftLf ?? base.lfText;
  const dirty = value !== base.lfText;
  const stale = !!draft && !sameBase(draft.base, read) && !(draft.saved && read.contentHash === draft.saved.contentHash && read.content === draft.saved.raw);
  const mixed = base.analysis.ending === "mixed";

  const commit = (nextLf: string) => {
    setSaveError(null);
    setNotice(null);
    const current = store.get(key);
    if (current) {
      const keep = current.mixedChoice || current.conflict || current.saved || !sameBase(current.base, read);
      if (nextLf === current.base.lfText && !keep) store.delete(key);
      else store.set({ ...current, draftLf: nextLf });
    } else if (nextLf !== base.lfText) {
      const record: FileDraft = {
        key, originInstance: origin, root, path,
        base: { raw: base.raw, lfText: base.lfText, mtime: base.mtime, contentHash: base.contentHash },
        draftLf: nextLf,
      };
      store.set(record);
    }
  };

  const discard = () => {
    store.delete(key);
    setSaveError(null);
    setNotice(null);
  };

  const save = () => {
    setSaveError(null);
    setNotice(null);
    setSavedIndicator(false);
    if (composing) {
      setSaveError("not saved. Finish the current text composition first.");
      return;
    }
    // The live textarea value is the coherent click-time draft, even if a
    // React render of the latest keystroke has not happened yet.
    const candidate = textareaRef.current?.value ?? value;
    if (candidate !== value) commit(candidate);
    const current = store.get(key);
    const working: FileDraftBase = current?.base ?? base;
    const admission = fileOriginAdmission(origin, qc.getQueryData<{ selected?: string }>(["hosts"])?.selected);
    if (!admission.admitted) {
      setSaveError(`not saved. ${admission.message}`);
      return;
    }
    // Re-check the newest cached read at click time: it must still be the
    // complete snapshot the draft came from. The daemon CAS then checks the
    // disk bytes against those same tokens.
    const latest = qc.getQueryData<FilesReadResponse>(["files", "read", root, path]) ?? read;
    const latestEditability = assessFileEditability(latest);
    if (!latestEditability.editable) {
      setSaveError(`not saved. Read-only: ${latestEditability.detail}`);
      return;
    }
    if (latest.mtime !== working.mtime || latest.contentHash !== working.contentHash || latest.content !== working.raw) {
      setSaveError("not saved. The file was re-read after this draft was started; review the current content before saving.");
      return;
    }
    const prepared = prepareFileTextWrite(working.raw, candidate, current?.mixedChoice);
    if (prepared.kind === "mixed-policy-required") {
      setSaveError(`not saved. This file mixes line endings (${countsText(prepared.counts)}). Choose how this edited draft saves its line endings first.`);
      choiceRef.current?.focus();
      return;
    }
    if (prepared.kind === "invalid-draft") {
      setSaveError(`not saved. The draft could not be serialized safely (${prepared.reason}); it is kept unchanged.`);
      return;
    }
    if (!prepared.dirty) {
      setNotice("Nothing to save: the draft matches the file's current bytes.");
      return;
    }
    const savedRaw = prepared.content;
    write.mutate(
      {
        root,
        path,
        content: savedRaw,
        expectedMtime: working.mtime,
        expectedContentHash: working.contentHash,
        actor: "ui-files-edit-mode",
      },
      {
        onSuccess: (result: FileWriteResult) => {
          const record: FileDraft = store.get(key) ?? { key, originInstance: origin, root, path, base: working, draftLf: candidate };
          if ("conflict" in result) {
            store.set({ ...record, conflict: { currentMtime: result.currentMtime, currentContentHash: result.currentContentHash } });
          } else {
            store.set({ ...record, conflict: undefined, saved: { raw: savedRaw, contentHash: result.newContentHash } });
            setSavedIndicator(true);
            setTimeout(() => setSavedIndicator(false), 2000);
          }
        },
        onError: (err) => {
          setSaveError(err instanceof Error ? err.message : String(err));
        },
      },
    );
  };

  const ending = base.analysis.ending;
  const endingSummary = ending === "mixed"
    ? `Mixed line endings: ${countsText(base.analysis.counts)}`
    : ending === "none"
      ? "No line breaks yet — new lines save as LF"
      : `Line endings: ${ENDING_LABEL[ending]} — preserved on save`;

  return (
    <div data-testid="files-editor" data-dirty={dirty} data-composing={composing} className="flex h-full flex-col">
      {/* Sticky so Save / Discard stay reachable while a long draft (or an
          on-screen keyboard) scrolls the content pane. */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-outline-variant bg-amber-50 px-3 py-1.5 font-mono text-[10px]">
        <span className="font-bold text-amber-900" data-testid="files-editor-status" role="status">
          {dirty ? "draft (unsaved)" : "no changes"}
        </span>
        <button
          type="button"
          data-testid="files-editor-save"
          disabled={!dirty || write.isPending || composing}
          onClick={save}
          className="touch-target border border-emerald-500 bg-emerald-50 px-2 py-0.5 uppercase tracking-[0.10em] text-emerald-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {write.isPending ? "saving…" : "save"}
        </button>
        <button
          type="button"
          data-testid="files-editor-cancel"
          disabled={!draft}
          onClick={discard}
          title="Discard this draft and show the file as last read"
          className="touch-target border border-outline bg-surface-lowest px-2 py-0.5 uppercase tracking-[0.10em] text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
        >
          discard
        </button>
        <span
          data-testid="files-editor-line-endings"
          data-ending={base.analysis.ending}
          className="text-amber-900/80"
        >
          {endingSummary}
        </span>
        {savedIndicator && (
          <span data-testid="files-editor-saved" className="ml-auto text-emerald-700">saved</span>
        )}
      </div>
      {mixed && dirty && (
        <fieldset
          ref={choiceRef}
          tabIndex={-1}
          data-testid="files-editor-mixed-choice"
          data-choice={draft?.mixedChoice ?? ""}
          className="border-b border-amber-300 bg-amber-50/60 px-3 py-2 font-mono text-[10px] text-amber-950 outline-none focus-visible:ring-1 focus-visible:ring-amber-500"
        >
          <legend className="sr-only">Line endings for this edited draft</legend>
          <div className="mb-1 font-bold">For this edited draft, save all line endings as:</div>
          <div className="flex flex-wrap gap-3">
            {(["lf", "crlf", "cr"] as const).map((ending) => (
              <label key={ending} className="touch-target inline-flex items-center gap-1">
                <input
                  type="radio"
                  name={`files-editor-mixed-${key}`}
                  data-testid={`files-editor-mixed-choice-${ending}`}
                  value={ending}
                  checked={draft?.mixedChoice === ending}
                  onChange={() => { const d = store.get(key); if (d) store.set({ ...d, mixedChoice: ending }); setSaveError(null); }}
                />
                {ENDING_LABEL[ending]}
              </label>
            ))}
          </div>
          <p className="mt-1 leading-relaxed">
            This file mixes {countsText(base.analysis.counts)}. Saving an edited draft replaces every existing line ending with the
            one you choose; exact mixed endings cannot be kept once the text changes. No choice means nothing is saved, and
            undoing back to the original text saves nothing.
          </p>
        </fieldset>
      )}
      {draft?.conflict && (
        <div data-testid="files-editor-conflict" role="alert" className="flex flex-wrap items-center gap-2 border-b border-red-200 bg-red-50 px-3 py-2 font-mono text-[10px] text-red-900">
          <span className="flex-1">
            File changed externally. Local mtime <code>{draft.base.mtime}</code> ≠ server <code>{draft.conflict.currentMtime}</code>. Your draft is kept. Refresh discards it and loads the current file — copy anything you need first.
          </span>
          <button
            type="button"
            data-testid="files-editor-refresh"
            onClick={() => {
              store.delete(key);
              qc.invalidateQueries({ queryKey: ["files", "read", root, path] });
            }}
            className="touch-target border border-red-500 bg-surface-lowest px-2 py-0.5 uppercase tracking-[0.10em] text-red-900"
          >
            refresh
          </button>
        </div>
      )}
      {stale && !draft?.conflict && (
        <div data-testid="files-editor-stale" role="alert" className="flex flex-wrap items-center gap-2 border-b border-red-200 bg-red-50 px-3 py-2 font-mono text-[10px] text-red-900">
          <span className="flex-1">
            The file changed on disk after this draft started (draft base {draft!.base.contentHash.slice(0, 12)}…, current {read.contentHash.slice(0, 12)}…). Save is blocked; copy what you need, then discard to load the current file.
          </span>
          <button type="button" data-testid="files-editor-discard-stale" onClick={discard}
            className="touch-target border border-red-500 bg-surface-lowest px-2 py-0.5 uppercase tracking-[0.10em] text-red-900">
            discard draft
          </button>
        </div>
      )}
      {saveError && (
        <div data-testid="files-editor-error" role="alert" className="border-b border-red-200 bg-red-50 px-3 py-2 font-mono text-[10px] text-red-900">
          Save failed: {saveError}
        </div>
      )}
      {notice && (
        <div data-testid="files-editor-notice" role="status" className="border-b border-outline-variant bg-background px-3 py-2 font-mono text-[10px] text-on-surface">
          {notice}
        </div>
      )}
      <textarea
        ref={textareaRef}
        data-testid="files-editor-textarea"
        aria-label={`Edit ${root}/${path}`}
        value={value}
        onChange={(e) => commit(e.target.value)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={(e) => { setComposing(false); commit(e.currentTarget.value); }}
        // touch-text: 16px on coarse pointers so iOS does not zoom on focus.
        className="touch-text min-h-[16rem] flex-1 resize-none border-0 bg-background p-3 font-mono text-[12px] leading-relaxed text-on-surface outline-none"
        spellCheck={false}
      />
    </div>
  );
}

/** Notice for a draft that is retained while its editor is not shown. */
export function RetainedDraftNotice({ draft, onResume, onDiscard }: { draft: FileDraft; onResume?: () => void; onDiscard: () => void }) {
  if (!isDraftDirty(draft) && !draft.conflict) return null;
  return (
    <div data-testid="files-draft-retained" role="status" className="mx-4 mt-4 flex flex-wrap items-center gap-2 border border-amber-400 bg-amber-50 px-3 py-2 font-mono text-[10px] text-amber-900">
      <span className="flex-1">
        An unsaved draft of this file is kept in this browser tab (started from {draft.base.mtime}). It is never saved or discarded without your action.
      </span>
      {onResume && (
        <button type="button" data-testid="files-draft-resume" onClick={onResume} className="touch-target border border-amber-500 bg-surface-lowest px-2 py-0.5 uppercase tracking-[0.10em]">
          resume editing
        </button>
      )}
      <button type="button" data-testid="files-draft-discard" onClick={onDiscard} className="touch-target border border-outline bg-surface-lowest px-2 py-0.5 uppercase tracking-[0.10em] text-on-surface">
        discard draft
      </button>
    </div>
  );
}
