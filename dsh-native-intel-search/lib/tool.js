import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

export const name = 'tool-intel-search'
export const inject = ['tools', 'workingDirectory']

const SCHEMA_VERSION = 2

// The question table is derived from the single source of truth
// (recurring-intel-search/reference/QUESTIONS.yaml) by scripts/build_questions.py.
// Never hand-edit questions.json, and never define a second question list here.
const SPEC = JSON.parse(readFileSync(new URL('./questions.json', import.meta.url), 'utf8'))

/**
 * Project a raw question from questions.json onto the declared question schema.
 * The YAML carries authoring extras (note, examples, free_text) and numeric option
 * values; the tool contract is closed, so normalize here instead of leaking them.
 */
function normalizeQuestion(raw) {
  const options = asArray(raw.options).map((option) => ({
    value: String(option.value),
    label: String(option.label ?? option.value),
  }))
  const rawDefault = raw.default
  const normalizedDefault = Array.isArray(rawDefault)
    ? rawDefault.map((item) => String(item))
    : rawDefault === undefined || rawDefault === null
      ? undefined
      : String(rawDefault)
  const question = {
    id: String(raw.id),
    group: String(raw.group ?? ''),
    round: Number.isInteger(raw.round) ? raw.round : 1,
    type: raw.type === 'multi' ? 'multi' : raw.type === 'text' ? 'text' : 'single',
    ask: String(raw.ask ?? ''),
    options,
    required: raw.required === true,
    maps_to: String(raw.maps_to ?? ''),
  }
  if (raw.when) question.when = String(raw.when)
  if (raw.note) question.note = String(raw.note)
  if (Array.isArray(raw.examples)) question.examples = raw.examples.map((item) => String(item))
  if (raw.free_text === true) question.free_text = true
  if (normalizedDefault !== undefined) question.default = normalizedDefault
  return question
}

const QUESTIONS = asArray(SPEC.questions).map(normalizeQuestion)
const RUNTIME_QUESTIONS = asArray(SPEC.runtime_questions).map(normalizeQuestion)

