"""Serve the trained student on this Mac at /v1/systemone, the same path as Jev's API.

The Unsloth app serves Clef models only on NVIDIA or AMD GPUs, so it can't run the
student on a Mac. This small server loads the student with the same Unsloth MLX code
that graded it, and answers the CLI's request in Jev's shape. It listens on
127.0.0.1 only, answers only JSON sent to 127.0.0.1, and answers only to the name of
the run it serves, such as clef-ft:worth-applying-run1. eval/local-endpoint.mjs and
model/serve_check.py send their requests here.

  model/.venv-train/bin/python model/serve_student.py --model model/private/student/run1/merged
"""

import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from label_pairs import refuse_if_labeling

PORT = 8899
MAX_BODY = 2_000_000  # bytes. A resume and a long posting fit easily.


def default_name(model_dir):
    """The name a run's student answers to: its run folder, as clef-ft:worth-applying-<run>."""
    return f"clef-ft:worth-applying-{Path(model_dir).resolve().parent.name}"


def make_handler(name, answer):
    """A request handler that answers POST /v1/systemone for the model `name` with answer(state, questions)."""

    class Handler(BaseHTTPRequestHandler):
        timeout = 30  # seconds per socket read, so a stalled client can't hold the server

        def reply(self, status, payload):
            data = json.dumps(payload, allow_nan=False).encode()
            self.send_response(status)
            if status == 200:
                self.send_header("x-unsloth-decision-backend", "mlx")  # a local Unsloth checkpoint answered
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            if self.path != "/v1/systemone":
                return self.reply(404, {"error": "Only POST /v1/systemone is served here."})
            # Only a local client sends Host 127.0.0.1. Requiring JSON makes a browser ask first, and it gets no answer.
            if self.headers.get("Host") != f"127.0.0.1:{self.server.server_port}":
                return self.reply(400, {"error": "Send requests to 127.0.0.1."})
            if (self.headers.get("Content-Type") or "").split(";")[0].strip() != "application/json":
                return self.reply(415, {"error": "Send JSON."})
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if not 0 < length <= MAX_BODY:
                return self.reply(413, {"error": "The request is empty or too large."})
            try:
                request = json.loads(self.rfile.read(length))
                state, questions = request["state"], request["questions"]
            except (ValueError, KeyError, TypeError):
                return self.reply(400, {"error": "Send JSON with state and questions."})
            if request.get("model") != name:
                return self.reply(400, {"error": f"Unknown model: {request.get('model')}. This server serves {name}."})
            started = time.perf_counter()
            try:
                answers, tokens = answer(state, questions)
                payload = {"answers": answers, "usage": {"input_tokens": tokens}}
                json.dumps(payload, allow_nan=False)
            except ValueError as e:
                # Only the kind of error is printed, since a message could quote the resume.
                print(f"couldn't read a request ({type(e).__name__})", flush=True)
                return self.reply(400, {"error": "The student couldn't read this request."})
            except Exception as e:
                print(f"couldn't answer a request ({type(e).__name__})", flush=True)
                return self.reply(500, {"error": "The student couldn't answer."})
            print(f"answered {len(questions)} questions in {round((time.perf_counter() - started) * 1000)} ms", flush=True)
            return self.reply(200, payload)

        def log_message(self, *args):
            pass  # requests carry a resume, so nothing about them is logged

    return Handler


def serve(name, answer, port=PORT):
    """The server, bound to this Mac only."""
    return HTTPServer(("127.0.0.1", port), make_handler(name, answer))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="a student's merged or adapters folder from train_student.py")
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--name", help="the model name requests must use (default: clef-ft:worth-applying-<run>)")
    args = ap.parse_args()
    refuse_if_labeling()
    name = args.name or default_name(args.model)

    from unsloth import FastDecisionModel

    from student_eval import load

    model, tokenizer = load(args.model, FastDecisionModel)

    def answer(state, questions):
        return FastDecisionModel.predict(model, tokenizer, state, questions), len(tokenizer.encode(state))

    server = serve(name, answer, args.port)
    print(f"serving {name} at http://127.0.0.1:{args.port}/v1/systemone (Ctrl-C to stop)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
