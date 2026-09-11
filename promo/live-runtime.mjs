import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = new URL('../', import.meta.url).pathname;
const source = JSON.parse(await readFile(join(process.env.HOME, '.local/share/miniq/settings.json'), 'utf8'));
const dir = await mkdtemp(join(tmpdir(), 'miniq-promo-'));
const settings = { provider: source.provider, approvalMode: 'alwaysAsk', remoteAccess: {
  enabled: true, relayUrl: 'ws://127.0.0.1:19200/ws', deviceName: 'miniQ Studio', deviceId: 'desktop-promo-studio',
}};
await writeFile(join(dir, 'settings.json'), JSON.stringify(settings), { mode: 0o600 });
const child = spawn(join(root, 'target/debug/miniq-daemon'), [], {
  env: { ...process.env, MINIQ_DATA_DIR: dir, MINIQ_PORT: '19300', MINIQ_TOKEN: 'promo-local-recording' },
  stdio: 'inherit',
});
console.log('Isolated recording runtime started; credentials remain outside the repository.');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 0));
