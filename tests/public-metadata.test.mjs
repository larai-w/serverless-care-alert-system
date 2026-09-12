import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('package metadata preserves the EchoCare research and license boundaries', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(packageJson.license, 'MIT');
  assert.match(packageJson.description, /research prototype/i);
  assert.match(packageJson.description, /not for clinical or emergency use/i);
});
