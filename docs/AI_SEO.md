# AI SEO suggestions (Claude) and Fix All

## Connecting Claude

Settings → Integrations → **Claude AI (Anthropic)** (needs `integrations.manage`, i.e. Super Admin):

1. Paste an Anthropic API key (console.anthropic.com → API keys) and choose **Test key and load models**.
2. Pick a model and choose **Connect**. The key is checked with Anthropic first; then it is stored **encrypted**
   (AES-256-GCM) on the server and never shown again — not in the browser, API responses, logs, audit entries or exports.
3. **Test connection**, **Use this model**, **Replace key** and **Disconnect** are on the same card.

No server environment variable has to be added: the encryption key is derived from `SESSION_SECRET`, which every
production server already has (or from `CREDENTIALS_ENCRYPTION_KEY` when set). Two infrastructure facts apply:

- **`SESSION_SECRET` must stay the same.** Changing it makes the saved key unreadable; the card then says so and the key
  must be entered again.
- **A database is needed to keep the key across restarts.** With `DATABASE_URL` (PostgreSQL) the encrypted key is stored
  and survives restarts and redeploys. Without it, the key is kept in memory until the next restart (the card warns).

One connection serves every website. Requests are limited to a few at a time across the server; rate limits (429) and
overload (529) are retried with backoff, honouring `retry-after`.

## What Claude writes

For each product, collection, page or article, only the fields that **need work** are sent: missing, too short or
long, duplicated, keyword-stuffed, all capitals, unclear. Good values are kept ("Already good — keep it").

| Field | Target | Notes |
|---|---|---|
| SEO title (title tag) | 50–60 characters (simple pages 30–60) | A suffix the theme appends (" – Shop") counts in the length and is not written again |
| Meta description | 140–160 characters (simple pages 120–160) | Complete sentences; different from the title |
| Title (name on the page) | 20–70 (collections and simple pages 3–40) | Always offered for review (product names matter) |
| Description | products 400–1500, collections 150–800 characters of text | Products and collections only; safe HTML (p, ul/li, h2/h3 — no H1, links, scripts); a replaced description is always reviewed first |
| H1 | as the title | When the H1 is the title, the title suggestion applies |
| Image alt text | concise, at most 125 | The image is sent to Claude so it can describe what it shows; never padded |
| Tags | 3–15 in total | Only new tags are added; existing tags are never removed (automated collections may use them) |

The prompt carries the resource's own content (title, description text, tags, images) and the store keywords present in
the current values. Every answer is checked before it is offered: length against the target, figures not in the
content, dropped store keywords, sameness with values other pages use, HTML safety. A value that misses gets one retry
with the exact problem; if it still misses, it is offered **for review** (not pre-selected) with the reason. Without
Claude (or when a request fails), the rule-based suggestions — built only from the page's existing text — are used and
the editor / Fix All says why.

## Fix All

Fix All (All pages, the SEO Optimization lists, the Issues board for issue-scoped fixes) now covers **every field**:
SEO title, meta description, title, description, H1, image alt text, tags and broken internal links.

- Crawl pages are judged for what the storefront shows; **titles, descriptions and tags are judged from the Shopify
  catalog** (products, collections, pages — 50 per request, up to 5,000 per kind), so products the crawl did not reach
  are included. Duplicate titles and descriptions across the catalog are found and get unique suggestions.
- Before anything is written: pages to fix, changes selected, changes to review, and the affected **fields per type and
  pages** are shown; pages and single changes can be excluded.
- Applying writes in batches of 10, reads every value back and checks the storefront page; only verified values count
  as fixed. Failures and conflicts are reported per change; nothing failed or unverified is marked fixed.
- If Claude rejects the key, AI is switched off for the rest of that fix (rule-based suggestions continue). After
  repeated rate-limit failures the remaining pages use rule-based suggestions and the dialog says to run it again later.

Code: `apps/api/src/ai/` (client, connection service, writer), `apps/api/src/shopify/aiDraft.ts`, `apps/api/src/shopify/bulk.ts`.
Tests: `apps/api/test/ai/claude-seo.test.ts` (mock Anthropic API; no network).
