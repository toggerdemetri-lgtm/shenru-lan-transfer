import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Execute the menu's JavaScript URL policy; AppKit itself is not emulated or
// validated by this test and still requires a real Mac acceptance run.
const source = await readFile(new URL('../launcher/macos/menu.js', import.meta.url), 'utf8');
function browserTarget(state) {
  const opened = [];
  const bridge = value => value;
  bridge.NSURL = { URLWithString: value => value };
  bridge.NSWorkspace = { sharedWorkspace: { openURL: value => opened.push(value) } };
  const context = { ObjC: { import() {}, registerSubclass() {} }, $: bridge };
  runInNewContext(source, context);
  context.readJSON = () => state;
  context.openSpace();
  return opened;
}

test('macOS Open menu immediately opens verified local and private space URLs', () => {
  for (const url of ['http://127.0.0.1:3000/', 'http://10.2.3.4:54321/', 'http://192.168.1.8:3000/', 'http://172.16.0.2:3000/', 'http://172.31.255.255:65535/']) {
    assert.deepEqual(browserTarget({ state: 'ready', url, entryURL: 'file:///Users/test/深入·局域网互传.html' }), [url]);
  }
});

test('macOS URL policy falls back to generated entry for non-private or malformed URLs', () => {
  const entryURL = 'file:///Users/test/深入·局域网互传.html';
  for (const url of ['javascript:alert(1)', 'https://192.168.1.8:3000/', 'http://192.168.1.999:3000/', 'http://172.32.1.2:3000/', 'http://8.8.8.8:3000/', 'http://127.0.0.1:0/', 'http://127.0.0.1:65536/', 'http://user@127.0.0.1:3000/']) {
    assert.deepEqual(browserTarget({ state: 'ready', url, entryURL }), [entryURL]);
  }
});

test('macOS menu does not open incomplete or failed startup status', () => {
  for (const state of [null, { state: 'starting' }, { state: 'error', error: 'failure' }]) assert.deepEqual(browserTarget(state), []);
});
