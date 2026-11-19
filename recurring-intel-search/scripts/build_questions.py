#!/usr/bin/env python3
"""Derive the native plugin's question table from the single source of truth.

    build_questions.py <repo-root>

Reads `<root>/recurring-intel-search/reference/QUESTIONS.yaml` and writes
`<root>/dsh-native-intel-search/lib/questions.json`, which `tool.js` loads at
start-up. The JSON is committed so the plugin stays self-contained when it is
installed with `file:`; `validate_config.py --all` fails when it is stale.

Run this after every change to QUESTIONS.yaml.
"""
import json
import os
import sys

try:
    import yaml  # type: ignore
except ImportError:  # pragma: no cover
    print("ERROR: PyYAML is required to build questions.json")
    raise SystemExit(2)

SOURCE = "recurring-intel-search/reference/QUESTIONS.yaml"
TARGET = "dsh-native-intel-search/lib/questions.json"
KEYS = ("version", "groups", "questions", "runtime_questions", "branch_job")


def build(spec):
    payload = {key: spec.get(key) for key in KEYS if key in spec}
    payload.setdefault("questions", [])
    payload.setdefault("runtime_questions", [])
    return payload


def render(payload):
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False) + "\n"


def main(argv):
    root = argv[1] if len(argv) > 1 else "."
    source = os.path.join(root, SOURCE)
    try:
        with open(source, encoding="utf-8") as handle:
            spec = yaml.safe_load(handle) or {}
    except OSError as exc:
        print(f"ERROR: cannot read {source}: {exc}")
        return 2
    except yaml.YAMLError as exc:
        print(f"ERROR: invalid YAML in {source}: {exc}")
        return 2

    payload = build(spec)
    target = os.path.join(root, TARGET)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(render(payload))
    questions = len(payload["questions"])
    runtime = len(payload["runtime_questions"])
    print(f"wrote {TARGET}: {questions} questions, {runtime} runtime")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
