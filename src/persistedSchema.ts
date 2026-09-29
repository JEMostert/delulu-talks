/** Data format versions are independent of workflow/opt-in behavior versions. */
export const PERSISTED_SCHEMA_VERSION = 1;
export type PersistedSchemaKind = "settings" | "transcript" | "rule";

export function assertPersistedSchema(value: unknown, kind: PersistedSchemaKind): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${kind} data: expected an object. Existing data is preserved.`);
  const version = (value as Record<string, unknown>).schemaVersion;
  if (version !== undefined && version !== PERSISTED_SCHEMA_VERSION)
    throw new Error(`Unsupported ${kind} schemaVersion ${String(version)}. Existing data is preserved; use a compatible app version.`);
}

/** Additive migration: preserve unknown metadata and literal content unchanged. */
export function versionPersistedRecord<T extends object>(value: T, kind: PersistedSchemaKind): T & { schemaVersion: 1 } {
  assertPersistedSchema(value, kind);
  return { ...structuredClone(value), schemaVersion: 1 };
}

export type ReversibleSchemaMigration<T extends object> = {
  kind: PersistedSchemaKind;
  before: T;
  after: T & { schemaVersion: 1 };
};
export function migratePersistedSchema<T extends object>(value: T, kind: PersistedSchemaKind): ReversibleSchemaMigration<T> {
  return { kind, before: structuredClone(value), after: versionPersistedRecord(value, kind) };
}
/** Return the original snapshot, including whether the version field was absent. */
export function reversePersistedSchema<T extends object>(migration: ReversibleSchemaMigration<T>): T {
  return structuredClone(migration.before);
}
