export class ProjectError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function safeError(error: unknown): { code: string; message: string } {
  if (error instanceof ProjectError)
    return { code: error.code, message: error.message };
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR')
    return { code: 'NOT_FOUND', message: 'The project path does not exist.' };
  if (code === 'EACCES' || code === 'EPERM')
    return {
      code: 'PERMISSION_DENIED',
      message: 'The path cannot be accessed.',
    };
  return {
    code: 'OPERATION_FAILED',
    message: 'The operation could not be completed.',
  };
}

export class Budget {
  private readonly deadline: number;
  visited = 0;
  bytes = 0;
  constructor(
    timeoutMs: number,
    public readonly signal?: AbortSignal,
  ) {
    this.deadline = Date.now() + timeoutMs;
  }
  check() {
    if (this.signal?.aborted || Date.now() >= this.deadline)
      throw new ProjectError(
        'TIMEOUT',
        'Operation deadline reached; narrow the request.',
      );
  }
  remaining() {
    this.check();
    return Math.max(1, this.deadline - Date.now());
  }
}

export function clip(text: string, bytes: number): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) return text;
  return new TextDecoder('utf-8', { fatal: false }).decode(
    buffer.subarray(0, Math.max(0, bytes)),
    { stream: true },
  );
}
