import { Role } from '../auth/dto/register.dto.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { RealtimeService } from './realtime.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '33333333-3333-4333-8333-333333333333';

function createGateway() {
  const authenticate = jest.fn();
  const canSubscribe = jest.fn();
  const realtime = {
    attach: jest.fn(),
    authenticate,
    canSubscribe,
  } as unknown as RealtimeService;
  return { gateway: new RealtimeGateway(realtime), authenticate, canSubscribe };
}

describe('RealtimeGateway', () => {
  afterEach(() => {
    delete process.env.REALTIME_ALLOWED_ORIGINS;
  });

  it('checks browser Origin before connection and authenticates from auth.token only', async () => {
    process.env.REALTIME_ALLOWED_ORIGINS = 'https://fixture.example';
    const { gateway, authenticate } = createGateway();
    authenticate.mockResolvedValue({ userId: USER_ID, role: Role.CLIENT });
    const server = { sockets: new Map(), use: jest.fn() };
    gateway.afterInit(server as never);
    const middleware = server.use.mock.calls[0][0];
    const socket = {
      handshake: {
        headers: { origin: 'https://fixture.example' },
        auth: { token: 'socket-auth-token' },
        query: { token: 'query-token-must-not-be-used' },
      },
      data: {},
    };
    const next = jest.fn();

    await middleware(socket, next);

    expect(authenticate).toHaveBeenCalledWith('socket-auth-token');
    expect(next).toHaveBeenCalledWith();
    expect(socket.data).toMatchObject({
      realtimeToken: 'socket-auth-token',
      realtimeUserId: USER_ID,
      realtimeRole: Role.CLIENT,
    });
  });

  it('rejects disallowed browser Origins and allows originless native clients only with JWT', async () => {
    process.env.REALTIME_ALLOWED_ORIGINS = 'https://fixture.example';
    const { gateway, authenticate } = createGateway();
    authenticate.mockResolvedValue({ userId: USER_ID, role: Role.DRIVER });
    const server = { sockets: new Map(), use: jest.fn() };
    gateway.afterInit(server as never);
    const middleware = server.use.mock.calls[0][0];
    const deniedNext = jest.fn();

    await middleware({
      handshake: { headers: { origin: 'https://untrusted.example' }, auth: { token: 'jwt' }, query: {} },
      data: {},
    }, deniedNext);

    expect(deniedNext).toHaveBeenCalledWith(expect.any(Error));
    expect(authenticate).not.toHaveBeenCalled();

    const nativeSocket = {
      handshake: { headers: {}, auth: { token: 'native-jwt' }, query: {} },
      data: {},
    };
    const nativeNext = jest.fn();
    await middleware(nativeSocket, nativeNext);
    expect(authenticate).toHaveBeenCalledWith('native-jwt');
    expect(nativeNext).toHaveBeenCalledWith();

    authenticate.mockResolvedValueOnce(null);
    const missingAuthNext = jest.fn();
    await middleware({
      handshake: { headers: {}, auth: {}, query: { token: 'query-only-jwt' } },
      data: {},
    }, missingAuthNext);
    expect(authenticate).toHaveBeenLastCalledWith(undefined);
    expect(missingAuthNext).toHaveBeenCalledWith(expect.any(Error));
  });

  it('joins only strict, authorized resource subscriptions with the frozen ACK shape', async () => {
    const { gateway, authenticate, canSubscribe } = createGateway();
    authenticate.mockResolvedValue({ userId: USER_ID, role: Role.CLIENT });
    canSubscribe.mockResolvedValue(true);
    const socket = {
      data: { realtimeToken: 'socket-jwt' },
      join: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
    };

    await expect(gateway.subscribe(socket as never, { resource: 'order', id: ORDER_ID })).resolves.toEqual({
      ok: true,
    });
    expect(socket.join).toHaveBeenCalledWith(`order:${ORDER_ID}`);
    expect(canSubscribe).toHaveBeenCalledWith(
      { userId: USER_ID, role: Role.CLIENT },
      { resource: 'order', id: ORDER_ID },
    );
  });

  it('rejects malformed IDs, extra subscription keys, and unauthorized joins without leaking details', async () => {
    const { gateway, authenticate, canSubscribe } = createGateway();
    authenticate.mockResolvedValue({ userId: USER_ID, role: Role.CLIENT });
    canSubscribe.mockResolvedValue(false);
    const socket = {
      data: { realtimeToken: 'socket-jwt' },
      join: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
    };

    await expect(gateway.subscribe(socket as never, { resource: 'order', id: 'not-a-uuid' })).resolves.toEqual({
      ok: false,
      error: 'INVALID_REQUEST',
    });
    await expect(gateway.subscribe(socket as never, {
      resource: 'order',
      id: ORDER_ID,
      room: 'arbitrary-room',
    })).resolves.toEqual({ ok: false, error: 'INVALID_REQUEST' });
    await expect(gateway.subscribe(socket as never, { resource: 'order', id: ORDER_ID })).resolves.toEqual({
      ok: false,
      error: 'FORBIDDEN',
    });
    canSubscribe.mockRejectedValueOnce(new Error('database details stay private'));
    await expect(gateway.subscribe(socket as never, { resource: 'order', id: ORDER_ID })).resolves.toEqual({
      ok: false,
      error: 'UNAVAILABLE',
    });
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('returns a generic unauthenticated ACK and disconnects after token or DB-role revocation', async () => {
    const { gateway, authenticate } = createGateway();
    authenticate.mockResolvedValue(null);
    const socket = {
      data: { realtimeToken: 'expired-jwt' },
      join: jest.fn(),
      disconnect: jest.fn(),
    };

    await expect(gateway.subscribe(socket as never, { resource: 'incidents' })).resolves.toEqual({
      ok: false,
      error: 'UNAUTHENTICATED',
    });
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socket.join).not.toHaveBeenCalled();
  });
});
