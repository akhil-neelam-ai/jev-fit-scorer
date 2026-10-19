"""Check that the Unsloth app serves the trained student, before any real resume goes to it.

A run's preview.json holds a few validation rows, all generated resumes, with the
answers the trained model gave in memory. This sends each one to the app's
/v1/systemone on this Mac, naming the student exactly, the way
eval/local-endpoint.mjs does. It fails unless every answer came from a local
checkpoint and every probability comes back within 0.02 of the trained model's.

  python3 model/serve_check.py --run model/private/student/run1
"""

import argparse
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

from student_eval import RELOAD_TOLERANCE, largest_change

LOCAL = "http://127.0.0.1:8888/v1/systemone"
MODEL = "clef-ft:worth-applying-run1"
WAIT_S, RETRY_S = 300, 5  # the app answers 503 while a model loads


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # a redirect becomes an error, so the rows never go anywhere else


# No proxy handler, because a configured proxy would carry the rows off this Mac.
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirects)


def with_probabilities(answer):
    """The app sends a yes-or-no answer as one number, the chance of yes."""
    if "probabilities" not in answer and isinstance(answer.get("noul"), (int, float)):
        return {**answer, "probabilities": {"true": answer["noul"], "false": 1 - answer["noul"]}}
    return answer


def ask(url, model, state, questions):
    """The app's answers to one request, refused unless a local checkpoint gave them."""
    request = urllib.request.Request(url, data=json.dumps({"state": state, "model": model, "questions": questions}).encode(),
                                     headers={"Authorization": "Bearer no-key-required", "Content-Type": "application/json"})
    deadline = time.monotonic() + WAIT_S
    while True:
        try:
            with OPENER.open(request, timeout=120) as res:
                if not res.headers.get("x-unsloth-decision-backend"):
                    raise SystemExit("The answer didn't come from a local checkpoint. Check the app's decision model setting.")
                return {name: with_probabilities(a) for name, a in json.load(res)["answers"].items()}
        except urllib.error.HTTPError as e:
            body = e.read().decode()[:300]
            e.close()
            if e.code == 503 and time.monotonic() + RETRY_S < deadline:
                time.sleep(RETRY_S)
                continue
            raise SystemExit(f"The app answered {e.code}: {body}")
        except urllib.error.URLError as e:
            raise SystemExit(f"No app answered at {url} ({e.reason}). Is the Unsloth app open, with the Decision API on?")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True, help="a run folder from train_student.py, holding preview.json")
    ap.add_argument("--url", default=LOCAL)
    ap.add_argument("--model", default=MODEL, help="the student's name in the app, such as clef-ft:<folder>")
    args = ap.parse_args()
    if not re.match(r"http://(127\.0\.0\.1|localhost)(:\d+)?/", args.url):
        raise SystemExit("--url must be on this Mac.")
    if not re.fullmatch(r"((clef|laya)-ft:[\w.-]+|laya-local)", args.model):
        raise SystemExit("--model must name a local model. A default alias could point at a hosted one.")
    preview = json.loads((Path(args.run) / "preview.json").read_text())
    worst, compared = 0.0, 0
    for item in preview:
        answers = ask(args.url, args.model, item["state"], item["questions"])
        if any("probabilities" not in answers.get(name, {}) for name in item["answers"]):
            raise SystemExit("The app's answers carry no probabilities to compare.")
        worst = max(worst, largest_change(item["answers"], answers))
        compared += sum(len(a["probabilities"]) for a in item["answers"].values())
    if not compared:
        raise SystemExit("Nothing was compared. Check preview.json.")
    print(f"largest probability change, app against the trained model: {worst:.4f} over {len(preview)} rows", flush=True)
    raise SystemExit(0 if worst < RELOAD_TOLERANCE else 1)


if __name__ == "__main__":
    main()
