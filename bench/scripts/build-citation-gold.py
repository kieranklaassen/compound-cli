#!/usr/bin/env python3
"""Build a citation gold set for compound-cli bench from a repository's own plans.

Positive labels: every plan under <docs>/plans that cites a <docs>/solutions file
dated on or before the plan. The primary query is the plan file itself through
the plan channel, with every line that names a learning by path removed (those
lines are where the labels come from). Noisy variants use the plan's title and
summary, or the title alone, as an activity sentence. Plans split into dev and
held-out by hash. Output stays inside the repository it describes; nothing
about the corpus is copied elsewhere.

Usage: build-citation-gold.py --root <checkout> [--docs docs] [--out bench]
       [--floor-macro 0.55] [--floor-negatives 1.0]
"""
import argparse
import hashlib
import json
import os
import re
import sys
from collections import defaultdict

PARSER = argparse.ArgumentParser()
PARSER.add_argument("--root", required=True, help="repository checkout whose plans and solutions are read")
PARSER.add_argument("--docs", default="docs", help="artifact root inside the repository (default docs)")
PARSER.add_argument("--out", default="bench", help="output directory, relative to --root (default bench)")
PARSER.add_argument("--floor-macro", type=float, default=0.0, help="macro recall floor written into the primary cases files")
PARSER.add_argument("--floor-negatives", type=float, default=1.0, help="negatives floor written into the primary cases files")
ARGS = PARSER.parse_args()
ROOT = os.path.abspath(ARGS.root)
DOCS = ARGS.docs
PLANS = os.path.join(ROOT, DOCS, "plans")
SOLUTIONS = os.path.join(ROOT, DOCS, "solutions")
OUT = os.path.join(ROOT, ARGS.out, "cases")
REDACTED = os.path.join(ROOT, ARGS.out, "plans")
os.makedirs(OUT, exist_ok=True)
os.makedirs(REDACTED, exist_ok=True)
# Any line that references a learning by path is dropped from the plan copy the
# judge sees: the labels come from those lines, so leaving them in would hand
# the judge the answer. Plans at recall time do not carry them yet.
LEAK = re.compile(r"^.*solutions/[A-Za-z0-9_./-]*\.md.*$", re.M)
redaction_stats = {"plans": 0, "lines_dropped": 0}


def redacted_plan(rel):
    src = os.path.join(ROOT, rel)
    text = open(src, encoding="utf-8", errors="replace").read()
    dropped = len(LEAK.findall(text))
    clean = LEAK.sub("", text)
    assert not re.search(r"solutions/[A-Za-z0-9_./-]+\.md", clean), rel
    out_rel = os.path.join(ARGS.out, "plans", os.path.basename(rel))
    with open(os.path.join(ROOT, out_rel), "w") as fh:
        fh.write(clean)
    redaction_stats["plans"] += 1
    redaction_stats["lines_dropped"] += dropped
    return out_rel

STOP = set("""a about above after again against all also am an and any are as at be because been before being below
between both but by can could did do does doing done down during each few for from further had has have having he her
here hers him his how i if in into is it its itself just let like me more most my no nor not now of off on once only or
other our ours out over own same she should so some such than that the their theirs them then there these they this
those through to too under until up us very was we were what when where which while who whom why will with would you
your yours add adds added adding make makes making use uses used using get gets got new one two via want need needs
should must may might fix feat plan refactor chore docs implement implementation support feature""".split())


def frontmatter(text):
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    block = text[3:end]
    body = text[end + 4:]
    data = {}
    for line in block.splitlines():
        m = re.match(r"^([a-z_]+):\s*(.*)$", line)
        if m:
            data[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return data, body


def first_heading(body):
    m = re.search(r"^#\s+(.+?)\s*$", body, re.M)
    return m.group(1).strip() if m else None


def clean_title(t):
    t = re.sub(r"^(feat|fix|refactor|chore|docs|perf|test)(\([^)]*\))?:\s*", "", t, flags=re.I)
    t = re.sub(r"\s+-\s+Plan$", "", t)
    t = re.sub(r"\s+Plan$", "", t)
    return t.strip()


def summary_of(body):
    for heading in ["Summary", "Overview", "Objective", "Problem", "Problem Frame", "Goal", "Context"]:
        m = re.search(rf"^#{{2,3}}\s+{re.escape(heading)}\b[^\n]*\n(.*?)(?=^#{{1,3}}\s|\Z)", body, re.M | re.S)
        if m:
            text = m.group(1).strip()
            text = re.sub(r"^\s*-\s*\*\*[^*]+\*\*:?\s*", "", text, flags=re.M)
            paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip() and not p.strip().startswith(("|", "```", "<", "---"))]
            if paras:
                return re.sub(r"\s+", " ", paras[0])[:600]
    paras = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip() and not p.strip().startswith(("#", "|", "```", "<", "---", "- ", "* "))]
    return re.sub(r"\s+", " ", paras[0])[:600] if paras else ""


