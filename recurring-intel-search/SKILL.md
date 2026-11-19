---
name: recurring-intel-search
description: Run a configurable intelligence search over public (and optionally login-gated) sources, then produce exactly the output the user asked for — a chat answer, a document, a table, or a chart. Use when the user asks for market, industry, competitor, policy, technology, or capital research; a recurring brief; or any configurable search whose scope and output are decided in conversation.
disable-model-invocation: true
---

# Recurring Intelligence Search

## Quick start

1. If the user points to an existing `config.yaml`, load it.
2. Otherwise do not ask for a file. Interview the user following
   [reference/QUESTIONS.yaml](reference/QUESTIONS.yaml): 16 questions in 4 groups, of which only 9 are
   required and 6 of those default with one click.
3. **Never invent questions, reword options, or add your own topics.** The YAML is the single source of
   truth; `reference/PROMPT.md` §0 only describes the order.
4. After the answers, show a compact confirmation card; proceed only after confirmation.
5. Read [reference/PROMPT.md](reference/PROMPT.md) for the workflow and
   [reference/CONFIG.md](reference/CONFIG.md) for the schema.
6. Run the search; produce the requested output shape; list uncovered angles and unreachable sources.

## The three things that must be clear before searching

The interview exists to make the user state these three; everything else is confirmation:

1. **Purpose** — what decision the result supports.
2. **What to collect** — subject, angles, keywords, time window, area, exclusions.
3. **What to output** — shape, must-have content, length, audience, frequency.

If any of the three is still vague after the interview, ask one clarifying question instead of guessing.

## Non-negotiables

- Do not invent facts, sources, people, cases, or numbers. If nothing is found, say so.
- Never assume an industry. `task.subject` + `task.angles` come from the conversation.
- Public sources first; login-gated sources second. If login is unavailable, skip and record it.
- Major claims need at least two independent sources; single-source items are leads only.
- Quote at most 1–3 sentences per source; always link.
- Label personal posts as `未验证`; separate official / media / individual.
- Exclude training camps, paid courses, referral ads, pure marketing, and anything in `task.exclude`.
- Stop on captcha, login wall, 403/429, or repeated prompts; do not retry aggressively.
- Crawl politely: keep at least 2 seconds between requests to the same host, back off 2→4→8 seconds on
  429/503 (max 3 attempts), never hammer one site in parallel, and prefer dropping a source over
  retrying the same URL. Record what was missed instead of forcing it.
- Default caps: top 10 cards per keyword, at most 3 bodies opened per keyword, at most 20 comments per
  note, at most 3 pages per public angle. State these caps in the confirmation card; raise them only if
  the user asks, and say what it costs.
- Always append a **source manifest**: URL, type (public / UGC / comment), item count, status
  (ok / blocked / skipped). Up to 40 rows inline; beyond that, list the first 20 plus a per-domain
  summary and write the full manifest to the output file.
- Never print, store, or ask for cookies, tokens, or passwords.
- Do not modify the user's existing files. New output is the default; merging into an old document is
  allowed only after the run-time confirmation below, with a backup taken first.
- Do not hardcode subjects, angles, sources, frequency, or output format. Read them from the conversation/config.

## Capability check (before searching)

Never assume the session can do these; determine each one first:

- **shell / python** — can it start a process?
- **browser** — is there a browser tool, or a CDP endpoint at `127.0.0.1:9222`?
- **web_search / web_fetch** — reachable, or blocked by the network policy?
- **file writing** — can output be written at all?

Rules:

- `sources.scope: public+login` with no browser control → say so **at the start**, skip those sources,
  and record why. Never claim a page was opened.
- Shell exists but CDP is down → detect the default browser; if it is Chromium-family
  (Edge/Chrome/Brave), launch it with `--remote-debugging-port=9222 --user-data-dir=<profile>` and wait
  up to 30 seconds. Firefox/Safari cannot serve CDP: fall back to an installed Chromium, or report.
- No file writing → `output.mode` must stay `chat`; do not promise a saved document.
- `web_fetch` blocked → fall back to `web_search` summaries and label them as unverified titles.

