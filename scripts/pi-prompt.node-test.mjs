import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { miniqTemplate, piDirectory, renderMiniqPrompt } from './pi-prompt.mjs';

const template = readFileSync(new URL('system-prompt.txt', piDirectory), 'utf8');

test('the embedded template keeps PI structure with miniQ branding', () => {
  assert.equal(template, miniqTemplate());
  assert.match(template, /You are an AI coworker running inside miniQ,/);
  assert.match(template, /Other tools cover web, browser, desktop, media, memory, agents, and tasks/);
  assert.match(template, /Use tool_search for missing tools and skill_search for missing skills/);
  assert.doesNotMatch(template, /\bPi documentation\b|\brunning inside pi\b|github\.com\/.*\/pi\b/i);
});

test('runtime tools and cwd produce exactly the same text as the PI constructor', () => {
  const tools = [
    { name: 'file_read', description: 'Read files' },
    { name: 'shell_run', description: 'Run PowerShell commands' },
  ];
  for (const cwd of ['D:\\a $& directory\\project', '/home/user/project']) {
    const actual = template
      .replace('- __MINIQ_TOOL_NAME__: __MINIQ_TOOL_DESCRIPTION__', () =>
        tools.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n'))
      .replace('__MINIQ_CWD__', () => cwd.replaceAll('\\', '/'));
    assert.equal(actual, renderMiniqPrompt(cwd, tools));
  }
  assert.equal(
    template.replace('- __MINIQ_TOOL_NAME__: __MINIQ_TOOL_DESCRIPTION__', '(none)')
      .replace('__MINIQ_CWD__', '/workspace'),
    renderMiniqPrompt('/workspace', []),
  );
});

test('vendored PI sources and license are unchanged', () => {
  const references = [
    ['system-prompt.ts', '../reference-repos/pi/packages/coding-agent/src/core/system-prompt.ts'],
    ['text.ts', '../reference-repos/pi/packages/ai/src/utils/text.ts'],
    ['LICENSE', '../reference-repos/pi/LICENSE'],
  ];
  for (const [name, path] of references) {
    const original = new URL(path, import.meta.url);
    if (existsSync(original)) {
      assert.deepEqual(readFileSync(new URL(name, piDirectory)), readFileSync(original));
    }
  }
});
