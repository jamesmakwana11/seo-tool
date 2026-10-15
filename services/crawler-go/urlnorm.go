package main

import (
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// URL handling shared by discovery, deduplication and reporting.
//
// Identity: scheme and host are lower-cased, the default port and the #fragment are removed, an empty path becomes "/",
// and tracking parameters (utm_*, gclid, fbclid, …) are removed because they never change the page. Every other query
// parameter is KEPT — some change the page (pagination, ids) — and classified so discovery can decide what to follow.

var badScheme = regexp.MustCompile(`(?i)^(javascript|mailto|tel|data|sms|whatsapp):`)

// resolveURL resolves href against base like the browser URL parser; ok=false for non-http(s) or unparsable links.
func resolveURL(href, base string) (string, bool) {
	h := strings.TrimSpace(href)
	h = strings.Map(func(r rune) rune {
		if r == '\t' || r == '\n' || r == '\r' {
			return -1
		}
		return r
	}, h)
	if h == "" || strings.HasPrefix(h, "#") || badScheme.MatchString(h) {
		return "", false
	}
	h = strings.ReplaceAll(h, "\\", "/")
	b, err := url.Parse(base)
	if err != nil {
		return "", false
	}
	r, err := url.Parse(h)
	if err != nil {
		return "", false
	}
	u := b.ResolveReference(r)
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", false
	}
	if u.Host == "" {
		return "", false
	}
	return canonicalString(u), true
}

// canonicalString renders u like the WHATWG serializer: lower-case scheme/host, no default port, no fragment, "/" path.
func canonicalString(u *url.URL) string {
	c := *u
	c.Scheme = strings.ToLower(c.Scheme)
	host := strings.ToLower(c.Host)
	if (c.Scheme == "https" && strings.HasSuffix(host, ":443")) || (c.Scheme == "http" && strings.HasSuffix(host, ":80")) {
		host = host[:strings.LastIndex(host, ":")]
	}
	c.Host = host
	c.Fragment = ""
	c.RawFragment = ""
	if c.Path == "" {
		c.Path = "/"
		c.RawPath = ""
	}
	c.User = nil
	return c.String()
}

// trackingParam reports query keys that only track visits and never change the page.
func trackingParam(k string) bool {
	k = strings.ToLower(k)
	if strings.HasPrefix(k, "utm_") {
		return true
	}
	switch k {
	case "gclid", "gbraid", "wbraid", "fbclid", "msclkid", "mc_cid", "mc_eid", "_ga", "_gl", "srsltid", "_pos", "_sid", "_ss", "_psq", "igshid", "yclid", "dclid":
		return true
	}
	return false
}

// normalizeKey is the identity used for deduplication (tracking parameters removed, other parameters kept in order).
func normalizeKey(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	if u.RawQuery != "" {
		parts := strings.Split(u.RawQuery, "&")
		kept := parts[:0]
		for _, p := range parts {
			if p == "" {
				continue
			}
			k := p
			if i := strings.IndexByte(p, '='); i >= 0 {
				k = p[:i]
			}
			if dk, err := url.QueryUnescape(k); err == nil {
				k = dk
			}
			if trackingParam(k) {
				continue
			}
			kept = append(kept, p)
		}
		u.RawQuery = strings.Join(kept, "&")
		u.ForceQuery = false
	}
	return canonicalString(u)
}

func hostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Host)
}

func pathOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	if u.Path == "" {
		return "/"
	}
	return u.EscapedPath()
}

func stripWWW(h string) string { return strings.TrimPrefix(strings.ToLower(h), "www.") }

// isSameSite: identical host, or the www / non-www variant of it.
func isSameSite(raw, siteHost string) bool {
	h := hostOf(raw)
	return h != "" && stripWWW(h) == stripWWW(siteHost)
}

var (
	reProductScoped = regexp.MustCompile(`^/collections/[^/]+/products/[^/]+`)
	reProduct       = regexp.MustCompile(`^/products/[^/]+`)
	reCollection    = regexp.MustCompile(`^/collections(/[^/]+)?(/[^/]+)?$`)
	reBlogArticle   = regexp.MustCompile(`^/blogs/[^/]+/[^/]+`)
	reBlogIndex     = regexp.MustCompile(`^/blogs/[^/]+$`)
	rePage          = regexp.MustCompile(`^/pages/[^/]+`)
	reSearch        = regexp.MustCompile(`^/search`)
	reTagPage       = regexp.MustCompile(`^/collections/[^/]+/[^/]+/?$`)
)

// templateOf: page template from the URL path (Shopify conventions), same rules as the Node API.
func templateOf(raw string) string {
	p := strings.TrimRight(pathOf(raw), "/")
	if p == "" {
		p = "/"
	}
	switch {
	case p == "/":
		return "home"
	case reProductScoped.MatchString(p), reProduct.MatchString(p):
		return "product"
	case reCollection.MatchString(p):
		return "collection"
	case reBlogArticle.MatchString(p):
		return "blog_article"
	case reBlogIndex.MatchString(p):
		return "blog_index"
	case rePage.MatchString(p):
		return "page"
	case reSearch.MatchString(p):
		return "search"
	}
	return "other"
}

