#!/usr/bin/env python3
"""Validate an intel-search config (schema v2) or the question spec itself.

Modes
-----
    validate_config.py <config.yaml>          validate one config file
    validate_config.py --questions <spec>     validate reference/QUESTIONS.yaml
    validate_config.py --check-sync <root>    assert the duplicated copies are identical
    validate_config.py --all <root>           questions + sync + every config.template.yaml

Exit codes: 0 ok, 1 invalid, 2 unreadable / unparseable.

PyYAML is optional. Without it, only the basic top-level key checks run and the
tool prints a warning instead of pretending it validated the structure.
"""
import datetime
import hashlib
import json
import os
import re
import sys

try:
    import yaml  # type: ignore
except ImportError:  # pragma: no cover - exercised on minimal hosts
    yaml = None

SCHEMA_VERSION = 2

PURPOSES = {
    "enter_field", "competitor", "policy", "technology",
    "capital", "material", "job", "other", "auto",
}
ANGLES = {"policy", "environment", "person", "product", "technology", "capital", "other"}
LOOKBACK_MODES = {"relative", "range", "since_last"}
AREA_MODES = {"all", "china", "overseas", "custom"}
FREQUENCIES = {"once", "weekly", "biweekly", "monthly"}
SCOPES = {"public", "public+login"}
LOGIN_METHODS = {"user", "materials", "existing_session"}
SOURCE_CATEGORIES = {"news", "company", "research", "policy", "social", "jobs", "capital"}
SOURCE_CONTENT = {"cards", "body", "images", "video", "comments", "metrics"}
OUTPUT_MODES = {"chat", "document", "table", "chart", "other"}
DOC_FORMATS = {"docx", "md", "pdf"}
TABLE_FORMATS = {"xlsx", "csv"}
MUST_INCLUDE = {"conclusion", "evidence", "timeline", "comparison", "data", "risk", "next", "quote"}
LENGTHS = {"short", "medium", "unlimited"}
AUDIENCES = {"self", "manager", "client", "public"}
V1_KEYS = {
    "domain": "task.subject",
    "cadence": "task.frequency + task.lookback（两个独立字段）",
    "lookback_days": "task.lookback",
}

errors = []
warnings = []


def err(msg):
    errors.append(msg)


def warn(msg):
    warnings.append(msg)


def _mapping(value):
    return value if isinstance(value, dict) else {}


def _list(value):
    return value if isinstance(value, list) else []


def _text(value):
    return value.strip() if isinstance(value, str) else ""


def _iso_date(value):
    """YAML loads an unquoted 2025-06-01 as datetime.date; accept both shapes."""
    if isinstance(value, (datetime.date, datetime.datetime)):
        return value.strftime("%Y-%m-%d")
    return _text(value)


def check_task(task):
    for key in ("name", "subject", "purpose", "frequency"):
        if not _text(task.get(key)):
            err(f"task.{key} is required")

    purpose = _text(task.get("purpose"))
    if purpose and purpose not in PURPOSES:
        err(f"task.purpose must be one of {sorted(PURPOSES)}")
    if purpose == "other" and not _text(task.get("purpose_note")):
        warn("task.purpose is 'other' but task.purpose_note is empty")

    angles = _list(task.get("angles"))
    if not angles:
        err("task.angles must be a non-empty list")
    else:
        unknown = [a for a in angles if a not in ANGLES]
        if unknown:
            err(f"task.angles has unknown value(s): {unknown}; allowed {sorted(ANGLES)}")
        if len(angles) > 4:
            warn("more than 4 angles makes every section shallow")
    if "other" in angles and not _text(task.get("angle_note")):
        warn("task.angles contains 'other' but task.angle_note is empty")

    if not _list(task.get("keywords")):
        warn("task.keywords is empty; keywords will be generated from subject + angles")

    lookback = _mapping(task.get("lookback"))
    mode = _text(lookback.get("mode"))
    if not mode:
        err("task.lookback.mode is required (relative | range | since_last)")
    elif mode not in LOOKBACK_MODES:
        err(f"task.lookback.mode must be one of {sorted(LOOKBACK_MODES)}")
    elif mode == "relative":
        days = lookback.get("days")
        if not isinstance(days, int) or isinstance(days, bool) or days < 1:
            err("task.lookback.days must be a positive integer when mode is 'relative'")
    elif mode == "range":
        for key in ("from", "to"):
            value = _iso_date(lookback.get(key))
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                err(f"task.lookback.{key} must be YYYY-MM-DD when mode is 'range'")
        frm, to = _iso_date(lookback.get("from")), _iso_date(lookback.get("to"))
        if frm and to and frm > to:
            err("task.lookback.from is later than task.lookback.to")

    area = _mapping(task.get("area"))
    area_mode = _text(area.get("mode"))
    if not area_mode:
        err("task.area.mode is required (all | china | overseas | custom)")
    elif area_mode not in AREA_MODES:
        err(f"task.area.mode must be one of {sorted(AREA_MODES)}")
    elif area_mode == "custom" and not _list(area.get("countries")):
        err("task.area.countries is required when mode is 'custom'")

    frequency = _text(task.get("frequency"))
    if frequency and frequency not in FREQUENCIES:
        err(f"task.frequency must be one of {sorted(FREQUENCIES)}")

    for old, hint in V1_KEYS.items():
        if old in task:
            err(f"task.{old} is a v1 field; use {hint}")


