export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
