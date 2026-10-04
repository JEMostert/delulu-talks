import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.platform === "win32" ? "python" : "python3",
  ["-m", "unittest", "discover", "-s", "electron/python", "-p", "*_test.py"],
  { stdio: "inherit" },
);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