const PURPOSES = new Set([
  'enter_field',
  'competitor',
  'policy',
  'technology',
  'capital',
  'material',
  'job',
  'other',
  'auto',
])
const ANGLES = new Set(['policy', 'environment', 'person', 'product', 'technology', 'capital', 'other'])
const LOOKBACK_MODES = new Set(['relative', 'range', 'since_last'])
const AREA_MODES = new Set(['all', 'china', 'overseas', 'custom'])
const FREQUENCIES = new Set(['once', 'weekly', 'biweekly', 'monthly'])
const SCOPES = new Set(['public', 'public+login'])
const LOGIN_METHODS = new Set(['user', 'materials', 'existing_session'])
const OUTPUT_MODES = new Set(['chat', 'document', 'table', 'chart', 'other'])
const DOC_FORMATS = new Set(['docx', 'md', 'pdf'])
const TABLE_FORMATS = new Set(['xlsx', 'csv'])
const MUST_INCLUDE = new Set([
  'conclusion',
  'evidence',
  'timeline',
  'comparison',
  'data',
  'risk',
  'next',
  'quote',
])
const LENGTHS = new Set(['short', 'medium', 'unlimited'])
const AUDIENCES = new Set(['self', 'manager', 'client', 'public'])
const SOURCE_CONTENT = new Set(['cards', 'body', 'images', 'video', 'comments', 'metrics'])

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function listOf(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  if (typeof value === 'string') {
    return value
      .split(/[,，、;；]/)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

function question(id) {
  return QUESTIONS.find((item) => item.id === id)
}

function optionValues(q) {
  return asArray(q?.options).map((option) => String(option.value))
}

/** Map a raw answer (value, label, or loose text) onto the option value. */
function resolveOption(q, raw) {
  if (raw === undefined || raw === null) return ''
  const text = String(raw).trim()
  if (!text) return ''
  const options = asArray(q?.options)
  const byValue = options.find((option) => String(option.value).toLowerCase() === text.toLowerCase())
  if (byValue) return String(byValue.value)
  const byLabel = options.find((option) => String(option.label).trim() === text)
  if (byLabel) return String(byLabel.value)
  const loose = options.find(
    (option) => String(option.label).includes(text) || text.includes(String(option.label)),
  )
  return loose ? String(loose.value) : text
}

function resolveMulti(q, raw) {
  return listOf(raw)
    .map((item) => resolveOption(q, item))
    .filter(Boolean)
}

function hasFileMode(value) {
  const modes = listOf(value).map((mode) => mode.toLowerCase())
  return modes.includes('document') || modes.includes('table')
}

/** `when` conditions from QUESTIONS.yaml, evaluated against the answers so far. */
function isVisible(q, answers) {
  switch (q.id) {
    case 'login_pages':
    case 'login_method':
    case 'login_content':
      return resolveOption(question('source_scope'), answers.source_scope) === 'public+login'
    case 'length':
    case 'output_format':
    case 'output_dir':
      return hasFileMode(answers.output_mode)
    default:
      return true
  }
}

function isAnswered(answers, q) {
  if (!isVisible(q, answers)) return true
  const value = answers[q.id]
  if (Array.isArray(value)) return value.length > 0
  return value !== undefined && value !== null && String(value).trim() !== ''
}

function emptySummary() {
  return {
    name: '',
    purpose: '',
    subject: '',
    angles: [],
    lookback: '',
    area: '',
    scope: '',
    outputMode: [],
    mustInclude: [],
    frequency: '',
  }
}

function resolveLookback(answers) {
  const raw = String(answers.lookback ?? '').trim()
  const asDays = Number(raw)
  if (Number.isFinite(asDays) && asDays > 0) {
    return { mode: 'relative', days: Math.trunc(asDays), from: '', to: '' }
  }
  if (/since_last|上次|上一份|上次结果/i.test(raw)) {
    return { mode: 'since_last', days: 0, from: '', to: '' }
  }
  const range = raw.match(/(\d{4}-\d{2}-\d{2})\s*(?:~|～|-|至|到)\s*(\d{4}-\d{2}-\d{2})/)
  if (range) {
    return { mode: 'range', days: 0, from: range[1], to: range[2] }
  }
  const relative = raw.match(/(\d+)\s*(天|日|周|个月|月|年)/)
  if (relative) {
    const amount = Number(relative[1])
    const unit = relative[2]
    const multiplier = unit === '周' ? 7 : unit === '个月' || unit === '月' ? 30 : unit === '年' ? 365 : 1
    return { mode: 'relative', days: amount * multiplier, from: '', to: '' }
  }
  return { mode: 'relative', days: 30, from: '', to: '' }
}

function lookbackLabel(lookback) {
  if (lookback.mode === 'since_last') return 'since_last'
  if (lookback.mode === 'range') return `${lookback.from}~${lookback.to}`
  return `${lookback.days}d`
}

function buildConfigFromAnswers(answers = {}) {
  const purpose = resolveOption(question('purpose'), answers.purpose) || 'auto'
  const subject = String(answers.subject ?? '').trim()
  const angles = resolveMulti(question('angles'), answers.angles)
  const areaMode = resolveOption(question('area'), answers.area) || 'all'
  const frequency = resolveOption(question('frequency'), answers.frequency) || 'once'
  const outputMode = resolveMulti(question('output_mode'), answers.output_mode)
  const mustInclude = resolveMulti(question('must_include'), answers.must_include)
  const scope = resolveOption(question('source_scope'), answers.source_scope) || 'public'
  const loginMethod = resolveOption(question('login_method'), answers.login_method) || 'user'
  const audience = resolveOption(question('audience'), answers.audience) || 'self'
  const length = resolveOption(question('length'), answers.length) || 'medium'
  const modes = outputMode.length > 0 ? outputMode : ['chat']
  const wantsTable = modes.includes('table')
  const format = hasFileMode(modes)
    ? resolveOption(question('output_format'), answers.output_format) || (wantsTable ? 'xlsx' : 'docx')
    : ''

  const lookback = resolveLookback(answers)
  const run = {
    chrome_cdp_url: 'http://127.0.0.1:9222',
    login_wait_min: scope === 'public+login' && loginMethod === 'user' ? 30 : 0,
    max_items_per_keyword: 10,
    max_comments_per_note: 20,
    delay_seconds: [2, 5],
  }

  return {
    version: SCHEMA_VERSION,
    task: {
      name: `${subject || '情报'} 搜索`,
      purpose,
      purpose_note: purpose === 'other' ? String(answers.purpose_note ?? '').trim() : '',
      subject,
      angles: angles.length > 0 ? angles : ['policy', 'environment'],
      angle_note: angles.includes('other') ? String(answers.angle_note ?? '').trim() : '',
      keywords: listOf(answers.keywords),
      exclude: listOf(answers.exclude),
      lookback,
      area: {
        mode: areaMode,
        countries: areaMode === 'custom' ? listOf(answers.area_countries) : [],
      },
      frequency,
      timezone: 'Asia/Shanghai',
    },
    sources: {
      scope,
      login_pages: scope === 'public+login' ? listOf(answers.login_pages) : [],
      login_method: loginMethod,
      content:
        scope === 'public+login'
          ? (() => {
              const picked = resolveMulti(question('login_content'), answers.login_content)
              return picked.length > 0 ? picked : ['cards']
            })()
          : [],
      categories: [],
    },
    output: {
      mode: modes,
      other_note: modes.includes('other') ? String(answers.output_other ?? '').trim() : '',
      format,
      must_include: mustInclude.length > 0 ? mustInclude : ['conclusion', 'evidence'],
      length,
      audience,
      dir: String(answers.output_dir ?? './reports').trim() || './reports',
      doc_updates: { enabled: false, docs: [], backup_dir: './backups' },
    },
    run,
  }
}

function validateConfig(cfg) {
  const errors = []
  const warnings = []

  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { errors: ['config must be a YAML mapping'], warnings, summary: emptySummary() }
  }
  if (cfg.version !== SCHEMA_VERSION) {
    errors.push(`version is required and must be ${SCHEMA_VERSION}`)
  }

  const task = cfg.task ?? {}
  for (const key of ['name', 'subject', 'purpose', 'frequency']) {
    if (!String(task[key] ?? '').trim()) errors.push(`task.${key} is required`)
  }
  for (const key of ['domain', 'cadence', 'lookback_days']) {
    if (key in task) errors.push(`task.${key} is a v1 field; migrate to task.subject / task.frequency + task.lookback`)
  }
  if (task.purpose && !PURPOSES.has(task.purpose)) {
    errors.push(`task.purpose must be one of: ${[...PURPOSES].join(', ')}`)
  }
  const angles = asArray(task.angles)
  if (angles.length === 0) errors.push('task.angles must be a non-empty list')
  for (const angle of angles) {
    if (!ANGLES.has(angle)) errors.push(`task.angles has unknown value: ${angle}`)
  }
  if (angles.length > 4) warnings.push('more than 4 angles makes every section shallow')

  const lookback = task.lookback ?? {}
  if (!LOOKBACK_MODES.has(lookback.mode)) {
    errors.push('task.lookback.mode must be relative | range | since_last')
  } else if (lookback.mode === 'relative') {
    if (!Number.isInteger(lookback.days) || lookback.days < 1) {
      errors.push('task.lookback.days must be a positive integer when mode is relative')
    }
  } else if (lookback.mode === 'range') {
    const iso = /^\d{4}-\d{2}-\d{2}$/
    if (!iso.test(String(lookback.from ?? ''))) errors.push('task.lookback.from must be YYYY-MM-DD')
    if (!iso.test(String(lookback.to ?? ''))) errors.push('task.lookback.to must be YYYY-MM-DD')
    if (
      iso.test(String(lookback.from ?? '')) &&
      iso.test(String(lookback.to ?? '')) &&
      String(lookback.from) > String(lookback.to)
    ) {
      errors.push('task.lookback.from is later than task.lookback.to')
    }
  }

  const area = task.area ?? {}
  if (!AREA_MODES.has(area.mode)) {
    errors.push('task.area.mode must be all | china | overseas | custom')
  } else if (area.mode === 'custom' && asArray(area.countries).length === 0) {
    errors.push('task.area.countries is required when mode is custom')
  }
  if (!FREQUENCIES.has(task.frequency)) {
    errors.push(`task.frequency must be one of: ${[...FREQUENCIES].join(', ')}`)
  }
  if (asArray(task.keywords).length === 0) {
    warnings.push('task.keywords is empty; keywords are generated from subject + angles')
  }

  const sources = cfg.sources ?? {}
  if (!SCOPES.has(sources.scope)) {
    errors.push('sources.scope must be public | public+login')
  } else if (sources.scope === 'public+login') {
    if (asArray(sources.login_pages).length === 0) {
      errors.push('sources.login_pages is required when scope is public+login')
    }
    if (!LOGIN_METHODS.has(sources.login_method ?? 'user')) {
      errors.push('sources.login_method must be user | materials | existing_session')
    }
    const content = asArray(sources.content)
    if (content.length === 0) {
      errors.push('sources.content is required when scope is public+login')
    }
    for (const item of content) {
      if (!SOURCE_CONTENT.has(item)) errors.push(`sources.content has unknown value: ${item}`)
    }
  }

  const output = cfg.output ?? {}
  const modes = asArray(output.mode)
  if (modes.length === 0) errors.push('output.mode must be a non-empty list')
  for (const mode of modes) {
    if (!OUTPUT_MODES.has(mode)) errors.push(`output.mode has unknown value: ${mode}`)
  }
  const wantsDoc = modes.includes('document')
  const wantsTable = modes.includes('table')
  if (wantsDoc && wantsTable) {
    errors.push("output.mode cannot include both 'document' and 'table'")
  }
  if (wantsDoc && !DOC_FORMATS.has(output.format)) {
    errors.push('output.format must be docx | md | pdf when mode includes document')
  }
  if (wantsTable && !TABLE_FORMATS.has(output.format)) {
    errors.push('output.format must be xlsx | csv when mode includes table')
  }
  if ((wantsDoc || wantsTable) && !String(output.dir ?? '').trim()) {
    errors.push('output.dir is required when mode includes document or table')
  }
  if (output.length && !LENGTHS.has(output.length)) {
    errors.push('output.length must be short | medium | unlimited')
  }
  const include = asArray(output.must_include)
  if (include.length === 0) errors.push('output.must_include must be a non-empty list')
  for (const item of include) {
    if (!MUST_INCLUDE.has(item)) errors.push(`output.must_include has unknown value: ${item}`)
  }
  if (output.audience && !AUDIENCES.has(output.audience)) {
    errors.push('output.audience must be self | manager | client | public')
  }
  const updates = output.doc_updates ?? {}
  if (updates.enabled === true) {
    if (asArray(updates.docs).length === 0) errors.push('output.doc_updates.docs is required when enabled')
    if (!String(updates.backup_dir ?? '').trim()) errors.push('output.doc_updates.backup_dir is required when enabled')
  }

  const run = cfg.run ?? {}
  const wait = run.login_wait_min ?? 0
  if (!Number.isInteger(wait) || wait < 0) {
    errors.push('run.login_wait_min must be a non-negative integer')
  }

  return {
    errors,
    warnings,
    summary: {
      name: String(task.name ?? ''),
      purpose: String(task.purpose ?? ''),
      subject: String(task.subject ?? ''),
      angles,
      lookback: lookbackLabel(lookback),
      area: String(area.mode ?? ''),
      scope: String(sources.scope ?? ''),
      outputMode: modes,
      mustInclude: include,
      frequency: String(task.frequency ?? ''),
    },
  }
}

function buildPrompt(raw, configPath, summary) {
  return [
    '你正在执行一次可配置的情报搜索。严格按下面的配置执行；不要假设行业，也不要沿用其他项目的语境。',
    '',
    `## 运行配置（${configPath}）`,
    '```yaml',
    raw.trim(),
    '```',
    '',
    '## 执行要求',
    '1. 时间窗口只看 task.lookback；task.frequency 只决定是否定期再跑，两者互不派生。',
    '2. 按 task.angles 逐个角度搜索；task.keywords 为空时先由 subject + angles 生成 5–10 个并请用户确认。',
    '3. 来源只按 sources.scope：public 不碰需要登录的页面；public+login 只访问 sources.login_pages 里列出的页面。',
    '4. 输出按 output.mode；mode 只有 chat 时不要写任何文件。must_include 决定章节，不写无关章节充数。',
    '5. 每条结论给来源链接、日期、1–3 句原文摘录；重大结论至少两个独立来源；个人分享标“未验证”。',
    '6. 排除培训营、引流广告、纯营销，以及 task.exclude 里的内容。',
    '7. 遇到验证码、登录墙、403/429 立即停止并记录，不硬闯。',
    '8. 不要动用户已有文件；要并进已有文档必须先备份、只追加、不删不改原文。',
    '9. 最后列出未覆盖的角度和不可达的来源，并说明原因。',
    '',
    `本次配置摘要：${summary.name || '(unnamed)'} / 目的 ${summary.purpose || '(none)'} / 视角 ${summary.angles.join(', ') || '(none)'}` +
      ` / 时间 ${summary.lookback || '(none)'} / 区域 ${summary.area || '(none)'} / 来源 ${summary.scope || '(none)'}` +
      ` / 输出 ${summary.outputMode.join('+') || '(none)'} / 节奏 ${summary.frequency || '(none)'}。`,
  ].join('\n')
}

const parameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    config: {
      type: 'string',
      description:
        'Advanced: path to an existing config.yaml. Omit it to use the conversational interview.',
    },
    answers: {
      type: 'object',
      additionalProperties: true,
      description:
        'Answers collected in conversation, keyed by question id from QUESTIONS.yaml. If required answers are missing, the tool returns the remaining questions.',
    },
    mode: {
      type: 'string',
      enum: ['questions', 'plan', 'prompt'],
      description:
        'questions returns the interview questions; plan returns validation and summary; prompt also returns the run prompt.',
    },
  },
}

const questionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    group: { type: 'string' },
    round: { type: 'integer' },
    type: { type: 'string', enum: ['single', 'multi', 'text'] },
    ask: { type: 'string' },
    options: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          value: { type: 'string' },
          label: { type: 'string' },
        },
        required: ['value', 'label'],
      },
    },
    default: {},
    required: { type: 'boolean' },
    when: { type: 'string' },
    note: { type: 'string' },
    examples: { type: 'array', items: { type: 'string' } },
    free_text: { type: 'boolean' },
    maps_to: { type: 'string' },
  },
  required: ['id', 'group', 'type', 'ask', 'options', 'required', 'maps_to'],
}

const outputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['needs_input', 'ready', 'invalid'] },
    configPath: { type: 'string' },
    valid: { type: 'boolean' },
    errors: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: questionSchema },
    runtimeQuestions: { type: 'array', items: questionSchema },
    summary: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        purpose: { type: 'string' },
        subject: { type: 'string' },
        angles: { type: 'array', items: { type: 'string' } },
        lookback: { type: 'string' },
        area: { type: 'string' },
        scope: { type: 'string' },
        outputMode: { type: 'array', items: { type: 'string' } },
        mustInclude: { type: 'array', items: { type: 'string' } },
        frequency: { type: 'string' },
      },
      required: [
        'name',
        'purpose',
        'subject',
        'angles',
        'lookback',
        'area',
        'scope',
        'outputMode',
        'mustInclude',
        'frequency',
      ],
    },
    prompt: { type: 'string' },
  },
  required: [
    'status',
    'configPath',
    'valid',
    'errors',
    'warnings',
    'questions',
    'runtimeQuestions',
    'summary',
    'prompt',
  ],
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function checkCdp(cdpUrl) {
  try {
    const response = await fetch(`${cdpUrl.replace(/\/$/, '')}/json/version`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    const data = await response.json()
    return { ok: true, browser: String(data.Browser || '') }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function firstExisting(paths) {
  for (const candidate of paths) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

function browserCandidates() {
  if (process.platform === 'win32') {
    const pf = process.env.PROGRAMFILES || 'C:\\Program Files'
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
    const local = process.env.LOCALAPPDATA || ''
    return [
      {
        name: 'Google Chrome',
        cdp: true,
        paths: [
          path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ],
      },
      {
        name: 'Microsoft Edge',
        cdp: true,
        paths: [
          path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ],
      },
      {
        name: 'Brave',
        cdp: true,
        paths: [
          path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
          path.join(pf86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        ],
      },
      {
        name: 'Mozilla Firefox',
        cdp: false,
        paths: [
          path.join(pf, 'Mozilla Firefox', 'firefox.exe'),
          path.join(pf86, 'Mozilla Firefox', 'firefox.exe'),
        ],
      },
    ]
  }
  if (process.platform === 'darwin') {
    return [
      { name: 'Google Chrome', cdp: true, paths: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] },
      { name: 'Microsoft Edge', cdp: true, paths: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] },
      { name: 'Brave', cdp: true, paths: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'] },
      { name: 'Safari', cdp: false, paths: ['/Applications/Safari.app/Contents/MacOS/Safari'] },
      { name: 'Mozilla Firefox', cdp: false, paths: ['/Applications/Firefox.app/Contents/MacOS/firefox'] },
    ]
  }
  return [
    { name: 'Google Chrome', cdp: true, paths: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'] },
    { name: 'Chromium', cdp: true, paths: ['/usr/bin/chromium', '/usr/bin/chromium-browser'] },
    { name: 'Microsoft Edge', cdp: true, paths: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'] },
    { name: 'Brave', cdp: true, paths: ['/usr/bin/brave-browser', '/usr/bin/brave'] },
    { name: 'Mozilla Firefox', cdp: false, paths: ['/usr/bin/firefox'] },
  ]
}

function detectDefaultBrowser() {
  if (process.platform !== 'win32') return null
  try {
    const key =
      'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice'
    const output = execFileSync('reg', ['query', key, '/v', 'ProgId'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    const match = output.match(/ProgId\s+REG_SZ\s+(\S+)/i)
    if (!match) return null
    const progId = match[1]
    const name = /MSEdge/i.test(progId)
      ? 'Microsoft Edge'
      : /Chrome/i.test(progId)
        ? 'Google Chrome'
        : /Brave/i.test(progId)
          ? 'Brave'
          : /Firefox/i.test(progId)
            ? 'Mozilla Firefox'
            : ''
    if (!name) return null
    const candidate = browserCandidates().find((browser) => browser.name === name)
    if (!candidate) return null
    return {
      ...candidate,
      path: firstExisting(candidate.paths),
      source: 'default',
    }
  } catch {
    return null
  }
}

function findBrowser(explicit, preferDefault = true) {
  if (explicit) {
    const resolved = path.resolve(explicit)
    if (existsSync(resolved)) {
      return { name: path.basename(resolved), cdp: true, path: resolved, source: 'explicit' }
    }
  }

  const candidates = browserCandidates()

  if (preferDefault) {
    const fallback = detectDefaultBrowser()
    if (fallback?.path && fallback.cdp) return fallback
    if (fallback && !fallback.cdp) {
      const chromium = candidates.find((browser) => browser.cdp && firstExisting(browser.paths))
      if (chromium) {
        return {
          ...chromium,
          path: firstExisting(chromium.paths),
          source: 'fallback',
          note: `Default browser ${fallback.name} does not support CDP; using ${chromium.name}.`,
        }
      }
      return { ...fallback, note: 'Default browser does not support CDP.' }
    }
  }

  for (const candidate of candidates) {
    if (!candidate.cdp) continue
    const found = firstExisting(candidate.paths)
    if (found) return { ...candidate, path: found, source: 'installed' }
  }
  return null
}

async function openLoginPages(cdpUrl, loginUrls) {
  const opened = []
  for (const url of loginUrls) {
    try {
      const response = await fetch(
        `${cdpUrl.replace(/\/$/, '')}/json/new?${encodeURIComponent(url)}`,
        { method: 'PUT', signal: AbortSignal.timeout(3000) },
      )
      if (response.ok) opened.push(url)
    } catch {
      // Best-effort; the caller still gets the CDP status.
    }
  }
  return opened
}


/** Minimal CDP JSON-RPC over the browser's own WebSocket (Node 22+ global). */
function wsEvaluate(wsUrl, expression, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {}
      reject(new Error('CDP evaluate timed out'))
    }, timeoutMs)
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      )
    })
    ws.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.id !== 1) return
      clearTimeout(timer)
      try {
        ws.close()
      } catch {}
      if (message.error) {
        reject(new Error(message.error.message || 'CDP error'))
        return
      }
      if (message.result?.exceptionDetails) {
        reject(new Error(message.result.exceptionDetails.text || 'page evaluation failed'))
        return
      }
      resolve(message.result?.result?.value)
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('CDP websocket error'))
    })
  })
}

