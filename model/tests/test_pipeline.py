"""Tests for the pure parts of the model pipeline.

Standard library only. Nothing here reads model/private/ or eval/private/: every
job, resume and label is made up in the test. Run from the repo root:

  npm run test:model
"""

import contextlib
import fcntl
import hashlib
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from collections import defaultdict
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "model"))

import build_pairs  # noqa: E402
import judge  # noqa: E402
import label_pairs  # noqa: E402
import make_resumes  # noqa: E402
import make_rows  # noqa: E402
import student_eval  # noqa: E402


def node(script, payload=None):
    out = subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT, input=json.dumps(payload or {}),
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def teacher_eval_without_mlx():
    """teacher_eval imports MLX at the top. Stub it so the plain helpers load on any machine."""
    for name in ("mlx", "mlx.core", "mlx_lm", "mlx_lm.models", "mlx_lm.models.cache"):
        sys.modules.setdefault(name, types.ModuleType(name))
    sys.modules["mlx_lm"].load = lambda *a, **k: None
    sys.modules["mlx_lm.models.cache"].make_prompt_cache = lambda *a, **k: None
    import teacher_eval
    return teacher_eval


class LabelOrder(unittest.TestCase):
    """A labeling run in progress depends on this order never changing."""

    def test_order_is_pinned(self):
        pairs = [{"pair_id": f"j{i}-p{i}"} for i in range(3000)]
        before = [p["pair_id"] for p in pairs]
        ids = [p["pair_id"] for p in build_pairs.label_order(pairs)]
        self.assertEqual(sorted(ids), sorted(before))
        self.assertEqual([p["pair_id"] for p in pairs], before, "the input list must not be shuffled in place")
        self.assertEqual(ids, [p["pair_id"] for p in build_pairs.label_order(iter(pairs))], "a generator gives the same order")
        self.assertEqual(ids[:5], ["j515-p515", "j2542-p2542", "j2085-p2085", "j524-p524", "j1792-p1792"])
        self.assertEqual(hashlib.sha1(",".join(ids).encode()).hexdigest()[:12], "f717079e42bf")


class LeakCheck(unittest.TestCase):
    TEST_TEXT = ("You will own the roadmap for our payments platform, talk to merchants every week, "
                 "work with engineering and design on quarterly goals, and report on adoption to leadership "
                 "while keeping the product reliable for thousands of small businesses across the country.")

    def setUp(self):
        self.urls = {build_pairs.norm_url("https://jobs.example.com/acme/123")}
        self.roles = {build_pairs.norm_role("Acme Inc", "Product Manager, Payments")}
        self.by_shingle = defaultdict(set)
        for s in build_pairs.shingles(self.TEST_TEXT):
            self.by_shingle[s].add("test-1")

    def leak(self, **job):
        base = {"url": "https://other.example.com/9", "company": "Globex", "title": "Analyst", "description": "Unrelated text."}
        return build_pairs.leak({**base, **job}, self.urls, self.roles, self.by_shingle)

    def test_same_url_in_another_spelling(self):
        for url in ("http://jobs.example.com/acme/123/", "https://www.jobs.example.com/acme/123?src=board#apply"):
            self.assertEqual(self.leak(url=url), "url", url)

    def test_same_company_and_title_in_another_spelling(self):
        self.assertEqual(self.leak(company="ACME INC.", title="product manager - payments"), "company and title")

    def test_copied_text(self):
        self.assertEqual(self.leak(description=self.TEST_TEXT), "shared text")

    def test_unrelated_job_passes(self):
        self.assertIsNone(self.leak())

    def test_copied_text_inside_a_long_posting_is_not_caught_here(self):
        # A known gap: the share is measured against the training posting's own length.
        # make_rows.py's audit also measures against the test job's length (see LeakAudit).
        padding = " ".join(f"filler{i}" for i in range(600))
        self.assertIsNone(self.leak(description=self.TEST_TEXT + " " + padding))


