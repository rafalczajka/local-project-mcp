export class ProjectError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SafeError {
  code: string;
  message: string;
}

export function errorCode(error: unknown): string | undefined {
  if (
    error !== null &&
    (typeof error === 'object' || typeof error === 'function') &&
    'code' in error
  ) {
    const code = error.code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

export function safeError(error: unknown): SafeError {
  if (error instanceof ProjectError)
    return { code: error.code, message: error.message };
  const code = errorCode(error);
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return { code: 'NOT_FOUND', message: 'The project path does not exist.' };
    case 'EACCES':
    case 'EPERM':
      return {
        code: 'PERMISSION_DENIED',
        message: 'The path cannot be accessed.',
      };
    default:
      return {
        code: 'OPERATION_FAILED',
        message: 'The operation could not be completed.',
      };
  }
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
  check(): void {
    if (this.signal?.aborted || Date.now() >= this.deadline)
      throw new ProjectError(
        'TIMEOUT',
        'Operation deadline reached; narrow the request.',
      );
  }
  remaining(): number {
    this.check();
    return Math.max(1, this.deadline - Date.now());
  }
}

export function clip(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) return text;
  // Streaming mode omits an incomplete UTF-8 character at the byte boundary.
  return new TextDecoder('utf-8', { fatal: false }).decode(
    buffer.subarray(0, Math.max(0, maxBytes)),
    { stream: true },
  );
}
