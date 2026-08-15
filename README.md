# FT50 Paper Search

A lightweight browser app for finding papers in Financial Times FT50 journals by keyword/topic, journal set, and publication-year range.

## Run

```bash
npm start
```

Then open `http://127.0.0.1:8000`.

## Publish On GitHub Pages

This repository includes a GitHub Actions workflow at `.github/workflows/pages.yml`.
After the project is pushed to GitHub, enable GitHub Pages with **Source: GitHub Actions**.
Every push to `main` deploys the static site.

## What It Searches

- Current FT50 list from the Financial Times update published on April 29, 2026.
- Optional historical 2016 FT50 journals removed in the 2026 update: Human Relations, Journal of Business Ethics, and Organization Studies.
- Live scholarly metadata from OpenAlex.

## Notes

- The app filters OpenAlex works by FT50 journal source IDs. Where a source ID is not hard-coded, it resolves the journal through OpenAlex Sources using the journal ISSN and caches the result in the browser.
- Date filtering uses publication year, so a search for 2019-2025 includes papers whose OpenAlex `publication_year` falls in that range.
- Results depend on OpenAlex metadata coverage and update timing.

## Sources

- Financial Times FT50 journal list: https://www.ft.com/ft50-journals
- OpenAlex API documentation: https://developers.openalex.org/api-reference/works
