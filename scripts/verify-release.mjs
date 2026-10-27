import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
async function files(dir) { return (await Promise.all((await readdir(dir, { withFileTypes: true })).map(async d => d.isDirectory() ? files(join(dir,d.name)) : [join(dir,d.name)]))).flat(); }
const paths = await files(process.argv[2] ?? '.');
for (const suffix of ['_amd64.deb', '.x86_64.rpm', '.pkg.tar.zst']) {
  const path = paths.find(p => p.endsWith(suffix));
  if (!path || !(await stat(path)).size) throw new Error(`Missing or empty ${suffix}`);
}
