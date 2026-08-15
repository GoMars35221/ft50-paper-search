import { FT50_JOURNALS, FT50_SOURCE, JOURNAL_GROUPS, journalsForSearch } from "./ft50.js?v=20260815-newest-first";
import { buildWorksUrl, normalizeWork, resolveJournalSourceId } from "./openalex.js?v=20260815-newest-first";
import { expandSearchTerms, keywordIdsForQuery, sortWorksForQuery } from "./search.js?v=20260815-newest-first";

const SOURCE_CACHE_KEY = "ft50-openalex-source-map-v2";
const SOURCE_CONCURRENCY = 4;
const SMART_RELEVANCE_CANDIDATE_LIMIT = 100;
const MIN_SMART_RELEVANCE_SCORE = 11;

const elements = {
  form: document.querySelector("#searchForm"),
  query: document.querySelector("#query"),
  yearFrom: document.querySelector("#yearFrom"),
  yearTo: document.querySelector("#yearTo"),
  discipline: document.querySelector("#discipline"),
  journal: document.querySelector("#journal"),
  sort: document.querySelector("#sort"),
  perPage: document.querySelector("#perPage"),
  includeHistorical: document.querySelector("#includeHistorical"),
  mailto: document.querySelector("#mailto"),
  sourceCoverage: document.querySelector("#sourceCoverage"),
  resultCount: document.querySelector("#resultCount"),
  journalSet: document.querySelector("#journalSet"),
  status: document.querySelector("#status"),
  activeFilters: document.querySelector("#activeFilters"),
  results: document.querySelector("#results"),
  prevPage: document.querySelector("#prevPage"),
  nextPage: document.querySelector("#nextPage"),
  pageLabel: document.querySelector("#pageLabel"),
  exportCsv: document.querySelector("#exportCsv"),
  exportRis: document.querySelector("#exportRis")
};

const state = {
  page: 1,
  total: 0,
  results: [],
  sourceCache: readSourceCache(),
  lastResolvedJournals: []
};

initialize();

function initialize() {
  populateDisciplineSelect();
  populateJournalSelect();
  renderJournalSet();
  bindEvents();
  runSearch();
}

function bindEvents() {
  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    state.page = 1;
    runSearch();
  });

  elements.includeHistorical.addEventListener("change", () => {
    populateJournalSelect();
    renderJournalSet();
  });

  elements.discipline.addEventListener("change", () => {
    populateJournalSelect();
    renderJournalSet();
  });

  elements.prevPage.addEventListener("click", () => {
    if (state.page > 1) {
      state.page -= 1;
      runSearch();
    }
  });

  elements.nextPage.addEventListener("click", () => {
    const maxPage = Math.ceil(state.total / Number(elements.perPage.value));
    if (state.page < maxPage) {
      state.page += 1;
      runSearch();
    }
  });

  elements.exportCsv.addEventListener("click", () => downloadText("ft50-results.csv", toCsv(state.results)));
  elements.exportRis.addEventListener("click", () => downloadText("ft50-results.ris", toRis(state.results)));
}

function populateDisciplineSelect() {
  elements.discipline.replaceChildren(
    ...JOURNAL_GROUPS.map((group) => {
      const option = document.createElement("option");
      option.value = group;
      option.textContent = group;
      return option;
    })
  );
}

function populateJournalSelect() {
  const journals = filteredJournalList();
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "All matching FT50 journals";

  elements.journal.replaceChildren(
    allOption,
    ...journals.map((journal) => {
      const option = document.createElement("option");
      option.value = journal.id;
      option.textContent = journal.name;
      return option;
    })
  );
}

function renderJournalSet() {
  const journals = filteredJournalList();
  const byGroup = new Map();

  for (const journal of journals) {
    const list = byGroup.get(journal.group) || [];
    list.push(journal);
    byGroup.set(journal.group, list);
  }

  const fragments = [];
  for (const [group, groupJournals] of byGroup.entries()) {
    const groupNode = document.createElement("div");
    groupNode.className = "journal-group";

    const title = document.createElement("h3");
    title.textContent = `${group} (${groupJournals.length})`;
    groupNode.append(title);

    const list = document.createElement("ul");
    for (const journal of groupJournals) {
      const item = document.createElement("li");
      item.textContent = journal.name;
      if (journal.added2026) item.dataset.badge = "Added 2026";
      if (journal.removed2026) item.dataset.badge = "Historical";
      list.append(item);
    }
    groupNode.append(list);
    fragments.push(groupNode);
  }

  elements.journalSet.replaceChildren(...fragments);
}