def check_sources(sources):
    scope = _text(sources.get("scope"))
    if not scope:
        err("sources.scope is required (public | public+login)")
        return
    if scope not in SCOPES:
        err(f"sources.scope must be one of {sorted(SCOPES)}")
        return

    if scope == "public":
        if _list(sources.get("login_pages")):
            warn("sources.login_pages is set but scope is 'public'; it will be ignored")
    else:
        if not _list(sources.get("login_pages")):
            err("sources.login_pages is required when scope is 'public+login'")
        method = _text(sources.get("login_method")) or "user"
        if method not in LOGIN_METHODS:
            err(f"sources.login_method must be one of {sorted(LOGIN_METHODS)}")
        content = _list(sources.get("content"))
        if not content:
            err("sources.content is required when scope is 'public+login'")
        unknown_content = [c for c in content if c not in SOURCE_CONTENT]
        if unknown_content:
            err(f"sources.content has unknown value(s): {unknown_content}; allowed {sorted(SOURCE_CONTENT)}")

    categories = _list(sources.get("categories"))
    unknown = [c for c in categories if c not in SOURCE_CATEGORIES]
    if unknown:
        err(f"sources.categories has unknown value(s): {unknown}")


def check_output(output):
    modes = _list(output.get("mode"))
    if not modes:
        err("output.mode must be a non-empty list")
        return
    unknown = [m for m in modes if m not in OUTPUT_MODES]
    if unknown:
        err(f"output.mode has unknown value(s): {unknown}; allowed {sorted(OUTPUT_MODES)}")
        return

    wants_doc = "document" in modes
    wants_table = "table" in modes
    wants_file = wants_doc or wants_table
    fmt = _text(output.get("format"))

    if wants_doc and fmt not in DOC_FORMATS:
        err(f"output.format must be one of {sorted(DOC_FORMATS)} when mode includes 'document'")
    if wants_table and fmt not in TABLE_FORMATS:
        err(f"output.format must be one of {sorted(TABLE_FORMATS)} when mode includes 'table'")
    if wants_doc and wants_table:
        err("output.mode cannot include both 'document' and 'table'; pick one file format")

    if wants_file:
        if not _text(output.get("dir")):
            err("output.dir is required when mode includes 'document' or 'table'")
        length = _text(output.get("length"))
        if length and length not in LENGTHS:
            err(f"output.length must be one of {sorted(LENGTHS)}")
    else:
        if fmt:
            warn("output.format is ignored because mode has no 'document' or 'table'")
        if modes == ["chat"] and _text(output.get("dir")):
            warn("output.dir is ignored in chat-only mode")

    if "other" in modes and not _text(output.get("other_note")):
        warn("output.mode includes 'other' but output.other_note is empty")
    if "chart" in modes:
        warn("output.mode includes 'chart'; charts need extractable data points or must be skipped")

    include = _list(output.get("must_include"))
    if not include:
        err("output.must_include must be a non-empty list")
    else:
        unknown = [m for m in include if m not in MUST_INCLUDE]
        if unknown:
            err(f"output.must_include has unknown value(s): {unknown}")

    audience = _text(output.get("audience"))
    if audience and audience not in AUDIENCES:
        err(f"output.audience must be one of {sorted(AUDIENCES)}")

    updates = _mapping(output.get("doc_updates"))
    if updates.get("enabled") is True:
        if not _list(updates.get("docs")):
            err("output.doc_updates.docs is required when doc_updates is enabled")
        if not _text(updates.get("backup_dir")):
            err("output.doc_updates.backup_dir is required when doc_updates is enabled")


