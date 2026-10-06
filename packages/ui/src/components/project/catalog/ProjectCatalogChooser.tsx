// Truthful catalog chooser. Every served entry appears, including unavailable
// ones with their reason. Equal display names are flagged; identity is always
// the exact catalog ID plus canonical root. Nothing is chosen implicitly.

import type { CatalogProject, ProjectCatalog, ProjectSelection } from "../../../lib/project-read.js";
import { cn } from "../../../lib/utils.js";
import { listKeyboard, Tag } from "./evidence-ui.js";
import { duplicateNameCounts } from "./project-location.js";

export function ProjectCatalogChooser({ catalog, selection, onChoose, testId = "project-catalog" }: {
  catalog: ProjectCatalog; selection: ProjectSelection | null; onChoose: (project: CatalogProject) => void; testId?: string;
}) {
  const names = duplicateNameCounts(catalog.projects);
  return (
    <nav aria-label="Project catalog" data-testid={testId}>
      <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-on-surface-variant">
        Catalog · {catalog.projects.length} project{catalog.projects.length === 1 ? "" : "s"}
      </p>
      <p className="mb-2 break-all font-mono text-[10px] text-on-surface-variant" title="Catalog file served by the connected instance">{catalog.catalogPath}</p>
      {catalog.projects.length === 0 ? (
        <p data-testid={`${testId}-empty`} className="border border-dashed border-outline-variant p-3 text-sm text-on-surface-variant">
          The catalog lists no projects. Add projects to the workspace catalog to browse them here.
        </p>
      ) : (
        <ul onKeyDown={(e) => listKeyboard(e)} className="space-y-1.5">
          {catalog.projects.map((project) => {
            const selected = selection?.id === project.id && selection.root === project.root;
            const twins = (names.get(project.name) ?? 1) - 1;
            const unavailable = project.error !== undefined;
            return (
              <li key={`${project.id}\u0000${project.root}`}>
                <button type="button" data-nav-item disabled={unavailable} aria-current={selected ? "true" : undefined}
                  data-testid={`${testId}-entry-${project.id}`} data-root={project.root}
                  onClick={() => onChoose(project)}
                  className={cn("w-full border px-2.5 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface",
                    selected ? "border-on-surface bg-surface-low" : "border-outline-variant bg-surface-lowest hover:border-on-surface",
                    unavailable && "cursor-not-allowed border-dashed opacity-80 hover:border-outline-variant")}>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-headline text-sm font-bold uppercase tracking-tight text-on-surface">{project.name}</span>
                    {selected ? <Tag tone="neutral">selected</Tag> : null}
                    {unavailable ? <Tag tone="bad" testId={`${testId}-entry-${project.id}-unavailable`}>unavailable</Tag> : null}
                    {twins > 0 ? <Tag tone="warn" testId={`${testId}-entry-${project.id}-same-name`} title="Identify this project by ID and root">same name ×{twins + 1}</Tag> : null}
                  </span>
                  <span className="mt-0.5 block font-mono text-[11px] text-on-surface">id {project.id}</span>
                  <span className="block break-all font-mono text-[10px] text-on-surface-variant">{project.root}</span>
                  {unavailable ? <span className="mt-1 block text-xs text-tertiary">{project.error}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
