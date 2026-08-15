import test from "node:test";
import assert from "node:assert/strict";
import { FT50_JOURNALS, JOURNAL_GROUPS, journalsForSearch } from "../src/ft50.js";
import {
  abstractFromInvertedIndex,
  buildSourceLookupUrls,
  buildWorksUrl,
  normalizeWork,
  pickBestSource
} from "../src/openalex.js";
import {
  buildSearchExpression,
  expandSearchTerms,
  keywordIdsForQuery,
  scoreWorkForQuery,
  sortWorksForQuery
} from "../src/search.js";

test("current FT50 list has exactly 50 journals", () => {
  assert.equal(journalsForSearch().length, 50);
});

test("historical option adds the three journals removed in 2026", () => {
  const journals = journalsForSearch({ includeHistorical: true });
  assert.equal(journals.length, 53);
  assert.ok(journals.some((journal) => journal.name === "Journal of Business Ethics"));
});

test("discipline filters include the requested FT50 business fields", () => {
  const expectedGroups = [
    "Accounting",
    "Finance",
    "Economics",
    "Management",
    "Marketing",
    "Strategy",
    "Operations Management",
    "Information Systems",
    "Entrepreneurship",
    "Organizational Behaviour / Human Resources",
    "International Business"
  ];

  for (const group of expectedGroups) {
    assert.ok(JOURNAL_GROUPS.includes(group), `${group} is missing from discipline filters`);
    assert.ok(journalsForSearch({ discipline: group }).length > 0, `${group} has no journals`);
  }
});

test("search data includes the user's named FT50 accounting, finance, management, marketing, and economics journals", () => {
  const expectedNames = [
    "The Accounting Review",
    "Accounting, Organizations and Society",
    "Contemporary Accounting Research",
    "Journal of Accounting and Economics",
    "Journal of Accounting Research",
    "Review of Accounting Studies",
    "Journal of Finance",
    "Journal of Financial Economics",
    "Review of Financial Studies",
    "Journal of Financial and Quantitative Analysis",
    "Review of Finance",
    "Academy of Management Journal",
    "Academy of Management Review",
    "Administrative Science Quarterly",
    "Strategic Management Journal",
    "Journal of Management Studies",
    "Organization Science",
    "Management Science",
    "Journal of Marketing",
    "Journal of Marketing Research",
    "Journal of Consumer Research",
    "Journal of Consumer Psychology",
    "Journal of the Academy of Marketing Science",
    "American Economic Review",
    "Econometrica",
    "Quarterly Journal of Economics",
    "Journal of Political Economy",
    "Review of Economic Studies"
  ];
  const searchableNames = new Set(
    journalsForSearch({ includeHistorical: true }).flatMap((journal) => [
      journal.name,
      ...(journal.aliases || [])
    ])
  );

  for (const name of expectedNames) {
    assert.ok(searchableNames.has(name), `${name} is missing from the FT50 search data`);
  }
});

test("works URL scopes searches to OpenAlex source IDs and publication years", () => {
  const url = new URL(
    buildWorksUrl({
      query: "supply chain resilience",
      sourceIds: ["S33323087", "S125775545"],
      yearFrom: 2019,
      yearTo: 2025,
      sort: "latest",
      page: 2,
      perPage: 25,
      mailto: "researcher@example.edu"
    })
  );

  assert.equal(url.origin + url.pathname, "https://api.openalex.org/works");
  assert.equal(url.searchParams.get("search"), "supply chain resilience");
  assert.equal(
    url.searchParams.get("filter"),
    "primary_location.source.id:S33323087|S125775545,publication_year:2019-2025,type:types/article"
  );
  assert.equal(url.searchParams.get("sort"), "publication_date:desc");
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.get("per-page"), "25");
  assert.equal(url.searchParams.get("mailto"), "researcher@example.edu");
});

test("search expansion maps IRO to investor relations variants", () => {
  const terms = expandSearchTerms("IRO");
  const expression = buildSearchExpression("IRO");

  assert.ok(terms.includes("investor relations"));
  assert.ok(terms.includes("investor relations officer"));
  assert.ok(expression.includes(" OR "));
  assert.ok(expression.includes('"investor relations"'));
  assert.ok(keywordIdsForQuery("investor relation").includes("investor-relations"));
});

test("works URL sends expanded search expressions and keyword filters", () => {
  const expandedUrl = new URL(
    buildWorksUrl({
      query: "IRO",
      sourceIds: ["S160506855"],
      yearFrom: 2019,
      yearTo: 2025,
      sort: "relevance"
    })
  );
  const keywordUrl = new URL(
    buildWorksUrl({
      sourceIds: ["S160506855"],
      keywordIds: ["investor-relations"],
      yearFrom: 2019,
      yearTo: 2025
    })
  );

  assert.ok(expandedUrl.searchParams.get("search").includes('"investor relations"'));
  assert.ok(keywordUrl.searchParams.get("filter").includes("keywords.id:investor-relations"));
});

test("relevance sort falls back to latest when no query is supplied", () => {
  const url = new URL(
    buildWorksUrl({
      sourceIds: ["S23254222"],
      yearFrom: 2024,
      yearTo: 2025,
      sort: "relevance"
    })
  );

  assert.equal(url.searchParams.get("sort"), "publication_date:desc");
});