def check_run(run):
    wait = run.get("login_wait_min", 0)
    if not isinstance(wait, int) or isinstance(wait, bool) or wait < 0:
        err("run.login_wait_min must be a non-negative integer")
    cap = run.get("max_items_per_keyword", 5)
    if isinstance(cap, int) and cap > 20:
        warn("run.max_items_per_keyword > 10 may trigger anti-bot responses")
    delay = _list(run.get("delay_seconds"))
    if delay and (len(delay) != 2 or not all(isinstance(x, (int, float)) for x in delay)):
        warn("run.delay_seconds should be [min, max]")


def validate_config(cfg):
    errors.clear()
    warnings.clear()

    if not isinstance(cfg, dict):
        err("config must be a YAML mapping")
        return False

    version = cfg.get("version")
    if version != SCHEMA_VERSION:
        if version is None:
            err(f"version is required; this schema is {SCHEMA_VERSION}")
        else:
            err(f"version must be {SCHEMA_VERSION} (got {version!r})")

    for block in ("task", "sources", "output", "run"):
        if not isinstance(cfg.get(block), dict):
            err(f"{block} must be a YAML mapping")

    check_task(_mapping(cfg.get("task")))
    check_sources(_mapping(cfg.get("sources")))
    check_output(_mapping(cfg.get("output")))
    check_run(_mapping(cfg.get("run")))
    return not errors


# --------------------------------------------------------------------------- #
# question spec
# --------------------------------------------------------------------------- #

def validate_questions(spec):
    errors.clear()
    warnings.clear()

    if not isinstance(spec, dict):
        err("question spec must be a YAML mapping")
        return False
    if spec.get("version") != SCHEMA_VERSION:
        err(f"question spec version must be {SCHEMA_VERSION}")

    questions = _list(spec.get("questions"))
    if not questions:
        err("questions must be a non-empty list")
        return False

    known_ids = {
        q.get("id") for q in questions if isinstance(q, dict) and isinstance(q.get("id"), str)
    }
    seen = set()
    conditional = 0
    for index, question in enumerate(questions, 1):
        if not isinstance(question, dict):
            err(f"questions[{index}] is not a mapping")
            continue
        qid = _text(question.get("id"))
        if not qid:
            err(f"questions[{index}] has no id")
            continue
        if qid in seen:
            err(f"duplicate question id: {qid}")
        seen.add(qid)

        if not _text(question.get("ask")):
            err(f"{qid}: ask is required")
        if not _text(question.get("maps_to")):
            err(f"{qid}: maps_to is required")
        qtype = _text(question.get("type"))
        if qtype not in {"single", "multi", "text"}:
            err(f"{qid}: type must be single | multi | text")
        if not isinstance(question.get("required"), bool):
            err(f"{qid}: required must be true or false")

        condition = _text(question.get("when"))
        if condition:
            conditional += 1
            for ref in re.findall(r"([a-z_]+)\s*(?:==|!=)", condition):
                if ref not in known_ids:
                    warn(f"{qid}: when-condition mentions unknown id {ref!r}")

        options = _list(question.get("options"))
        values = []
        for option in options:
            if not isinstance(option, dict):
                err(f"{qid}: every option must be a mapping with value/label")
                continue
            value = option.get("value")
            if value is None or _text(str(value)) == "":
                err(f"{qid}: option without value")
            if not _text(option.get("label")):
                err(f"{qid}: option {value!r} has no label")
            values.append(str(value))
        if qtype in {"single", "multi"} and not options:
            err(f"{qid}: {qtype} question needs options")
        if len(values) != len(set(values)):
            err(f"{qid}: duplicate option values")

        default = question.get("default")
        if default is not None and default != "by_purpose" and values:
            defaults = default if isinstance(default, list) else [default]
            for item in defaults:
                if str(item) not in values:
                    err(f"{qid}: default {item!r} is not one of its options")

    runtime = _list(spec.get("runtime_questions"))
    if not runtime:
        warn("runtime_questions is empty; the document-merge question should live there")

    print(f"questions: {len(questions)} ({conditional} conditional), runtime: {len(runtime)}")
    return not errors


