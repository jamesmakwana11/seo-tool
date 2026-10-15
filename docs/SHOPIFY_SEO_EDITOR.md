# Shopify connection and SEO editor

The SEO editor turns audit findings into changes in Shopify: SEO titles, meta descriptions, product / collection /
page / article titles, descriptions and content (H2–H3 headings, internal links), tags and product image alt text.
Theme-level problems (an H1 written by a section, a canonical tag in `layout/theme.liquid`) are prepared as theme
file proposals and written only to an **unpublished** theme.

Nothing is written to Shopify until a person reviews the exact changes and types the confirmation phrase.

## 1. Create the Shopify app (once)

Use the Shopify **Dev Dashboard** (or a Partner app) for the store:

1. Create an app. Under **Configuration / URLs**:
   - App URL: the Sentinel address, e.g. `https://<service>.onrender.com`
   - Allowed redirection URL: `https://<service>.onrender.com/api/shopify/oauth/callback`
     (Settings → Shopify in Sentinel shows the exact value).
2. Access scopes:

   | Scope | Why |
   | --- | --- |
   | `read_products`, `write_products` | Read and change products and collections (`productUpdate`, `collectionUpdate`) |
   | `read_content`, `write_content` | Read and change pages and blog articles (`pageUpdate`, `articleUpdate`, SEO metafields via `metafieldsSet`) |
   | `read_themes` (optional) | List themes and read theme files to see where an H1 comes from |
   | `write_themes` (optional) | Write a reviewed file to an **unpublished** theme (`themeFilesUpsert`). Sentinel never calls `themePublish` |
   | `write_files` (optional) | Change image alt text (`fileUpdate`; `write_themes` also allows it) |

   A `write_*` scope includes its `read_*` scope.
3. Copy the app's **Client ID** and **Client secret**.

## 2. Configure the server

Set on the API server (Render → Environment; locally in `apps/api/.env`):

| Variable | Value |
| --- | --- |
| `SHOPIFY_API_KEY` | the app's Client ID |
| `SHOPIFY_API_SECRET` | the app's Client secret (secret) |
| `APP_BASE_URL` | the public HTTPS address of Sentinel (or `SHOPIFY_APP_URL` if the OAuth redirect must use another address) |
| `SHOPIFY_SCOPES` | optional; default is all scopes in the table above |
| `SHOPIFY_API_VERSION` | optional; default `2026-07` |

Alternative for the primary website: a custom-app token in `SHOPIFY_STORE_DOMAIN` (`deodap.myshopify.com`) and
`SHOPIFY_ADMIN_TOKEN`. Sentinel reads the token's granted scopes and reports missing ones.

## 3. Connect

Settings → **Shopify** → enter `your-store.myshopify.com` → **Connect with Shopify** → approve in Shopify. Only roles
with `integrations.manage` (Admin) can connect or disconnect.

What the server checks on the way back (`GET /api/shopify/oauth/callback`):

- the `hmac` of the query (HMAC-SHA256 with the client secret, constant-time compare);
- the `state` is one this server issued, unused, at most 10 minutes old, for the same shop;
- the shop is a `*.myshopify.com` host and the callback timestamp is recent;
- the code is exchanged at `https://{shop}/admin/oauth/access_token`, and all required scopes were granted.

Any failure redirects back to Settings → Shopify with the reason; nothing is stored.

### Where the token lives — and restarts

The access token is kept **only in the API server's memory**. It is never sent to the browser, never written to disk,
never logged, never included in exports or the project ZIP, and never passed to the crawler or Lighthouse processes.
Because there is no database, **a restart or redeploy forgets the OAuth token**: connect again afterwards (one
click), or use `SHOPIFY_ADMIN_TOKEN`, which is read from the environment at every start. **Disconnect** drops the
token from memory; to revoke it, uninstall the app in the Shopify admin.

## 4. Use the SEO editor

**SEO operations → SEO editor** (permission `shopify.edit`; Admin and SEO Specialist by default).

1. Open a page: paste a URL (or use **Fix in SEO editor** in a crawl's page details), or browse products /
   collections / pages / articles. The URL is matched to the Shopify resource by handle (collection-scoped product
   URLs and locale prefixes included).
2. The draft shows, per field: the value **now in Shopify**, the **proposed** value, **why** it is proposed, the
   **validation** result, and **how it is applied** (the mutation, or “Theme edit”).
   Suggestions only reuse text that is already there (title, description, shop name): a missing meta description is
   taken from the first sentences of the description, an over-long SEO title is shortened at a word boundary, an
   `<h1>` inside a description is demoted to `<h2>` when the theme already prints the title as H1, duplicate tags are
   removed, an image without alt text gets the product title. Titles are never reworded automatically.
3. Edit any proposed value by hand. Validation flags lengths, HTML in plain-text fields, `<script>`/event handlers/
   `javascript:` links (refused), heading-level skips, extra H1s, internal links over `http://` or to
   collection-scoped product URLs, and **figures (numbers, sizes, quantities) that appear nowhere in the current
   content** — check those before applying.
4. **Where the H1 comes from:** from the newest crawl's H1s — equal to the title (change the title field), inside the
   description (edit it here), or anything else (the theme writes it: theme proposal).
5. **Review and apply** (one draft or a batch of up to 50): Sentinel reads every value from Shopify again, lists
   exactly what will change, marks fields changed in Shopify since the draft as **conflicts** (never written), offers
   **Download original values** (JSON), and asks you to type `APPLY <n> CHANGES`.
6. Applying runs one resource after another. Shopify's rate limits are respected (cost-based throttling, 429
   `Retry-After`, 5xx retries). A failed field does not stop the batch; each field ends as *verified*, *written but
   not verified*, *failed*, *conflict* or *skipped*.
7. **Verification:** every written field is read back from the Admin API. Then the storefront page is fetched again
   (when live crawling is allowed) and the title tag, meta description, H1 and image alt are compared. Shopify's
   storefront cache can lag — **Check storefront again** repeats the check.

## 5. Theme changes

**SEO editor → Theme changes** (permission `shopify.theme`; Admin and Developer by default).

1. Duplicate the live theme in Shopify (Online Store → Themes → Duplicate).
2. Choose the copy, open a file under `layout/`, `templates/`, `sections/` or `snippets/`, edit it, say why.
3. **Create proposal**: a line diff; the original file is kept and downloadable. Nothing is written.
4. **Write to <theme>**: type `APPLY TO <theme name>`. Refused for the live (MAIN) theme. If the file changed in
   Shopify since the proposal (checksum), nothing is written (conflict). The written file is read back to verify.
5. Preview the theme in Shopify and publish it yourself.

## Limitations

- Drafts, proposals and the OAuth token live in memory: a restart discards them (no database at this stage).
- Clearing an existing SEO title / meta description is not offered (Shopify then falls back to the title /
  description); do that in the Shopify admin.
- Image alt text is edited for product media (first 20 images). Images inside description HTML are edited in the
  description; images placed by the theme need a theme edit.
- Article excerpts and page/article bodies are edited as HTML (no visual editor).
- The H1 source needs crawl data for the page; without it the editor says so.
- Development and tests use a mocked Shopify only (`apps/api/test/shopify/`): no real store was read or written.
