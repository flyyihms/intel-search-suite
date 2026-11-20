# DSH 原生插件：intel-search

这是一个 **DSH 原生 bundle**，安装后注册两个工具：`intel_search` 和 `browser_setup`。

它做五件事：

1. 从 `lib/questions.json` 取出问题清单（由 `QUESTIONS.yaml` 生成，唯一事实源）
2. 把对话里的回答组装成内部 config（schema v2）
3. 校验配置：目的、视角、时间范围、区域、来源、输出、登录
4. 返回配置摘要 + 一段可直接执行的搜索 Prompt
5. 要登录时，检查 9222；没开就先启动**系统默认浏览器**（Chromium 系），Firefox/Safari 则回退到已安装的 Chromium，并打开登录页

它**不自己搜网页**。真正的搜索、抓取、写文件仍由 DSH Agent 用现有 web/文件工具完成；`browser_setup` 只负责把登录环境拉起来。

## 这是给 DSH 写的

先说清楚边界，免得装错地方：

- 它通过 DSH 的 Cordis 运行时注册工具（`ctx.tools`）并使用 `ctx.workingDirectory`，**只能在 DSH 里运行**。
  不是通用 CLI，也不是给别的 Agent 用的 MCP server。
- **在 DSH 里怎么用**：
  1. 安装（`dsh plugin ... add file:<仓库路径>\dsh-native-intel-search`，或 Plugins 页面）
  2. 重启或等 HMR 重载（工具列表里应出现 `intel_search` 和 `browser_setup`）
  3. 调 `intel_search({})` 拿问题 → 把回答作为 `answers` 再调一次 → 拿返回的 `prompt` 去执行搜索
- **想迁移到别的宿主**：
  - 首选直接用 `prompt-only/PROMPT.md`（纯文本）或 `recurring-intel-search`（Skill）——它们只要求宿主"能对话、能上网"。
  - 要保留代码形态：`recurring-intel-search/reference/QUESTIONS.yaml` 和 schema v2 可以原样复用，
    自己写一个等价的"问 18 题 + 组装 config + 产出 prompt"的脚本即可，不需要 DSH 的任何 API。
  - 迁移时唯一要重写的是 `browser_setup`（DSH 专属的 CDP 启动器），换宿主可用 Playwright/Puppeteer 代替。

## 结构

```text
dsh-native-intel-search/
├── package.json          # bundle + tool subpath
├── cordis.patch.yml      # 插入 tool-intel-search 行
├── lib/
│   ├── index.js          # bundle 入口（空）
│   ├── tool.js           # intel_search + browser_setup
│   └── questions.json    # 由 QUESTIONS.yaml 生成，不要手改
├── config.template.yaml  # schema 参考/可选预填
└── README.md
```

## 安装

优先用 DSH 的插件管理器或 CLI。

### CLI

```powershell
# 把 <仓库路径> 换成你克隆/解压的位置
dsh plugin --profile desktop add file:<仓库路径>\dsh-native-intel-search
```

`desktop` 换成你的 profile 名。安装后确认 bundle 已启用；没有 HMR 时重启 DSH。

`file:` 和 `link:` 都能装，占用的磁盘和生效方式不同，按需选：

| 方式 | profile 里放什么 | C 盘占用 | 改代码后 |
|---|---|---|---|
| `file:`（默认） | 拷贝一份包 + 依赖 | 约 1.7 MB | 必须重装一次 |
| `link:` | 一个符号链接指向仓库 | 约几 KB | **重启即生效**，不用重装 |

`link:` 的**前提**：仓库里先装过一次依赖，让 `yaml` 能从仓库目录解析：

```powershell
cd <仓库路径>\dsh-native-intel-search
npm install --no-audit --no-fund
dsh plugin --profile desktop add "link:<仓库路径>\dsh-native-intel-search"
```

没装依赖就用 `link:`，加载会报 `Cannot find package 'yaml'`——这就是旧版 README 说"别用 link"的原因。

### Web

Plugins 页面 → Install / Add bundle → 选择你克隆下来的本地路径 `<仓库路径>\dsh-native-intel-search`。
安装/启用后重启或等 HMR 重载。

## 问题从哪来

- 唯一事实源：`../recurring-intel-search/reference/QUESTIONS.yaml`
- 生成：`python recurring-intel-search/scripts/build_questions.py .`
- CI 会校验 `lib/questions.json` 与 YAML 是否一致；不一致直接报 `questions.json is stale`

**不要在 `tool.js` 里另写一份问题列表。** 之前就是这么漂移成三套问题的。

## 配置方式

默认：**对话式**。第一次调用 `intel_search` 不传参数，它返回 `needs_input` 和剩余问题；Agent 问完后把回答作为 `answers` 再调一次。

问题共 18 题，分 4 组：

| 组 | 题号 | 问什么 |
|---|---|---|
| A 目的 | 1 | 支持什么决定 |
| B 搜什么 | 2–7 | 对象 / 视角 / 关键词 / 时间范围 / 区域 / 不看什么 |
| C 来源 | 8–11 | 公开 / 公开+登录；具体页面、登录方式、要取的内容 |
| D 输出 | 12–18 | 形态 / 格式 / 要件 / 篇幅 / 受众 / 节奏 / 目录 |

必答 9 题 + 条件必答；`when` 条件不满足的题不会出现在返回里（例如只选"对话里回答"就不会出现篇幅、格式、目录）。

