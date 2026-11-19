import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// End-to-end interview: walk each scenario through the tool, extract the YAML the tool
// emits, and leave it for the Python validator to re-check (cross-language parity).
const { apply } = await import(new URL('../lib/tool.js', import.meta.url).href)

const tools = []
apply(
  {
    tools: { register: (tool) => tools.push(tool) },
    workingDirectory: { ensure: async () => process.cwd() },
  },
  {},
)
const intel = tools.find((tool) => tool.name === 'intel_search')
assert.ok(intel, 'intel_search missing')

const outDir = path.join(process.cwd(), '.interview-out')
mkdirSync(outDir, { recursive: true })

function yamlFromPrompt(prompt) {
  const match = prompt.match(/```yaml\n([\s\S]*?)\n```/)
  assert.ok(match, 'prompt did not embed the config YAML')
  return match[1] + '\n'
}

async function run(name, answers) {
  const result = await intel.execute({ mode: 'prompt', answers }, {})
  assert.equal(result.status, 'ready', `${name}: expected ready, got ${result.status}: ${result.errors.join('; ')}`)
  const yaml = yamlFromPrompt(result.prompt)
  writeFileSync(path.join(outDir, `${name}.yaml`), yaml, 'utf8')
  return { result, yaml }
}

// --- scenario A: public, chat only -----------------------------------------
const a = await run('A-public-chat', {
  purpose: 'policy',
  subject: '某行业',
  angles: ['policy', 'environment'],
  lookback: 90,
  area: 'china',
  source_scope: 'public',
  output_mode: ['chat'],
  must_include: ['conclusion', 'evidence'],
  frequency: 'once',
})
assert.ok(!/- comments/.test(a.yaml), 'A: public scope must not select login content')
assert.ok(/content: \[\]/.test(a.yaml), 'A: public scope should emit an empty content list')
assert.ok(a.yaml.includes('mode:\n  - chat') || a.yaml.includes('- chat'), 'A: chat mode missing')
assert.ok(!a.yaml.includes('docx'), 'A: chat-only must not pick a document format')

// --- scenario B: public, document ------------------------------------------
const b = await run('B-public-document', {
  purpose: 'competitor',
  subject: '某公司新品线',
  angles: ['product', 'technology'],
  lookback: '2025-06-01~2025-09-30',
  area: 'custom',
  area_countries: ['新加坡'],
  source_scope: 'public',
  output_mode: ['document'],
  output_format: 'md',
  length: 'short',
  must_include: ['conclusion', 'timeline', 'risk'],
  frequency: 'monthly',
})
assert.ok(b.yaml.includes('2025-06-01'), 'B: range lookback missing')
assert.ok(b.yaml.includes('新加坡'), 'B: custom area missing')
assert.ok(b.yaml.includes('monthly'), 'B: frequency missing')

// --- scenario C: login scope with content types ----------------------------
const c = await run('C-login-comments', {
  purpose: 'technology',
  subject: '目标行业消费变化',
  angles: ['person', 'capital'],
  lookback: 365,
  area: 'all',
  source_scope: 'public+login',
  login_pages: ['某内容平台'],
  login_method: 'user',
  login_content: ['cards', 'comments'],
  output_mode: ['table'],
  output_format: 'xlsx',
  length: 'medium',
  must_include: ['conclusion', 'data'],
  frequency: 'once',
})
assert.ok(c.yaml.includes('public+login'), 'C: scope missing')
assert.ok(c.yaml.includes('- comments'), 'C: login content comments missing')
assert.ok(c.yaml.includes('max_comments_per_note: 20'), 'C: comment cap missing')
assert.ok(c.yaml.includes('max_items_per_keyword: 10'), 'C: item cap missing')

// --- the interview must hide conditional questions until their trigger -----
const steps = [
  { answers: {}, expectHidden: ['login_pages', 'login_content', 'length', 'output_dir'] },
  { answers: { output_mode: ['document'] }, expectShown: ['length', 'output_format', 'output_dir'] },
  { answers: { source_scope: 'public+login' }, expectShown: ['login_pages', 'login_content'] },
]
for (const step of steps) {
  const view = await intel.execute({ mode: 'questions', answers: step.answers }, {})
  const ids = view.questions.map((q) => q.id)
  for (const id of step.expectHidden ?? []) assert.ok(!ids.includes(id), `${id} should be hidden for ${JSON.stringify(step.answers)}`)
  for (const id of step.expectShown ?? []) assert.ok(ids.includes(id), `${id} should be shown for ${JSON.stringify(step.answers)}`)
}

console.log('interview ok: A/B/C built, conditional visibility verified, YAML written to .interview-out/')