class LeakAudit(unittest.TestCase):
    """make_rows.py's audit is the last guard between the test jobs and the training rows."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        record = {"job": {"title": "Product Manager", "company": "", "pageUrl": "https://jobs.example.com/acme/123",
                          "description": LeakCheck.TEST_TEXT},
                  "card": {"title": "Product Manager, Payments", "company": "Acme Inc", "url": ""}}
        (Path(self.tmp.name) / "test-1.json").write_text(json.dumps(record))
        with mock.patch.object(make_rows, "TEST", Path(self.tmp.name)):
            self.index = make_rows.audit_index()

    def tearDown(self):
        self.tmp.cleanup()

    def reason(self, **job):
        base = {"url": "https://other.example.com/9", "company": "Globex", "title": "Analyst", "description": "Unrelated text."}
        return make_rows.audit_reason({**base, **job}, self.index)

    def test_url_in_another_spelling(self):
        self.assertEqual(self.reason(url="http://www.jobs.example.com/acme/123/?src=board"), "url")

    def test_company_and_title_from_the_card(self):
        self.assertEqual(self.reason(company="ACME INC.", title="product manager - payments"), "company and title")

    def test_test_text_inside_a_long_posting(self):
        padding = " ".join(f"filler{i}" for i in range(600))
        self.assertEqual(self.reason(description=LeakCheck.TEST_TEXT + " " + padding), "shared text")

    def test_text_with_html_entities(self):
        encoded = "&nbsp;".join(LeakCheck.TEST_TEXT.split())
        self.assertFalse(build_pairs.shingles(encoded) & build_pairs.shingles(LeakCheck.TEST_TEXT), "the entities must matter")
        self.assertEqual(self.reason(description=encoded), "shared text")

    def test_unrelated_job_passes(self):
        self.assertIsNone(self.reason())

    def test_no_test_jobs_means_no_rows(self):
        with tempfile.TemporaryDirectory() as empty, mock.patch.object(make_rows, "TEST", Path(empty)):
            with self.assertRaises(SystemExit):
                make_rows.audit_index()


class JobLevels(unittest.TestCase):
    def job(self, **kw):
        return {"internship": False, "bucket": "mid", "leader": False, **kw}

    def test_levels_follow_the_job(self):
        self.assertEqual(build_pairs.levels_for(self.job(internship=True, bucket="entry")), {"student"})
        self.assertEqual(build_pairs.levels_for(self.job(bucket="entry")), {"new grad", "early career"})
        self.assertEqual(build_pairs.levels_for(self.job(bucket="mid")), {"early career", "mid level"})
        self.assertEqual(build_pairs.levels_for(self.job(bucket="senior")), {"mid level", "senior"})
        self.assertEqual(build_pairs.levels_for(self.job(bucket="senior", leader=True)), {"senior", "leader"})


class Personas(unittest.TestCase):
    def test_mix_and_twist_rules(self):
        people = make_resumes.personas()
        self.assertEqual(len(people), 156)
        self.assertEqual(len({p["id"] for p in people}), 156)
        for function in make_resumes.FUNCTIONS:
            mine = [p for p in people if p["function"] == function]
            self.assertEqual(len(mine), 12, function)
            levels = {name: sum(1 for p in mine if p["level"] == name) for name, _, _, _ in make_resumes.LEVELS}
            self.assertEqual(levels, {"student": 2, "new grad": 2, "early career": 2, "mid level": 3, "senior": 2, "leader": 1})
        for p in people:
            twist = p["twist"] or ""
            if "MBA student" in twist:
                self.assertEqual(p["level"], "student")
            if "PhD" in twist:
                self.assertIn(p["level"], ("student", "new grad"))
            if "bootcamp" in twist:
                self.assertIn(p["function"], ("engineering", "design", "data"))
            if "government or nonprofits" in twist:
                self.assertIn(p["stage"], ("a government agency", "a nonprofit"))

    def test_length_band_uses_whole_numbers(self):
        self.assertTrue(make_resumes.within_band(230, 200))
        self.assertFalse(make_resumes.within_band(231, 200))
        self.assertTrue(make_resumes.within_band(170, 200))
        self.assertFalse(make_resumes.within_band(169, 200))


class ParityWithScoringJs(unittest.TestCase):
    """The teacher reads a Python copy of buildState. It must match the extension's."""

    def test_build_state_matches(self):
        teacher_eval = teacher_eval_without_mlx()
        max_chars = node("import { MAX_DESCRIPTION_CHARS } from './scoring.js'; console.log(MAX_DESCRIPTION_CHARS);")
        cases = [
            {"resume": "  Jane Doe\nAnalyst  ", "job": {"title": "PM", "company": "Acme", "description": "Build things.", "pageUrl": "https://x.example.com/1"}},
            {"resume": "Sam", "job": {"title": "Engineer", "company": "", "description": "", "pageUrl": ""}},
            {"resume": "Lee", "job": {"title": "Long", "company": "Initech", "description": "word " * 20000, "pageUrl": ""}},
        ]
        js = node("import { buildState } from './scoring.js'; let s = ''; process.stdin.on('data', d => s += d);"
                  "process.stdin.on('end', () => console.log(JSON.stringify(JSON.parse(s).map(buildState))));", cases)
        for case, expected in zip(cases, js):
            self.assertEqual(teacher_eval.build_state(case["resume"], case["job"], max_chars), expected)

    def test_dimension_names_match(self):
        keys = node("import { DIMENSIONS } from './scoring.js'; console.log(JSON.stringify(Object.keys(DIMENSIONS)));")
        self.assertEqual(judge.DIMS, keys)

    def test_function_and_level_lists_agree(self):
        self.assertEqual(set(build_pairs.NEAR), set(make_resumes.FUNCTIONS))
        self.assertEqual(build_pairs.LEVELS, [level[0] for level in make_resumes.LEVELS])


