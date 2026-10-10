import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import request from 'supertest';
import { historyHost } from './route-history.fixtures.js';
import {
  barrier,
  heldEndpointRace,
} from './route-claim-cancellation.fixtures.js';
import {
  startOwnedContainer,
  cleanupOwnedResources,
} from './geolocation-migration.fixtures.js';
import { PROPOSAL_DATE } from './route-assignment.fixtures.js';
import { RouteAssignmentService } from '../src/modules/routes/route-assignment.service.js';

jest.setTimeout(120_000);
describe('DRAFT claim versus cancellation: actual owned PostgreSQL locks', () => {
  let host: Awaited<ReturnType<typeof historyHost>>;
  let receipt: ReturnType<typeof startOwnedContainer>;
  const oldSecret = process.env.JWT_SECRET;
  beforeAll(() => {
    receipt = startOwnedContainer();
  });
  beforeEach(async () => {
    host = await historyHost();
  });
  afterEach(async () => {
    await host.app.close();
    await host.db.close();
  });
  afterAll(() => {
    if (oldSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldSecret;
    cleanupOwnedResources();
    expect(() =>
      execFileSync('docker', ['inspect', receipt.containerId], {
        stdio: 'pipe',
      }),
    ).toThrow();
    expect(existsSync(receipt.scratchDir)).toBe(false);
  });
  const draft = () =>
    request(host.app.getHttpServer())
      .post('/api/v1/routes')
      .auth(host.token(), { type: 'bearer' })
      .send({ zoneId: 'zone', orderIds: ['one'], routeDate: PROPOSAL_DATE });
  const cancel = () =>
    request(host.app.getHttpServer())
      .patch('/api/v1/orders/one/status')
      .auth(host.token(), { type: 'bearer' })
      .send({ status: 'CANCELLED' });
  async function noCancelledClaim() {
    const order = await host.db.orm.public.Order.where({ id: 'one' }).first();
    const claims = await host.db.orm.public.OrderClaim.where({
      orderId: 'one',
      releasedAt: null,
    }).all();
    expect(
      order?.status === 'CANCELLED' &&
        (claims.length > 0 || order.routeId !== null),
    ).toBe(false);
  }
  it('DRAFT locks first: cancellation waits, rereads the committed claim, and rejects', async () => {
    const hold = barrier();
    const service: any = host.app.get(RouteAssignmentService);
    const original = service.lockOrders.bind(service);
    const spy = jest
      .spyOn(service, 'lockOrders')
      .mockImplementationOnce(async (...args) => {
        await original(...args);
        hold.signal();
        await hold.wait;
      });
    const [drafting, cancelling] = await heldEndpointRace(
      draft(),
      cancel,
      hold,
      host.database,
      () => spy.mockRestore(),
    );
    expect(drafting.status).toBe(201);
    expect(cancelling.status).toBe(409);
    await noCancelledClaim();
  });
  it('cancellation locks first: DRAFT waits and rejects fresh CANCELLED eligibility', async () => {
    const hold = barrier();
    const original = host.db.transaction.bind(host.db);
    const spy = jest.spyOn(host.db, 'transaction').mockImplementationOnce(
      (fn: any) =>
        original(async (tx) => {
          const orderModel = tx.orm.public.Order;
          const wrapped = new Proxy(orderModel, {
            get(target, key) {
              if (key !== 'where') {
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
              }
              return (...args: any[]) => {
                const query = (target.where as any)(...args);
                return new Proxy(query, {
                  get(q, method) {
                    if (method !== 'update') {
                      const value = Reflect.get(q, method);
                      return typeof value === 'function'
                        ? value.bind(q)
                        : value;
                    }
                    return async (data: any) => {
                      const result = await q.update(data);
                      if (data.status === 'CANCELLED') {
                        hold.signal();
                        await hold.wait;
                      }
                      return result;
                    };
                  },
                });
              };
            },
          });
          return fn(
            new Proxy(tx, {
              get(target, key) {
                if (key !== 'orm') return Reflect.get(target, key);
                return new Proxy(tx.orm, {
                  get(orm, ns) {
                    if (ns !== 'public') return Reflect.get(orm, ns);
                    return new Proxy(tx.orm.public, {
                      get(models, model) {
                        return model === 'Order'
                          ? wrapped
                          : Reflect.get(models, model);
                      },
                    });
                  },
                });
              },
            }),
          );
        }) as any,
    );
    const [cancelling, drafting] = await heldEndpointRace(
      cancel(),
      draft,
      hold,
      host.database,
      () => spy.mockRestore(),
    );
    expect(cancelling.status).toBe(200);
    expect(drafting.status).toBe(409);
    await noCancelledClaim();
  });
});
