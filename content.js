/* Jev Fit Scorer — content script for lennysjobs.com
 *
 * Exact CSS class names for the job cards are not known, so this script uses
 * heuristic DOM anchoring instead:
 *   1. Find every element whose trimmed text is exactly "Am I a fit?".
 *   2. From each, walk up ancestors (max 10 levels) and pick the largest
 *      single-job wrapper with both a job-title link and company link.
 *   3. Extract fields from their individual elements and send
 *      them to the background worker for scoring.
 *   4. Inject a score badge next to the button; mark the card processed.
 *
 * If this ever misfires on a site redesign, the most likely thing to adjust is
 * the ancestor heuristic in findCardContainer() — look for the wrapper that
 * visually boxes one job listing.
 */

const PROCESSED_ATTR = "data-jev-scored";
const BUTTON_TEXT = "Am I a fit?";
const MAX_ANCESTOR_LEVELS = 10;

let scanScheduled = false;

function scheduleScan() {
  if (scanScheduled) return;
  scanScheduled = true;
  setTimeout(() => {
    scanScheduled = false;
    scanCards();
  }, 400); // debounce: let the "Show more" batch finish rendering
}

// An element is a fit-button candidate if its own visible text is exactly the
// button label. We match on exact text rather than a class name so a redesign
// that renames classes doesn't break us (as long as the label stays).
function findFitButtons() {
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let node;
  while ((node = walker.nextNode())) {
    if (
      node.children.length === 0 &&
      node.textContent.trim() === BUTTON_TEXT &&
      node.offsetParent !== null
    ) {
      out.push(node);
    }
  }
  return out;
}

function countFitButtons(root) {
  let count = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node;
  while ((node = walker.nextNode())) {
    if (
      node.children.length === 0 &&
      node.textContent.trim() === BUTTON_TEXT &&
      node.offsetParent !== null
    ) {
      count++;
    }
  }
  return count;
}

function text(el) {
  return (el?.textContent || "").trim().replace(/\s+/g, " ");
}

function isCompanyLink(link) {
  try {
    const url = new URL(link.href);
    return url.hostname === "trueup.io" && url.pathname.startsWith("/co/");
  } catch {
    return false;
  }
}

function findCompanyLink(root) {
  return [...root.querySelectorAll("a")].find((link) => isCompanyLink(link) && text(link));
}

function findTitleLink(root) {
  return [...root.querySelectorAll("a")].find(
    (link) => text(link).length > 5 && !isCompanyLink(link) && link.href
  );
}

// Walk up from the button and retain the outermost wrapper that still belongs
// to one listing. The extra metadata is a sibling of the upper job-details row
// on the live board, so returning the first matching ancestor drops it.
function findCardContainer(buttonEl) {
  let card = null;
  let el = buttonEl.parentElement;
  for (let level = 0; level < MAX_ANCESTOR_LEVELS && el; level++) {
    const buttonsInside = countFitButtons(el);
    if (buttonsInside > 1) break;
    if (buttonsInside === 1 && findTitleLink(el) && findCompanyLink(el)) card = el;
    el = el.parentElement;
  }
  return card;
}

function leafTexts(root) {
  return [...root.querySelectorAll("*")]
    .filter((el) => el.children.length === 0)
    .map((el) => text(el))
    .filter(Boolean);
}

function unique(values) {
  return [...new Set(values)];
}