test("abstract reconstruction follows inverted-index positions", () => {
  const abstract = abstractFromInvertedIndex({
    resilience: [3],
    supply: [0],
    chains: [1],
    matter: [2]
  });

  assert.equal(abstract, "supply chains matter resilience");
});

test("source lookup prefers exact ISSN matches", () => {
  const journal = FT50_JOURNALS.find((item) => item.id === "accounting-review");
  const source = pickBestSource(journal, [
    {
      id: "https://openalex.org/S1",
      display_name: "Accounting Review Quarterly",
      issn: ["1111-1111"],
      works_count: 1000,
      type: "journal"
    },
    {
      id: "https://openalex.org/S160506855",
      display_name: "The Accounting Review",
      issn_l: "0001-4826",
      issn: ["0001-4826"],
      works_count: 100,
      type: "journal"
    }
  ]);

  assert.equal(source.id, "https://openalex.org/S160506855");
});

test("source lookup URLs include ISSN and name fallback", () => {
  const urls = buildSourceLookupUrls({
    name: "Research Policy",
    issn: "0048-7333"
  });

  assert.equal(urls.length, 2);
  assert.ok(new URL(urls[0]).searchParams.get("filter").includes("issn:0048-7333"));
  assert.equal(new URL(urls[1]).searchParams.get("search"), "Research Policy");
});

test("work normalization extracts authors, source, DOI, and abstract", () => {
  const result = normalizeWork({
    id: "https://openalex.org/W1",
    doi: "https://doi.org/10.1234/example",
    display_name: "A Useful Paper",
    publication_year: 2025,
    publication_date: "2025-03-01",
    cited_by_count: 12,
    primary_location: {
      landing_page_url: "https://example.com/paper",
      pdf_url: "https://example.com/paper.pdf",
      source: {
        id: "https://openalex.org/S23254222",
        display_name: "American Economic Review"
      }
    },
    open_access: {
      is_oa: true,
      oa_url: "https://example.com/oa"
    },
    authorships: [
      { author: { display_name: "Ada Lovelace" } },
      { author: { display_name: "Grace Hopper" } }
    ],
    abstract_inverted_index: {
      Good: [0],
      metadata: [1]
    },
    keywords: [{ display_name: "Investor Relations" }],
    relevance_score: 4.25,
    topics: [{ display_name: "Innovation" }]
  });

  assert.equal(result.title, "A Useful Paper");
  assert.equal(result.journal, "American Economic Review");
  assert.equal(result.doi, "10.1234/example");
  assert.equal(result.abstract, "Good metadata");
  assert.equal(result.pdfUrl, "https://example.com/paper.pdf");
  assert.equal(result.oaUrl, "https://example.com/oa");
  assert.deepEqual(result.authors, ["Ada Lovelace", "Grace Hopper"]);
  assert.deepEqual(result.keywords, ["Investor Relations"]);
  assert.equal(result.relevanceScore, 4.25);
  assert.deepEqual(result.topics, ["Innovation"]);
});

test("smart relevance scores matches while preserving publication-date order", () => {
  const ranked = sortWorksForQuery(
    [
      {
        title: "A Highly Cited Unrelated Paper",
        keywords: [],
        topics: ["Asset Pricing"],
        abstract: "This paper studies portfolio choice.",
        publicationDate: "2025-01-01",
        citedByCount: 500
      },
      {
        title: "Investor Relations and Corporate Disclosure",
        keywords: ["Investor Relations"],
        topics: ["Corporate Disclosure"],
        abstract: "The investor relations officer communicates with investors.",
        publicationDate: "2021-01-01",
        citedByCount: 5
      }
    ],
    "IRO",
    "relevance"
  );

  assert.equal(ranked[0].title, "A Highly Cited Unrelated Paper");
  assert.ok(ranked[1].matchScore > ranked[0].matchScore);
});

test("short acronym matching does not score substrings inside unrelated words", () => {
  const score = scoreWorkForQuery(
    {
      title: "EPA scrutiny and voluntary environmental disclosures",
      keywords: ["Environmental disclosure"],
      topics: ["Corporate disclosure"],
      abstract: "The paper studies environmental reporting.",
      publicationDate: "2025-01-01"
    },
    "IRO"
  );

  assert.equal(score, 0);
});

test("latest and smart relevance use raw rank score as a publication-date tie-breaker", () => {
  const ranked = sortWorksForQuery(
    [
      {
        title: "Investor Relations",
        keywords: [],
        topics: [],
        abstract: "",
        publicationDate: "2018-07-01",
        citedByCount: 1
      },
      {
        title: "Investor Relations and Information Assimilation",
        keywords: ["Investor relations", "Officer"],
        topics: ["Auditing, Earnings Management, Governance"],
        abstract: "Investor relations officers facilitate information assimilation by the market.",
        publicationDate: "2018-07-01",
        citedByCount: 280
      }
    ],
    "IRO",
    "relevance"
  );

  assert.equal(ranked[0].title, "Investor Relations and Information Assimilation");
  assert.ok(ranked[0].rankScore > ranked[0].matchScore);
  assert.equal(ranked[0].matchScore, 100);
});
