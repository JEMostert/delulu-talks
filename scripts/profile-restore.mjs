// Run with Bun. Dry-run is the default; restoring requires explicit --restore.
import { restoreProfileBackup, validateProfileBackup } from "../electron/services/profileRestore.ts";
const usage = "bun scripts/profile-restore.mjs --backup <completed snapshot> --target <new isolated directory> [--source-profile <original profile>] [--settings-only] [--restore]";
const args = process.argv.slice(2), options = {};
if (args.includes("--help")) { console.log(usage); process.exit(0); }
for (let index = 0; index < args.length; index++) {
  const flag = args[index];
  if (["--restore", "--settings-only"].includes(flag)) { options[flag] = true; continue; }
  if (!["--backup", "--target", "--source-profile"].includes(flag) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(usage);
  options[flag] = args[++index];
}
if (!options["--backup"] || !options["--target"]) throw new Error(usage);
const request = { backupDirectory: options["--backup"], targetDirectory: options["--target"],
  sourceProfileDirectory: options["--source-profile"], allowSettingsOnly: !!options["--settings-only"] };
try {
  const restore = !!options["--restore"];
  const plan = await (restore ? restoreProfileBackup(request) : validateProfileBackup(request));
  console.log(JSON.stringify({ outcome: restore ? "restored" : "dry-run", ...plan }, null, 2));
} catch (error) {
  const causes = error instanceof AggregateError ? [...error.errors] : error?.cause ? [error.cause] : [];
  console.error(JSON.stringify({ outcome: "failed", message: error instanceof Error ? error.message : String(error),
    causes: causes.map((cause) => cause instanceof Error ? cause.message : String(cause)) }, null, 2));
  process.exitCode = 1;
}
