import { spawnSync } from 'node:child_process';

const files = ['tests/*.test.mjs', ...(process.platform === 'darwin' ? ['tests-macos/*.test.mjs'] : [])];
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  stdio: 'inherit', windowsHide: true,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
