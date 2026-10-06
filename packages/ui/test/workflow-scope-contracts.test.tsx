import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useWorkflowSse, __test_internals } from "../src/hooks/useWorkflowSse.js";
const remote = { kind: "remote-instance", hostId: "elsewhere" } as const;
afterEach(() => { cleanup(); __test_internals.reset(); vi.unstubAllGlobals(); });
describe("workflow connected-instance subscription", () => {
  it("does not subscribe to the local workflow feed under an unsupported remote selection", () => {
    const construct = vi.fn();
    vi.stubGlobal("EventSource", class { constructor(url: string) { construct(url); } addEventListener() {} close() {} });
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);
    const { result } = renderHook(() => useWorkflowSse(remote), { wrapper });
    expect(construct).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ scopeSupported: false, scopeError: { code: "unsupported_scope" } });
  });
});
