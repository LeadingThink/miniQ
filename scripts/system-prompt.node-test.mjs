import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const directory = new URL('../crates/miniq-daemon/prompts/', import.meta.url);
const prompt = readFileSync(new URL('system-prompt.md', directory), 'utf8');
const behaviorSha256 = '6df4f6b6b8d1ce39e103a724d36d77d712c5f8ed518ff7e43270554a3613954f';

test('miniQ owns a complete copy of the behavioral instructions', () => {
  const boundary = prompt.indexOf('\n\n<miniq_runtime_bindings>');
  assert.ok(boundary > 0, 'the prompt must contain the runtime bindings');
  const original = prompt.substring(0, boundary)
    .replace('You are miniQ, an AI coworker running inside a local agent harness.',
      'You are Codex, an agent based on GPT-6.')
    .replace('As miniQ,', 'As Codex,');
  assert.equal(createHash('sha256').update(original).digest('hex'), behaviorSha256);
});

test('the complete prompt already contains miniQ identity and tool bindings', () => {
  assert.ok(prompt.startsWith('You are miniQ,'));
  assert.doesNotMatch(prompt, /You are Codex|As Codex,|an agent based on GPT-6/);
  assert.equal(prompt.match(/<miniq_runtime_bindings>/g)?.length, 1);
  assert.match(prompt, /Use shell_run for shell commands/);
  assert.match(prompt, /ask_user waits for a response; it is not asynchronous/);
  assert.match(prompt, /Read an installed skill through skill_read/);
  assert.ok(prompt.trimEnd().endsWith('</miniq_runtime_bindings>'));
});

test('the standalone prompt includes its provenance and attribution', () => {
  const readme = readFileSync(new URL('README.md', directory), 'utf8');
  assert.ok(readme.includes(behaviorSha256));
  assert.match(readme, /23934d31b15b1127c83535f84854e5009f7cd51d/);
  assert.match(readFileSync(new URL('LICENSE.codex', directory), 'utf8'), /Apache License/);
  assert.match(readFileSync(new URL('NOTICE.codex', directory), 'utf8'), /OpenAI/);
});
