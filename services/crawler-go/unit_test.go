package main

import (
	"bytes"
	"compress/gzip"
	"net/netip"
	"strings"
	"testing"
)

func TestNormalizeKeyStripsTrackingKeepsMeaningfulParams(t *testing.T) {
	cases := map[string]string{
		"HTTPS://Shop.Example:443/a?utm_source=x&id=5#frag": "https://shop.example/a?id=5",
		"https://shop.example/products/a?gclid=1&fbclid=2":  "https://shop.example/products/a",
		"https://shop.example/collections/all?page=2":       "https://shop.example/collections/all?page=2",
		"http://shop.example:80":                            "http://shop.example/",
	}
	for in, want := range cases {
		if got := normalizeKey(in); got != want {
			t.Errorf("normalizeKey(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestResolveURL(t *testing.T) {
	base := "https://shop.example/collections/all"
	ok := map[string]string{"/products/a": "https://shop.example/products/a", "b?x=1#y": "https://shop.example/collections/b?x=1", "//cdn.example/i.png": "https://cdn.example/i.png"}
	for in, want := range ok {
		if got, k := resolveURL(in, base); !k || got != want {
			t.Errorf("resolveURL(%q) = %q,%v want %q", in, got, k, want)
		}
	}
	for _, bad := range []string{"", "#top", "mailto:a@b.c", "javascript:void(0)", "tel:123", "ftp://x/y"} {
		if _, k := resolveURL(bad, base); k {
			t.Errorf("resolveURL(%q) should be rejected", bad)
		}
	}
}

func TestQueryClassesAndTemplates(t *testing.T) {
	if c, n := queryClass("https://s.example/collections/all?page=3"); c != qPagination || n != 3 {
		t.Fatal("page=3 should be pagination")
	}
	for _, u := range []string{"https://s.example/c?sort_by=price", "https://s.example/c?filter.v.price.gte=1", "https://s.example/p?variant=123", "https://s.example/c?page=1", "https://s.example/c?page=2&sort_by=x"} {
		if c, _ := queryClass(u); c != qFacet {
			t.Errorf("%s should be a facet/view URL", u)
		}
	}
	if c, _ := queryClass("https://s.example/item?id=7"); c != qOther {
		t.Error("id=7 should be an other (followed) parameter")
	}
	tpl := map[string]string{"https://s.example/": "home", "https://s.example/products/x": "product", "https://s.example/collections/c/products/x": "product",
		"https://s.example/collections/c": "collection", "https://s.example/blogs/news/post": "blog_article", "https://s.example/blogs/news": "blog_index",
		"https://s.example/pages/about": "page", "https://s.example/search?q=a": "search", "https://s.example/foo": "other"}
	for u, want := range tpl {
		if got := templateOf(u); got != want {
			t.Errorf("templateOf(%s)=%s want %s", u, got, want)
		}
	}
	if crawlTrapReason("https://s.example/a/b/a/b/a") == "" || crawlTrapReason("https://s.example/collections/x/products/y") != "" {
		t.Error("trap detection")
	}
	if !globMatch("/blogs/*/tagged/*", "/blogs/news/tagged/sale") || !globMatch("/pages/old", "/pages/old/sub") || globMatch("/pages/old", "/pages/older") {
		t.Error("glob")
	}
}

func TestRobots(t *testing.T) {
	r := parseRobots("User-agent: *\nDisallow: /cart\nAllow: /cart/ok$\nCrawl-delay: 2\n\nUser-agent: DeoDapSEOSentinel\nDisallow: /private\nCrawl-delay: 0.5\nSitemap: https://s.example/sm.xml\n")
	if ok, _ := r.allowed("OtherBot", "/cart/x"); ok {
		t.Error("/cart disallowed for *")
	}
	if ok, _ := r.allowed("OtherBot", "/cart/ok"); !ok {
		t.Error("longest/allow-wins")
	}
	if ok, _ := r.allowed("DeoDapSEOSentinel/1.0 (+x)", "/cart/x"); !ok {
		t.Error("specific group replaces *")
	}
	if _, _, d := r.groupFor("DeoDapSEOSentinel/1.0"); d != 0.5 {
		t.Errorf("crawl-delay %v", d)
	}
	if _, _, d := r.groupFor("x"); d != 2 {
		t.Errorf("crawl-delay * %v", d)
	}
	if len(r.Sitemaps) != 1 {
		t.Error("sitemap line")
	}
}

func TestNetGuard(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "::1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:a00:1::", "fc00::1", "100.64.1.1"} {
		if blockedAddressReason(netip.MustParseAddr(ip), false) == "" {
			t.Errorf("%s must be blocked", ip)
		}
	}
	if blockedAddressReason(netip.MustParseAddr("8.8.8.8"), false) != "" || blockedAddressReason(netip.MustParseAddr("127.0.0.1"), true) != "" {
		t.Error("public / allowed loopback")
	}
	if blockedAddressReason(netip.MustParseAddr("10.0.0.1"), true) == "" {
		t.Error("private stays blocked even with loopback allowed")
	}
	for _, u := range []string{"http://user:pw@s.example/", "ftp://s.example/", "http://metadata.google.internal/", "http://printer.local/", "http://127.0.0.1/"} {
		if checkURL(u, false) == nil {
			t.Errorf("%s must be refused", u)
		}
	}
}

func TestSitemapStream(t *testing.T) {
	x := `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
<url><image:image><image:loc>https://cdn.example/a.jpg</image:loc></image:image><loc>https://s.example/p?a=1&amp;b=2</loc><lastmod>2026-10-01</lastmod></url>
<url><loc><![CDATA[https://s.example/c]]></loc></url></urlset>`
	var got []string
	p, err := parseSitemapStream(strings.NewReader(x), 1<<20, func(l, m string) { got = append(got, l+"|"+m) })
	if err != nil || p.kind != "urlset" || strings.Join(got, ",") != "https://s.example/p?a=1&b=2|2026-10-01,https://s.example/c|" {
		t.Fatalf("got %v %v", got, err)
	}
	var gz bytes.Buffer
	w := gzip.NewWriter(&gz)
	w.Write([]byte(`<sitemapindex><sitemap><loc>https://s.example/s1.xml</loc></sitemap></sitemapindex>`))
	w.Close()
	p, err = parseSitemapStream(&gz, 1<<20, func(string, string) {})
	if err != nil || p.kind != "sitemapindex" || len(p.children) != 1 {
		t.Fatalf("gzip index %v %v", p, err)
	}
	if _, err := parseSitemapStream(strings.NewReader("<html>no</html>"), 1<<20, func(string, string) {}); err == nil {
		t.Fatal("html is not a sitemap")
	}
	// Truncation keeps what was read.
	var b strings.Builder
	b.WriteString(`<urlset>`)
	for i := 0; i < 2000; i++ {
		b.WriteString(`<url><loc>https://s.example/p` + strings.Repeat("x", 10) + `</loc></url>`)
	}
	b.WriteString(`</urlset>`)
	n := 0
	p, err = parseSitemapStream(strings.NewReader(b.String()), 20000, func(string, string) { n++ })
	if err != nil || !p.trunc || n == 0 || n >= 2000 {
		t.Fatalf("truncation: %v %d %v", p, n, err)
	}
}

func TestExtract(t *testing.T) {
	doc := `<!doctype html><html lang="en"><head><title>Steel Chopper | DeoDap</title><meta name="Description" content=" Sharp  steel chopper ">
<meta name="robots" content="NOINDEX"><link rel="canonical" href="/products/chopper"><meta property="og:title" content="OG"><link rel="next" href="?page=2">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"Chopper","offers":{"@type":"Offer","price":"10"}},{"@type":"BreadcrumbList"}]}</script>
<script src="https://apps.example/x.js" async></script></head><body>
<header><nav><a href="/collections/all">All</a></nav></header>
<main><h1>Steel  Chopper</h1><p>This chopper is a kitchen tool that makes cutting vegetables quick and safe for everyone.</p>
<h2>What is the capacity?</h2><p>It holds 500 ml of chopped vegetables.</p><div class="product-grid"><a href="/products/other">Other</a></div>
<img src="/img/IMG_1234.jpg"><img src="/img/b.jpg" alt="Steel chopper"><span class="price">₹ 1,299.00</span>
<table><tr><th>Material </th><td>Steel</td></tr></table><a href="tel:+919999999999">Call</a><time datetime="2026-01-05">5 Jan</time></main>
<footer><a href="https://other.example/x">x</a></footer></body></html>`
	p := extractHTML([]byte(doc), "https://shop.example/products/chopper", "shop.example")
	if p == nil || *p.Title != "Steel Chopper | DeoDap" || *p.MetaDescription != "Sharp steel chopper" || *p.MetaRobots != "noindex" {
		t.Fatalf("head: %+v", p)
	}
	if len(p.Canonicals) != 1 || p.Canonicals[0] != "https://shop.example/products/chopper" || p.Pagination.Next == nil || *p.Pagination.Next != "https://shop.example/products/chopper?page=2" {
		t.Fatalf("links: %v %v", p.Canonicals, p.Pagination.Next)
	}
	if len(p.H1s) != 1 || p.H1s[0] != "Steel Chopper" || len(p.SchemaTypes) < 3 || len(p.SchemaNodes) != 2 {
		t.Fatalf("h1/schema: %v %v", p.H1s, p.SchemaTypes)
	}
	if len(p.QuestionHeadings) != 1 || p.QuestionHeadings[0].FirstAnswerWords != 7 {
		t.Fatalf("question headings %+v", p.QuestionHeadings)
	}
	if len(p.Images) != 2 || p.Images[0].Alt != nil || !p.Images[0].InMain || len(p.VisiblePrices) != 1 || p.VisiblePrices[0].Values[0] != 1299 {
		t.Fatalf("images/prices %+v %+v", p.Images, p.VisiblePrices)
	}
	if !p.Features.SpecTable || p.Features.DefinitionSentence == nil || !p.PhoneVisible || len(p.VisibleDates) == 0 || p.VisibleDates[0].ISO != "2026-01-05T00:00:00.000Z" {
		t.Fatalf("features %+v dates %+v", p.Features, p.VisibleDates)
	}
	for _, b := range p.OwnBlocks {
		if strings.Contains(b, "Other") {
			t.Fatal("grid text must be excluded from own blocks")
		}
	}
	if wordCount("don't stop—now it's 2026") != 5 {
		t.Errorf("wordCount %d", wordCount("don't stop—now it's 2026"))
	}
	if len(p.InternalLinks) != 2 || len(p.ExternalLinks) != 1 || p.Links[0].InMain {
		t.Fatalf("links %v %v", p.InternalLinks, p.ExternalLinks)
	}
}