def tokens(text):
    return {t for t in re.findall(r"[a-z0-9][a-z0-9_-]+", text.lower()) if len(t) > 2 and t not in STOP}


def date_of(data, filename):
    for key in ("date", "created"):
        v = data.get(key, "")
        m = re.match(r"(\d{4}-\d{2}-\d{2})", v)
        if m:
            return m.group(1)
    m = re.match(r"(\d{4}-\d{2}-\d{2})", filename)
    return m.group(1) if m else None


learnings = {}
for dirpath, _, files in os.walk(SOLUTIONS):
    for name in files:
        if not name.endswith(".md"):
            continue
        path = os.path.join(dirpath, name)
        rel = os.path.relpath(path, ROOT)
        text = open(path, encoding="utf-8", errors="replace").read()
        data, body = frontmatter(text)
        title = data.get("title") or first_heading(body) or name
        aw = re.findall(r"^\s*-\s+\"?(.+?)\"?\s*$", text[: text.find("\n---", 3)] if text.startswith("---") else "", re.M)
        learnings[rel] = {
            "date": date_of(data, name),
            "title": title,
            "tokens": tokens(title + " " + data.get("tags", "") + " " + " ".join(aw) + " " + data.get("module", "")),
        }

print(f"learnings: {len(learnings)}, without date: {sum(1 for l in learnings.values() if not l['date'])}", file=sys.stderr)

CITE = re.compile(r"(?:docs/|\.\./|\./)?(solutions/[A-Za-z0-9_./-]+\.md)")
positives = []
negatives_pool = []
dangling = 0
stats = defaultdict(int)
for name in sorted(os.listdir(PLANS)):
    if not name.endswith(".md"):
        continue
    path = os.path.join(PLANS, name)
    rel = os.path.relpath(path, ROOT)
    text = open(path, encoding="utf-8", errors="replace").read()
    data, body = frontmatter(text)
    plan_date = date_of(data, name)
    slug = re.sub(r"^\d{4}-\d{2}-\d{2}-(\d{3}-)?", "", name[:-3]).replace("-plan", "").replace("-", " ")
    title = clean_title(data.get("title") or first_heading(body) or slug)
    summary = summary_of(body)
    cited = []
    for m in CITE.finditer(text):
        target = DOCS + "/" + m.group(1)
        if target in learnings:
            if target not in cited:
                cited.append(target)
        else:
            dangling += 1
    if not plan_date:
        stats["plan_without_date"] += 1
        continue
    before = [c for c in cited if learnings[c]["date"] and learnings[c]["date"] <= plan_date]
    stats["plans"] += 1
    if before:
        stats["plans_with_prior_citations"] += 1
        stats["pairs"] += len(before)
        positives.append({"plan": rel, "date": plan_date, "title": title, "summary": summary, "expected": before})
    elif not cited:
        ptoks = tokens(title + " " + summary)
        overlap = max((len(ptoks & l["tokens"]) for l in learnings.values()), default=0)
        negatives_pool.append({"plan": rel, "date": plan_date, "title": title, "summary": summary, "overlap": overlap})

print(json.dumps(stats), f"dangling citations: {dangling}", file=sys.stderr)


def split_of(key):
    return "dev" if int(hashlib.sha256(key.encode()).hexdigest(), 16) % 10 < 6 else "heldout"


def case_id(plan):
    return re.sub(r"-plan$", "", os.path.basename(plan)[:-3])[:70]


def positive_case(p, variant):
    cid = case_id(p["plan"])
    if variant == "full":
        activity = p["title"] + (". " + p["summary"] if p["summary"] else "")
        return {"id": cid + "--title-summary", "query": {"activity": activity}, "expected": p["expected"]}
    if variant == "title":
        return {"id": cid + "--title-only", "query": {"activity": p["title"]}, "expected": p["expected"]}
    if variant == "plan":
        return {"id": cid, "query": {"plan": redacted_plan(p["plan"])}, "expected": p["expected"]}
    raise ValueError(variant)


