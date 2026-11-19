# Intel Search Suite

![ci](https://github.com/flyyihms/intel-search-suite/actions/workflows/ci.yml/badge.svg)

三个版本，同一个核心：**可配置的情报搜索**。
都支持对话式配置——不需要先改 YAML，也不需要先准备 `config.yaml`。

## 怎么选（先看这个）

| 你的情况 | 选哪个 | 原因 |
|---|---|---|
| 只想试一次；或者发给别人用 | **Prompt** | 不用安装，复制就能跑 |
| 经常用，宿主支持 Agent Skill | **Skill** | 安装一次，之后按技能调用 |
| 主要在 DSH 里用，想要一个原生工具入口 | **DSH Native** | 注册 `intel_search` + `browser_setup`，最像“插件” |
| 要跨软件/跨宿主 | **Prompt** | Native 绑定 DSH；Skill 也要宿主支持 |
| 不想安装任何东西 | **Prompt** | 零安装 |
| 想安装后自动被发现 | **Skill / Native** | 有技能/工具注册 |
| 要自动更新 Word + 备份 + changelog | 三者都支持 | 按宿主和安装意愿选 |

一句话：

- **Prompt**：最轻，适合试用和分享。
- **Skill**：适合长期复用，安装一次就能按技能调用。
- **DSH Native**：适合 DSH 深度用户，要一个真正的工具入口。

## 三者对比

| 维度 | Prompt | Skill | DSH Native |
|---|---|---|---|
| 形态 | 纯 Prompt | `SKILL.md` + 参考文档 + 脚本 | DSH bundle + `intel_search` / `browser_setup` |
| 安装 | 不需要 | 复制到 skills 目录 | `file:` 安装到 DSH profile |
| 入口 | 把 Prompt 发给 Agent | 说“跑一次情报搜索” | 调 `intel_search({})` |
| 配置 | Agent 按 `QUESTIONS.yaml` 提问 | 同左 | 无参数返回问题；带 `answers` 再调 |
| 运行环境 | 任意支持长任务的 Agent | 支持 Skill 的宿主 | DSH |
| 启动浏览器 | 宿主有 shell 时，按 `PROMPT.md` §0.5 自行检测默认浏览器并拉起 CDP | 同左（共用同一份流程） | 调 `browser_setup` 工具，不依赖 shell |
| 登录时的配合 | 在窗口里登录一次即可，**不需要回话**；Agent 用登录探针自己判断 | 同左 | 同左（`browser_login_check`） |
| 没有浏览器时 | **开始前**就说明，只做公开来源 | 同左 | 返回 `status: failed` + 具体原因 |
| 登录失败的可见性 | 结果里写"未访问 + 原因" | 同左 | 结构化返回 `browserName` / `source` / `error` |
| 额外能力 | 能力检查清单 | 参考文档、校验脚本 | 原生工具、配置校验 |
| 维护成本 | 最低 | 中 | 代码 + DSH API 兼容 |
| 适合 | 试用、分享、跨软件 | 长期复用 | DSH 原生入口 |

不用登录来源时，三个版本完全一样：只搜公开来源，不需要任何浏览器。

## DSH 原生插件和 Skill 差在哪

一句话：**原生插件是装进 DSH 运行时的代码包；Skill 是给 Agent 读的工作手册。**

| 维度 | DSH 原生插件 | Agent Skill |
|---|---|---|
| 本质 | Cordis 插件包（代码） | `SKILL.md` + 参考文档 + 可选脚本 |
| 加载 | DSH profile / 插件管理器加载 | 放到 skills 目录，按需读入 |
| 能做什么 | 注册工具、命令、UI、钩子；访问 `ctx`/会话/工作区 | 描述流程、模板、检查清单；调用现有工具 |
| 不能做什么 | 不能脱离 DSH 运行时 | 不能新增工具/UI/会话 API |
| 安装/维护 | 包 + 配置，通常要重启；代码要跟 API 兼容 | 复制文件夹，通常不用构建；改 Markdown 即可 |
| 可移植 | 基本绑定 DSH | 支持 Skill 的宿主之间较容易迁移 |
| 适合 | 一键入口、原生工具、设置页、插件市场分发 | 工作流、研究流程、报告模板、轻量自动化 |

**怎么判断：**

- 只是想把“怎么搜、怎么筛、怎么写报告”固定下来 → **Skill**。
- 想要一个真正的工具/按钮/设置页，和 DSH 会话、状态深度集成 → **原生插件**。
- 要跨软件/跨宿主 → **Prompt 或 Skill**，不要选原生插件。
- 本套件的原生版注册 `intel_search`，但实际搜索仍由 Agent 执行；它是“入口 + 校验 + 组装”，不是 headless 搜索引擎。

## 共同点

- **对话式配置**：先问缺的，不要求用户编辑 YAML。
- 4 组提问（18 题，必答 9 题 + 条件必答）：目的 → 搜什么 → 来源与登录 → 输出什么。
- 提问后给“配置确认卡”，确认后再跑。
- 同一套配置字段、同一份问题定义、同一套输出结构与质量规则。
- 默认只新建、不碰你已有的文档；只有你明确选择"并进已有文档"时才追加（先备份、只追加、删除或改写标"待确认"，并附恢复命令）。
- 浏览器/登录态由宿主提供；三个版本的差别见上方对比表的"启动浏览器 / 登录时的配合"几行。
- 登录底线：不替你输账号密码、不保存 Cookie/Token、只访问登录页清单里的页面、遇验证码立即停、选"提供材料"时完全不启动浏览器。
- 抓取有节奏：同域请求间隔 ≥2 秒、429/503 退避重试；需要登录时**先开浏览器再并行搜公开来源**，不让你干等。
- 抓取有上限（默认每关键词 top 10、每条笔记评论 20 条、每个角度 3 个页面），并**必须附抓取清单**：URL + 类型 + 条数 + 状态。
- 不编造、不硬闯验证码、个人分享标“未验证”。

## 怎么开始

### 1. Prompt

打开 [prompt-only/PROMPT.md](prompt-only/PROMPT.md)，把整份内容发给 Agent。
Agent 会按 `QUESTIONS.yaml` 问 4 组问题；回答后确认，再开始。

### 2. Skill

把 [recurring-intel-search/](recurring-intel-search/) 复制到你的 skills 目录。
装好后说：

- “跑一次情报搜索。”
- “Run the recurring intelligence search.”

Agent 会先问配置，不需要先建 `config.yaml`。

### 3. DSH Native

安装：

```powershell
# 把 <仓库路径> 换成你克隆/解压的位置
dsh plugin --profile desktop add file:<仓库路径>\dsh-native-intel-search
```

然后调：

```json
{ "mode": "questions" }
```

拿到问题，回答后带 `answers` 再调一次。
要登录时先调 `browser_setup`（检查/启动 9222、打开登录页），登录后再抓。
详见 [dsh-native-intel-search/README.md](dsh-native-intel-search/README.md)。

## 目录

```text
intel-search-suite/
├── README.md                  # 本文件：怎么选 + 三者区别
├── prompt-only/               # 纯 Prompt
├── recurring-intel-search/      # Agent Skill
└── dsh-native-intel-search/     # DSH 原生 bundle
```

## 不要混用

三个包**互不依赖**，各自看自己的 README：

- Prompt 的用法不要套到 Skill 上。
- Skill 的安装目录不要当成 DSH 插件目录。
- Native 的 `intel_search` 只存在于 DSH，不要指望在别的宿主里出现。

配置字段是同一套，但每个包的入口和安装方式不同。

## 同机另一个 DSH 会话也可能不行

DSH 会话共享机器，但不共享**工具集、沙箱权限、工作目录、审批状态**。

检查四件事：

1. 那个会话有没有 shell 工具？没有就调不起浏览器。
2. 有 shell，能不能起 Python/浏览器？沙箱/权限可能拦。
3. `127.0.0.1:9222` 是否在监听？浏览器是否用专用 profile 启动？
4. 工作目录是不是项目根？脚本和相对路径可能找不到。

另外，专用浏览器的 9222 只能有一个实例占用。这个会话已经起了，另一个会话应该连同一个 9222，而不是再起一个。

## 持续检查

每次 push 到 `main`，GitHub Actions 会用
[recurring-intel-search/scripts/validate_config.py](recurring-intel-search/scripts/validate_config.py)
每次 push 跑四道检查，任何一处漂移都会亮红：

1. `validate_config.py --all`：问题定义、`questions.json` 新鲜度、三份模板、副本一致性
2. `check_consistency.py`：Python 与 JavaScript 的枚举是否一致、文档是否覆盖所有 question id、README 里的题数是否与定义一致
3. `smoke.mjs`：插件输出 schema、条件题可见性、`ready`/`invalid` 两条路径
4. `interview.mjs`：A/B/C 三条访谈路径，并把 JS 生成的配置交给 Python 校验器再验一遍

## 许可证

MIT，见 [LICENSE](LICENSE)。


