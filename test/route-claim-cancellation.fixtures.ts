import { execPsqlCommand } from './geolocation-migration.fixtures.js';

export function barrier() {
  let signal!: () => void;
  let release!: () => void;
  return {
    held: new Promise<void>((resolve) => {
      signal = resolve;
    }),
    wait: new Promise<void>((resolve) => {
      release = resolve;
    }),
    signal: () => signal(),
    release: () => release(),
  };
}

export async function assertOrderWait(database: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const count = Number(
      execPsqlCommand(
        database,
        `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()
       AND cardinality(pg_blocking_pids(pid)) > 0 AND query LIKE '%order%';`,
      ),
    );
    if (count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('No actual PostgreSQL Order lock wait observed');
}

export async function awaitHeld(held: Promise<void>) {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      held,
      new Promise<void>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Endpoint did not acquire held lock')),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Drain every launched HTTP request before database/container teardown, even on a failed barrier.
export async function heldEndpointRace(
  first: PromiseLike<{ status: number }>,
  second: () => PromiseLike<{ status: number }>,
  hold: ReturnType<typeof barrier>,
  database: string,
  restore: () => void,
) {
  const settle = (request: PromiseLike<{ status: number }>) =>
    Promise.resolve(request).then(
      (response) => ({ response, error: undefined }),
      (error: unknown) => ({ response: undefined, error }),
    );
  const firstResult = settle(first);
  let secondResult: ReturnType<typeof settle> | undefined;
  let failure: unknown;
  try {
    await awaitHeld(
      Promise.race([
        hold.held,
        firstResult.then(({ response, error }) => {
          throw (
            error ??
            new Error(
              `First endpoint completed before held lock: ${response?.status}`,
            )
          );
        }),
      ]),
    );
    secondResult = settle(second());
    await assertOrderWait(database);
  } catch (error) {
    failure = error;
  } finally {
    hold.release();
    restore();
  }
  const a = await firstResult;
  const b = await secondResult;
  if (failure) throw failure;
  if (a.error || b?.error) throw a.error ?? b?.error;
  return [a.response!, b!.response!];
}