func isCollectionTagPage(raw string) bool {
	p := pathOf(raw)
	return reTagPage.MatchString(p) && !strings.Contains(p, "/products/")
}

var (
	nonHTMLExt = regexp.MustCompile(`(?i)\.(jpe?g|png|gif|webp|avif|svg|ico|css|js|mjs|json|xml|txt|pdf|zip|mp4|webm|mov|mp3|woff2?|ttf|eot|csv|xlsx?|docx?)(\?|$)`)
	skipPaths  = regexp.MustCompile(`(?i)^/(cart|checkout|account|checkouts|orders|admin|apps/|services/|tools/|password|challenge|cdn/|wpm@|\.well-known)`)
	// Parameters that sort, filter, search or select a variant: the page is a view of another page.
	facetParam = regexp.MustCompile(`(?i)^(sort_by|sort|order|orderby|filter\..*|filter|q|query|search|view|variant|constraint|pf_.*|tag|tags|color|colour|size|price.*|min_price|max_price|limit|per_page|currency|locale|country|ref)$`)
)

// Query classes used by discovery.
const (
	qNone       = iota // no query string
	qPagination        // only ?page=N, N ≥ 2
	qFacet             // sort / filter / search / variant view of another page
	qOther             // other parameters: may change the page; followed with a per-path cap
)

func queryClass(raw string) (int, int) {
	u, err := url.Parse(raw)
	if err != nil || u.RawQuery == "" {
		return qNone, 0
	}
	q := u.Query()
	if len(q) == 0 {
		return qNone, 0
	}
	if len(q) == 1 {
		if v, ok := q["page"]; ok && len(v) == 1 {
			if n, err := strconv.Atoi(v[0]); err == nil && fmt.Sprint(n) == v[0] {
				if n >= 2 {
					return qPagination, n
				}
				return qFacet, 0 // ?page=1 duplicates the first page
			}
		}
	}
	for k := range q {
		if facetParam.MatchString(k) || k == "page" {
			return qFacet, 0
		}
	}
	return qOther, 0
}

// paginationPage returns N for a plain ?page=N (N ≥ 2) URL.
func paginationPage(raw string) (int, bool) {
	c, n := queryClass(raw)
	return n, c == qPagination
}

// Crawl-trap limits (endless generated URL spaces).
const (
	trapMaxURLLength = 2048
	trapMaxSegments  = 25
	trapMaxRepeats   = 3
	trapMaxPage      = 10000
)

func crawlTrapReason(raw string) string {
	if len(raw) > trapMaxURLLength {
		return fmt.Sprintf("URL longer than %d characters", trapMaxURLLength)
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	segs := []string{}
	for _, s := range strings.Split(u.Path, "/") {
		if s != "" {
			segs = append(segs, s)
		}
	}
	if len(segs) > trapMaxSegments {
		return fmt.Sprintf("more than %d path segments", trapMaxSegments)
	}
	if len(segs) >= trapMaxRepeats {
		counts := map[string]int{}
		for _, s := range segs {
			counts[s]++
			if counts[s] >= trapMaxRepeats {
				if len(s) > 40 {
					s = s[:40]
				}
				return fmt.Sprintf("path segment %q repeated %d times", s, counts[s])
			}
		}
	}
	if n, ok := paginationPage(raw); ok && n > trapMaxPage {
		return fmt.Sprintf("?page=%d is beyond %d", n, trapMaxPage)
	}
	return ""
}

// budgetReason: why a URL wastes crawl budget (parameter / faceted / tag page), or "".
func budgetReason(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	q := u.Query()
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	bad := []string{}
	for _, k := range keys {
		if facetParam.MatchString(k) || k == "page" || trackingParam(k) {
			bad = append(bad, k)
		}
	}
	if len(bad) > 0 {
		return "query parameter(s): " + strings.Join(bad, ", ")
	}
	if len(keys) > 0 {
		return "query string: " + strings.Join(keys, ", ")
	}
	if isCollectionTagPage(raw) {
		return "collection tag page (/collections/x/tag)"
	}
	return ""
}

// globMatch: user exclusion pattern on the path ("*" matches any run of characters; a pattern without "*" matches the
// path itself and everything below it).
func globMatch(pattern, path string) bool {
	pattern = strings.TrimSpace(pattern)
	if pattern == "" {
		return false
	}
	if !strings.Contains(pattern, "*") {
		p := strings.TrimRight(pattern, "/")
		return path == pattern || path == p || strings.HasPrefix(path, p+"/")
	}
	parts := strings.Split(regexp.QuoteMeta(pattern), `\*`)
	re, err := regexp.Compile("^" + strings.Join(parts, ".*") + "$")
	return err == nil && re.MatchString(path)
}

func productHandle(raw string) string {
	p := pathOf(raw)
	i := strings.Index(p, "/products/")
	if i < 0 {
		return ""
	}
	h := p[i+len("/products/"):]
	if j := strings.IndexAny(h, "/?#"); j >= 0 {
		h = h[:j]
	}
	if d, err := url.PathUnescape(h); err == nil {
		return d
	}
	return h
}