negatives_pool.sort(key=lambda n: (n["overlap"], n["plan"]))
hard_negatives = [n for n in negatives_pool if n["overlap"] <= 1][:20]
SYNTHETIC_NEGATIVES = [
    ("neg-tls-rotation", "Rotate the TLS certificate on the production load balancer before it expires"),
    ("neg-terraform-vpc", "Set up Terraform for a new VPC with private subnets and a NAT gateway"),
    ("neg-ios-swiftdata", "Migrate the iOS app's Core Data store to SwiftData"),
    ("neg-kubernetes-hpa", "Tune the Kubernetes horizontal pod autoscaler for the image processing service"),
    ("neg-rust-wasm", "Compile the Rust image decoder to WebAssembly and benchmark it against the C build"),
    ("neg-android-widget", "Build an Android home screen widget that shows the next calendar event"),
]

for split in ("dev", "heldout"):
    pos = [p for p in positives if split_of(p["plan"]) == split]
    negs = [n for n in hard_negatives if split_of(n["plan"]) == split]
    synthetic = SYNTHETIC_NEGATIVES[:3] if split == "dev" else SYNTHETIC_NEGATIVES[3:]
    neg_cases = [{"id": cid, "query": {"activity": act}, "expected": [], "negative": True} for cid, act in synthetic]
    # Primary: the whole plan file as the channel, which is how skills call it.
    primary = {
        "name": f"{os.path.basename(ROOT)}-{split}",
        "description": f"Citation gold set, {split} split. Positives are plan-to-learning citations where the learning is dated on or before the plan; the query is the plan file itself through the plan channel. Negatives are synthetic unrelated work (gated at 100 percent). Private to the repository it was built from.",
        "corpus": None,
        "floor": {"macro_recall": ARGS.floor_macro, "negatives_correct": ARGS.floor_negatives},
        "cases": [positive_case(p, "plan") for p in pos] + neg_cases,
    }
    with open(os.path.join(OUT, f"{split}.json"), "w") as fh:
        json.dump(primary, fh, indent=2)
    # Noisy variants: title and summary as an activity sentence; title alone.
    for variant, label in (("full", "title-summary"), ("title", "title-only")):
        noisy = {
            "name": f"{os.path.basename(ROOT)}-{split}-{label}",
            "description": f"{split} positives with a {label} activity query (noisy variant of the plan channel).",
            "corpus": None,
            "floor": {"macro_recall": 0.0},
            "cases": [positive_case(p, variant) for p in pos] + neg_cases,
        }
        with open(os.path.join(OUT, f"{split}-{label}.json"), "w") as fh:
            json.dump(noisy, fh, indent=2)
    uncited = {
        "name": f"{os.path.basename(ROOT)}-{split}-uncited",
        "description": f"{split} plans with no learning citations and near-zero lexical overlap with any learning. A hit is either a false positive or a silent miss by the plan author; reported, never gated.",
        "corpus": None,
        "floor": {"macro_recall": 0.0},
        "cases": [{"id": "uncited-" + case_id(n["plan"]), "query": {"plan": redacted_plan(n["plan"])}, "expected": [], "negative": True, "note": f"max lexical overlap with any learning {n['overlap']}"} for n in negs],
    }
    with open(os.path.join(OUT, f"{split}-uncited.json"), "w") as fh:
        json.dump(uncited, fh, indent=2)
    print(f"{split}: {len(pos)} positive plans, {sum(len(p['expected']) for p in pos)} pairs, {len(synthetic)} synthetic negatives (gated), {len(negs)} uncited plans (diagnostic)", file=sys.stderr)

print(f"redaction: {redaction_stats}", file=sys.stderr)

# Near-duplicate learnings (title Jaccard >= 0.5) for the confusion diagnostic.
pairs = []
items = list(learnings.items())
for i in range(len(items)):
    for j in range(i + 1, len(items)):
        a, b = items[i][1]["tokens"], items[j][1]["tokens"]
        if not a or not b:
            continue
        jac = len(a & b) / len(a | b)
        if jac >= 0.35:
            pairs.append({"a": items[i][0], "b": items[j][0], "jaccard": round(jac, 2)})
with open(os.path.join(OUT, "near-duplicates.json"), "w") as fh:
    json.dump(pairs, fh, indent=2)
print(f"near-duplicate learning pairs: {len(pairs)}", file=sys.stderr)