/** Default probe: a page with a login wall is logged out; a page with content is logged in. */
const LOGIN_PROBE = `(() => {
  const text = (document.body.innerText || '').slice(0, 3000);
  const wall = /扫码登录|登录后查看|请先登录|请登录后|Log in|Sign in|login to continue/i.test(text);
  const items = document.querySelectorAll('section.note-item, article, [data-testid="note-item"]').length;
  return JSON.stringify({ wall, items, loggedIn: !wall && items > 0, url: location.href });
})()`

async function checkLoginOnce(cdpUrl, urlContains, probe, timeoutMs) {
  const base = cdpUrl.replace(/\/$/, '')
  let targets
  try {
    const response = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(3000) })
    targets = await response.json()
  } catch (error) {
    return { ok: false, status: 'error', error: `CDP not reachable: ${error instanceof Error ? error.message : String(error)}` }
  }
  const page = targets.find((target) => target.type === 'page' && String(target.url).includes(urlContains))
  if (!page) return { ok: false, status: 'no_page', error: `no page matching "${urlContains}"` }
  try {
    const raw = await wsEvaluate(page.webSocketDebuggerUrl, probe, timeoutMs)
    let sample = {}
    try {
      sample = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {})
    } catch {
      sample = { raw }
    }
    return { ok: true, status: sample.loggedIn === true ? 'logged_in' : 'logged_out', sample }
  } catch (error) {
    return { ok: false, status: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}

export function apply(ctx, config = {}) {
  const defaultConfigPath = config.defaultConfigPath ?? './config.yaml'
  const maxConfigBytes = config.maxConfigBytes ?? 262144

  const tool = {
    name: 'intel_search',
    description:
      'Prepare a configurable intelligence search: collect answers defined in QUESTIONS.yaml, validate the config, and return a ready-to-run prompt. Call with no arguments first for the interview questions, then call again with the answers. The interview establishes three things: why search (purpose), what to collect (subject, angles, keywords, time window, area), and what to output (shape, must-have content, length, cadence).',
    parameters,
    output: {
      schema: outputSchema,
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.status === 'needs_input'
              ? `intel_search: ${value.questions.length} question(s) remaining.`
              : value.valid
                ? `intel_search: ${value.summary.name || '(unnamed)'} / 目的 ${value.summary.purpose || '(none)'} / 视角 ${value.summary.angles.join(', ') || '(none)'} / 输出 ${value.summary.outputMode.join('+') || '(none)'} ready.`
                : `intel_search: ${value.errors.length} error(s): ${value.errors.join('; ')}`,
        },
      ],
    },
    async execute(args, exec) {
      if (args.mode !== undefined && !['questions', 'plan', 'prompt'].includes(args.mode)) {
        throw new Error(`mode must be "questions", "plan", or "prompt" (got ${JSON.stringify(args.mode)})`)
      }

      const answers = args.answers || {}

      // Advanced file path: validate an existing config instead of interviewing.
      if (args.config) {
        const cwd = exec.agent
          ? await ctx.workingDirectory.ensure(exec.agent, exec.signal)
          : process.cwd()
        const requested = args.config || defaultConfigPath
        const configPath = path.isAbsolute(requested) ? requested : path.resolve(cwd, requested)
        const raw = await readFile(configPath, 'utf8')
        if (Buffer.byteLength(raw, 'utf8') > maxConfigBytes) {
          throw new Error(`config is larger than ${maxConfigBytes} bytes: ${configPath}`)
        }

        let cfg
        const parseErrors = []
        try {
          cfg = parseYaml(raw)
        } catch (error) {
          parseErrors.push(`YAML parse error: ${error instanceof Error ? error.message : String(error)}`)
        }
        const result =
          parseErrors.length > 0
            ? { errors: parseErrors, warnings: [], summary: emptySummary() }
            : validateConfig(cfg)

        return {
          status: result.errors.length === 0 ? 'ready' : 'invalid',
          configPath,
          valid: result.errors.length === 0,
          errors: result.errors,
          warnings: result.warnings,
          questions: [],
          runtimeQuestions: [],
          summary: result.summary,
          prompt:
            result.errors.length === 0 && args.mode !== 'plan'
              ? buildPrompt(raw, configPath, result.summary)
              : '',
        }
      }

      const visible = QUESTIONS.filter((q) => isVisible(q, answers))
      const remaining = visible.filter((q) => !isAnswered(answers, q))
      const missingRequired = remaining.filter((q) => q.required === true)
      if (missingRequired.length > 0 || (args.mode === 'questions' && remaining.length > 0)) {
        return {
          status: 'needs_input',
          configPath: '',
          valid: false,
          errors: [],
          warnings: [],
          questions: remaining.length > 0 ? remaining : visible,
          runtimeQuestions: [],
          summary: emptySummary(),
          prompt: '',
        }
      }

      const cfg = buildConfigFromAnswers(answers)
      const result = validateConfig(cfg)
      const raw = stringifyYaml(cfg)
      const ok = result.errors.length === 0
      return {
        status: ok ? 'ready' : 'invalid',
        configPath: '(conversation)',
        valid: ok,
        errors: result.errors,
        warnings: result.warnings,
        questions: [],
        runtimeQuestions: ok ? RUNTIME_QUESTIONS : [],
        summary: result.summary,
        prompt: ok && args.mode !== 'plan' ? buildPrompt(raw, '(conversation)', result.summary) : '',
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: args.config ? 'Load intel search config' : 'Start intel search interview',
        kind: 'read',
        rawInput: args.config || '(conversation)',
      }
    },
  }


  const browserTool = {
    name: 'browser_setup',
    description:
      'Check or start a browser CDP endpoint for login-gated sources. Detect the system default browser first; if it is Chromium-based (Edge/Chrome/Brave), launch it with the dedicated profile; if it is Firefox/Safari, fall back to an installed Chromium browser. Open login pages after CDP is ready.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cdp_url: {
          type: 'string',
          description: 'CDP endpoint. Default: http://127.0.0.1:9222',
        },
        profile_dir: {
          type: 'string',
          description:
          'Browser user-data-dir. Use the dedicated profile that holds the logins, e.g. <你的用户目录>\\.dsh-browser-profile.',
        },
        browser_path: {
          type: 'string',
          description: 'Optional explicit browser executable path; overrides default-browser detection.',
        },
        chrome_path: {
          type: 'string',
          description: 'Legacy alias for browser_path.',
        },
        prefer_default: {
          type: 'boolean',
          description: 'Prefer the system default browser when it supports CDP. Default true.',
        },
        login_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Login pages to open after CDP is ready.',
        },
        wait_seconds: {
          type: 'integer',
          description: 'How long to wait for CDP after launch. Default 30.',
        },
        check_only: {
          type: 'boolean',
          description: 'If true, only check CDP; never launch a browser.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['ready', 'launched', 'failed'] },
          cdpUrl: { type: 'string' },
          profileDir: { type: 'string' },
          browserPath: { type: 'string' },
          browserName: { type: 'string' },
          source: { type: 'string' },
          launched: { type: 'boolean' },
          loginUrls: { type: 'array', items: { type: 'string' } },
          browser: { type: 'string' },
          note: { type: 'string' },
          error: { type: 'string' },
        },
        required: [
          'status',
          'cdpUrl',
          'profileDir',
          'browserPath',
          'browserName',
          'source',
          'launched',
          'loginUrls',
          'browser',
          'note',
          'error',
        ],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.status === 'ready'
              ? `browser_setup: CDP ready (${value.browser || 'browser'}).`
              : value.status === 'launched'
                ? `browser_setup: ${value.browserName || 'browser'} launched; log in in the opened window.`
                : `browser_setup failed: ${value.error}`,
        },
      ],
    },
    async execute(args, exec) {
      const cdpUrl = String(args.cdp_url || 'http://127.0.0.1:9222')
      const cwd = exec?.agent
        ? await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        : process.cwd()
      const profileDir = path.resolve(
        cwd,
        String(args.profile_dir || process.env.DSH_BROWSER_PROFILE || '.dsh-browser-profile'),
      )
      const loginUrls = Array.isArray(args.login_urls)
        ? args.login_urls.map(String).filter(Boolean)
        : []
      const waitSeconds = Number.isInteger(args.wait_seconds)
        ? Math.max(1, Math.min(120, args.wait_seconds))
        : 30

      const before = await checkCdp(cdpUrl)
      if (before.ok) {
        const opened = await openLoginPages(cdpUrl, loginUrls)
        return {
          status: 'ready',
          cdpUrl,
          profileDir,
          browserPath: '',
          browserName: before.browser,
          source: 'existing',
          launched: false,
          loginUrls: opened.length > 0 ? opened : loginUrls,
          browser: before.browser,
          note: '',
          error: '',
        }
      }

      if (args.check_only) {
        return {
          status: 'failed',
          cdpUrl,
          profileDir,
          browserPath: '',
          browserName: '',
          source: '',
          launched: false,
          loginUrls,
          browser: '',
          note: '',
          error: `CDP not reachable at ${cdpUrl}: ${before.error || 'unknown'}`,
        }
      }

      const explicit = args.browser_path || args.chrome_path
      const selected = findBrowser(explicit, args.prefer_default !== false)
      if (!selected || !selected.path) {
        return {
          status: 'failed',
          cdpUrl,
          profileDir,
          browserPath: '',
          browserName: '',
          source: '',
          launched: false,
          loginUrls,
          browser: '',
          note: '',
          error:
            'No browser executable found. Install Chrome/Edge/Brave, pass browser_path, or start the browser manually.',
        }
      }

      if (!selected.cdp) {
        return {
          status: 'failed',
          cdpUrl,
          profileDir,
          browserPath: selected.path,
          browserName: selected.name,
          source: selected.source,
          launched: false,
          loginUrls,
          browser: '',
          note: selected.note || '',
          error: `Default browser ${selected.name} does not support CDP. Install/use Chrome/Edge/Brave, or pass browser_path.`,
        }
      }

      await mkdir(profileDir, { recursive: true })
      let port = '9222'
      try {
        port = new URL(cdpUrl).port || '9222'
      } catch {
        // Keep the default port; checkCdp will report the invalid URL.
      }

      try {
        const child = spawn(
          selected.path,
          [
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${profileDir}`,
            '--no-first-run',
            '--no-default-browser-check',
            'about:blank',
          ],
          { detached: true, stdio: 'ignore', windowsHide: false },
        )
        child.unref()
      } catch (error) {
        return {
          status: 'failed',
          cdpUrl,
          profileDir,
          browserPath: selected.path,
          browserName: selected.name,
          source: selected.source,
          launched: false,
          loginUrls,
          browser: '',
          note: selected.note || '',
          error: error instanceof Error ? error.message : String(error),
        }
      }

      let lastError = ''
      const deadline = Date.now() + waitSeconds * 1000
      while (Date.now() < deadline) {
        await sleep(500)
        const now = await checkCdp(cdpUrl)
        if (now.ok) {
          const opened = await openLoginPages(cdpUrl, loginUrls)
          return {
            status: 'launched',
            cdpUrl,
            profileDir,
            browserPath: selected.path,
            browserName: selected.name,
            source: selected.source,
            launched: true,
            loginUrls: opened.length > 0 ? opened : loginUrls,
            browser: now.browser,
            note: selected.note || '',
            error: '',
          }
        }
        lastError = now.error || lastError
      }

      return {
        status: 'failed',
        cdpUrl,
        profileDir,
        browserPath: selected.path,
        browserName: selected.name,
        source: selected.source,
        launched: true,
        loginUrls,
        browser: '',
        note: selected.note || '',
        error: `Browser launched but CDP was not ready within ${waitSeconds}s: ${lastError}. If this profile is already open without 9222, close it and retry.`,
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: 'Check or start browser CDP',
        kind: 'other',
        rawInput: args.cdp_url || 'http://127.0.0.1:9222',
      }
    },
  }


  const loginTool = {
    name: 'browser_login_check',
    description:
      'Check whether a login-gated page is actually logged in, by evaluating a probe in the page over CDP. Use this instead of asking the user to report back: open the login page with browser_setup, then call this once now and again after the public sources are done. With wait_seconds > 0 it polls until logged in or the timeout expires.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cdp_url: { type: 'string', description: 'CDP endpoint. Default: http://127.0.0.1:9222' },
        url_contains: { type: 'string', description: 'Substring of the target page URL. Default: the login host.' },
        probe: {
          type: 'string',
          description:
            'Optional JS expression evaluated in the page; must return JSON with { loggedIn: boolean }. Defaults to a login-wall-vs-content heuristic.',
        },
        wait_seconds: {
          type: 'integer',
          description: '0 = single check (default). >0 = poll until logged in or the timeout expires.',
        },
        poll_seconds: { type: 'integer', description: 'Polling interval when wait_seconds > 0. Default 5.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['logged_in', 'logged_out', 'no_page', 'timeout', 'error'] },
          waitedSeconds: { type: 'integer' },
          url: { type: 'string' },
          items: { type: 'integer' },
          error: { type: 'string' },
        },
        required: ['status', 'waitedSeconds', 'url', 'items', 'error'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.status === 'logged_in'
              ? `browser_login_check: logged in (${value.items} items on page).`
              : value.status === 'logged_out'
                ? 'browser_login_check: still on the login wall.'
                : `browser_login_check: ${value.status}${value.error ? ' - ' + value.error : ''}`,
        },
      ],
    },
    async execute(args) {
      const cdpUrl = String(args.cdp_url || 'http://127.0.0.1:9222')
      const urlContains = String(args.url_contains || '')
      const probe = String(args.probe || LOGIN_PROBE)
      const waitSeconds = Number.isInteger(args.wait_seconds) ? Math.max(0, Math.min(600, args.wait_seconds)) : 0
      const pollSeconds = Number.isInteger(args.poll_seconds) ? Math.max(2, Math.min(30, args.poll_seconds)) : 5

      const deadline = Date.now() + waitSeconds * 1000
      let result = await checkLoginOnce(cdpUrl, urlContains, probe, 8000)
      while (result.status === 'logged_out' && Date.now() < deadline) {
        await sleep(pollSeconds * 1000)
        result = await checkLoginOnce(cdpUrl, urlContains, probe, 8000)
      }
      if (result.status === 'logged_out' && Date.now() >= deadline && waitSeconds > 0) {
        result = { ...result, status: 'timeout' }
      }
      const sample = result.sample || {}
      return {
        status: result.status,
        waitedSeconds: waitSeconds,
        url: String(sample.url || ''),
        items: Number(sample.items || 0),
        error: result.error || '',
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: 'Check login state via CDP',
        kind: 'read',
        rawInput: args.cdp_url || 'http://127.0.0.1:9222',
      }
    },
  }

  ctx.tools.register(tool)
  ctx.tools.register(browserTool)
  ctx.tools.register(loginTool)
}
