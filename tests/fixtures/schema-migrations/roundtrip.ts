/** Executable fixture assertions; intentionally not run during issue implementation. */
import assert from "node:assert/strict";
import fixture from "./legacy-roundtrip.json";
import {
  migratePersistedSchema,
  reversePersistedSchema,
} from "../../../src/persistedSchema";
import {
  readPersonalProfiles,
  assertPersonalProfilesUpdate,
} from "../../../src/personalProfiles";

export function assertSchemaMigrationFixtures(): void {
  for (const kind of ["settings", "transcript", "rule"] as const) {
    const before = fixture[kind];
    const migration = migratePersistedSchema(before, kind);
    assert.deepEqual(migration.after, { ...before, schemaVersion: 1 });
    assert.deepEqual(reversePersistedSchema(migration), before);
    const repeated = migratePersistedSchema(migration.after, kind);
    assert.deepEqual(repeated.after, migration.after);
    assert.deepEqual(reversePersistedSchema(repeated), migration.after);
  }
  assert.throws(() =>
    migratePersistedSchema(fixture.futureSettings, "settings"),
  );
  assert.throws(() =>
    migratePersistedSchema(fixture.futureTranscript, "transcript"),
  );
  assert.throws(() => migratePersistedSchema(fixture.futureRule, "rule"));
  assert.deepEqual(readPersonalProfiles(fixture.futureProfiles), {
    status: "unsupported",
    document: fixture.futureProfiles,
  });
  assert.throws(() =>
    assertPersonalProfilesUpdate(fixture.futureProfiles, {
      schemaVersion: 1,
      profiles: [],
    }),
  );
}
