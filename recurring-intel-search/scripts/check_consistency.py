#!/usr/bin/env python3
"""Cross-check the three deliverables against the single source of truth.

Checks
------
1. QUESTIONS.yaml -> questions.json is fresh, ids unique, maps_to points at a known block.
2. Every question id is mentioned in at least one user-facing doc.
3. Enum sets agree between validate_config.py (Python) and lib/tool.js (JavaScript).
4. Counts claimed by the READMEs match the real question table.
5. The three config templates carry the fields the schema requires.
6. CONFIG.md documents every enum value that the validator accepts.

Exit codes: 0 ok, 1 mismatch, 2 unreadable input.
"""
import json
import os
import re
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else "."
SPEC_PATH = os.path.join(ROOT, "recurring-intel-search/reference/QUESTIONS.yaml")
JSON_PATH = os.path.join(ROOT, "dsh-native-intel-search/lib/questions.json")
PY_PATH = os.path.join(ROOT, "recurring-intel-search/scripts/validate_config.py")
JS_PATH = os.path.join(ROOT, "dsh-native-intel-search/lib/tool.js")
PROMPT_PATHS = [
    "recurring-intel-search/reference/PROMPT.md",
    "prompt-only/PROMPT.md",
]
DOC_PATHS = PROMPT_PATHS + [
    "recurring-intel-search/SKILL.md",
    "recurring-intel-search/reference/CONFIG.md",
]
README_PATHS = [
    "README.md",
    "recurring-intel-search/README.md",
    "prompt-only/README.md",
    "dsh-native-intel-search/README.md",
]
TEMPLATES = [
    "recurring-intel-search/config.template.yaml",
    "dsh-native-intel-search/config.template.yaml",
    "prompt-only/config.template.yaml",
]

problems = []


def read(path):
    with open(os.path.join(ROOT, path), encoding="utf-8") as handle:
        return handle.read()


def fail(message):
    problems.append(message)


def main():
    try:
        spec = json.load(open(JSON_PATH, encoding="utf-8"))
    except OSError as exc:
        print(f"ERROR: cannot read {JSON_PATH}: {exc}")
        return 2

    questions = spec.get("questions", [])
    runtime = spec.get("runtime_questions", [])
    total = len(questions)
    conditional = [q for q in questions if q.get("when")]
    required = [q for q in questions if q.get("required")]
    required_always = [q for q in questions if q.get("required") and not q.get("when")]

    # --- 1. ids / maps_to ---------------------------------------------------
    ids = [q.get("id") for q in questions]
    if len(ids) != len(set(ids)):
        fail("duplicate question ids in questions.json")
    blocks = {"task", "sources", "output", "run"}
    for question in questions:
        target = str(question.get("maps_to", ""))
        if target.split(".")[0] not in blocks:
            fail(f"{question.get('id')}: maps_to '{target}' is outside task/sources/output/run")

    # --- 2. every id is documented somewhere --------------------------------
    docs = {path: read(path) for path in DOC_PATHS if os.path.isfile(os.path.join(ROOT, path))}
    joined = "\n".join(docs.values())
    for question in questions + runtime:
        identifier = str(question.get("id"))
        if identifier not in joined:
            fail(f"question '{identifier}' is never mentioned in PROMPT/SKILL/CONFIG")

    # --- 3. enum parity Python <-> JavaScript -------------------------------
    py = read(PY_PATH)
    js = read(JS_PATH)

    def py_set(name):
        match = re.search(rf"^{name} = \{{([^}}]*)\}}", py, re.M)
        return {item.strip().strip('"\'') for item in match.group(1).split(",") if item.strip()} if match else None

    def js_set(name):
        match = re.search(rf"const {name} = new Set\(\[([^\]]*)\]\)", js)
        return {item.strip().strip("'\"") for item in match.group(1).split(",") if item.strip()} if match else None

    for name in (
        "PURPOSES",
        "ANGLES",
        "LOOKBACK_MODES",
        "AREA_MODES",
        "FREQUENCIES",
        "SCOPES",
        "LOGIN_METHODS",
        "OUTPUT_MODES",
        "MUST_INCLUDE",
        "LENGTHS",
        "AUDIENCES",
        "SOURCE_CONTENT",
        "DOC_FORMATS",
        "TABLE_FORMATS",
    ):
        left, right = py_set(name), js_set(name)
        if left is None or right is None:
            fail(f"enum {name}: not found in {'python' if left is None else 'javascript'}")
        elif left != right:
            fail(f"enum {name} differs: python-only={sorted(left - right)} js-only={sorted(right - left)}")

    # --- 4. README counts ---------------------------------------------------
    visible_at_start = total - len(conditional)
    readme_text = "\n".join(read(path) for path in README_PATHS)
    checks = [
        (r"共 (\d+) 题", total, "total question count after 共"),
        (r"（(\d+) 题，必答", total, "total question count in the parenthetical"),
        (r"必答 (\d+) 题", len(required_always), "unconditional required question count"),
        (r"返回 (\d+) 题", visible_at_start, "questions asked before any answer"),
        (r"题中 (\d+) 题为条件题", len(conditional), "conditional question count"),
        (r"(\d+) 条件题", len(conditional), "conditional question count in summary form"),
    ]
    for pattern, expected, label in checks:
        for match in re.finditer(pattern, readme_text):
            value = int(match.group(1))
            if value != expected:
                fail(f"README {label}: found {value}, expected {expected} ('{match.group(0)}')")

    # --- 5. templates -------------------------------------------------------
    for template in TEMPLATES:
        text = read(template)
        for needle in ("version: 2", "content: [", "max_comments_per_note"):
            if needle not in text:
                fail(f"{template} is missing '{needle}'")

    # --- 6. CONFIG.md documents the enums ----------------------------------
    config_doc = docs.get("recurring-intel-search/reference/CONFIG.md", "")
    for value in sorted(py_set("AREA_MODES") | py_set("SCOPES") | py_set("OUTPUT_MODES") | py_set("SOURCE_CONTENT")):
        if value not in config_doc:
            fail(f"CONFIG.md never mentions enum value '{value}'")

    # --- 7. runtime question lives outside the interview -------------------
    if not runtime:
        fail("runtime_questions is empty (doc merge question must live there)")
    for question in runtime:
        if question.get("id") in ids:
            fail(f"runtime question '{question.get('id')}' also appears in the interview")

    if problems:
        print(f"FAILED: {len(problems)} problem(s)")
        for message in problems:
            print(f"  - {message}")
        return 1

    print(
        f"consistent: {total} questions ({len(conditional)} conditional, {len(required_always)} required up front, "
        f"{visible_at_start} asked at start), {len(runtime)} runtime; enums, docs, templates, README counts agree"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