async function runSearch() {
  const params = readSearchParams();
  const validation = validateParams(params);

  if (validation) {
    setStatus(validation, "error");
    return;
  }

  setLoading(true);
  setStatus("Resolving FT50 journal sources...");

  try {
    const journals = selectedJournals(params);
    const resolvedJournals = await ensureSourceIds(journals);
    const sourceIds = unique(resolvedJournals.map((journal) => journal.sourceId).filter(Boolean));
    const skipped = journals.length - resolvedJournals.length;

    if (!sourceIds.length) {
      throw new Error("No OpenAlex source IDs were available for the selected journal set.");
    }

    state.lastResolvedJournals = resolvedJournals;
    renderActiveFilters(params, resolvedJournals, skipped);
    setStatus("Searching OpenAlex title, abstract, full text, and keyword tags...");
    const apiYearFrom = openAlexYearFrom(params);
    const useRankedCandidatePool = shouldUseRankedCandidatePool(params);
    const requestPage = useRankedCandidatePool ? 1 : state.page;
    const requestPerPage = useRankedCandidatePool
      ? Math.max(params.perPage, SMART_RELEVANCE_CANDIDATE_LIMIT)
      : params.perPage;

    const requests = [
      buildWorksUrl({
        query: params.query,
        sourceIds,
        yearFrom: apiYearFrom,
        yearTo: params.yearTo,
        sort: params.sort,
        page: requestPage,
        perPage: requestPerPage,
        mailto: params.mailto,
        articleOnly: true
      })
    ];

    const keywordIds = keywordIdsForQuery(params.query);
    if (keywordIds.length) {
      requests.push(
        buildWorksUrl({
          query: "",
          sourceIds,
          yearFrom: apiYearFrom,
          yearTo: params.yearTo,
          sort: params.sort,
          page: requestPage,
          perPage: requestPerPage,
          mailto: params.mailto,
          articleOnly: true,
          keywordIds
        })
      );
    }

    const datasets = await Promise.all(requests.map(fetchWorks));
    const rawWorks = dedupeWorks(datasets.flatMap((data) => data.results || []));
    const rankedWorks = sortWorksForQuery(rawWorks.map(normalizeWork), params.query, params.sort);
    const displayWorks = useRankedCandidatePool
      ? rankedWorks.filter((work) => work.rankScore >= MIN_SMART_RELEVANCE_SCORE)
      : rankedWorks;
    const orderedWorks = useRankedCandidatePool ? orderByPublicationDateDesc(displayWorks) : displayWorks;
    state.total = useRankedCandidatePool ? displayWorks.length : estimateTotal(datasets, rawWorks.length);
    state.results = useRankedCandidatePool
      ? orderedWorks.slice((state.page - 1) * params.perPage, state.page * params.perPage)
      : orderedWorks.slice(0, params.perPage);

    renderResults(state.results);
    renderPagination();
    setStatus(statusMessage(state.results.length, skipped), state.results.length ? "success" : "empty");
    const resultLabel = useRankedCandidatePool
      ? "ranked candidates"
      : requests.length > 1
        ? "candidate records"
        : "results";
    elements.resultCount.textContent = `${state.total.toLocaleString()} ${resultLabel}`;
  } catch (error) {
    state.results = [];
    state.total = 0;
    renderResults([]);
    renderPagination();
    setStatus(error.message || "Search failed.", "error");
    elements.resultCount.textContent = "Search failed";
  } finally {
    setLoading(false);
  }
}

function readSearchParams() {
  return {
    query: elements.query.value.trim(),
    yearFrom: Number(elements.yearFrom.value),
    yearTo: Number(elements.yearTo.value),
    discipline: elements.discipline.value,
    journalId: elements.journal.value,
    sort: elements.sort.value,
    perPage: Number(elements.perPage.value),
    includeHistorical: elements.includeHistorical.checked,
    mailto: elements.mailto.value.trim()
  };
}

function validateParams(params) {
  const currentYear = new Date().getFullYear() + 1;

  if (!Number.isInteger(params.yearFrom) || !Number.isInteger(params.yearTo)) {
    return "Enter whole publication years.";
  }

  if (params.yearFrom < 1900 || params.yearTo > currentYear) {
    return `Use years between 1900 and ${currentYear}.`;
  }

  if (params.yearFrom > params.yearTo) {
    return "The start year must be earlier than or equal to the end year.";
  }

  return "";
}

function filteredJournalList() {
  return journalsForSearch({
    includeHistorical: elements.includeHistorical.checked,
    discipline: elements.discipline.value || "All disciplines"
  });
}

function selectedJournals(params) {
  const journals = journalsForSearch({
    includeHistorical: params.includeHistorical,
    discipline: params.discipline
  });

  if (params.journalId === "all") return journals;
  return journals.filter((journal) => journal.id === params.journalId);
}