class Rows(unittest.TestCase):
    def test_gold_uses_the_teacher_probabilities(self):
        probabilities = {"fit": {"0": 0.1, "1": 0.6, "2": 0.3, "3": 0.0, "4": 0.0}, "visa": {"yes": 0.3, "no": 0.7}}
        gold = make_rows.gold_for(probabilities, {"fit": {}, "visa": {}})
        self.assertEqual(gold["fit"]["label"], "1")
        self.assertEqual(gold["fit"]["probabilities"], probabilities["fit"])
        self.assertEqual(gold["visa"]["label"], "false")
        self.assertAlmostEqual(gold["visa"]["probabilities"]["true"], 0.3)

    def test_damage_is_repeatable_and_keeps_the_words(self):
        text = "JANE DOE\nAustin, TX\n\nEXPERIENCE\n- Built dashboards that the sales team uses every week to plan coverage\n- Cut report time"
        for kind in make_rows.DAMAGE:
            once = make_rows.damaged(text, kind, "pair-1")
            self.assertEqual(once, make_rows.damaged(text, kind, "pair-1"), kind)
            self.assertNotEqual(once, text, kind)
            self.assertIn("Cut report time", once.replace("\n", " "), kind)

    def test_the_job_side_looks_like_what_the_extension_sends(self):
        self.assertEqual(make_rows.page_url("https://x.example.com/jobs/1?src=board&utm=a#apply"), "https://x.example.com/jobs/1")
        ids = [f"j{i}-p{i}" for i in range(2000)]
        text = "Line one &amp; more\n\nLine two"
        shaped = [make_rows.job_text(text, i) for i in ids]
        self.assertEqual(shaped, [make_rows.job_text(text, i) for i in ids])
        self.assertTrue(all("&amp;" not in t and "\xa0" not in t for t in shaped))
        one_line = sum("\n" not in t for t in shaped) / len(ids)
        self.assertTrue(0.75 < one_line < 0.85, one_line)
        no_company = sum(make_rows.company_for("Acme", i) == "" for i in ids) / len(ids)
        self.assertTrue(0.92 < no_company < 0.98, no_company)


class ConfidenceFilter(unittest.TestCase):
    QUESTIONS = {False: {"fit": {}, "dim_domain": {}}, True: {"fit": {}, "dim_domain": {}, "visa": {}}}
    PROBABILITIES = {"fit": {"0": 0.1, "1": 0.9}, "dim_domain": {"0": 1.0}, "visa": {"yes": 0.2, "no": 0.8}}

    def row(self, mass, visa=True):
        label = {"probabilities": self.PROBABILITIES, "optionMass": mass}
        return make_rows.row_for({"pair_id": "j1-p1", "visa": visa}, "state", label, self.QUESTIONS)

    def test_clear_answers_make_a_row(self):
        row, removed = self.row({"fit": 0.95, "domain": 0.92, "visa": 0.6})
        self.assertFalse(removed)
        self.assertEqual(set(row["questions"]), {"fit", "dim_domain", "visa"})
        self.assertEqual(row["gold"]["fit"]["probabilities"], self.PROBABILITIES["fit"])

    def test_one_unclear_answer_drops_the_whole_row(self):
        self.assertEqual(self.row({"fit": 0.95, "domain": 0.85, "visa": 0.6}), (None, False))

    def test_a_missing_or_nan_mass_counts_as_unclear(self):
        self.assertEqual(self.row({"fit": 0.95, "visa": 0.6}), (None, False))
        self.assertEqual(self.row({"fit": 0.95, "domain": float("nan"), "visa": 0.6}), (None, False))

    def test_an_unclear_visa_answer_is_removed_and_the_row_stays(self):
        row, removed = self.row({"fit": 0.95, "domain": 0.95, "visa": 0.4})
        self.assertTrue(removed)
        self.assertNotIn("visa", row["questions"])
        self.assertNotIn("visa", row["gold"])

    def test_visa_is_asked_only_when_the_pair_asks_it(self):
        row, removed = self.row({"fit": 0.95, "domain": 0.95, "visa": 0.1}, visa=False)
        self.assertFalse(removed)
        self.assertEqual(set(row["questions"]), {"fit", "dim_domain"})


