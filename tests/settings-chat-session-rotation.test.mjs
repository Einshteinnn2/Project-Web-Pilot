import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import {
  DEFAULT_CHAT_SESSION_TASK_LIMIT, restoreChatSessionTaskLimit, validateChatSessionTaskLimit,
} from '../src/chat-session-rotation-settings.mjs';
import { settingsPanelView } from '../src/ui/settings-panel.mjs';

test('limit is a strict integer 1–10; missing legacy setting gets 4, invalid stored value is rejected', () => {
  assert.equal(DEFAULT_CHAT_SESSION_TASK_LIMIT, 4);
  for (let value = 1; value <= 10; value++) assert.equal(validateChatSessionTaskLimit(value), value);
  for (const bad of [0, -1, 11, 1.5, 9.5, Infinity, NaN, '4', '1', null, undefined, true, {}, [], Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => validateChatSessionTaskLimit(bad), { code: 'CHAT_SESSION_TASK_LIMIT_INVALID' });
    assert.throws(() => restoreChatSessionTaskLimit({ chatSessionTaskLimit: bad }),
      { code: 'CHAT_SESSION_TASK_LIMIT_INVALID' });
  }
  assert.equal(restoreChatSessionTaskLimit(), 4);
  assert.equal(restoreChatSessionTaskLimit({}), 4);
  assert.equal(restoreChatSessionTaskLimit({ parallelExecution: { parallel_allowed: true, max_workers: 3 } }), 4);
  assert.equal(restoreChatSessionTaskLimit({ chatSessionTaskLimit: 1 }), 1);
});

test('the selected global limit survives the settings.json serialization/restart boundary', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-rotation-settings-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const settings = path.join(folder, 'settings.json');
  for (const value of [1, 4, 10]) {
    await fs.writeFile(settings, JSON.stringify({ chatSessionTaskLimit: validateChatSessionTaskLimit(value),
      projectAutoPlan: { '/fixture': { enabled: false } }, otherSetting: 'unchanged' }));
    const restored = JSON.parse(await fs.readFile(settings, 'utf8'));
    assert.equal(restoreChatSessionTaskLimit(restored), value);
    assert.equal(restored.projectAutoPlan['/fixture'].enabled, false, 'limit cannot enable AutoPlan');
    assert.equal(restored.otherSetting, 'unchanged');
  }
});

test('the real preload forwards the Settings action to the dedicated protected IPC channel', async () => {
  const invoked = [];
  let api;
  const preload = await fs.readFile(new URL('../src/preload.cjs', import.meta.url), 'utf8');
  vm.runInNewContext(preload, {
    require: module => {
      assert.equal(module, 'electron');
      return { contextBridge: { exposeInMainWorld: (name, value) => {
        assert.equal(name, 'webPilot'); api = value;
      } }, ipcRenderer: { invoke: (...args) => { invoked.push(args); return Promise.resolve(); } } };
    },
  });
  await api.setChatSessionTaskLimit(1);
  await api.setChatSessionTaskLimit(10);
  assert.deepEqual(invoked, [['pilot:set-chat-session-task-limit', 1], ['pilot:set-chat-session-task-limit', 10]]);
  assert.equal(typeof api.setAutoPlan, 'function', 'AutoPlan remains a separate user action');
});

test('Settings renders persisted limit for Chat/Work and sends valid edits without toggling AutoPlan', async t => {
  const dom = new JSDOM(await fs.readFile(new URL('../src/ui/index.html', import.meta.url), 'utf8'));
  const before = globalThis.document;
  globalThis.document = dom.window.document;
  t.after(() => { globalThis.document = before; dom.window.close(); });
  const $ = id => dom.window.document.getElementById(id), calls = [];
  const view = settingsPanelView((...args) => calls.push(args));
  const state = { platform: 'linux', theme: 'light', hideToolCalls: true, projects: [],
    settings: { workspace: '/fixture' }, autoPlan: { enabled: false },
    selected: { workspace: '/fixture', experience: 'work' } };

  view.render(state, false);
  const input = $('chat-session-task-limit'), error = $('chat-session-task-limit-error');
  assert.equal($('auto-plan-settings-title').textContent, 'AutoPlan — Chat-сессии');
  assert.equal(input.value, '4', 'old settings have the documented default');
  assert.equal(input.min, '1');
  assert.equal(input.max, '10');
  assert.equal(input.step, '1');
  assert.match($('chat-session-task-limit-help').textContent, /При включённом AutoPlan.*На Work не влияет/);
  assert.equal(input.disabled, false, 'value is editable even while AutoPlan is OFF and Work is selected');

  for (const invalid of ['', '0', '11', '-1', '2.5', 'abc']) {
    input.value = invalid;
    input.dispatchEvent(new dom.window.Event('change'));
    assert.deepEqual(calls, [], `invalid input ${JSON.stringify(invalid)} must not reach IPC`);
    assert.equal(error.hidden, false);
    assert.match(error.textContent, /от 1 до 10/);
    assert.equal(input.getAttribute('aria-invalid'), 'true');
  }

  for (const value of [1, 10, 4]) {
    input.value = String(value);
    input.dispatchEvent(new dom.window.Event('change'));
    assert.deepEqual(calls.pop(), ['setChatSessionTaskLimit', value]);
    assert.equal(error.hidden, true);
    assert.equal(input.hasAttribute('aria-invalid'), false);
  }
  assert.deepEqual(calls, [], 'changing the limit never dispatches setAutoPlan');

  view.render({ ...state, chatSessionTaskLimit: 9, autoPlan: { enabled: true } }, true);
  assert.equal(input.value, '9');
  assert.equal(input.disabled, true, 'pending IPC blocks concurrent edits');
  view.render({ ...state, chatSessionTaskLimit: 9 }, false);
  assert.equal(input.value, '9', 'Settings reflects the persisted value after rerender');
  assert.equal(input.disabled, false);
  assert.equal($('auto-plan-toggle').getAttribute('aria-pressed'), 'false',
    'rendering settings cannot enable AutoPlan');
});
