import { buildSearchExpression } from "./search.js?v=20260815-newest-first";

const OPENALEX_BASE_URL = "https://api.openalex.org";

const WORK_SELECT_FIELDS = [
  "id",
  "doi",
  "display_name",
  "title",
  "publication_year",
  "publication_date",
  "cited_by_count",
  "authorships",
  "primary_location",
  "open_access",
  "abstract_inverted_index",
  "keywords",
  "topics",
  "concepts",
  "relevance_score",
  "type"
];

export function normalizeForMatch(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\bthe\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function stripOpenAlexId(id) {
  if (!id) return "";
  return String(id).replace("https://openalex.org/", "");
}

export function buildSourceLookupUrls(journal) {
  const urls = [];

  if (journal.issn) {
    const issnUrl = new URL(`${OPENALEX_BASE_URL}/sources`);
    issnUrl.searchParams.set("filter", `issn:${journal.issn}`);
    issnUrl.searchParams.set("per-page", "5");
    issnUrl.searchParams.set("select", "id,display_name,issn_l,issn,works_count,type");
    urls.push(issnUrl.toString());
  }

  const searchUrl = new URL(`${OPENALEX_BASE_URL}/sources`);
  searchUrl.searchParams.set("search", journal.name);
  searchUrl.searchParams.set("per-page", "5");
  searchUrl.searchParams.set("select", "id,display_name,issn_l,issn,works_count,type");
  urls.push(searchUrl.toString());

  return urls;
}

export function pickBestSource(journal, sources = []) {
  if (!sources.length) return null;

  const allowedNames = [journal.name, ...(journal.aliases || [])].map(normalizeForMatch);
  const normalizedIssn = normalizeIssn(journal.issn);

  const exactByIssn = sources.find((source) => {
    const issns = [source.issn_l, ...(source.issn || [])].map(normalizeIssn);
    return normalizedIssn && issns.includes(normalizedIssn);
  });
  if (exactByIssn) return exactByIssn;

  const exactByName = sources.find((source) =>
    allowedNames.includes(normalizeForMatch(source.display_name))
  );
  if (exactByName) return exactByName;

  const journalSources = sources.filter((source) => source.type === "journal");
  return journalSources.sort((a, b) => (b.works_count || 0) - (a.works_count || 0))[0] || sources[0];
}

export async function resolveJournalSourceId(journal, fetchImpl = fetch) {
  if (journal.sourceId) return journal.sourceId;

  for (const url of buildSourceLookupUrls(journal)) {
    const response = await fetchImpl(url);
    if (!response.ok) continue;

    const data = await response.json();
    const best = pickBestSource(journal, data.results || []);
    const sourceId = stripOpenAlexId(best?.id);
    if (sourceId) return sourceId;
  }

  return "";
}

export function buildWorksUrl({
  query = "",
  sourceIds = [],
  yearFrom,
  yearTo,
  sort = "latest",
  page = 1,
  perPage = 25,
  mailto = "",
  articleOnly = true,
  keywordIds = []
}) {
  const url = new URL(`${OPENALEX_BASE_URL}/works`);
  const filters = [];

  if (sourceIds.length) {
    filters.push(`primary_location.source.id:${sourceIds.join("|")}`);
  }

  if (yearFrom && yearTo) {
    filters.push(`publication_year:${yearFrom}-${yearTo}`);
  }

  if (articleOnly) {
    filters.push("type:types/article");
  }

  if (keywordIds.length) {
    filters.push(`keywords.id:${keywordIds.map(normalizeKeywordId).join("|")}`);
  }

  if (filters.length) {
    url.searchParams.set("filter", filters.join(","));
  }

  if (query.trim()) {
    url.searchParams.set("search", buildSearchExpression(query));
  }

  if (sort === "latest" || (sort === "relevance" && !query.trim())) {
    url.searchParams.set("sort", "publication_date:desc");
  }

  if (sort === "citations") {
    url.searchParams.set("sort", "cited_by_count:desc");
  }

  if (mailto.trim()) {
    url.searchParams.set("mailto", mailto.trim());
  }

  url.searchParams.set("page", String(page));
  url.searchParams.set("per-page", String(perPage));
  url.searchParams.set("select", WORK_SELECT_FIELDS.join(","));

  return url.toString();
}

export function abstractFromInvertedIndex(index) {
  if (!index || typeof index !== "object") return "";

  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) {
      words[position] = word;
    }
  }

  return words.filter(Boolean).join(" ");
}

export function normalizeWork(work) {
  const primaryLocation = work.primary_location || {};
  const source = primaryLocation.source || {};
  const authors = (work.authorships || [])
    .map((authorship) => authorship.author?.display_name)
    .filter(Boolean);
  const topics = (work.topics || work.concepts || [])
    .map((topic) => topic.display_name)
    .filter(Boolean)
    .slice(0, 4);
  const keywords = (work.keywords || [])
    .map((keyword) => keyword.display_name)
    .filter(Boolean)
    .slice(0, 5);
  const doi = work.doi ? work.doi.replace("https://doi.org/", "") : "";
  const landingUrl = primaryLocation.landing_page_url || work.doi || work.id;
  const pdfUrl = primaryLocation.pdf_url || "";
  const oaUrl = work.open_access?.oa_url || "";

  return {
    id: work.id,
    title: work.display_name || work.title || "Untitled work",
    authors,
    year: work.publication_year || "",
    publicationDate: work.publication_date || "",
    citedByCount: work.cited_by_count || 0,
    journal: source.display_name || "Unknown source",
    sourceId: stripOpenAlexId(source.id),
    doi,
    landingUrl,
    pdfUrl,
    oaUrl,
    isOpenAccess: Boolean(work.open_access?.is_oa),
    abstract: abstractFromInvertedIndex(work.abstract_inverted_index),
    keywords,
    relevanceScore: Number(work.relevance_score || 0),
    topics
  };
}

function normalizeIssn(issn) {
  return String(issn || "").replace(/[^0-9X]/gi, "").toUpperCase();
}

function normalizeKeywordId(keywordId) {
  return String(keywordId || "")
    .replace("https://openalex.org/keywords/", "")
    .replace(/^keywords\//, "")
    .trim();
}