## 使用

### 1. 先拿问题

```json
{ "mode": "questions" }
```

返回示例（节选）：

```json
{
  "status": "needs_input",
  "questions": [
    {
      "id": "purpose",
      "group": "A",
      "type": "single",
      "ask": "这次搜索要支持你做什么决定？",
      "options": [
        { "value": "policy", "label": "盯政策与合规变化" },
        { "value": "auto", "label": "你帮我判断" }
      ],
      "required": true,
      "maps_to": "task.purpose"
    }
  ],
  "runtimeQuestions": []
}
```

### 2. 带回答再调用

```json
{
  "answers": {
    "purpose": "policy",
    "subject": "某行业",
    "angles": ["policy", "environment"],
    "lookback": 90,
    "area": "china",
    "source_scope": "public",
    "output_mode": ["document"],
    "output_format": "docx",
    "must_include": ["conclusion", "evidence", "risk"],
    "frequency": "once"
  },
  "mode": "prompt"
}
```

返回 `status: "ready"`、`summary`、`prompt`，以及 `runtimeQuestions`（写入文件前才问的"新建 / 并进已有文档"）。

- `mode: "questions"`：只返回剩余问题。
- `mode: "plan"`：只返回校验结果和摘要。
- `mode: "prompt"`：额外返回完整执行 Prompt。
- 配置有错时 `status: "invalid"`，`errors` 列出具体字段。
- 条件题不满足时不会出现在 `questions` 里；答案里多填的条件字段会被忽略。

高级：`{ "config": "config.yaml", "mode": "prompt" }` 仍可用（schema v2）。

## 登录前：browser_setup

如果配置里 `sources.scope` 是 `public+login`，先调用：

```json
{
  "prefer_default": true,
  "profile_dir": "<你的用户目录>\\.dsh-browser-profile",
  "login_urls": ["https://www.xiaohongshu.com"],
  "wait_seconds": 30
}
```

它会：

1. 检查 `127.0.0.1:9222`
2. 没开就检测**系统默认浏览器**：Edge / Chrome / Brave 等 Chromium 系优先
3. 默认是 Firefox / Safari 时，回退到已安装的 Chromium
4. 用专用 profile 启动，等 CDP 就绪
5. 打开登录页

返回 `status: ready / launched / failed`，以及 `browserName`、`browserPath`、`source`、`note`。

登录仍由用户完成。**登录态在哪个浏览器，就用哪个；换浏览器要重新登录。**
只想检查、不启动：`{ "check_only": true }`。

## 登录后怎么知道好了：browser_login_check

不需要用户回一句"好了"。这个工具在页面里跑探针（默认判断"登录墙 vs 有内容的页面"），返回结构化状态：

```json
{ "status": "logged_in", "waitedSeconds": 0, "url": "https://www.xiaohongshu.com/...", "items": 22, "error": "" }
```

- `wait_seconds: 0`（默认）→ 只查一次，适合"开浏览器后先记个初始状态"
- `wait_seconds: 120` → 自己轮询到登录成功或超时，不用用户回话
- `probe` 可传自定义 JS（返回 `{ loggedIn: boolean }`），适配别的站点
- `status`：`logged_in` / `logged_out` / `timeout` / `no_page` / `error`

## 边界

- 这是 DSH 原生 bundle，不是 Skill，也不是纯 Prompt。
- 不内置搜索/抓取；搜索由 DSH 的 web 工具执行。
- 不代替用户登录；`browser_setup` 只启动浏览器和打开登录页。
- `browser_setup` 启动浏览器可能受宿主沙箱限制；失败时用浏览器自己的命令手动启动。
- 安装 Host 代码会在 DSH 进程内运行；只安装你信任的包。
- 卸载：Plugins 页面 Remove，或 `dsh plugin --profile desktop remove dsh-intel-search`。

## 已验证

- `node --check lib/tool.js` 通过。
- 加载插件后注册了 `intel_search`、`browser_setup`、`browser_login_check` 三个工具。
- `intel_search({})` → `needs_input`，返回 12 题（18 题中 6 题为条件题，此时不出现）。
- 只选 `output_mode: ["chat"]` → 不返回 `length` / `output_format` / `output_dir`。
- 选 `document` → 三者出现；选 `public+login` → 出现 `login_pages` / `login_method`。
- 完整答案 → `ready`，摘要含 purpose/angles/lookback/area/scope/outputMode/frequency。
- 故意错配（表格 + docx、起始日期晚于结束日期）→ `invalid`，`errors` 精确列出两条。
- `validate_config.py --all` 通过：18 题、6 条件题、questions.json 与 YAML 一致、三份模板一致。
- `browser_login_check` 实测：对已登录的某内容平台搜索页返回 `logged_in`、`items: 22`。
- `node scripts/smoke.mjs` 通过：输出字段都在声明范围内、选项值均为字符串、条件题按 `when` 隐藏、
  `ready` 与 `invalid` 两条路径正确。CI 已接入该脚本。
- `node scripts/interview.mjs` 通过：A（公开+对话）、B（公开+文档+日期区间+自定义区域）、C（登录+评论）
  三条路径都能产出 `ready`，且生成的 YAML 能被 Python 校验器再次通过。CI 已接入。

## 版本

- DSH: `0.2.1-rc.3`
- Node: `>=20`
- 依赖: `yaml`
