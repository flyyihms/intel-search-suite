# dsh-native-skill

给 [`dsh-native-intel-search`](../dsh-native-intel-search/) 插件配的**斜杠技能**入口：
输入 `/intel <主题>` 就能启动那套问答式情报调研，不用记得工具名。

## 为什么是技能而不是命令

DSH 的斜杠命令（`ctx.commands.register`）返回值只有 `success` / `error`，两个都是给用户看的一行结果，**没法往对话里注入一条消息触发 agent 干活**。
技能不同：`/intel xxx` 会把这里的 Markdown 指令注入 agent 上下文，agent 照着调用 `intel_search`。

## 安装

把 `SKILL.md` 复制到本机 skills 目录：

```text
<DSH_AGENTS_HOME>/skills/intel/SKILL.md
```

技能目录是热加载的，保存后 `/intel` 立即可用，不需要重启。

## 用法

```text
/intel 天津移动网信安全能力落地方案
```

不带主题直接 `/intel` → agent 会先问主题，不会开始问答。

## 它和 `recurring-intel-search/` 的区别

| | recurring-intel-search | dsh-native-skill |
|---|---|---|
| 依赖 | 纯提示词，任何 agent 都能用 | 依赖 `dsh-native-intel-search` 注册的 `intel_search` 工具 |
| 入口 | 自然语言"跑一次情报搜索" | `/intel <主题>` |
| 问答收集 | agent 自行组织 | 强制用提问卡片（`ask_user_question`） |

两者互不依赖，装哪个都能用，装错也不会互相干扰。
