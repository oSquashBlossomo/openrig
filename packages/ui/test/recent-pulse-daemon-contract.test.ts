// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createDb } from '../../daemon/src/db/connection.js';
import { migrate } from '../../daemon/src/db/migrate.js';
import { ALL_MIGRATIONS } from '../../daemon/src/db/all-migrations.js';
import { EventBus } from '../../daemon/src/domain/event-bus.js';
import { QueueRepository } from '../../daemon/src/domain/queue-repository.js';
import { StreamStore } from '../../daemon/src/domain/stream-store.js';
import { queueRoutes } from '../../daemon/src/routes/queue.js';
import { streamRoutes } from '../../daemon/src/routes/stream.js';
import { readRecentTransitions, readPulse, readMaintainedStream } from '../src/lib/recent-pulse-contracts.js';
import { LOCAL_OPERATOR_INSTANCE as local } from '../src/lib/operator-read.js';
it('accepts actual in-memory daemon queue, transition and stream route DTOs without mutation', async () => {
  const db = createDb();
  try {
    migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id,name) VALUES ('private-dto','rig')").run();
    const bus = new EventBus(db);
    const queue = new QueueRepository(db, bus);
    const stream = new StreamStore(db, bus);
    const item = await queue.create({ sourceSession: 'sender@rig', destinationSession: 'pod-owner@rig', body: 'Actual work', summary: 'Exact served summary', nudge: false });
    await queue.claim({ qitemId: item.qitemId, destinationSession: item.destinationSession });
    const emitted = stream.emit({ sourceSession: 'sender@rig', body: 'Maintained message' });
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('queueRepo' as never, queue); c.set('streamStore' as never, stream); c.set('eventBus' as never, bus); await next(); });
    app.route('/api/queue', queueRoutes());
    app.route('/api/stream', streamRoutes());
    app.get('/api/rigs/summary', c => c.json([{ id: 'private-dto', name: 'rig' }]));
    app.get('/api/rigs/private-dto/nodes', c => c.json([{ logicalId: 'pod.owner', canonicalSessionName: 'pod-owner@rig', nodeKind: 'agent', terminalActive: null, lastActivityAt: null }]));
    const fetch = vi.fn((route: string, init?: RequestInit) => app.request(route, init));
    vi.stubGlobal('fetch', fetch);
    const recent = await readRecentTransitions(local, { kind: 'rig', rig: 'rig' });
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ qitemId: item.qitemId, change: 'claimed', summary: 'Exact served summary', targetKind: 'qitem' });
    const pulse = await readPulse(local);
    expect(pulse.sources.inProgress.data).toEqual(queue.list({ state: 'in-progress', limit: 100 }));
    expect(pulse.model.parked?.servedCount).toBe(0);
    expect(pulse.model.now?.servedCount).toBe(0);
    expect(pulse.seats[0].terminalActive).toBeNull();
    const page = await readMaintainedStream(local);
    expect(page.rows).toEqual([emitted]);
    expect(fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    expect(queue.getById(item.qitemId)?.state).toBe('in-progress');
  }
  finally {
    vi.unstubAllGlobals();
    db.close();
  }
});
