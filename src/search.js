const SEARCH_EXPANSIONS = [
  {
    matchers: [
      "iro",
      "i r o",
      "investor relation",
      "investor relations",
      "investor relation officer",
      "investor relations officer",
      "investor relations officers"
    ],
    terms: [
      "IRO",
      "investor relation",
      "investor relations",
      "investor relation officer",
      "investor relations officer",
      "investor relations officers",
      "investor relations function",
      "investor relations department"
    ],
    keywordIds: ["investor-relations"]
  }
];

const MAX_SEARCH_TERMS = 12;
const MAX_KEYWORD_IDS = 8;

export function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function expandSearchTerms(query) {
  const cleanQuery = collapseSpaces(query);
  if (!cleanQuery) return [];

  const terms = [cleanQuery];
  const normalizedQuery = normalizeSearchText(cleanQuery);

  for (const expansion of SEARCH_EXPANSIONS) {
    if (matchesExpansion(normalizedQuery, expansion.matchers)) {
      terms.push(...expansion.terms);
    }
  }

  return uniqueByNormalized(terms).slice(0, MAX_SEARCH_TERMS);
}

export function buildSearchExpression(query) {
  const terms = expandSearchTerms(query);
  if (terms.length <= 1) return terms[0] || "";
  return terms.map(formatSearchTerm).join(" OR ");
}

export function keywordIdsForQuery(query) {
  const cleanQuery = collapseSpaces(query);
  if (!cleanQuery) return [];

  const ids = [];
  const normalizedQuery = normalizeSearchText(cleanQuery);

  for (const expansion of SEARCH_EXPANSIONS) {
    if (matchesExpansion(normalizedQuery, expansion.matchers)) {
      ids.push(...expansion.keywordIds);
    }
  }

  const phraseCandidates = [
    cleanQuery,
    ...cleanQuery.split(/[,;|]/g),
    ...expandSearchTerms(cleanQuery)
  ];

  for (const phrase of phraseCandidates) {
    const slug = keywordSlug(phrase);
    if (slug && slug.includes("-")) ids.push(slug);
  }

  return uniqueByNormalized(ids).slice(0, MAX_KEYWORD_IDS);
}

export function scoreWorkForQuery(work, query) {
  const terms = expandSearchTerms(query).map(normalizeSearchText).filter(Boolean);
  if (!terms.length) return 0;

  const fields = [
    { value: work.title, weight: 38 },
    { value: (work.keywords || []).join(" "), weight: 34 },
    { value: (work.topics || []).join(" "), weight: 20 },
    { value: work.abstract, weight: 14 },
    { value: work.journal, weight: 4 }
  ];

  let score = Math.min(10, Math.log1p(Number(work.relevanceScore || 0)) * 3);

  for (const field of fields) {
    const text = normalizeSearchText(field.value);
    if (!text) continue;

    for (const term of terms) {
      const tokens = term.split(" ").filter(Boolean);
      if (text.includes(term)) {
        score += field.weight + Math.min(10, term.length / 3);
      } else if (tokens.length > 1 && tokens.every((token) => text.includes(token))) {
        score += field.weight * 0.45;
      }
    }
  }

  return Math.max(0, Math.round(score));
}

export function sortWorksForQuery(works, query, sort = "relevance") {
  const hasQuery = Boolean(collapseSpaces(query));
  const scored = works.map((work) => {
    const rankScore = hasQuery ? scoreWorkForQuery(work, query) : 0;
    return {
      ...work,
      rankScore,
      matchScore: hasQuery ? Math.min(100, rankScore) : 0
    };
  });

  if (sort === "citations") {
    return scored.sort(compareByCitationsThenScore);
  }

  if (sort === "latest") {
    return scored.sort(compareByDateThenScore);
  }

  return scored.sort(compareByScoreThenDate);
}

function formatSearchTerm(term) {
  const cleanTerm = collapseSpaces(term);
  if (!cleanTerm) return "";
  if (/\s/.test(cleanTerm)) return `"${cleanTerm.replace(/"/g, "")}"`;
  return cleanTerm;
}

function matchesExpansion(normalizedQuery, matchers) {
  const paddedQuery = ` ${normalizedQuery} `;
  return matchers.some((matcher) => {
    const normalizedMatcher = normalizeSearchText(matcher);
    return normalizedQuery === normalizedMatcher || paddedQuery.includes(` ${normalizedMatcher} `);
  });
}

function keywordSlug(value) {
  return normalizeSearchText(value)
    .split(" ")
    .filter((part) => part.length > 1)
    .join("-");
}

function compareByScoreThenDate(a, b) {
  return (
    scoreValue(b) - scoreValue(a) ||
    dateValue(b.publicationDate, b.year) - dateValue(a.publicationDate, a.year) ||
    b.citedByCount - a.citedByCount
  );
}

function compareByDateThenScore(a, b) {
  return (
    dateValue(b.publicationDate, b.year) - dateValue(a.publicationDate, a.year) ||
    scoreValue(b) - scoreValue(a) ||
    b.citedByCount - a.citedByCount
  );
}

function compareByCitationsThenScore(a, b) {
  return (
    b.citedByCount - a.citedByCount ||
    scoreValue(b) - scoreValue(a) ||
    dateValue(b.publicationDate, b.year) - dateValue(a.publicationDate, a.year)
  );
}

function scoreValue(work) {
  return Number(work.rankScore ?? work.matchScore ?? 0);
}

function dateValue(publicationDate, year) {
  return Date.parse(publicationDate || `${year || 0}-01-01`) || 0;
}

function collapseSpaces(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function uniqueByNormalized(values) {
  const seen = new Set();
  const unique = [];

  for (const value of values) {
    const cleanValue = collapseSpaces(value);
    const key = normalizeSearchText(cleanValue);
    if (!cleanValue || seen.has(key)) continue;
    seen.add(key);
    unique.push(cleanValue);
  }

  return unique;
}
