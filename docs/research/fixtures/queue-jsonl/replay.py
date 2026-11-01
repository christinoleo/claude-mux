#!/usr/bin/env python3
"""Rebuild Claude Code's queue from a transcript's queue-operation lines.

Usage: replay.py FILE.jsonl            print the queue after each line, then what is left
       replay.py --check FIXTURE.jsonl compare the result with the "_expect" line in a fixture

This is the smallest model that fits Claude Code 2.1.309. Three things matter:
- enqueue lines carry no id, so a remove is matched to its enqueue by text;
- dequeue lines carry no text, so the entry they take must be predicted;
- dequeue takes the highest priority first, and the priority is not logged.
  Human prompts are "next" and task notifications are "later", so the content is
  the only way to tell them apart.
"""
import json
import sys

NOTIFICATION = "<task-notification"
# popAll and popOne send the text back to the prompt box; the rest take it out of the queue.
TEXT_OPS = {"remove", "popAll", "popOne"}


def rank(item):
    return 1 if (item["text"] or "").lstrip().startswith(NOTIFICATION) else 0


def is_human(item):
    """Everything a person queued. A long paste is logged inside a pasted_content wrapper."""
    text = item["text"]
    if text is None:
        return True  # the text was withheld: compaction, or a mod that hooks prompts
    stripped = text.lstrip()
    return not stripped.startswith("<") or stripped.startswith("<pasted_content")


def step(queue, rec):
    """Apply one line. Returns the entry it took, or None."""
    op = rec.get("operation")
    if op == "enqueue":
        queue.append({"text": rec.get("content"), "at": rec.get("timestamp")})
        return None
    if op == "dequeue":
        if not queue:
            return None
        best = min(range(len(queue)), key=lambda i: (rank(queue[i]), i))
        return queue.pop(best)
    if op in TEXT_OPS:
        for i, item in enumerate(queue):
            if item["text"] == rec.get("content"):
                return queue.pop(i)
        # dropped_by_hook lines have no content, so a blocked prompt cannot be matched.
    return None


def replay(path):
    queue, expect = [], None
    with open(path, errors="replace") as lines:
        for line in lines:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if "_expect" in rec:
                expect = rec["_expect"]
            elif rec.get("type") == "queue-operation":
                step(queue, rec)
    return queue, expect


def main(argv):
    check = "--check" in argv
    failed = False
    for path in [a for a in argv if a != "--check"]:
        queue, expect = replay(path)
        shown = [i["text"] or "(text not logged)" for i in queue if is_human(i)]
        if check:
            ok = shown == expect
            failed |= not ok
            print(("ok  " if ok else "FAIL"), path, shown)
        else:
            print(path, shown)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
