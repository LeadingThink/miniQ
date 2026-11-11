import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const piDirectory = new URL('../crates/miniq-daemon/prompts/pi/', import.meta.url);
export const piCommit = '682c7b93ce3e0a52b579c2b65b4c06bb392e7180';
const upstream = `https://github.com/earendil-works/pi/blob/${piCommit}/packages/coding-agent`;
const miniqDocs = {
  readme: 'https://github.com/LeadingThink/miniQ',
  docs: 'https://github.com/LeadingThink/miniQ/tree/main/docs',
  examples: 'https://github.com/LeadingThink/miniQ/tree/main/examples',
};

function script(name) {
  return stripTypeScriptTypes(readFileSync(new URL(name, piDirectory), 'utf8'))
    .replace(/^import[^\n]*\n/gm, '')
    .replace(/^export /gm, '');
}

// Run the unmodified upstream constructor. Only its environment is supplied here.
const context = vm.createContext({
  getReadmePath: () => miniqDocs.readme,
  getDocsPath: () => miniqDocs.docs,
  getExamplesPath: () => miniqDocs.examples,
  formatSkillsForPrompt: () => {
    throw new Error('Skills are supplied separately by miniQ');
  },
});
vm.runInContext(script('text.ts'), context, { filename: fileURLToPath(new URL('text.ts', piDirectory)) });
vm.runInContext(script('system-prompt.ts'), context, {
  filename: fileURLToPath(new URL('system-prompt.ts', piDirectory)),
});

function rebrandPrompt(prompt) {
  return prompt
    .replace('You are a coding assistant running inside pi,', 'You are a coding assistant running inside miniQ,')
    .replace('Pi documentation', 'miniQ documentation')
    .replaceAll('When reading pi docs or examples', 'When reading miniQ docs or examples')
    .replaceAll('__PI_TOOL_NAME__', '__MINIQ_TOOL_NAME__')
    .replaceAll('__PI_TOOL_DESCRIPTION__', '__MINIQ_TOOL_DESCRIPTION__')
    .replaceAll('__PI_CWD__', '__MINIQ_CWD__')
    .replace(
      '- Show file paths clearly when working with files',
      '- Show file paths clearly when working with files\n- Use tool_search for missing tools and skill_search for missing skills',
    );
}

export function renderMiniqPrompt(cwd, tools) {
  return rebrandPrompt(context.buildSystemPrompt({
    cwd,
    selectedTools: tools.map((tool) => tool.name),
    toolSnippets: Object.fromEntries(tools.map((tool) => [tool.name, tool.description])),
  }));
}

export function miniqTemplate() {
  return renderMiniqPrompt('__MINIQ_CWD__', [
    { name: '__MINIQ_TOOL_NAME__', description: '__MINIQ_TOOL_DESCRIPTION__' },
  ]);
}
