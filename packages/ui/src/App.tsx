import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useHosts, LOCAL_HOST } from "./api.js";
import { startEvents, useEvents } from "./events.js";
import { useRoute } from "./router.js";
import { Link } from "./components/bits.js";
import { FleetPage } from "./pages/Fleet.js";
import { SeatPage } from "./pages/Seat.js";
import { ActivityPage } from "./pages/Activity.js";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 2_000, refetchOnWindowFocus: true } },
});

const HOST_KEY = "openrig.host";

function useHostSelection(): [string, (id: string) => void] {
  const [host, setHost] = useState(() => { try { return localStorage.getItem(HOST_KEY) || LOCAL_HOST; } catch { return LOCAL_HOST; } });
  return [host, (id) => { setHost(id); try { localStorage.setItem(HOST_KEY, id); } catch { /* fine */ } }];
}

function HostPicker({ host, onChange }: { host: string; onChange: (id: string) => void }) {
  const hosts = useHosts();
  const list = hosts.data?.hosts ?? [];
  const own = hosts.data?.ownName ?? "this Mac";
  if (list.length === 0) return <span className="host-one">{own}</span>;
  return (
    <select className="host" value={host} onChange={(e) => onChange(e.target.value)} aria-label="host">
      <option value={LOCAL_HOST}>{own} (local)</option>
      {list.map((h) => (
        <option key={h.id} value={h.id} disabled={h.transport !== "http"}>
          {h.id}{h.status !== "reachable" ? ` · ${h.status}` : ""}{h.transport !== "http" ? " · ssh" : ""}
        </option>
      ))}
    </select>
  );
}

function Shell() {
  const route = useRoute();
  const [host, setHost] = useHostSelection();
  const { connected } = useEvents();
  useEffect(() => startEvents(queryClient), []);
  const nav = (
    <nav className="nav" aria-label="primary">
      <Link href="/" className={route.page === "fleet" || route.page === "seat" ? "active" : ""}>Fleet</Link>
      <Link href="/activity" className={route.page === "activity" ? "active" : ""}>Activity</Link>
    </nav>
  );
  return (
    <div className="shell">
      <header className="top">
        <Link href="/" className="brand">OpenRig</Link>
        {nav}
        <div className="top-right">
          <span className={`live ${connected ? "live-on" : "live-off"}`} title={connected ? "event stream connected" : "event stream disconnected; polling"}>{connected ? "live" : "polling"}</span>
          <HostPicker host={host} onChange={setHost} />
        </div>
      </header>
      <main>
        {route.page === "fleet" && <FleetPage hostId={host} />}
        {route.page === "seat" && <SeatPage key={route.session} session={route.session} hostId={host} />}
        {route.page === "activity" && <ActivityPage hostId={host} />}
      </main>
      <footer className="tabs">{nav}</footer>
    </div>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Shell />
    </QueryClientProvider>
  );
}
