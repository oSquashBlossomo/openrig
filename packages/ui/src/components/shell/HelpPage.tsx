// Help & actions — contextual keyboard/mobile help and action discovery.
//
// Every TUI section and command (help-registry.ts) with its GUI destination
// or established CLI/native equivalent and an explicit availability. The
// page performs no reads, so it stays usable while the daemon is loading,
// failing or offline; Back returns to the page it was opened from.

import { useCallback } from "react";
import { Link, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { cn } from "../../lib/utils.js";
import { SectionHeader } from "../ui/section-header.js";
import { CopyButton, SearchInput, Tag, useUrlSyncedText, type Tone } from "../operator/OperatorPrimitives.js";
import { DisplayZoneNote } from "../time/DisplayTime.js";
import { filterHelp, helpForPath, HELP_SECTIONS, type HelpAvailability, type HelpEntry, type HelpSection } from "./help-registry.js";
import { validateHelpSearch } from "./shell-search.js";

const AVAILABILITY: Record<HelpAvailability, { label: string; tone: Tone; meaning: string }> = {
  gui: { label: "In the GUI", tone: "good", meaning: "A reachable page performs it." },
  partial: { label: "Partial", tone: "warn", meaning: "Reachable, with the named gap." },
  pending: { label: "Not in GUI yet", tone: "warn", meaning: "Not available on these pages yet; use the stated TUI/CLI equivalent." },
  cli: { label: "CLI", tone: "info", meaning: "Offline or native operation; run the command on that machine." },
  native: { label: "Browser", tone: "muted", meaning: "The browser's own behavior is the equivalent." },
};

export function HelpPage() {
  const search = validateHelpSearch(useSearch({ strict: false }) as Record<string, unknown>);
  const navigate = useNavigate();
  const router = useRouter();
  const writeQuery = useCallback((q: string | undefined) => void navigate({
    to: "/help", search: (prev: Record<string, unknown>) => ({ ...validateHelpSearch(prev), q }), replace: true,
  }), [navigate]);
  const [query, setQuery] = useUrlSyncedText(search.q, writeQuery);
  const contextual = search.from ? helpForPath(search.from.split(/[?#]/)[0]!) : undefined;
  const sections = filterHelp(HELP_SECTIONS, query);
  const fromPath = search.from?.split(/[?#]/)[0];

  return (
    <div data-testid="help-page" className="mx-auto w-full max-w-[1000px] px-4 py-6 sm:px-6">
      <header className="mb-4 border-b border-outline-variant pb-4">
        <SectionHeader tone="muted">Help · actions</SectionHeader>
        <h1 className="mt-1 font-headline text-headline-md font-bold uppercase tracking-tight text-on-surface">Help & actions</h1>
        <p className="mt-1 max-w-[72ch] text-sm text-on-surface-variant">
          Every TUI section and command, with where to do it here or the existing CLI equivalent. This page reads nothing from the daemon,
          so it works while pages are loading, failing or offline.
        </p>
        {search.from ? (
          // Raw push of the exact originating href (no search re-stringify), so
          // identities such as project "1.0" come back byte for byte.
          <a href={search.from} data-testid="help-return" onClick={(event) => { event.preventDefault(); router.history.push(search.from!); }}
            className="mt-2 inline-block font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface underline">
            ← Back to {fromPath}
          </a>
        ) : null}
      </header>

      <SearchInput label="Find an action" testId="help-search" value={query} onChange={setQuery} placeholder="command, page, CLI, key" />

      <details className="mt-3 border border-outline-variant px-3 py-2" data-testid="help-legend">
        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant">What the availability labels mean</summary>
        <ul className="mt-2 space-y-1 text-xs">
          {(Object.keys(AVAILABILITY) as HelpAvailability[]).map((key) => (
            <li key={key} className="flex flex-wrap items-baseline gap-2"><Tag tone={AVAILABILITY[key].tone}>{AVAILABILITY[key].label}</Tag><span className="text-on-surface-variant">{AVAILABILITY[key].meaning}</span></li>
          ))}
        </ul>
      </details>

      {contextual && !query ? (
        <section aria-labelledby="help-contextual-heading" data-testid="help-contextual" className="mt-4 border border-on-surface bg-surface-lowest px-4 py-3">
          <h2 id="help-contextual-heading" className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-on-surface">On this page · {contextual.title}</h2>
          <p className="mt-1 text-xs text-on-surface-variant">{contextual.summary}</p>
          <EntryList entries={contextual.entries} testIdPrefix="help-contextual" />
        </section>
      ) : null}

      <nav aria-label="Help sections" className="mt-4 flex flex-wrap gap-1" data-testid="help-toc">
        {sections.map((section) => (
          <a key={section.id} href={`#help-${section.id}`} className="border border-outline-variant px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] hover:bg-surface-low">{section.title}</a>
        ))}
      </nav>

      {sections.length === 0 ? (
        <p data-testid="help-filter-empty" className="mt-4 border border-dashed border-outline-variant px-4 py-5 text-sm text-on-surface-variant">No action matches “{query}”. Try a page name, a TUI command or a CLI verb.</p>
      ) : sections.map((section) => <HelpSectionBlock key={section.id} section={section} />)}
    </div>
  );
}

function HelpSectionBlock({ section }: { section: HelpSection }) {
  return (
    <section id={`help-${section.id}`} aria-labelledby={`help-${section.id}-heading`} data-testid={`help-section-${section.id}`} className="mt-6 border-t border-outline-variant pt-3">
      <h2 id={`help-${section.id}-heading`} className="font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-on-surface">
        {section.title}
        {section.tuiSection ? <span className="ml-2 font-normal text-on-surface-variant">TUI :{section.tuiSection}</span> : null}
      </h2>
      <p className="mt-1 text-xs text-on-surface-variant">{section.summary}</p>
      {section.id === "config" ? <DisplayZoneNote testId="help-display-zone" className="mt-1 font-mono text-[10px] text-on-surface" /> : null}
      <EntryList entries={section.entries} testIdPrefix="help-entry" />
    </section>
  );
}

function EntryList({ entries, testIdPrefix }: { entries: HelpEntry[]; testIdPrefix: string }) {
  return (
    <ul className="mt-2 divide-y divide-outline-variant border border-outline-variant">
      {entries.map((entry) => {
        const availability = AVAILABILITY[entry.availability];
        return (
          <li key={entry.id} data-testid={`${testIdPrefix}-${entry.id}`} data-availability={entry.availability} className="px-3 py-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-sm font-medium text-on-surface">{entry.title}</span>
              <Tag tone={availability.tone}>{availability.label}</Tag>
              <code className="break-all font-mono text-[10px] text-on-surface-variant">{entry.tui}</code>
            </div>
            <p className="mt-0.5 break-words text-xs text-on-surface-variant [overflow-wrap:anywhere]">{entry.description}</p>
            {entry.targets?.length ? (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {entry.targets.map((target) => (
                  <Link key={`${target.to}-${target.label}`} to={target.to as never} search={(target.search ?? {}) as never}
                    data-testid={`${testIdPrefix}-${entry.id}-link`}
                    className={cn("inline-flex min-h-[32px] items-center border border-on-surface px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] hover:bg-surface-low",
                      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface")}>
                    {target.label} →
                  </Link>
                ))}
              </div>
            ) : null}
            {entry.cli?.length ? (
              <ul className="mt-1 space-y-0.5">
                {entry.cli.map((command) => (
                  <li key={command} className="flex flex-wrap items-center gap-2">
                    <code className="break-all bg-surface-low px-1 font-mono text-[11px] text-on-surface">{command}</code>
                    <CopyButton value={command} label="Copy" />
                  </li>
                ))}
              </ul>
            ) : null}
            {entry.keys ? <p className="mt-1 font-mono text-[10px] text-on-surface-variant">Keys: {entry.keys}</p> : null}
            {entry.note ? <p className="mt-1 text-xs text-on-surface-variant">{entry.note}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}
