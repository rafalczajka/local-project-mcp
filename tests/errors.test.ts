import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Budget,
  clip,
  errorCode,
  ProjectError,
  safeError,
} from '../src/errors.js';

test('error codes are narrowed without assuming thrown values are Error instances', () => {
  for (const value of [null, undefined, 42, 'ENOENT', {}, { code: 1 }]) {
    assert.equal(errorCode(value), undefined);
  }
  assert.equal(errorCode(new ProjectError('TIMEOUT', 'deadline')), 'TIMEOUT');
  assert.equal(errorCode({ code: 'ENOENT' }), 'ENOENT');
  assert.equal(
    errorCode(Object.assign(() => undefined, { code: 'EPERM' })),
    'EPERM',
  );
});

test('safe errors preserve explicit project errors and sanitize filesystem errors', () => {
  assert.deepEqual(safeError(new ProjectError('ENOENT', 'Public message')), {
    code: 'ENOENT',
    message: 'Public message',
  });
  for (const code of ['ENOENT', 'ENOTDIR']) {
    assert.deepEqual(
      safeError(Object.assign(new Error('private path'), { code })),
      {
        code: 'NOT_FOUND',
        message: 'The project path does not exist.',
      },
    );
  }
  for (const code of ['EACCES', 'EPERM']) {
    assert.deepEqual(safeError({ code, message: 'private path' }), {
      code: 'PERMISSION_DENIED',
      message: 'The path cannot be accessed.',
    });
  }
});

test('unknown thrown values never expose their messages', () => {
  for (const error of [
    null,
    undefined,
    'private',
    42,
    false,
    Symbol('private'),
    new Error('private'),
    { code: 'UNKNOWN', message: 'private' },
    { code: 1 },
  ]) {
    assert.deepEqual(safeError(error), {
      code: 'OPERATION_FAILED',
      message: 'The operation could not be completed.',
    });
  }
});

test('budgets expire at the deadline and cancellation uses the same public error', (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const budget = new Budget(10);
  assert.equal(budget.remaining(), 10);
  now = 1009;
  budget.check();
  assert.equal(budget.remaining(), 1);
  now = 1010;
  const expected = {
    code: 'TIMEOUT',
    message: 'Operation deadline reached; narrow the request.',
  };
  assert.throws(() => budget.check(), expected);
  assert.throws(() => budget.remaining(), expected);
  const controller = new AbortController();
  const cancelled = new Budget(1000, controller.signal);
  controller.abort();
  assert.throws(() => cancelled.check(), expected);
  assert.throws(() => cancelled.remaining(), expected);
});

test('clipping respects byte boundaries without adding replacement characters', () => {
  const text = 'aą😀z';
  const expected = ['', 'a', 'a', 'aą', 'aą', 'aą', 'aą', 'aą😀', text];
  for (const [bytes, result] of expected.entries()) {
    assert.equal(clip(text, bytes), result);
  }
  assert.equal(clip(text, -1), '');
  assert.equal(clip(text, 100), text);
  assert.equal(clip('', 0), '');
});
