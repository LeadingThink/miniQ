const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { contains, executablePath, launchArgs } = require('../src/launch');

test('arguments preserve spaces, Unicode and shell metacharacters as one value', () => {
  const root = path.resolve('/tmp/项目 ;$(echo injected)');
  const file = path.join(root, "quote' \"`draft`.md");
  assert.deepEqual(launchArgs('attachFile', root, file), ['-C', root, '--attach', file]);
  assert.deepEqual(launchArgs('resumeLast', root, undefined), ['-C', root, 'resume', '--last']);
  assert.deepEqual(launchArgs('doctor', root, undefined), ['-C', root, '--no-start', 'doctor']);
});

test('attachment containment rejects traversal, siblings and root', () => {
  const root = path.resolve('/tmp/project');
  for (const file of [root, path.resolve('/tmp/project-other/a'), path.join(root, '..', 'outside')]) {
    assert.equal(contains(root, file), false);
    assert.throws(() => launchArgs('attachFile', root, file));
  }
  assert.throws(() => launchArgs('attachFile', root, path.join(root, 'bad\nname')));
  assert.throws(() => launchArgs('unrecognized', root, undefined));
});

test('executable must be absolute, Windows accepts native executables only', () => {
  for (const value of ['miniq', './miniq', '/tmp/bad\nname', '/tmp/bad\0name']) {
    assert.throws(() => executablePath(value, 'linux', {}));
  }
  assert.equal(executablePath('/tmp/mini q', 'linux', {}), '/tmp/mini q');
  assert.equal(executablePath('C:\\Program Files\\miniQ\\miniq.exe', 'win32', {}), 'C:\\Program Files\\miniQ\\miniq.exe');
  assert.throws(() => executablePath('C:\\miniq.cmd', 'win32', {}));
  assert.throws(() => executablePath('', 'win32', {}));
});