The detailed deployment steps live in [reference/PROMPT.md](reference/PROMPT.md) §0.5 — follow them
instead of inventing a different procedure.

## Workflow

1. **Interview** — per `reference/QUESTIONS.yaml`; honour `when` conditions (skip questions whose
   condition is not met); confirm before searching.
2. **Scope** — resolve the time window (`relative` / `range` / `since_last`), the area, and the keywords
   (generate 5–10 from subject + angles when the user left them empty, then confirm).
3. **Public sources** — search each angle: policy, environment, person, product, technology, capital.
   Narrow to `sources.categories` when non-empty.
4. **Login-gated sources** — only when `sources.scope: public+login`. Start the browser and ask the
   user to log in **first**, then immediately run the public search in parallel; check the login state
   with `browser_login_check` (once now, again after the public part, or let it poll); never ask the user to reply "done". Never make the user wait while you idle. Use
   `sources.login_pages`, `sources.login_method` and `sources.content` (cards / body / images /
   video / comments / metrics); do not type credentials for the user.
5. **Synthesize** — 3–6 judgements grouped by `task.angles`; each with evidence and impact.
6. **Compare with last run** — what is new, what reversed, what disappeared; dedupe by URL/title.
7. **Produce output** — per `output.mode` and `output.must_include`; honour `output.length` and
   `output.audience`.
8. **Report gaps** — which angles found nothing, which sources were unreachable, and why.

## Output contract

- `chat` — answer in the conversation, write no files.
- `document` — `{output.dir}/{task.name}_{YYYY-MM-DD}.{format}` where `format` is `docx`, `md`, or `pdf`.
- `table` — `{output.dir}/{task.name}_{YYYY-MM-DD}.{format}` where `format` is `xlsx` or `csv`.
- `chart` — only when the sources yield extractable data points; otherwise say data is insufficient.
- `other` — follow `output.other_note`.
- Always: list uncovered angles and unreachable sources, even in `chat` mode.

## Frequency and time window are two different questions

They are separate fields on purpose:

- `task.frequency` — `once`, `weekly`, `biweekly`, `monthly`. Whether to run again.
- `task.lookback` — `relative` (`days`), `range` (`from`/`to`), or `since_last`. How far back to search.

Never derive one from the other. A monthly frequency over a 7-day window is a valid configuration, and a
one-off search over 12 months is equally valid.

## Merging into an existing document (run-time only)

Never ask this in the interview — a first-time user has no existing document.

Ask it only when you are actually about to write a document:

> Write a new document (default), or merge into an existing one? Merging means append-only, backup first,
> never delete or rewrite existing text.

When merging: back up to `output.doc_updates.backup_dir/YYYY-MM-DD.zip`, append only, mark deletions or
conclusion changes as `待确认`, write a changelog entry with a restore command, roll back on failure.

## Guardrails for sources

- `sources.scope: public` → never touch login-gated pages.
- `sources.scope: public+login` → only the pages listed in `sources.login_pages`.
- `run.login_wait_min: 0` or no browser → skip all login-gated sources and record why.
- Empty keyword list → generate from subject + angles, confirm with the user, then search.
- If a source is unreachable, record URL + reason + what was missed.

## Install

Copy this folder to your skills directory:

- Codex personal: `~/.cursor/skills/recurring-intel-search/`
- Codex project: `.cursor/skills/recurring-intel-search/`
- DSH: use your environment's skills directory.

No config file is required. On first use, the agent interviews per `reference/QUESTIONS.yaml`.
Advanced: copy `config.template.yaml` to `config.yaml` for a fixed preset.

## Files

- `reference/QUESTIONS.yaml` — the 16 interview questions + run-time question (single source of truth).
- `reference/PROMPT.md` — full workflow prompt (identical copy in `prompt-only/PROMPT.md`).
- `reference/CONFIG.md` — every config field (schema v2).
- `config.template.yaml` — schema reference / optional preset; not required for normal use.
- `scripts/validate_config.py` — schema and required-field check (also checks this package's question ids).
