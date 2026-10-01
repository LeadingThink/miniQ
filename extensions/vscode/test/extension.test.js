// The fixture never runs a process or connects to a daemon.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const launch = require('../src/launch');

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'miniq-extension-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const binary = path.join(dir, process.platform === 'win32' ? 'miniq.exe' : 'miniq');
  await fs.writeFile(binary, '', { mode: 0o700 });
  const root = path.join(dir, 'project');
  await fs.mkdir(root);
  const file = path.join(root, 'file.md');
  await fs.writeFile(file, 'fixture only');
  /** @param {string} name */
  const uri = name => ({ scheme: 'file', fsPath: name, toString: () => `file://${name}` });
  const folder = { name: 'project', uri: uri(root) };
  const document = { uri: uri(file), isDirty: false };
  /** @type {Record<string, any>[]} */
  const terminals = [];
  let confirmed = true;
  let confirmHook = () => {};
  const api = {
    workspace: {
      isTrusted: true,
      workspaceFolders: [folder],
      textDocuments: [document],
      getWorkspaceFolder: () => folder,
      getConfiguration: () => ({ get: () => binary }),
    },
    window: {
      activeTextEditor: { document },
      showQuickPick: async () => undefined,
      showWarningMessage: async () => { confirmHook(); return confirmed ? 'Attach Saved File' : undefined; },
      /** @param {Record<string, any>} options */
      createTerminal: options => { terminals.push(options); return { show() {} }; },
    },
  };
  const source = await fs.readFile(path.join(__dirname, '../src/extension.js'), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(source, {
    /** @param {string} name */
    require: name => name === 'vscode' ? api : name === './launch' ? launch : require(name),
    module, process,
  });
  /** @type {{runCommand: (api: any, action: string, resource?: any) => Promise<void>}} */
  const extension = /** @type {any} */ (module.exports);
  return { api, terminals, root, dir, file, document, extension,
    /** @param {boolean} value */
    confirm: value => { confirmed = value; },
    /** @param {() => void} hook */
    onConfirm: hook => { confirmHook = hook; },
  };
}

test('opens a terminal with a native executable and separate arguments', async t => {
  const f = await fixture(t);
  await f.extension.runCommand(f.api, 'resumeLast');
  assert.equal(f.terminals.length, 1);
  assert.equal(f.terminals[0].cwd, await fs.realpath(f.root));
  assert.deepEqual(Array.from(f.terminals[0].shellArgs), ['-C', await fs.realpath(f.root), 'resume', '--last']);
  assert.equal(typeof f.terminals[0].shellPath, 'string');
});

test('untrusted or removed workspaces cannot launch even through direct command invocation', async t => {
  const f = await fixture(t);
  f.api.workspace.isTrusted = false;
  await assert.rejects(f.extension.runCommand(f.api, 'open'), /Trust/);
  f.api.workspace.isTrusted = true;
  f.onConfirm(() => { f.api.workspace.isTrusted = false; });
  await assert.rejects(f.extension.runCommand(f.api, 'attachFile'), /Trust/);
  assert.equal(f.terminals.length, 0);
});

test('attachments require saved content and explicit confirmation', async t => {
  const f = await fixture(t);
  f.document.isDirty = true;
  await assert.rejects(f.extension.runCommand(f.api, 'attachFile'), /Save/);
  f.document.isDirty = false;
  f.confirm(false);
  await f.extension.runCommand(f.api, 'attachFile');
  assert.equal(f.terminals.length, 0);
  f.confirm(true);
  await f.extension.runCommand(f.api, 'attachFile');
  assert.deepEqual(Array.from(f.terminals[0].shellArgs), ['-C', await fs.realpath(f.root), '--attach', await fs.realpath(f.file)]);
});

test('symlinks outside the project are refused', async t => {
  const f = await fixture(t);
  const outside = path.join(f.dir, 'outside.md');
  await fs.writeFile(outside, 'outside fixture');
  await fs.unlink(f.file);
  await fs.symlink(outside, f.file);
  await assert.rejects(f.extension.runCommand(f.api, 'attachFile'), /inside this workspace/);
  assert.equal(f.terminals.length, 0);
});

test('workspace removal during confirmation and missing executable prevent launch', async t => {
  const f = await fixture(t);
  f.onConfirm(() => { f.api.workspace.workspaceFolders = []; });
  await assert.rejects(f.extension.runCommand(f.api, 'attachFile'), /removed/);
  assert.equal(f.terminals.length, 0);
  f.api.workspace.workspaceFolders = [{ name: 'project', uri: f.document.uri }];
  f.api.workspace.getConfiguration = () => ({ get: () => path.join(f.dir, 'missing') });
  await assert.rejects(f.extension.runCommand(f.api, 'open'), /executable unavailable/);
});