function findLocation(leafText) {
  return (
    leafText.find(
      (value) =>
        /^(?:REMOTE|[A-Z][A-Z .,'/-]{4,})$/.test(value) &&
        !/^(?:AWS|GCP|MCP|LLM|API|SQL)$/.test(value)
    ) || ""
  );
}

function findPosted(leafText) {
  return leafText.find((value) => /^\d+\s+(?:day|week|month)s?(?:\s+ago)?$/.test(value)) || "";
}

// Extract what we can from the card. The title link points to an EXTERNAL
// career page, so the full job description is not available — card text only.
function extractJob(card) {
  const titleEl = findTitleLink(card) || card.querySelector("h1,h2,h3,h4");
  const companyEl = findCompanyLink(card);
  const title = text(titleEl);
  const company = text(companyEl);
  const cardText = text(card);
  const leafText = leafTexts(card);

  const salary =
    leafText.find((value) => /\$[\d,.]+K?\s*[-–—to]+\s*\$?[\d,.]+K?/.test(value)) || "";
  const location = findLocation(leafText);
  const posted = findPosted(leafText);

  const metaMatch = cardText.match(
    /(?:\d{1,3}\s*)?Trajectory score|Layoff[^•·|]*|\d[\d,]* employees|[\d,]+ open jobs|Valuation[^•·|]*|\bPublic\b|Time-consuming ATS/gi
  );
  const meta = unique((metaMatch || []).map((value) => value.trim())).join(" · ");

  // The board marks skill chips with a monospace class. If that marker changes,
  // retain short all-caps chips as a conservative fallback.
  const markedTags = [...card.querySelectorAll('[class*="font-mono"]')]
    .map((el) => text(el))
    .filter((t) => t.length > 0 && t.length <= 24 && /^[A-Za-z0-9 .+#/-]+$/.test(t))
    .filter((t) => t !== title && t !== company && t !== location && t !== posted && t !== salary);
  const tagValues =
    markedTags.length > 0
      ? markedTags
      : leafText.filter(
          (t) =>
            /^[A-Z0-9+#/-]{2,24}$/.test(t) &&
            t !== location &&
            t !== posted &&
            t !== salary
        );
  const tags = unique(tagValues).slice(0, 12).join(", ");

  const companyBlock = companyEl?.parentElement?.parentElement;
  const tagline =
    leafTexts(companyBlock || card).find(
      (value) => value.length > 10 && value.length < 140 && value !== company && value !== title
    ) || "";

  return {
    id: [title, company, location].join(" | "),
    title,
    company,
    location,
    tagline,
    tags,
    salary,
    posted,
    meta
  };
}

function badgeColor(fit) {
  if (fit == null) return "#9ca3af";
  if (fit >= 3) return "#16a34a"; // green
  if (fit >= 2) return "#d97706"; // amber
  return "#6b7280"; // gray
}

function injectBadge(card, buttonEl, job) {
  // Don't double-inject.
  if (card.querySelector("[data-jev-badge]")) return;
  const badge = document.createElement("span");
  badge.setAttribute("data-jev-badge", "1");
  badge.textContent = "Jev …";
  Object.assign(badge.style, {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    marginLeft: "8px",
    padding: "4px 10px",
    borderRadius: "999px",
    fontSize: "12px",
    fontWeight: "600",
    background: "#f3f4f6",
    color: "#374151",
    border: "1px solid #e5e7eb",
    whiteSpace: "nowrap",
    cursor: "default"
  });
  buttonEl.insertAdjacentElement("afterend", badge);

  const requestScore = (manual = false) => chrome.runtime.sendMessage({ type: "score_job", job, manual }, (resp) => {
    if (chrome.runtime.lastError) {
      setBadgeError(badge, "ext error", requestScore);
      return;
    }
    if (resp?.manualRequired) {
      setBadgeManual(badge, requestScore);
      return;
    }
    if (!resp || !resp.ok) {
      setBadgeError(badge, resp?.error || "failed", requestScore);
      return;
    }
    const r = resp.result;
    if (r.fit == null) {
      setBadgeError(badge, "no score", requestScore);
      return;
    }
    const color = badgeColor(r.fit);
    badge.textContent = `Jev ${r.fit.toFixed(1)}/4`;
    badge.style.background = color + "1a";
    badge.style.color = color;
    badge.style.borderColor = color + "55";
    const whyLabels = {
      role_match: "role match",
      company_quality: "company quality",
      compensation: "compensation",
      location_remote: "location/remote"
    };
    badge.title =
      `Fit: ${r.fit.toFixed(1)} / 4 — ${r.fitLabel || ""}\n` +
      `Confidence: ${r.fitConfidence != null ? Math.round(r.fitConfidence * 100) + "%" : "n/a"}\n` +
      `Strongest factor: ${whyLabels[r.why] || r.why || "n/a"}\n` +
      (r.visa != null ? `Sponsorship-friendly: ${Math.round(r.visa * 100)}%\n` : "") +
      `${r.cached ? "From cache (free)" : "Scored just now"}`;
  });
  requestScore();
}

function setBadgeManual(badge, requestScore) {
  badge.textContent = "Score with Jev";
  badge.style.background = "#f3f4f6";
  badge.style.color = "#374151";
  badge.style.borderColor = "#e5e7eb";
  badge.style.cursor = "pointer";
  badge.title = "Auto-score is off. Click to score this job.";
  badge.onclick = (event) => {
    event.stopPropagation();
    badge.textContent = "Jev …";
    badge.style.cursor = "default";
    badge.onclick = null;
    requestScore(true);
  };
}

function setBadgeError(badge, reason, requestScore) {
  badge.textContent = "Jev ✕";
  badge.style.background = "#fef2f2";
  badge.style.color = "#dc2626";
  badge.style.borderColor = "#fecaca";
  badge.style.cursor = "pointer";
  badge.title = `Scoring failed: ${reason}. Click to retry.`;
  badge.onclick = (e) => {
    e.stopPropagation();
    badge.textContent = "Jev …";
    badge.style.cursor = "default";
    badge.onclick = null;
    requestScore(true);
  };
}

function scanCards() {
  const buttons = findFitButtons();
  for (const btn of buttons) {
    const card = findCardContainer(btn);
    if (!card || card.hasAttribute(PROCESSED_ATTR)) continue;
    const job = extractJob(card);
    if (!job.title) continue; // not a real job card, skip
    card.setAttribute(PROCESSED_ATTR, "1");
    injectBadge(card, btn, job);
  }
}

// Observe the whole page: cards render dynamically and "Show more" appends
// more of them. The debounced scan re-runs after each DOM burst.
const observer = new MutationObserver(scheduleScan);
observer.observe(document.body, { childList: true, subtree: true });

scanCards();
