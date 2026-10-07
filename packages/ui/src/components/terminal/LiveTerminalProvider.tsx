// OPR.0.4.0.1 — React context wrapping ONE global LiveTerminalRegistry.
//
// PM-locked: the cap is GLOBAL, so a single provider is mounted ABOVE all three
// terminal surfaces (graph + table + topology) and every ProgressiveTerminal
// shares the one registry. The cap comes from config
// (ui.terminal.max_live_terminals) with MAX_LIVE_TERMINALS as the default; a cap
// change is applied to the same registry (rare, config-driven). When no provider is
// present (e.g. an isolated render) a lazily-created module singleton keeps the
// cap global-by-construction instead of crashing.

import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { LiveTerminalRegistry, MAX_LIVE_TERMINALS } from "./live-terminal-registry.js";
import { useSettings } from "../../hooks/useSettings.js";

/** OPR.0.4.0.1 — read the configured global cap
 *  (ui.terminal.max_live_terminals), falling back to MAX_LIVE_TERMINALS when
 *  unset/invalid. The 2 -> 3 change is a one-place config edit (AC-5). Mount
 *  site: `<LiveTerminalProvider cap={useTerminalCap()}>`. */
export function useTerminalCap(): number {
  const { data } = useSettings();
  const raw = data?.settings?.["ui.terminal.max_live_terminals"]?.value;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 1 ? n : MAX_LIVE_TERMINALS;
}

export interface LiveTerminalContextValue {
  /** Mark a terminal live; evicts the oldest (reverting it to static) if over cap. */
  requestLive(key: string, revertToStatic: () => void): void;
  /** Free a terminal's slot without evicting (on unmount / manual revert). */
  release(key: string): void;
  isLive(key: string): boolean;
}

const LiveTerminalContext = createContext<LiveTerminalContextValue | null>(null);

function toValue(registry: LiveTerminalRegistry): LiveTerminalContextValue {
  return {
    requestLive: (key, revert) => registry.requestLive(key, revert),
    release: (key) => registry.release(key),
    isLive: (key) => registry.isLive(key),
  };
}

interface LiveTerminalProviderProps {
  /** Cap from config; defaults to MAX_LIVE_TERMINALS. */
  cap?: number;
  children: ReactNode;
}

export function LiveTerminalProvider({ cap = MAX_LIVE_TERMINALS, children }: LiveTerminalProviderProps) {
  // One registry for the provider's lifetime. A cap change (config edit) is
  // applied in place, so live terminals stay counted: rebuilding the registry
  // would leave them live but untracked and let the cap be exceeded. Lowering
  // evicts the oldest to static after commit (their reverts set state).
  const [state] = useState(() => {
    const registry = new LiveTerminalRegistry(cap);
    return { registry, value: toValue(registry) };
  });
  useLayoutEffect(() => {
    state.registry.setCap(cap);
  }, [state, cap]);
  return <LiveTerminalContext.Provider value={state.value}>{children}</LiveTerminalContext.Provider>;
}

// Module singleton fallback: keeps the cap global even if a surface renders a
// ProgressiveTerminal outside an explicit provider (defensive). The real app
// mounts LiveTerminalProvider above all surfaces.
let fallbackRegistry: LiveTerminalRegistry | null = null;
function getFallbackValue(): LiveTerminalContextValue {
  if (!fallbackRegistry) fallbackRegistry = new LiveTerminalRegistry(MAX_LIVE_TERMINALS);
  return toValue(fallbackRegistry);
}

export function useLiveTerminal(): LiveTerminalContextValue {
  const ctx = useContext(LiveTerminalContext);
  const fallbackRef = useRef<LiveTerminalContextValue | null>(null);
  if (ctx) return ctx;
  if (!fallbackRef.current) fallbackRef.current = getFallbackValue();
  return fallbackRef.current;
}

/** Test-only: reset the module singleton so cap/eviction state does not leak
 *  across tests that render ProgressiveTerminal without an explicit provider. */
export function __resetFallbackRegistryForTests(): void {
  fallbackRegistry = null;
}