class Splits(unittest.TestCase):
    def test_held_out_is_stable_and_about_a_tenth(self):
        ids = [str(600000000 + i) for i in range(2000)]
        first = [make_rows.held_out(i) for i in ids]
        self.assertEqual(first, [make_rows.held_out(i) for i in ids])
        self.assertTrue(150 <= sum(first) <= 250, sum(first))

    def test_no_held_out_job_or_resume_trains(self):
        for i in range(3000):
            pair = {"job_id": str(600000000 + i), "resume_id": f"p{i % 156:03d}"}
            split, measures = make_rows.split_for(pair, {})
            out = make_rows.held_out(pair["job_id"]) or make_rows.held_out(pair["resume_id"])
            self.assertEqual(split, "valid" if out else "train", pair)
            self.assertEqual(measures is None, split == "train", pair)

    def test_a_tailored_resume_is_held_out_with_the_job_it_came_from(self):
        source = next(str(600000000 + i) for i in range(1000) if make_rows.held_out(str(600000000 + i)))
        resume = next(f"t{i:03d}" for i in range(1, 1000) if not make_rows.held_out(f"t{i:03d}"))
        other = next(str(700000000 + i) for i in range(1000) if not make_rows.held_out(str(700000000 + i)))
        cross = {"job_id": other, "resume_id": resume, "resume_dir": "tailored"}
        self.assertEqual(make_rows.split_for(cross, {resume: source}), ("valid", "new resume"))
        self.assertEqual(make_rows.split_for(cross, {resume: other}), ("train", None))
        self.assertEqual(make_rows.split_for({**cross, "resume_dir": "generated"}, {resume: source}), ("train", None))


class StudentResults(unittest.TestCase):
    def test_result_holds_what_the_grader_reads(self):
        # compare-versions.mjs reads a missing scorecard dimension as 1, so a dropped key would pass silently.
        questions = node("import { buildQuestions } from './scoring.js';"
                         "console.log(JSON.stringify(buildQuestions({ needsSponsorship: true })));")
        criteria = node("import { FIT_CRITERIA } from './scoring.js'; console.log(JSON.stringify(FIT_CRITERIA));")
        grader = json.loads(re.search(r"const DIMS = (\[[^\]]*\]);", (ROOT / "eval/compare-versions.mjs").read_text()).group(1))
        dims = [k[len("dim_"):] for k in questions if k.startswith("dim_")]
        answers = {"fit": {"probabilities": {"0": 0.1, "1": 0.2, "2": 0.4, "3": 0.2, "4": 0.1}},
                   "why": {"probabilities": {d: 1 / len(dims) for d in dims}},
                   "visa": {"probabilities": {"true": 0.3, "false": 0.7}},
                   **{f"dim_{d}": {"probabilities": {"0": 0.2, "1": 0.5, "2": 0.3}} for d in dims}}
        result = student_eval.result_from_answers(answers, questions, criteria)
        self.assertEqual(sorted(result["scorecard"]), sorted(grader))
        self.assertAlmostEqual(result["fit"], 2.0)
        self.assertAlmostEqual(result["scorecard"][dims[0]]["score"], 1.1)
        self.assertEqual(result["fitLabel"], criteria[2])
        self.assertAlmostEqual(result["visa"], 0.3)
        del answers[f"dim_{dims[0]}"]
        with self.assertRaises(KeyError):
            student_eval.result_from_answers(answers, questions, criteria)

    def test_reload_check_counts_nan_as_a_failure(self):
        before = {"fit": {"probabilities": {"0": 0.5, "1": 0.5}}}
        self.assertEqual(student_eval.largest_change(before, before), 0.0)
        broken = {"fit": {"probabilities": {"0": float("nan"), "1": 0.5}}}
        self.assertEqual(student_eval.largest_change(before, broken), float("inf"))


