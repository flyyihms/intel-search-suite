import assert from 'node:assert/strict'

// Guard the two bugs that only showed up at runtime in DSH:
//   1. output fields the declared schema does not allow (note/examples/...)
//   2. option values that are not strings (numeric YAML values)
// It also proves the tool loads with its real dependencies (yaml, node:fs).
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
assert.ok(intel, 'intel_search was not registered')
assert.ok(tools.find((tool) => tool.name === 'browser_setup'), 'browser_setup was not registered')
assert.ok(tools.find((tool) => tool.name === 'browser_login_check'), 'browser_login_check was not registered')

const QUESTION_FIELDS = new Set([
  'id',
  'group',
  'round',
  'type',
  'ask',
  'options',
  'default',
  'required',
  'when',
  'note',
  'examples',
  'free_text',
  'maps_to',
])
const REQUIRED_FIELDS = ['id', 'group', 'type', 'ask', 'options', 'required', 'maps_to']

function checkQuestion(question) {
  for (const key of Object.keys(question)) {
    assert.ok(QUESTION_FIELDS.has(key), `${question.id}: undeclared field "${key}"`)
  }
  for (const key of REQUIRED_FIELDS) {
    assert.ok(key in question, `${question.id}: missing required field "${key}"`)
  }
  assert.ok(Array.isArray(question.options), `${question.id}: options must be an array`)
  for (const option of question.options) {
    assert.equal(typeof option.value, 'string', `${question.id}: option.value must be a string`)
    assert.equal(typeof option.label, 'string', `${question.id}: option.label must be a string`)
  }
}

const empty = await intel.execute({ mode: 'questions' }, {})
assert.equal(empty.status, 'needs_input')
assert.ok(empty.questions.length > 0, 'no questions returned')
empty.questions.forEach(checkQuestion)

// Conditional questions must stay hidden until their `when` holds.
const chatOnly = await intel.execute({ mode: 'questions', answers: { output_mode: ['chat'] } }, {})
const chatIds = chatOnly.questions.map((q) => q.id)
for (const hidden of ['length', 'output_format', 'output_dir']) {
  assert.ok(!chatIds.includes(hidden), `${hidden} must not appear for chat-only output`)
}

const loginHidden = await intel.execute({ mode: 'questions', answers: { source_scope: 'public' } }, {})
const loginHiddenIds = loginHidden.questions.map((q) => q.id)
for (const hidden of ['login_pages', 'login_method', 'login_content']) {
  assert.ok(!loginHiddenIds.includes(hidden), `${hidden} must stay hidden for public scope`)
}

const loginShown = await intel.execute({ mode: 'questions', answers: { source_scope: 'public+login' } }, {})
const loginShownIds = loginShown.questions.map((q) => q.id)
for (const shown of ['login_pages', 'login_method', 'login_content']) {
  assert.ok(loginShownIds.includes(shown), `${shown} must appear for login scope`)
}

const ready = await intel.execute(
  {
    mode: 'plan',
    answers: {
      purpose: 'policy',
      subject: '某行业',
      angles: ['policy', 'environment'],
      keywords: '行业, 合规',
      lookback: 90,
      area: 'china',
      source_scope: 'public',
      output_mode: ['document'],
      output_format: 'docx',
      must_include: ['conclusion', 'evidence'],
      frequency: 'once',
    },
  },
  {},
)
assert.equal(ready.status, 'ready', `expected ready, got ${ready.status}: ${ready.errors.join('; ')}`)
assert.equal(ready.summary.area, 'china')
assert.equal(ready.summary.lookback, '90d')

const invalid = await intel.execute(
  {
    mode: 'plan',
    answers: {
      purpose: 'policy',
      subject: 'x',
      angles: ['policy'],
      lookback: '2025-03-01~2025-01-01',
      area: 'custom',
      area_countries: ['SG'],
      source_scope: 'public',
      output_mode: ['table'],
      output_format: 'docx',
      must_include: ['conclusion'],
      frequency: 'once',
    },
  },
  {},
)
assert.equal(invalid.status, 'invalid', 'mismatched table format must be rejected')
assert.ok(invalid.errors.length >= 2, 'expected at least two validation errors')

console.log(`smoke ok: ${empty.questions.length} questions, conditional rules ok, ready/invalid paths ok`)
