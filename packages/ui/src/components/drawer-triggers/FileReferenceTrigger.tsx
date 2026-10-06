// V1 attempt-3 Phase 4 — FileReferenceTrigger.
//
// Opens the drawer FileViewer with the caller's exact payload. Attribution
// (originInstance/project/anchor) travels inside FileViewerData unchanged;
// FileViewer captures the known selection at open time only when the caller
// supplied no originInstance.

import { type ReactNode, type CSSProperties } from "react";
import { useDrawerSelection } from "../AppShell.js";
import type { FileViewerData } from "../drawer-viewers/FileViewer.js";

interface FileReferenceTriggerProps {
  data: FileViewerData;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  testId?: string;
}

export function FileReferenceTrigger({ data, children, className, style, testId }: FileReferenceTriggerProps) {
  const { setSelection } = useDrawerSelection();
  return (
    <button
      type="button"
      data-testid={testId ?? "file-reference-trigger"}
      onClick={() => setSelection({ type: "file", data })}
      className={className ?? "text-left"}
      style={style}
    >
      {children}
    </button>
  );
}
