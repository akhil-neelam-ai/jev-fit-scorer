// Reads the open job page: the job's title, company, description, and address.
//
// The popup passes extractOpenJobPage to chrome.scripting.executeScript, which
// runs it in the tab from its source text alone. So the function must stay
// self-contained: everything it uses is defined inside it.
// test/extract.test.mjs runs it the same way, on sample pages in Chrome.
//
// It runs only in the active tab after the user opens the extension. activeTab
// grants temporary access for that interaction. The extension does not request
// blanket access to career sites.
export function extractOpenJobPage() {
  const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
  const isVisible = (element) => !element.checkVisibility || element.checkVisibility({ visibilityProperty: true });
  const firstVisible = (scope, selector) => Array.from(scope.querySelectorAll(selector)).find(isVisible);

  // Where career sites put the description. Finding one is also a sign that
  // the page is a job posting.
  const descriptionSelectors = [
    "[data-automation-id='jobPostingDescription']", // Workday, also in its list-and-detail view
    "#jobDescriptionText", // Indeed
    ".jobs-description__content", // LinkedIn
    "[data-qa='job-description']",
    "[data-testid='job-description']",
    "#job-description",
    ".job-description",
    "[class*='job-description']"
  ];
  // Page furniture and controls, which aren't part of the job.
  const skipped = "script, style, noscript, nav, header, footer, aside, form, button, svg";

  // The text a reader sees. Hidden and skipped elements are left out. Each
  // element that isn't inline, such as a paragraph or a list item, is set off
  // by spaces, so words from neighboring blocks don't run together.
  const visibleText = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.data;
    if (node.nodeType !== Node.ELEMENT_NODE || node.matches(skipped) || !isVisible(node)) return "";
    if (node.tagName === "BR") return " ";
    const text = Array.from(node.childNodes, visibleText).join("");
    return /^(inline|contents)$/.test(getComputedStyle(node).display) ? text : ` ${text} `;
  };

  const roots = [...descriptionSelectors, "article", "main", "[role='main']"]
    .map((selector) => document.querySelector(selector))
    .filter((element) => element && isVisible(element) && clean(element.innerText).length >= 250);
  const root = roots[0] || document.body;

  let description = clean(visibleText(root));
  // Too little text is left, often because the whole page sits in one <form>.
  // Fall back to everything visible on the page.
  if (description.length < 250) description = clean(document.body.innerText);

  // An explicit job-title element beats any h1, since a site banner's h1 can
  // come first. Then the h1 inside the description's container, then the
  // page's first h1.
  const titleElement =
    firstVisible(document, [
      "[data-qa='job-title']",
      "[data-testid='job-title']",
      "[data-automation-id='jobPostingHeader']", // Workday
      "[data-testid='jobsearch-JobInfoHeader-title']", // Indeed
      ".job-details-jobs-unified-top-card__job-title" // LinkedIn
    ].join(", ")) ||
    firstVisible(root, "h1") ||
    firstVisible(document, "h1");
  const title = clean(
    titleElement?.textContent ||
      document.querySelector("meta[property='og:title']")?.content ||
      document.title
  );
  const explicitCompany = clean(
    document.querySelector("[data-qa='company-name'], [data-testid='company-name'], .company-name")?.textContent
  );
  // Amazon Jobs presents the legal employer in the paragraph immediately after
  // the H1: "Job ID: ... | Amazon Kuiper Commercial Services LLC".
  const titleSubheading = clean(titleElement?.nextElementSibling?.textContent);
  const company = explicitCompany || (titleSubheading.includes("|")
    ? clean(titleSubheading.slice(titleSubheading.lastIndexOf("|") + 1))
    : "");

  // Scoring sends the page to TypeSafe, so the popup scores on its own only
  // when the page looks like a job posting. Any one sign is enough:
  // schema.org JobPosting data, a description container from a common job
  // site, a job site or job-like address, or a job-section heading such as
  // "Responsibilities" or "Qualifications". Other pages, like an inbox or a
  // bank, get a "Score anyway" button instead.
  const jobContainers = [
    ...descriptionSelectors,
    "[class*='jobs-description']", // LinkedIn
    ".job__description", // Greenhouse
    ".posting-page", // Lever
    "[class*='jobdescription' i]",
    "[id*='jobdescription' i]",
    "[id*='job-description' i]"
  ];
  const jobSites = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|workable\.com|smartrecruiters\.com|jobvite\.com|icims\.com|bamboohr\.com|recruitee\.com|breezy\.hr|teamtailor\.com|indeed\.com|glassdoor\.com|ziprecruiter\.com|wellfound\.com|builtin\.com|dice\.com|simplify\.jobs)$/;
  const jobPath = /\/(jobs?|careers?|positions?|openings?|postings?|vacanc(y|ies)|requisitions?)(\/|$)/i;
  const sectionHeading = /^(about (the|this) (role|job|position|team|opportunity)|(key |your |main |primary |core )?(responsibilities|duties)|((minimum|basic|preferred|required|additional) )?qualifications|(job )?requirements|what you('|’)ll (do|bring|need|work on)|what you will (do|bring|need|work on)|what we('|’)re looking for|what we are looking for|who you are|job (description|summary|details)|role overview|nice to haves?)\s*:?$/i;
  // A heading counts only in the page's own text. Lines inside illustrations
  // (aria-hidden or role="img"), such as a mockup of a job page on this
  // extension's own landing page, don't make a page a job posting. SVG icons
  // are often aria-hidden and have no innerText.
  const lines = (element) => (element.innerText ?? "").split("\n").map((line) => line.trim());
  const illustrated = new Set(
    Array.from(document.querySelectorAll("[aria-hidden='true'], [role='img']")).filter(isVisible).flatMap(lines)
  );
  const hasJobHeading = lines(document.body).some((line) => sectionHeading.test(line) && !illustrated.has(line));
  const looksLikeJob =
    Array.from(document.querySelectorAll("script[type='application/ld+json']"))
      .some((script) => script.textContent.includes("JobPosting")) ||
    Boolean(document.querySelector("[itemtype*='schema.org/JobPosting' i]")) ||
    jobContainers.some((selector) => document.querySelector(selector)) ||
    jobSites.test(location.hostname) ||
    (/(^|\.)linkedin\.com$/.test(location.hostname) && location.pathname.startsWith("/jobs")) ||
    jobPath.test(location.pathname) ||
    hasJobHeading;

  // Many career pages show the posting in a frame from an applicant tracking
  // system, which this function can't read. The popup offers to open it.
  const atsHosts = ["greenhouse.io", "lever.co", "ashbyhq.com", "icims.com", "myworkdayjobs.com", "jobvite.com", "smartrecruiters.com"];
  const onHost = (hostname, host) => hostname === host || hostname.endsWith("." + host);
  const embedded = Array.from(document.querySelectorAll("iframe[src]")).find((frame) => {
    try {
      const { protocol, hostname } = new URL(frame.src);
      // A frame from the site the page is already on isn't another site.
      return /^https?:$/.test(protocol) &&
        atsHosts.some((host) => onHost(hostname, host) && !onHost(location.hostname, host));
    } catch {
      return false;
    }
  });

  return {
    title,
    company,
    description,
    // No query string or fragment, which can carry sign-in tokens and tracking ids.
    pageUrl: location.origin + location.pathname,
    looksLikeJob,
    embeddedSrc: embedded ? embedded.src : ""
  };
}