async function ensureSourceIds(journals) {
  const known = [];
  const toResolve = [];

  for (const journal of journals) {
    const cached = state.sourceCache[journal.id];
    const sourceId = journal.sourceId || cached;
    if (sourceId) {
      known.push({ ...journal, sourceId });
    } else {
      toResolve.push(journal);
    }
  }

  updateSourceCoverage(known.length, journals.length);

  const resolved = await mapLimit(toResolve, SOURCE_CONCURRENCY, async (journal) => {
    const sourceId = await resolveJournalSourceId(journal);
    if (sourceId) {
      state.sourceCache[journal.id] = sourceId;
      writeSourceCache(state.sourceCache);
      updateSourceCoverage(known.length + Object.keys(state.sourceCache).length, FT50_JOURNALS.length);
      return { ...journal, sourceId };
    }
    return null;
  });

  const ready = [...known, ...resolved.filter(Boolean)];
  updateSourceCoverage(ready.length, journals.length);
  return ready;
}

function renderActiveFilters(params, journals, skipped) {
  const chips = [
    `${params.yearFrom}-${params.yearTo}`,
    params.sort === "latest"
      ? "Latest first"
      : params.sort === "citations"
        ? "Most cited"
        : "Smart relevance, newest first",
    params.discipline,
    journals.length === 1 ? journals[0].name : `${journals.length} journals`
  ];

  const expandedTerms = expandSearchTerms(params.query);
  const keywordIds = keywordIdsForQuery(params.query);
  const apiYearFrom = openAlexYearFrom(params);

  if (params.query) chips.unshift(params.query);
  if (apiYearFrom < params.yearFrom) chips.push(`${apiYearFrom} online-first buffer`);
  if (expandedTerms.length > 1) chips.push(`${expandedTerms.length} search variants`);
  if (keywordIds.length) chips.push("Keyword tags included");
  if (params.includeHistorical) chips.push("Historical FT50 included");
  if (skipped) chips.push(`${skipped} unresolved sources skipped`);

  elements.activeFilters.replaceChildren(
    ...chips.map((chip) => {
      const node = document.createElement("span");
      node.textContent = chip;
      return node;
    })
  );
}

function renderResults(results) {
  elements.results.replaceChildren();

  if (!results.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No papers matched this search.";
    elements.results.append(empty);
    updateExportButtons();
    return;
  }

  for (const result of results) {
    elements.results.append(renderResult(result));
  }

  updateExportButtons();
}

function renderResult(result) {
  const article = document.createElement("article");
  article.className = "result-card";

  const meta = document.createElement("div");
  meta.className = "result-meta";
  const metaPills = [
    pill(result.journal),
    pill(result.publicationDate || result.year || "Date unavailable"),
    pill(`${result.citedByCount.toLocaleString()} citations`),
    result.matchScore ? pill(`Match ${result.matchScore}`) : null,
    pill(result.isOpenAccess ? "Open access" : "Closed")
  ];
  meta.append(...metaPills.filter(Boolean));

  const title = document.createElement("h2");
  title.textContent = result.title;

  const authors = document.createElement("p");
  authors.className = "authors";
  authors.textContent = formatAuthors(result.authors);

  const abstract = document.createElement("p");
  abstract.className = "abstract";
  abstract.textContent = result.abstract ? truncate(result.abstract, 560) : "No abstract available in OpenAlex.";

  const topics = document.createElement("div");
  topics.className = "topics";
  const tagValues = unique([...(result.keywords || []), ...(result.topics || [])].filter(Boolean)).slice(0, 6);
  topics.replaceChildren(...tagValues.map(pill));

  const actions = document.createElement("div");
  actions.className = "result-actions";
  actions.append(linkButton("Open", result.landingUrl));

  if (result.doi) {
    actions.append(linkButton("DOI", `https://doi.org/${result.doi}`));
  }

  if (result.pdfUrl) {
    actions.append(linkButton("PDF", result.pdfUrl));
  }

  if (result.oaUrl && result.oaUrl !== result.pdfUrl && result.oaUrl !== result.landingUrl) {
    actions.append(linkButton("OA", result.oaUrl));
  }

  article.append(meta, title, authors, abstract);
  if (tagValues.length) article.append(topics);
  article.append(actions);
  return article;
}

function renderPagination() {
  const perPage = Number(elements.perPage.value);
  const maxPage = Math.max(1, Math.ceil(state.total / perPage));
  elements.prevPage.disabled = state.page <= 1;
  elements.nextPage.disabled = state.page >= maxPage || state.total === 0;
  elements.pageLabel.textContent = `Page ${state.page} of ${maxPage}`;
}

