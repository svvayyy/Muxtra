export const JSON_SCHEMA_VERSION = 1 as const;

export interface JsonEnvelope<T> {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  command: string;
  generatedAt: string;
  data: T;
}

/**
 * Every machine-readable command uses the same versioned envelope. Consumers can
 * reject an unknown schema before interpreting command-specific data.
 */
export function jsonEnvelope<T>(command: string, data: T): JsonEnvelope<T> {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    command,
    generatedAt: new Date().toISOString(),
    data,
  };
}

export function printJson<T>(command: string, data: T): void {
  console.log(JSON.stringify(jsonEnvelope(command, data), null, 2));
}
