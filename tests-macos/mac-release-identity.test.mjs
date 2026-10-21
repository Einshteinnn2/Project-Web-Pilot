import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSameMacDirectory } from '../scripts/check-mac-signature.mjs';

test('installed app identity survives a reboot: volume UUID and inode, device only within one boot', () => {
  const before = { device: 16777230, inode: 42, volumeUUID: 'VOL', bootSessionUUID: 'BOOT-1' };
  assert.doesNotThrow(() => assertSameMacDirectory(before, { device: 16777234, inode: 42, volumeUUID: 'VOL', bootSessionUUID: 'BOOT-2' }, 'app'));
  assert.throws(() => assertSameMacDirectory(before, { device: 16777234, inode: 42, volumeUUID: 'VOL', bootSessionUUID: 'BOOT-1' }, 'app'));
  assert.throws(() => assertSameMacDirectory(before, { device: 16777230, inode: 43, volumeUUID: 'VOL', bootSessionUUID: 'BOOT-1' }, 'app'));
  assert.throws(() => assertSameMacDirectory(before, { device: 16777230, inode: 42, volumeUUID: 'OTHER', bootSessionUUID: 'BOOT-1' }, 'app'));
  assert.throws(() => assertSameMacDirectory({ device: 1, inode: 42 }, { device: 2, inode: 42, volumeUUID: 'VOL' }, 'legacy'));
});