function openAlexYearFrom(params) {
  if (!params.query || params.yearFrom <= 1900) return params.yearFrom;
  return params.yearFrom - 1;
}

function shouldUseRankedCandidatePool(params) {
  return Boolean(params.query && params.sort === "relevance");
}

function orderByPublicationDateDesc(works) {
  return [...works].sort(
    (a, b) =>
      dateValue(b.publicationDate, b.year) - dateValue(a.publicationDate, a.year) ||
      (b.rankScore || 0) - (a.rankScore || 0) ||
      b.citedByCount - a.citedByCount
  );
}

async function fetchWorks(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`OpenAlex returned HTTP ${response.status}.`);
  }
  return response.json();
}

function dedupeWorks(works) {
  const seen = new Map();

  for (const work of works) {
    const key = work.id || work.doi || work.display_name;
    if (key && !seen.has(key)) {
      seen.set(key, work);
    }
  }

  return [...seen.values()];
}

function estimateTotal(datasets, fallback) {
  const total = datasets.reduce((sum, data) => sum + (data.meta?.count || 0), 0);
  return Math.max(total, fallback);
}

function dateValue(publicationDate, year) {
  return Date.parse(publicationDate || `${year || 0}-01-01`) || 0;
}

function setLoading(isLoading) {
  elements.form.querySelectorAll("button, input, select").forEach((control) => {
    if (control.id !== "exportCsv" && control.id !== "exportRis") {
      control.disabled = isLoading;
    }
  });

  elements.prevPage.disabled = isLoading || state.page <= 1;
  elements.nextPage.disabled = isLoading || state.total === 0;
  document.body.toggleAttribute("data-loading", isLoading);
}

function setStatus(message, tone = "neutral") {
  elements.status.textContent = message;
  elements.status.dataset.tone = tone;
}

function statusMessage(resultLength, skipped) {
  if (!resultLength && skipped) return `No papers found. ${skipped} source IDs could not be resolved.`;
  if (!resultLength) return "No papers found for these filters.";
  if (skipped) return `Showing ${resultLength} papers. ${skipped} source IDs could not be resolved.`;
  return `Showing ${resultLength} papers from OpenAlex.`;
}

function updateSourceCoverage(ready, total) {
  elements.sourceCoverage.textContent = `${Math.min(ready, total)}/${total} sources ready`;
}

function updateExportButtons() {
  const disabled = state.results.length === 0;
  elements.exportCsv.disabled = disabled;
  elements.exportRis.disabled = disabled;
}

function pill(text) {
  const span = document.createElement("span");
  span.className = "pill";
  span.textContent = text;
  return span;
}

function linkButton(label, href) {
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = label;
  return link;
}

function formatAuthors(authors) {
  if (!authors.length) return "Authors unavailable";
  if (authors.length <= 6) return authors.join(", ");
  return `${authors.slice(0, 6).join(", ")} and ${authors.length - 6} more`;
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trim()}...`;
}

function unique(values) {
  return [...new Set(values)];
}

async function mapLimit(items, limit, mapper) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function toCsv(results) {
  const header = [
    "title",
    "authors",
    "year",
    "publication_date",
    "journal",
    "keywords",
    "citations",
    "doi",
    "url",
    "oa_url",
    "abstract"
  ];
  const rows = results.map((result) => [
    result.title,
    result.authors.join("; "),
    result.year,
    result.publicationDate,
    result.journal,
    (result.keywords || []).join("; "),
    result.citedByCount,
    result.doi,
    result.landingUrl,
    result.oaUrl,
    result.abstract
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

function toRis(results) {
  return results
    .map((result) => {
      const lines = ["TY  - JOUR", `TI  - ${result.title}`];
      for (const author of result.authors) lines.push(`AU  - ${author}`);
      if (result.year) lines.push(`PY  - ${result.year}`);
      if (result.journal) lines.push(`JO  - ${result.journal}`);
      for (const keyword of result.keywords || []) lines.push(`KW  - ${keyword}`);
      if (result.doi) lines.push(`DO  - ${result.doi}`);
      if (result.landingUrl) lines.push(`UR  - ${result.landingUrl}`);
      if (result.oaUrl && result.oaUrl !== result.landingUrl) lines.push(`L2  - ${result.oaUrl}`);
      if (result.abstract) lines.push(`AB  - ${result.abstract}`);
      lines.push("ER  -");
      return lines.join("\n");
    })
    .join("\n\n");
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function readSourceCache() {
  try {
    return JSON.parse(localStorage.getItem(SOURCE_CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeSourceCache(cache) {
  localStorage.setItem(SOURCE_CACHE_KEY, JSON.stringify(cache));
}
