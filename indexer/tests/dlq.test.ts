import { describe, expect, it, vi } from 'vitest';
import { DeadLetterQueue } from '../src/dlq';

interface Evt {
  event_id: string;
  ledger: number;
}

function clock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('DeadLetterQueue (issue #1441)', () => {
  it('keeps a failed event observable with its error, attempts and next retry time', () => {
    const c = clock();
    const dlq = new DeadLetterQueue<Evt>({ baseDelayMs: 100, now: c.now });

    const entry = dlq.enqueue({ event_id: 'e1', ledger: 5 }, { error: new Error('RPC timeout') });

    expect(entry).toMatchObject({
      key: 'e1',
      state: 'pending',
      attempts: 1,
      lastError: 'RPC timeout',
      firstFailedAt: 1_000,
      nextRetryAt: 1_100,
    });
    expect(dlq.size).toBe(1);
    expect(dlq.stats()).toEqual({ pending: 1, exhausted: 0 });
  });

  it('retries a transient failure after its backoff and removes it on success', async () => {
    const c = clock();
    const dlq = new DeadLetterQueue<Evt>({ baseDelayMs: 100, now: c.now });
    dlq.enqueue({ event_id: 'e1', ledger: 5 }, { error: 'blip' });
    const handler = vi.fn();

    expect(await dlq.retryDue(handler)).toEqual({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      exhausted: 0,
    });
    expect(handler).not.toHaveBeenCalled();

    c.advance(100);
    expect((await dlq.retryDue(handler)).succeeded).toBe(1);
    expect(handler).toHaveBeenCalledWith({ event_id: 'e1', ledger: 5 }, expect.anything());
    expect(dlq.size).toBe(0);
  });

  it('doubles the backoff and exhausts after maxAttempts, keeping the entry listed', async () => {
    const c = clock();
    const dlq = new DeadLetterQueue<Evt>({ maxAttempts: 3, baseDelayMs: 100, now: c.now });
    dlq.enqueue({ event_id: 'e1', ledger: 5 }, { error: 'down' });
    const failing = vi.fn().mockRejectedValue(new Error('still down'));

    c.advance(100);
    await dlq.retryDue(failing);
    expect(dlq.get('e1')).toMatchObject({ attempts: 2, nextRetryAt: 1_300 });

    c.advance(200);
    const report = await dlq.retryDue(failing);
    expect(report).toEqual({ attempted: 1, succeeded: 0, failed: 1, exhausted: 1 });

    const exhausted = dlq.get('e1');
    expect(exhausted).toMatchObject({ state: 'exhausted', attempts: 3, lastError: 'still down' });
    expect(exhausted?.nextRetryAt).toBeUndefined();
    expect(dlq.list('exhausted').map((e) => e.key)).toEqual(['e1']);

    // Exhausted entries are never retried automatically.
    c.advance(1_000_000);
    await dlq.retryDue(failing);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('lets an operator resume an exhausted entry with a fresh attempt budget', async () => {
    const c = clock();
    const dlq = new DeadLetterQueue<Evt>({ maxAttempts: 1, now: c.now });
    dlq.enqueue({ event_id: 'e1', ledger: 5 }, { error: 'down' });
    expect(dlq.get('e1')?.state).toBe('exhausted');

    expect(dlq.requeue('e1')).toBe(true);
    expect(dlq.get('e1')).toMatchObject({ state: 'pending', attempts: 0 });

    const handler = vi.fn();
    expect((await dlq.retryDue(handler)).succeeded).toBe(1);
    expect(dlq.size).toBe(0);
    expect(dlq.requeue('missing')).toBe(false);
  });

  it('exhausts permanent (malformed) failures immediately', () => {
    const dlq = new DeadLetterQueue<Evt>();
    const entry = dlq.enqueue(
      { event_id: 'bad', ledger: 1 },
      { error: new Error('cannot decode topic'), permanent: true }
    );
    expect(entry.state).toBe('exhausted');
    expect(dlq.stats()).toEqual({ pending: 0, exhausted: 1 });
  });

  it('records a repeated failure of the same event as another attempt, not a duplicate', () => {
    const c = clock();
    const dlq = new DeadLetterQueue<Evt>({ maxAttempts: 2, now: c.now });
    dlq.enqueue({ event_id: 'e1', ledger: 5 }, { error: 'first' });
    c.advance(10);
    const second = dlq.enqueue({ event_id: 'e1', ledger: 5 }, { error: 'second' });

    expect(dlq.size).toBe(1);
    expect(second).toMatchObject({
      attempts: 2,
      state: 'exhausted',
      lastError: 'second',
      firstFailedAt: 1_000,
      lastFailedAt: 1_010,
    });
  });

  it('keeps the old single-argument enqueue(event) call working', () => {
    const dlq = new DeadLetterQueue();
    dlq.enqueue({ some: 'payload' });
    dlq.enqueue({ some: 'other payload' });
    expect(dlq.size).toBe(2);
    expect(dlq.list()[0].lastError).toBe('unknown error');
  });

  it('discards an entry only when asked', () => {
    const dlq = new DeadLetterQueue<Evt>();
    dlq.enqueue({ event_id: 'e1', ledger: 5 });
    expect(dlq.discard('e1')).toBe(true);
    expect(dlq.discard('e1')).toBe(false);
    expect(dlq.size).toBe(0);
  });
});