# --------------------------------------------------------------------------- #
# duplicated-copy check
# --------------------------------------------------------------------------- #

SYNC_GROUPS = [
    ("recurring-intel-search/reference/PROMPT.md", "prompt-only/PROMPT.md"),
    (
        "recurring-intel-search/config.template.yaml",
        "dsh-native-intel-search/config.template.yaml",
        "prompt-only/config.template.yaml",
    ),
]


QUESTIONS_JSON = "dsh-native-intel-search/lib/questions.json"
SPEC_KEYS = ("version", "groups", "questions", "runtime_questions", "branch_job")


def expected_questions_json(root):
    """Render the JSON the plugin must carry, from the single source of truth."""
    spec, code = _load(os.path.join(root, "recurring-intel-search/reference/QUESTIONS.yaml"))
    if spec is None:
        return None
    payload = {key: spec.get(key) for key in SPEC_KEYS if key in spec}
    payload.setdefault("questions", [])
    payload.setdefault("runtime_questions", [])
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False) + "\n"


def check_questions_json(root):
    expected = expected_questions_json(root)
    if expected is None:
        err("cannot derive questions.json from QUESTIONS.yaml")
        return False
    target = os.path.join(root, QUESTIONS_JSON)
    try:
        with open(target, encoding="utf-8") as handle:
            actual = handle.read()
    except OSError as exc:
        err(f"cannot read {QUESTIONS_JSON}: {exc}")
        return False
    if actual != expected:
        err(f"{QUESTIONS_JSON} is stale; run scripts/build_questions.py")
        return False
    print(f"in sync: {QUESTIONS_JSON} == QUESTIONS.yaml")
    return True


def _digest(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def check_sync(root):
    for group in SYNC_GROUPS:
        paths = [os.path.join(root, item) for item in group]
        missing = [p for p in paths if not os.path.isfile(p)]
        if missing:
            for item in missing:
                err(f"missing file: {item}")
            continue
        digests = {p: _digest(p) for p in paths}
        if len(set(digests.values())) != 1:
            err("copies differ: " + " vs ".join(group))
        else:
            print(f"in sync: {' == '.join(group)}")
    return not errors


# --------------------------------------------------------------------------- #
# cli
# --------------------------------------------------------------------------- #

def _load(path):
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    except OSError as exc:
        print(f"ERROR: cannot read {path}: {exc}")
        return None, 2
    if yaml is None:
        print("ERROR: PyYAML is required for structured checks")
        return None, 2
    try:
        return yaml.safe_load(text) or {}, 0
    except Exception as exc:  # noqa: BLE001 - reported verbatim
        print(f"ERROR: invalid YAML in {path}: {exc}")
        return None, 2


def _report():
    for message in errors:
        print(f"ERROR: {message}")
    for message in warnings:
        print(f"WARN: {message}")
    if errors:
        print(f"FAILED: {len(errors)} error(s), {len(warnings)} warning(s)")
        return 1
    print(f"OK: {len(warnings)} warning(s)")
    return 0


def main(argv):
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0

    if "--questions" in argv:
        spec, code = _load(argv[argv.index("--questions") + 1])
        if spec is None:
            return code
        validate_questions(spec)
        return _report()

    if "--check-sync" in argv:
        errors.clear()
        warnings.clear()
        check_sync(argv[argv.index("--check-sync") + 1])
        return _report()

    if "--all" in argv:
        root = argv[argv.index("--all") + 1]
        spec, code = _load(os.path.join(root, "recurring-intel-search/reference/QUESTIONS.yaml"))
        if spec is None:
            return code
        validate_questions(spec)
        if errors:
            return _report()

        for template in (
            "recurring-intel-search/config.template.yaml",
            "dsh-native-intel-search/config.template.yaml",
            "prompt-only/config.template.yaml",
        ):
            cfg, code = _load(os.path.join(root, template))
            if cfg is None:
                return code
            validate_config(cfg)
            if errors:
                for message in errors:
                    print(f"ERROR: {template}: {message}")
                return 1
            print(f"OK: {template}")

        errors.clear()
        warnings.clear()
        check_questions_json(root)
        check_sync(root)
        return _report()

    cfg, code = _load(argv[1] if len(argv) > 1 else "config.yaml")
    if cfg is None:
        return code
    validate_config(cfg)
    return _report()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
