# Config Reference（schema v2）

> 这是 schema 参考。普通使用由 Agent 在对话里问，不需要用户编辑本文件。
> 只有高级用法（固定预设、已有配置文件）才需要手写 `config.yaml`。
> 问题定义见 [QUESTIONS.yaml](QUESTIONS.yaml)；本文件只解释字段。

一个 `config.yaml` 描述四件事：**为什么搜、搜什么、从哪搜、输出什么**。
字段留空或 `enabled: false` 时，对应模块跳过，结果里写"未配置 / 未覆盖"。

## 最小配置

```yaml
version: 2

task:
  name: "行业合规搜索"
  purpose: "policy"
  subject: "某行业"
  angles: ["policy", "environment"]
  lookback:
    mode: "relative"
    days: 90
  area:
    mode: "china"
  frequency: "once"

sources:
  scope: "public"

output:
  mode: ["chat"]
  must_include: ["conclusion", "evidence"]
```

## `task`

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 输出文件名前缀，也是标题 |
| `purpose` | 是 | `enter_field` / `competitor` / `policy` / `technology` / `capital` / `material` / `job` / `other` / `auto` |
| `purpose_note` | 否 | `purpose: other` 时的一句话说明 |
| `subject` | 是 | 搜什么：行业 / 公司 / 产品 / 政策 / 人物 / 事件 |
| `angles` | 是 | 视角，至少一个：`policy` / `environment` / `person` / `product` / `technology` / `capital` / `other` |
| `angle_note` | 否 | `angles` 含 `other` 时的说明 |
| `keywords` | 否 | 留空则由 `subject + angles` 生成，先确认再搜 |
| `exclude` | 否 | 明确不看的内容：已知结论、竞品黑名单、噪音类型 |
| `lookback` | 是 | 见下 |
| `area` | 是 | 见下 |
| `frequency` | 是 | `once` / `weekly` / `biweekly` / `monthly` |
| `timezone` | 否 | 默认 `Asia/Shanghai`，用于日期 |

### `task.lookback`（时间窗口，与频率无关）

| 字段 | 说明 |
|---|---|
| `mode` | `relative`（最近 N 天）/ `range`（起止日期）/ `since_last`（上一份结果之后） |
| `days` | `mode: relative` 时生效，默认 30 |
| `from` / `to` | `mode: range` 时生效，`YYYY-MM-DD` |

### `task.area`（区域范围）

| 字段 | 说明 |
|---|---|
| `mode` | `all`（默认，不按地域过滤）/ `china` / `overseas` / `custom` |
| `countries` | `mode: custom` 时生效，如 `["新加坡", "日本"]` |

## `sources`

| 字段 | 必填 | 说明 |
|---|---|---|
| `scope` | 是 | `public`（含不登录可见的社交/招聘公开页）/ `public+login` |
| `login_pages` | 条件 | `scope: public+login` 时必填：URL 或"平台/账号/页面名" |
| `login_method` | 条件 | `user`（用户自己登录，默认）/ `materials`（用户贴内容，不登录）/ `existing_session`（复用现有 CDP 会话） |
| `content` | 条件 | `scope: public+login` 时必填：`cards` / `body` / `images` / `video` / `comments` / `metrics` |
| `categories` | 否 | 收窄来源类型：`news` / `company` / `research` / `policy` / `social` / `jobs` / `capital` |

规则：

- `scope: public` → 绝不访问需要登录的页面。
- `scope: public+login` → 只访问 `login_pages` 里列出的页面。
- 没有浏览器 / CDP，或 `run.login_wait_min: 0` → 跳过登录型来源并记录原因。
- 登录失败、遇到验证码 → 跳过，不硬闯。

## `output`

| 字段 | 必填 | 说明 |
|---|---|---|
| `mode` | 是 | 可多选：`chat` / `document` / `table` / `chart` / `other` |
| `other_note` | 否 | `mode` 含 `other` 时的说明 |
| `format` | 条件 | `document`: `docx` / `md` / `pdf`；`table`: `xlsx` / `csv` |
| `must_include` | 是 | 可多选：`conclusion` / `evidence` / `timeline` / `comparison` / `data` / `risk` / `next` / `quote` |
| `length` | 否 | `short` / `medium` / `unlimited`，仅 `document` / `table` |
| `audience` | 否 | `self` / `manager` / `client` / `public` |
| `dir` | 条件 | `document` / `table` 时的输出目录，默认 `./reports` |

规则：

- `mode: ["chat"]` → 不写任何文件，也就不需要 `format` / `length` / `dir`。
- `chart` → 只有来源里存在可提取的数据点时才画；否则明确写"数据不足"。
- `must_include` 决定章节；不在其中的章节不要写来充数。

### `output.doc_updates`（运行期才启用）

| 字段 | 说明 |
|---|---|
| `enabled` | 默认 `false`。只有用户运行期明确选择"并进已有文档"才置 `true` |
| `docs` | 要追加的文档路径列表 |
| `backup_dir` | 备份目录，改前生成 `YYYY-MM-DD.zip` |

规则：

- 面试阶段永远是 `false`，新用户不会被问到。
- 只追加；删除、重写、改结论标"待确认"。
- 改前备份；构建失败立即回滚；changelog 必须能指导恢复。

## `run`

| 字段 | 说明 |
|---|---|
| `chrome_cdp_url` | 专用浏览器的 CDP 端点，如 `http://127.0.0.1:9222` |
| `login_wait_min` | 等用户登录的最长分钟数；`0` 表示禁用登录型来源 |
| `max_items_per_keyword` | 每个关键词的上限，默认 10 |
| `max_comments_per_note` | 每条笔记最多取多少条评论，默认 20 |
| `delay_seconds` | `[min, max]` 请求间隔 |

## 从 v1 迁移

v1 的 `task.domain` / `task.cadence` / `lookback_days` / `topics[]` / `user.*` 已废弃：

| v1 | v2 |
|---|---|
| `task.domain` | `task.subject` |
| `topics[].name` | `task.angles`（按视角分组，不再是自由主题） |
| `topics[].keywords` | `task.keywords` |
| `task.cadence` + `lookback_days` | `task.frequency` + `task.lookback`（两个独立字段） |
| `user.profile` / `target_roles` | 移到 `purpose: job` 支线（`task.job.*`），通用流程不需要 |
| `output.report.enabled/format/dir/sections` | `output.mode` / `format` / `dir` / `must_include` |
| `output.changelog` | 并入 `output.doc_updates` 的运行期流程 |

`validate_config.py` 遇到 `task.cadence` 或 `task.domain` 会直接报错并提示按上表迁移。

## 常见错误

- 把"频率"和"时间窗口"混成一个字段（v2 里是两个）。
- `sources.scope: public+login` 但没写 `login_pages`。
- `output.mode: ["chat"]` 却填了 `format` / `dir`。
- `must_include` 里塞了不认识的章节名。
- 把某个具体公司的来源写死在模板里，而不是写进对话答案。
- 面试阶段就把 `doc_updates.enabled` 设为 `true`。
