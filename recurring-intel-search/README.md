# Recurring Intelligence Search

这是一个**可安装的 Agent Skill**：
带 `SKILL.md`、问题定义、配置规范、校验脚本，安装后 Agent 能按技能描述发现并执行。

## 安装

把整个 `recurring-intel-search` 文件夹放到你的 skills 目录：

- Codex personal：`~/.cursor/skills/recurring-intel-search/`
- Codex project：`.cursor/skills/recurring-intel-search/`
- DSH：用你环境的 skills 目录；放好后重启/重新加载技能。

不需要先创建 `config.yaml`。
装好后直接说：

- "跑一次情报搜索。"
- "Run the recurring intelligence search."
- "按对话里确认的配置出一份政策合规搜索结果。"

Agent 会按 `reference/QUESTIONS.yaml` 逐轮提问；确认后再搜。

高级：已有 `config.yaml` 时，可以直接给路径，并用：

```bash
python scripts/validate_config.py config.yaml
```

## 提问模型

问题定义只有一份：[`reference/QUESTIONS.yaml`](reference/QUESTIONS.yaml)。共 18 题，分 4 组：

| 组 | 题号 | 问什么 |
|---|---|---|
| A 目的 | 1 | 支持什么决定 |
| B 搜什么 | 2–7 | 对象 / 视角 / 关键词 / 时间范围 / 区域 / 不看什么 |
| C 来源 | 8–11 | 公开 / 公开+登录；具体页面、登录方式、要取的内容 |
| D 输出 | 12–17 | 形态 / 要件 / 篇幅 / 格式 / 受众 / 节奏 |
| E 交付 | 18 | 文件放哪（仅在要写文件时出现） |

必答 9 题，其余多为一键默认。`when` 条件不满足的题不会出现——所以选了"只在对话里回答"就不会被问篇幅和目录。

技能默认 `disable-model-invocation: true`，需要显式点名；这是为了避免它在无关任务里自动触发。

## 时间范围 ≠ 节奏

两个独立字段，不要混：

- `task.lookback`：搜多久以前。`relative`（最近 N 天）/ `range`（起止日期）/ `since_last`（上一份结果之后）。
- `task.frequency`：要不要定期再跑。`once` / `weekly` / `biweekly` / `monthly`。

"每月一次、只看最近 7 天"和"只跑一次、回看 12 个月"都是合法配置。调度器用你自己的 cron / DSH schedule；技能本身不绑定时间。

## 抓取节奏与登录

- **反爬**：同一域名请求间隔 ≥ 2 秒；429/503 退避 2→4→8 秒，最多 3 次；不并发轰炸同一站点，
  不循环重试同一 URL；宁可换来源也不硬爬。
- **登录并行**：需要登录时**先拉起浏览器请你登录**，同时并行搜公开来源；公开部分跑完再回来看登录态。
  不会让你干等。
- 登录失败 → 记"未访问 + 原因"，不阻塞、不催。
- **要取什么内容**也是登录题的一部分：`sources.content` 可选 `cards`（标题+摘要）/ `body`（正文）/
  `images`（图里的文字与价格）/ `video`（标题+简介）/ `comments`（评论）/ `metrics`（互动数据）。

## 抓取上限与清单

默认值（确认卡里会写出来，用户可要求调大）：

| 项 | 默认 |
|---|---|
| 每关键词卡片 | top 10 |
| 每关键词点开正文 | 最多 3 条 |
| 每条笔记评论 | 最多 20 条高赞 |
| 每角度公开来源 | 最多 3 个页面 |

结果末尾必须附**抓取清单**：URL + 类型（公开 / UGC / 评论）+ 条数 + 状态（成功 / 被拦 / 跳过）。
超过 40 条时正文列前 20 + 按域名汇总，完整清单写进输出文件。

## 输出

- `chat`：只在对话里给，不落盘。
- `document`：`{output.dir}/{task.name}_{YYYY-MM-DD}.{docx|md|pdf}`
- `table`：`{output.dir}/{task.name}_{YYYY-MM-DD}.{xlsx|csv}`
- `chart`：来源里有可提取数据点时才画，否则明确写"数据不足"。
- 无论哪种：都列出未覆盖的角度和不可达的来源。

## 文档：默认只新建

- `output.doc_updates.enabled` 默认 `false`，面试阶段永远不启用，新用户不会被问到"要不要追加到已有文档"。
- 只有真正要写文档、且你明确选择"并进已有文档"时才会：先备份 → 只追加 → 不删不改原文 → 记录 changelog 与恢复命令。

## 校验

```bash
# 校验一份 config
python scripts/validate_config.py config.yaml

# 校验问题定义本身
python scripts/validate_config.py --questions reference/QUESTIONS.yaml

# 校验问题定义 + questions.json 新鲜度 + 三份模板 + 副本一致性（CI 用）
python scripts/validate_config.py --all <repo-root>

# 文档与代码一致性：枚举是否两边一样、文档是否覆盖所有 id、README 题数是否正确
python scripts/check_consistency.py <repo-root>
```

## 边界

- 浏览器/登录态由宿主提供；没有浏览器就跳过登录型来源。
- 这是 Skill，不是 DSH 原生 Cordis 插件。
- 登录型来源只访问配置里列出的页面；不绕过验证码。
- 不编造案例、数据或人物；找不到就写"本期未发现"。
