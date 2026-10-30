import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
async function files(dir) { return (await Promise.all((await readdir(dir, { withFileTypes: true })).map(async d => d.isDirectory() ? files(join(dir,d.name)) : [join(dir,d.name)]))).flat(); }
const paths = await files(process.argv[2] ?? '.');
for (const suffix of ['_amd64.deb', '.x86_64.rpm', '.pkg.tar.zst']) {
  const path = paths.find(p => p.endsWith(suffix));
  if (!path || !(await stat(path)).size) throw new Error(`Missing or empty ${suffix}`);
}

// Exercise the shipped CLI from an extracted package, without Python, audio,
// model downloads, or a checkout. Its runtime adapter and skill are embedded.
const deb = paths.find(p => p.endsWith('_amd64.deb'));
const temp = await mkdtemp(join(tmpdir(), 'delulu-release-'));
try {
  execFileSync('dpkg-deb', ['--extract', deb, temp]);
  const cli = join(temp, 'usr/bin/delulu');
  const env = { ...process.env, XDG_DATA_HOME: join(temp, 'empty-data') };
  const version = execFileSync(cli, ['--version'], { env, encoding: 'utf8' }).trim();
  const status = JSON.parse(execFileSync(cli, ['status'], { env, encoding: 'utf8' }));
  if (!version.startsWith('delulu ') || status.configured !== false || status.ready !== false)
    throw new Error('Packaged CLI did not report a clean optional model state');
  // Delulu FM's host relies on the per-call bundled voice.
  const help = execFileSync(cli, ['speak', '--help'], { env, encoding: 'utf8' });
  if (!help.includes('--bundled-voice'))
    throw new Error('Packaged CLI lacks speak --bundled-voice, which Delulu FM needs');
  console.log(`Verified packaged ${version}: no model required`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
