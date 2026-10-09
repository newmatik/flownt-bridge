import { describe, expect, it } from 'vitest';
import { PushError, canRetryJobEvent, mayHaveReachedServer } from '../src/bridge.js';

describe('mayHaveReachedServer', () => {
  it('is false when the connection was never established', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
      expect(mayHaveReachedServer({ code })).toBe(false);
      expect(mayHaveReachedServer({ cause: { code } })).toBe(false);
    }
  });

  it('is true for timeouts, resets and unknown errors', () => {
    expect(mayHaveReachedServer({ name: 'AbortError' })).toBe(true);
    expect(mayHaveReachedServer({ code: 'ECONNRESET' })).toBe(true);
    expect(mayHaveReachedServer(new Error('boom'))).toBe(true);
    expect(mayHaveReachedServer(null)).toBe(true);
  });
});

describe('canRetryJobEvent', () => {
  const notSent = new PushError('refused', false);
  const unknown = new PushError('timeout', true);

  it('retries anything that certainly did not arrive', () => {
    expect(canRetryJobEvent(notSent, 'job_complete')).toBe(true);
    expect(canRetryJobEvent(notSent, 'job_failed')).toBe(true);
  });

  it('retries an ambiguous failure only when the backend can dedupe it', () => {
    expect(canRetryJobEvent(unknown, 'job_complete', 'job-42')).toBe(true);
    expect(canRetryJobEvent(unknown, 'job_complete')).toBe(false);
    expect(canRetryJobEvent(unknown, 'job_complete', null)).toBe(false);
    // job_failed carries no source_job_id → never safe to resend blindly
    expect(canRetryJobEvent(unknown, 'job_failed', 'job-42')).toBe(false);
  });
});
