import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
async function files(dir) { return (await Promise.all((await readdir(dir, { withFileTypes: true })).map(async d => d.isDirectory() ? files(join(dir,d.name)) : [join(dir,d.name)]))).flat(); }
const paths = await files(process.argv[2] ?? '.');
for (const suffix of ['_amd64.deb', '.x86_64.rpm', '.pkg.tar.zst', '_aarch64.dmg']) {
  const path = paths.find(p => p.endsWith(suffix));
  if (!path || !(await stat(path)).size) throw new Error(`Missing or empty ${suffix}`);
}

// Exercise the shipped CLI from an extracted package, without Python, audio,
// model downloads, or a checkout. Its skill (and the opt-in Chatterbox adapter) are embedded.
const deb = paths.find(p => p.endsWith('_amd64.deb'));
const temp = await mkdtemp(join(tmpdir(), 'delulu-release-'));
try {
  execFileSync('dpkg-deb', ['--extract', deb, temp]);
  const cli = join(temp, 'usr/bin/delulu');
  const env = { ...process.env, XDG_DATA_HOME: join(temp, 'empty-data') };
  const version = execFileSync(cli, ['--version'], { env, encoding: 'utf8' }).trim();
  const status = JSON.parse(execFileSync(cli, ['status'], { env, encoding: 'utf8' }));
  if (!version.startsWith('delulu ') || status.model !== false || status.ready !== false)
    throw new Error('Packaged CLI did not report a clean optional model state');
  // Delulu FM's host speaks the station's language with a chosen voice.
  const help = execFileSync(cli, ['speak', '--help'], { env, encoding: 'utf8' });
  if (!help.includes('--lang') || !help.includes('--voice'))
    throw new Error('Packaged CLI lacks speak --lang/--voice, which Delulu FM needs');
  // The model roles (speech to text, cleanup, Delulu FM's music, the voice) ship as one native engine binary:
  // it must start and list its roles and a compute device without ComfyUI, Python or
  // a downloaded model. The old per-role helpers, each with its own ggml, are gone.
  const lib = join(temp, 'usr/lib/delulu-talks');
  const helpers = (await readdir(lib)).sort();
  if (helpers.join() !== 'delulu-engine,delulu-pill')
    throw new Error(`Expected delulu-engine and delulu-pill in /usr/lib/delulu-talks, found ${helpers.join(', ')}`);
  const probe = JSON.parse(execFileSync(join(lib, 'delulu-engine'), ['probe'], { env, encoding: 'utf8' }));
  if (!version.endsWith(` ${probe.version}`))
    throw new Error(`Packaged delulu-engine is ${probe.version}, the CLI is ${version}`);
  for (const role of ['stt', 'llm', 'music', 'tts'])
    if (!probe.roles?.includes(role)) throw new Error(`Packaged delulu-engine lacks the ${role} role`);
  if (typeof probe.device !== 'string' || !probe.device)
    throw new Error('Packaged delulu-engine did not report a compute device');
  // The recording pill: its own small binary without GTK. It draws a frame
  // offscreen, so this needs no desktop.
  const pill = join(lib, 'delulu-pill');
  const pillVersion = execFileSync(pill, ['--version'], { env, encoding: 'utf8' }).trim();
  if (!version.endsWith(` ${pillVersion.split(' ').pop()}`))
    throw new Error(`Packaged delulu-pill is ${pillVersion}, the CLI is ${version}`);
  const frame = join(temp, 'pill.png');
  execFileSync(pill, ['--render', 'success', '0', 'Typed', frame], { env, stdio: 'ignore' });
  if ((await stat(frame)).size < 1000) throw new Error('Packaged delulu-pill drew no frame');
  const linked = execFileSync('ldd', [pill], { encoding: 'utf8' });
  if (/gtk|gdk|cairo|webkit/i.test(linked)) throw new Error(`Packaged delulu-pill links GTK:\n${linked}`);
  console.log(`Verified packaged ${version}: no model required; engine on ${probe.device}; GTK-free pill`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
