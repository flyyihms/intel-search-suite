---
name: intel
description: >-
  Start a recurring-intelligence search with the intel_search tool.
  Usage: /intel <topic>
---

# Intel

When invoked as `/intel <topic>`, drive the `intel_search` tool for that topic.

## Flow

1. **Collect** — call `intel_search` with no arguments. It returns the interview
   questions (why search, what to collect, keywords, time window, area, output shape).
2. **Ask** — collect the missing answers with the `ask_user_question` tool (see the
   hard rule below). Skip questions the topic already answers; group the rest into
   one card set rather than one card per question.
3. **Build** — call `intel_search` again with `answers`. It validates the config
   and returns a ready-to-run search prompt.
4. **Hand off** — show the prompt, then ask whether to run the search now.

## Rules

- **Ask with cards, never with a list.** Every field still unknown to you must be
  collected through `ask_user_question` (options + a recommended default). Printing
  the questions as bullets in the reply is a regression: it is not answerable and
  the user has to type option keys by hand. If the card is cancelled, ask for a
  one-line answer in prose instead.
- No topic given → ask for the topic first; do not start the interview.
- Never invent answers for missing fields; leave them for the user.
- Only read the tool's `questions.json` when the tool's own output does not carry
  the question list; never treat that file as the source of truth for option values.
- If `intel_search` reports validation errors, fix the answers and call it again.
- Do not start browsing on your own: running the search is a separate decision
  the user makes after seeing the prompt.
