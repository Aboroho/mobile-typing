export function assertNever(value: never): never {
  throw new Error(`Unhandled discriminated union value: ${JSON.stringify(value)}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Narrowing helper that keeps exhaustiveness checks at the call site. */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
