import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SeatPage } from "../src/pages/Seat.js";
import { SeatTerminal } from "../src/components/Terminal.js";
const mocks = vi.hoisted(() => ({ hosts: [] as Array<{id: string; terminalProxy?: boolean}>, sockets: [] as any[] }));
vi.mock("../src/api.js", () => ({ useFleet: () => ({ byRig: new Map(), isLoading: true }), useHosts: () => ({ data: { hosts: mocks.hosts } }), useSend: () => ({}) }));
vi.mock("@xterm/xterm", () => ({ Terminal: class { options = {}; open(){} onData(){} attachCustomWheelEventHandler(){} dispose(){} focus(){} write(){} } }));
beforeEach(() => {
  mocks.hosts = []; mocks.sockets = []; localStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe(){} disconnect(){} });
  vi.stubGlobal("WebSocket", class { static OPEN=1; readyState=1; onclose?: (e: unknown)=>void; constructor(public url: string){mocks.sockets.push(this);} close(){} send(){} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("uses the local proxy URL with the host envelope and local terminal token", () => {
  localStorage.setItem("openrig.terminalBearerToken", "local token"); render(<SeatTerminal session="worker@team" hostId="remote alias" />);
  const url = new URL(mocks.sockets[0].url); expect(url.pathname).toBe("/api/terminal/worker%40team"); expect(url.searchParams.get("host")).toBe("remote alias"); expect(url.searchParams.get("token")).toBe("local token"); expect(url.host).toBe(window.location.host);
});
it.each([1001,1008,1011])("does not reconnect after policy/lifecycle close %s", code => {
  vi.useFakeTimers(); render(<SeatTerminal session="worker@team" hostId="remote" />); mocks.sockets[0].onclose({code,reason:"refused"}); vi.advanceTimersByTime(6000); expect(mocks.sockets).toHaveLength(1);
});
it.each([undefined,false])("keeps remote seats read-only without terminalProxy=true (%s)", flag => {
  mocks.hosts=[{id:"remote",terminalProxy:flag}]; render(<SeatPage session="worker@team" hostId="remote"/>); expect(mocks.sockets).toHaveLength(0); expect(screen.getByText(/Terminals and sends are served/)).toBeTruthy(); expect(screen.queryByRole("textbox")).toBeNull();
});
it("offers an opted-in remote terminal but never a remote composer", () => {
  mocks.hosts=[{id:"remote",terminalProxy:true}]; render(<SeatPage session="worker@team" hostId="remote"/>); expect(mocks.sockets).toHaveLength(1); expect(new URL(mocks.sockets[0].url).searchParams.get("host")).toBe("remote"); expect(screen.queryByRole("textbox")).toBeNull();
});
it("retains the local terminal and local composer", () => { render(<SeatPage session="worker@team" hostId="local"/>); expect(mocks.sockets).toHaveLength(1); expect(screen.getByRole("textbox")).toBeTruthy(); });
