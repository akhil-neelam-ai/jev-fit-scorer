"""What the teacher reads, and how its answers are read, without loading MLX.

A label is only good for the prompt that made it. The prompt stamp hashes the parts
of teacher_eval.py that decide a label, together with the questions scoring.js
defines. Those parts are the system prompt, the state and prompt templates, and the
code that reads the answers. teacher_eval.py imports MLX at the top, so this module
reads its source as text instead of importing it. That lets make_rows.py and
label_pairs.py check stamps under any Python.
"""

import ast
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEACHER = ROOT / "model/teacher_eval.py"
# The parts of teacher_eval.py that decide what a label says.
STAMPED = ("SYSTEM", "build_state", "build_prompt", "Reader", "score_job")


def rubric():
    """The questions, dimensions and limits, exactly as scoring.js defines them."""
    script = (
        "import { buildQuestions, DIMENSIONS, FIT_CRITERIA, MAX_DESCRIPTION_CHARS } from './scoring.js';"
        "console.log(JSON.stringify({ questions: buildQuestions({ needsSponsorship: true }),"
        " labels: Object.fromEntries(Object.entries(DIMENSIONS).map(([k, d]) => [k, d.label])),"
        " fitCriteria: FIT_CRITERIA, maxChars: MAX_DESCRIPTION_CHARS }));"
    )
    out = subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def stamped_parts(source):
    """The source text of each part in STAMPED. Any edit to one of them, even a comment, changes the stamp."""
    parts = {}
    for node in ast.parse(source).body:
        names = [t.id for t in node.targets if isinstance(t, ast.Name)] if isinstance(node, ast.Assign) else [getattr(node, "name", None)]
        for name in names:
            if name in STAMPED:
                parts[name] = ast.get_source_segment(source, node)
    missing = sorted(set(STAMPED) - set(parts))
    if missing:
        raise SystemExit(f"{TEACHER.name} no longer defines {', '.join(missing)}, so labels can't be stamped.")
    return parts


def prompt_stamp(r=None, source=None):
    """A short hash of everything that decides a label besides the pair itself.
    Labels with one stamp answered one prompt, read the same way."""
    parts = stamped_parts(TEACHER.read_text() if source is None else source)
    return hashlib.sha1(json.dumps([parts, rubric() if r is None else r], sort_keys=True).encode()).hexdigest()[:12]