class LabelRuns(unittest.TestCase):
    """label_pairs.py runs unattended for hours, so its lock, skip and stop paths are pinned here."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "pairs").mkdir()
        (self.tmp / "resumes/generated").mkdir(parents=True)
        (self.tmp / "pairs/jobs.jsonl").write_text(json.dumps({"id": "j1", "title": "PM", "company": "Acme",
                                                               "description": "Build things.", "url": ""}) + "\n")
        pairs = [{"pair_id": f"j1-p{i}", "job_id": "j1", "resume_id": f"p{i}", "role": "fit"} for i in range(7)]
        (self.tmp / "pairs/pairs.jsonl").write_text("".join(json.dumps(p) + "\n" for p in pairs))
        for i in range(6):  # p6 has no resume yet, so it waits
            (self.tmp / f"resumes/generated/p{i}.txt").write_text("Jane Doe")
        self.patches = [mock.patch.object(label_pairs, name, self.tmp / sub) for name, sub in
                        (("PAIRS", "pairs"), ("RESUMES", "resumes"), ("LABELS", "labels"), ("LOCK", "label_pairs.lock"))]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        shutil.rmtree(self.tmp)

    def run_main(self, score_job, *argv, load=None):
        mlx_lm = types.ModuleType("mlx_lm")
        mlx_lm.load = load or (lambda path: (object(), types.SimpleNamespace(apply_chat_template=lambda *a, **k: "chat")))
        teacher = types.ModuleType("teacher_eval")
        teacher.__dict__.update(DEFAULT_MODEL="teacher", SYSTEM="", Reader=lambda model, tok: None, score_job=score_job,
                                build_prompt=lambda state, r: "", build_state=lambda resume, job, n: "state",
                                rubric=lambda: {"maxChars": 100})
        with mock.patch.dict(sys.modules, {"mlx_lm": mlx_lm, "teacher_eval": teacher}), \
                mock.patch.object(sys, "argv", ["label_pairs.py", "--pairs", "pairs.jsonl", *argv]), \
                contextlib.redirect_stdout(io.StringIO()):
            label_pairs.main()

    def labels(self):
        return sorted(p.name for p in (self.tmp / "labels").glob("*"))

    @staticmethod
    def scored(*args):
        return {"fit": 2.0, "elapsedMs": 5}, 10, {"fit": 1.0}, {"fit": {"2": 1.0}}

    def test_a_held_lock_stops_other_model_scripts(self):
        with open(label_pairs.LOCK, "w") as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(SystemExit):
                label_pairs.refuse_if_labeling()
        label_pairs.refuse_if_labeling()  # released, so this returns

    def test_nothing_to_do_never_loads_the_model(self):
        def never(path):
            raise AssertionError("the model was loaded")
        self.run_main(self.scored, "--limit", "0", load=never)
        (self.tmp / "labels").mkdir(exist_ok=True)
        for i in range(6):
            (self.tmp / f"labels/j1-p{i}.json").write_text("{}")
        self.run_main(self.scored, load=never)  # p0 to p5 labeled, p6 waiting

    def test_a_failing_pair_is_skipped_and_the_run_exits_1(self):
        calls = []

        def score_job(*args):
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError("Metal hiccup")
            return self.scored()

        with self.assertRaises(SystemExit) as stop:
            self.run_main(score_job)
        self.assertEqual(stop.exception.code, 1)
        self.assertEqual(len(self.labels()), 5)  # one failed, five labeled, p6 still waits
        self.assertTrue(all(name.endswith(".json") for name in self.labels()), "no temp file is left behind")

    def test_five_failures_in_a_row_stop_the_run(self):
        calls = []

        def score_job(*args):
            calls.append(1)
            raise RuntimeError("broken model")

        with self.assertRaises(SystemExit) as stop:
            self.run_main(score_job)
        self.assertIn("in a row", str(stop.exception.code))
        self.assertEqual(len(calls), label_pairs.MAX_FAILURES_IN_A_ROW)
        self.assertEqual(self.labels(), [])


class JudgeMath(unittest.TestCase):
    def test_spearman_and_expected(self):
        self.assertAlmostEqual(judge.spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1.0)
        self.assertAlmostEqual(judge.spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1.0)
        self.assertAlmostEqual(judge.expected({"0": 0.5, "2": 0.5}), 1.0)


if __name__ == "__main__":
    unittest.main()
