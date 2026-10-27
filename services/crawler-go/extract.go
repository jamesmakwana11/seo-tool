package main

import (
	"encoding/json"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/net/html"
)

// HTML extraction — a field-for-field port of apps/api/src/crawler/parse.ts so the existing SEO analyzers receive the
// same data. `blocks` and `mainText` are not sent (the Node API derives them from `segments`), which keeps page records
// small; everything else uses the same JSON names. Parity with the Node parser is covered by tests on shared fixtures.

type Segment struct {
	Kind  string `json:"kind"`
	Level int    `json:"level,omitempty"`
	Text  string `json:"text"`
}
type Heading struct {
	Level int    `json:"level"`
	Text  string `json:"text"`
}
type Link struct {
	URL      string  `json:"url"`
	Text     string  `json:"text"`
	Internal bool    `json:"internal"`
	InMain   bool    `json:"inMain"`
	Rel      *string `json:"rel,omitempty"`
}
type Image struct {
	Src     string  `json:"src"`
	Alt     *string `json:"alt"`
	Width   *string `json:"width,omitempty"`
	Height  *string `json:"height,omitempty"`
	Loading *string `json:"loading,omitempty"`
	InMain  bool    `json:"inMain"`
	Index   int     `json:"index"`
	// Location: where on the page the <img> is — landmark (header / nav / main / aside / footer), Shopify section and a
	// recognisable component (gallery, slider, card, logo …), e.g. `footer › section "footer" › .footer__badges`.
	Location string `json:"location,omitempty"`
}
type HeadScript struct {
	Src    string  `json:"src"`
	Async  bool    `json:"async"`
	Defer  bool    `json:"defer"`
	Module bool    `json:"module"`
	Type   *string `json:"type,omitempty"`
}
type JSONLD struct {
	Raw   string `json:"raw"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}
type Price struct {
	Text   string    `json:"text"`
	Values []float64 `json:"values"`
}
type FAQItem struct {
	Q string `json:"q"`
	A string `json:"a"`
}
type QHeading struct {
	Level            int    `json:"level"`
	Text             string `json:"text"`
	FirstAnswer      string `json:"firstAnswer"`
	FirstAnswerWords int    `json:"firstAnswerWords"`
}
type VisibleDate struct {
	Label string `json:"label"`
	Text  string `json:"text"`
	ISO   string `json:"iso,omitempty"`
}
type OG struct {
	URL         *string `json:"url,omitempty"`
	Title       *string `json:"title,omitempty"`
	Image       *string `json:"image,omitempty"`
	Description *string `json:"description,omitempty"`
	Type        *string `json:"type,omitempty"`
}
type Twitter struct {
	Card  *string `json:"card,omitempty"`
	Title *string `json:"title,omitempty"`
	Image *string `json:"image,omitempty"`
}
type Features struct {
	Tables             int     `json:"tables"`
	DataTables         int     `json:"dataTables"`
	OrderedLists       int     `json:"orderedLists"`
	DefinitionLists    int     `json:"definitionLists"`
	Video              bool    `json:"video"`
	SpecTable          bool    `json:"specTable"`
	DefinitionSentence *string `json:"definitionSentence,omitempty"`
}

type ParsedHTML struct {
	Lang                 *string          `json:"lang,omitempty"`
	HasViewport          bool             `json:"hasViewport"`
	Title                *string          `json:"title,omitempty"`
	TitleCount           int              `json:"titleCount"`
	MetaDescription      *string          `json:"metaDescription,omitempty"`
	MetaDescriptionCount int              `json:"metaDescriptionCount"`
	MetaRobots           *string          `json:"metaRobots,omitempty"`
	Canonicals           []string         `json:"canonicals"`
	OG                   OG               `json:"og"`
	Twitter              Twitter          `json:"twitter"`
	H1s                  []string         `json:"h1s"`
	Headings             []Heading        `json:"headings"`
	Links                []Link           `json:"links"`
	InternalLinks        []string         `json:"internalLinks"`
	ExternalLinks        []string         `json:"externalLinks"`
	InternalLinkCount    int              `json:"internalLinkCount"`
	Images               []Image          `json:"images"`
	HeadScripts          []HeadScript     `json:"headScripts"`
	ScriptSrcs           []string         `json:"scriptSrcs"`
	Stylesheets          []string         `json:"stylesheets"`
	JSONLD               []JSONLD         `json:"jsonld"`
	SchemaNodes          []map[string]any `json:"schemaNodes"`
	SchemaTypes          []string         `json:"schemaTypes"`
	VisiblePrices        []Price          `json:"visiblePrices"`
	Breadcrumb           struct {
		Visible bool    `json:"visible"`
		Text    *string `json:"text,omitempty"`
	} `json:"breadcrumb"`
	Reviews struct {
		VisibleCount int      `json:"visibleCount"`
		Texts        []string `json:"texts"`
		SummaryText  *string  `json:"summaryText,omitempty"`
		HasVisible   bool     `json:"hasVisible"`
	} `json:"reviews"`
	FAQ struct {
		Present bool      `json:"present"`
		Items   []FAQItem `json:"items"`
	} `json:"faq"`
	QuestionHeadings []QHeading `json:"questionHeadings"`
	Author           struct {
		Name    *string `json:"name,omitempty"`
		HasBio  bool    `json:"hasBio"`
		BioText *string `json:"bioText,omitempty"`
	} `json:"author"`
	VisibleDates              []VisibleDate `json:"visibleDates"`
	WordCount                 int           `json:"wordCount"`
	OwnBlocks                 []string      `json:"ownBlocks"`
	Segments                  []Segment     `json:"segments"`
	DescriptionText           *string       `json:"descriptionText,omitempty"`
	DescriptionWords          int           `json:"descriptionWords"`
	ContentWordsExcludingGrid int           `json:"contentWordsExcludingGrid"`
	MixedContent              []string      `json:"mixedContent"`
	Pagination                struct {
		Next *string `json:"next,omitempty"`
		Prev *string `json:"prev,omitempty"`
	} `json:"pagination"`
	Features     Features `json:"features"`
	PhoneVisible bool     `json:"phoneVisible"`

	// Not sent: used by the crawler itself (Rust text core, discovery).
	blocks   []string
	mainText string
}

// ------------------------------------------------------------------------------------------------ text helpers

func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	}
	return r >= '\u2000' && r <= '\u200a'
}

// collapse: runs of whitespace → one space, trimmed (JS /[\s\u00a0]+/g + trim()).
func collapse(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	space := false
	for _, r := range s {
		if isJSSpace(r) {
			space = true
			continue
		}
		if space && b.Len() > 0 {
			b.WriteByte(' ')
		}
		space = false
		b.WriteRune(r)
	}
	return b.String()
}

func isWordStart(r rune) bool { return unicode.IsLetter(r) || unicode.IsNumber(r) }
func isWordCont(r rune) bool  { return isWordStart(r) || r == '\'' || r == '’' || r == '-' }

// wordCount matches the shared TypeScript wordCount: /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu.
func wordCount(s string) int {
	n := 0
	in := false
	for _, r := range s {
		if in {
			if isWordCont(r) {
				continue
			}
			in = false
		}
		if isWordStart(r) {
			in = true
			n++
		}
	}
	return n
}

func sp(s string) *string { return &s }

// ------------------------------------------------------------------------------------------------ DOM helpers

func isElem(n *html.Node) bool { return n != nil && n.Type == html.ElementNode }

func attr(n *html.Node, key string) (string, bool) {
	for _, a := range n.Attr {
		if a.Namespace == "" && a.Key == key {
			return a.Val, true
		}
	}
	return "", false
}

func attrOr(n *html.Node, key string) string { v, _ := attr(n, key); return v }

func hasClass(n *html.Node, classes ...string) bool {
	c, ok := attr(n, "class")
	if !ok {
		return false
	}
	for _, tok := range strings.Fields(c) {
		for _, want := range classes {
			if tok == want {
				return true
			}
		}
	}
	return false
}

func attrContainsCI(n *html.Node, key, sub string) bool {
	v, ok := attr(n, key)
	return ok && strings.Contains(strings.ToLower(v), sub)
}

func walk(n *html.Node, fn func(*html.Node) bool) {
	if !fn(n) {
		return
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		walk(c, fn)
	}
}

func findAll(root *html.Node, pred func(*html.Node) bool) []*html.Node {
	var out []*html.Node
	walk(root, func(n *html.Node) bool {
		if isElem(n) && pred(n) {
			out = append(out, n)
		}
		return true
	})
	return out
}

func findFirst(root *html.Node, pred func(*html.Node) bool) *html.Node {
	var found *html.Node
	walk(root, func(n *html.Node) bool {
		if found != nil {
			return false
		}
		if isElem(n) && pred(n) {
			found = n
			return false
		}
		return true
	})
	return found
}

// closest: the element itself or its nearest ancestor matching pred (jQuery closest).
func closest(n *html.Node, pred func(*html.Node) bool) *html.Node {
	for x := n; x != nil; x = x.Parent {
		if isElem(x) && pred(x) {
			return x
		}
	}
	return nil
}

func inside(n, anc *html.Node) bool {
	for x := n; x != nil; x = x.Parent {
		if x == anc {
			return true
		}
	}
	return false
}

var componentClass = regexp.MustCompile(`(?i)(gallery|slider|slideshow|carousel|swiper|thumbnail|media|card|logo|banner|badge|icon|menu|footer__|header__|collage|grid__item|image-with-text|multicolumn|testimonial)`)

// imageLocation: the page landmark, the Shopify section (id="shopify-section-…", the part after "__") and the nearest
// element whose class names a component, joined with " › " — "" when nothing identifies the place.
func imageLocation(img *html.Node) string {
	parts := []string{}
	if l := closest(img.Parent, tagIs("header", "nav", "main", "aside", "footer")); l != nil {
		parts = append(parts, l.Data)
	}
	if sec := closest(img.Parent, func(x *html.Node) bool { return strings.HasPrefix(attrOr(x, "id"), "shopify-section-") }); sec != nil {
		id := strings.TrimPrefix(attrOr(sec, "id"), "shopify-section-")
		if i := strings.LastIndex(id, "__"); i >= 0 {
			id = id[i+2:]
		}
		parts = append(parts, `section "`+id+`"`)
	}
	if c := closest(img.Parent, func(x *html.Node) bool { return componentClass.MatchString(attrOr(x, "class")) }); c != nil {
		for _, tok := range strings.Fields(attrOr(c, "class")) {
			if componentClass.MatchString(tok) {
				parts = append(parts, "."+tok)
				break
			}
		}
	}
	return strings.Join(parts, " › ")
}

func tagIs(names ...string) func(*html.Node) bool {
	return func(n *html.Node) bool {
		for _, nm := range names {
			if n.Data == nm {
				return true
			}
		}
		return false
	}
}

// textContent: every descendant text node (cheerio .text()).
func textContent(n *html.Node) string {
	var b strings.Builder
	walk(n, func(x *html.Node) bool {
		if x.Type == html.TextNode {
			b.WriteString(x.Data)
		}
		return true
	})
	return b.String()
}

var skipTags = map[string]bool{"script": true, "style": true, "noscript": true, "template": true, "svg": true, "iframe": true, "canvas": true, "nav": true, "header": true, "footer": true, "select": true, "button": true, "head": true, "title": true}
var skipClass = regexp.MustCompile(`(?i)(^|[\s_-])(breadcrumbs?|announcement-bar|cookie|visually-hidden|skip-to-content|drawer|menu-drawer)([\s_-]|$)`)
var gridClass = regexp.MustCompile(`(?i)(^|\s)(product-grid|product-card[\w-]*|card-wrapper|card--product|grid-product|grid__item|product-item|productitem|collection-products|related-products|product-recommendations|predictive-search)(\s|$)`)
var blockTags = map[string]bool{"p": true, "div": true, "li": true, "ul": true, "ol": true, "section": true, "article": true, "aside": true, "table": true, "thead": true, "tbody": true, "tr": true, "td": true, "th": true, "dd": true, "dt": true, "dl": true, "blockquote": true,
	"figure": true, "figcaption": true, "pre": true, "br": true, "details": true, "summary": true, "main": true, "form": true, "address": true, "hr": true, "body": true, "caption": true, "label": true}

func headingLevel(name string) int {
	if len(name) == 2 && name[0] == 'h' && name[1] >= '1' && name[1] <= '6' {
		return int(name[1] - '0')
	}
	return 0
}

func isSkipped(n *html.Node, extra func(*html.Node) bool) bool {
	if !isElem(n) {
		return false
	}
	if skipTags[n.Data] {
		return true
	}
	if attrOr(n, "role") == "navigation" || attrOr(n, "aria-hidden") == "true" {
		return true
	}
	if _, ok := attr(n, "hidden"); ok {
		return true
	}
	if skipClass.MatchString(attrOr(n, "class")) {
		return true
	}
	return extra != nil && extra(n)
}

// textOfNode: plain text of a subtree with block boundaries turned into spaces.
func textOfNode(n *html.Node, skip func(*html.Node) bool) string {
	var b strings.Builder
	var rec func(x *html.Node)
	rec = func(x *html.Node) {
		switch x.Type {
		case html.TextNode:
			b.WriteString(x.Data)
			return
		case html.CommentNode, html.DoctypeNode:
			return
		}
		if skip != nil && skip(x) {
			return
		}
		if isElem(x) {
			switch x.Data {
			case "script", "style", "noscript", "template", "svg":
				return
			}
		}
		block := isElem(x) && (blockTags[x.Data] || headingLevel(x.Data) > 0)
		if block {
			b.WriteByte(' ')
		}
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			rec(c)
		}
		if block {
			b.WriteByte(' ')
		}
	}
	rec(n)
	return collapse(b.String())
}

// segmentsOf: main content as ordered heading / text segments (navigation, header, footer, scripts excluded).
func segmentsOf(root *html.Node, extraSkip func(*html.Node) bool) []Segment {
	segs := []Segment{}
	var buf strings.Builder
	flush := func() {
		t := collapse(buf.String())
		if t != "" {
			segs = append(segs, Segment{Kind: "text", Text: t})
		}
		buf.Reset()
	}
	var rec func(x *html.Node)
	rec = func(x *html.Node) {
		if x.Type == html.TextNode {
			buf.WriteString(x.Data)
			return
		}
		if x.Type != html.ElementNode && x.Type != html.DocumentNode {
			return
		}
		if x != root && isSkipped(x, extraSkip) {
			return
		}
		if isElem(x) {
			if lvl := headingLevel(x.Data); lvl > 0 {
				flush()
				if t := textOfNode(x, nil); t != "" {
					segs = append(segs, Segment{Kind: "heading", Level: lvl, Text: t})
				}
				return
			}
		}
		block := isElem(x) && blockTags[x.Data]
		if block {
			flush()
		}
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			rec(c)
		}
		if block {
			flush()
		}
	}
	rec(root)
	flush()
	return segs
}

func collectTypes(v any, out map[string]bool, order *[]string, depth int) {
	if depth > 12 || v == nil {
		return
	}
	switch x := v.(type) {
	case []any:
		for _, e := range x {
			collectTypes(e, out, order, depth+1)
		}
	case map[string]any:
		add := func(t string) {
			if !out[t] {
				out[t] = true
				*order = append(*order, t)
			}
		}
		switch t := x["@type"].(type) {
		case string:
			add(t)
		case []any:
			for _, e := range t {
				if s, ok := e.(string); ok {
					add(s)
				}
			}
		}
		for k, e := range x {
			if k != "@type" && k != "@context" {
				collectTypes(e, out, order, depth+1)
			}
		}
	}
}

var priceRe = regexp.MustCompile(`(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)`)

func parsePriceValues(text string) []float64 {
	out := []float64{}
	for _, m := range priceRe.FindAllString(text, -1) {
		var v float64
		if err := json.Unmarshal([]byte(strings.ReplaceAll(m, ",", "")), &v); err == nil {
			out = append(out, v)
		}
	}
	return out
}

const dateSrc = `(\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9},?\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})`

var updRe = regexp.MustCompile(`(?i)(last updated|updated on|updated|last modified|modified on|published on|posted on|published)\s*:?\s*` + dateSrc)
var ordinalRe = regexp.MustCompile(`(\d)(st|nd|rd|th)`)
var dateLayouts = []string{time.RFC3339Nano, "2006-01-02T15:04:05Z07:00", "2006-01-02T15:04:05", "2006-01-02T15:04", "2006-01-02 15:04:05", "2006-01-02",
	"2 January 2006", "2 Jan 2006", "2 January, 2006", "2 Jan, 2006", "January 2, 2006", "Jan 2, 2006", "January 2 2006", "Jan 2 2006",
	"Monday, January 2, 2006", "Mon, 02 Jan 2006 15:04:05 MST", "Mon, 2 Jan 2006 15:04:05 -0700"}

// toISO approximates JavaScript Date parsing for the formats pages use (dates without a zone are read as UTC).
func toISO(s string) string {
	s = strings.TrimSpace(ordinalRe.ReplaceAllString(s, "$1"))
	if s == "" {
		return ""
	}
	for _, l := range dateLayouts {
		if t, err := time.Parse(l, s); err == nil {
			return t.UTC().Format("2006-01-02T15:04:05.000Z")
		}
	}
	// Month name spelled out in a different case ("march 12, 2024").
	if len(s) > 0 {
		t := strings.ToUpper(s[:1]) + strings.ToLower(s[1:])
		for _, l := range dateLayouts[6:] {
			if tt, err := time.Parse(l, t); err == nil {
				return tt.UTC().Format("2006-01-02T15:04:05.000Z")
			}
		}
	}
	return ""
}

var faqHeading = regexp.MustCompile(`(?i)\b(faq|faqs|frequently asked|questions? (&|and) answers?|q\s*&\s*a)\b`)
var questionStart = regexp.MustCompile(`(?i)^(what|how|why|which|is|are|can|could|does|do|did|where|when|who|should|will|would|wholesale\s.*\?)\b`)
var endsQ = regexp.MustCompile(`\?\s*$`)
var specKw = regexp.MustCompile(`(?i)\b(material|dimensions?|size|weight|capacity|specifications?|colou?r|warranty|power|wattage|voltage|battery|pack of|quantity|model)\b`)
var specHeading = regexp.MustCompile(`(?i)specification|specs|product details`)
var definitionRe = regexp.MustCompile(`(?i)\b(is|are|refers to|means)\s+(a|an|the)\b`)
var phoneRe = regexp.MustCompile(`(\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b`)
var authorPrefix = regexp.MustCompile(`(?i)^(by|written by|author:?)\s+`)
var updatedWord = regexp.MustCompile(`(?i)updated|modified`)
var publishedWord = regexp.MustCompile(`(?i)published|posted`)
var httpRaw = regexp.MustCompile(`(?i)^http://`)
var videoSrc = regexp.MustCompile(`(?i)youtube|vimeo`)

// splitSentences: text split after . ! or ? followed by whitespace (JS /(?<=[.!?])\s+/).
func splitSentences(s string) []string {
	var out []string
	start := 0
	rs := []rune(s)
	for i := 0; i < len(rs); i++ {
		if (rs[i] == '.' || rs[i] == '!' || rs[i] == '?') && i+1 < len(rs) && isJSSpace(rs[i+1]) {
			out = append(out, string(rs[start:i+1]))
			j := i + 1
			for j < len(rs) && isJSSpace(rs[j]) {
				j++
			}
			start = j
			i = j - 1
		}
	}
	if start < len(rs) {
		out = append(out, string(rs[start:]))
	}
	return out
}

// ------------------------------------------------------------------------------------------------ extraction

func extractHTML(doc []byte, pageURL, siteHost string) *ParsedHTML {
	root, err := html.Parse(strings.NewReader(string(doc)))
	if err != nil {
		return nil
	}
	p := &ParsedHTML{Canonicals: []string{}, H1s: []string{}, Headings: []Heading{}, Links: []Link{}, InternalLinks: []string{}, ExternalLinks: []string{}, Images: []Image{},
		HeadScripts: []HeadScript{}, ScriptSrcs: []string{}, Stylesheets: []string{}, JSONLD: []JSONLD{}, SchemaNodes: []map[string]any{}, SchemaTypes: []string{},
		VisiblePrices: []Price{}, QuestionHeadings: []QHeading{}, VisibleDates: []VisibleDate{}, OwnBlocks: []string{}, Segments: []Segment{}, MixedContent: []string{}}
	p.Reviews.Texts = []string{}
	p.FAQ.Items = []FAQItem{}
	isHTTPS := strings.HasPrefix(pageURL, "https:")
	abs := func(h string, ok bool) (string, bool) {
		if !ok {
			return "", false
		}
		return resolveURL(h, pageURL)
	}
	inSVG := func(n *html.Node) bool { return closest(n, func(x *html.Node) bool { return x.Data == "svg" }) != nil }

	htmlEl := findFirst(root, tagIs("html"))
	headEl := findFirst(root, tagIs("head"))
	body := findFirst(root, tagIs("body"))
	if htmlEl != nil {
		if v, ok := attr(htmlEl, "lang"); ok {
			p.Lang = sp(v)
		}
	}

	// ------------------------------------------------------------------ head
	titles := findAll(root, func(n *html.Node) bool { return n.Data == "title" && !inSVG(n) })
	p.TitleCount = len(titles)
	if len(titles) > 0 {
		p.Title = sp(collapse(textContent(titles[0])))
	}
	metas := findAll(root, tagIs("meta"))
	var robotsParts []string
	for _, m := range metas {
		name := strings.ToLower(attrOr(m, "name"))
		switch name {
		case "description":
			p.MetaDescriptionCount++
			if p.MetaDescriptionCount == 1 {
				p.MetaDescription = sp(collapse(attrOr(m, "content")))
			}
		case "robots", "googlebot":
			if c := strings.ToLower(attrOr(m, "content")); c != "" {
				robotsParts = append(robotsParts, c)
			}
		case "viewport":
			p.HasViewport = true
		}
	}
	if len(robotsParts) > 0 {
		p.MetaRobots = sp(strings.Join(robotsParts, ", "))
	}
	metaContent := func(match func(*html.Node) bool) *string {
		for _, m := range metas {
			if match(m) {
				if v, ok := attr(m, "content"); ok {
					return sp(collapse(v))
				}
				return nil
			}
		}
		return nil
	}
	prop := func(v string) func(*html.Node) bool {
		return func(n *html.Node) bool { return attrOr(n, "property") == v }
	}
	nameEq := func(v string) func(*html.Node) bool { return func(n *html.Node) bool { return attrOr(n, "name") == v } }
	p.OG.URL = metaContent(prop("og:url"))
	p.OG.Title = metaContent(prop("og:title"))
	p.OG.Image = metaContent(prop("og:image"))
	if p.OG.Image == nil {
		p.OG.Image = metaContent(prop("og:image:secure_url"))
	}
	p.OG.Description = metaContent(prop("og:description"))
	p.OG.Type = metaContent(prop("og:type"))
	p.Twitter.Card = metaContent(nameEq("twitter:card"))
	p.Twitter.Title = metaContent(nameEq("twitter:title"))
	p.Twitter.Image = metaContent(nameEq("twitter:image"))

	seenNext, seenPrev := false, false
	for _, l := range findAll(root, tagIs("link")) {
		rel, hasRel := attr(l, "rel")
		if !hasRel {
			continue
		}
		toks := strings.Fields(strings.ToLower(rel))
		for _, t := range toks {
			if t == "canonical" {
				href, okh := attr(l, "href")
				if u, ok := abs(href, okh); ok {
					p.Canonicals = append(p.Canonicals, u)
				} else {
					p.Canonicals = append(p.Canonicals, href)
				}
				break
			}
		}
		if strings.EqualFold(rel, "stylesheet") {
			if u, ok := abs(attr(l, "href")); ok {
				p.Stylesheets = append(p.Stylesheets, u)
			}
		}
		// First link[rel="next"] / [rel="prev"] only (its href resolved, as the Node parser does).
		if rel == "next" && !seenNext {
			seenNext = true
			if u, ok := abs(attr(l, "href")); ok {
				p.Pagination.Next = sp(u)
			}
		}
		if rel == "prev" && !seenPrev {
			seenPrev = true
			if u, ok := abs(attr(l, "href")); ok {
				p.Pagination.Prev = sp(u)
			}
		}
	}
	scripts := findAll(root, tagIs("script"))
	seenScript := map[string]bool{}
	types := map[string]bool{}
	var typeOrder []string
	for _, s := range scripts {
		if src, ok := attr(s, "src"); ok {
			if headEl != nil && inside(s, headEl) {
				res, okr := abs(src, true)
				if !okr {
					res = src
				}
				if res != "" {
					hs := HeadScript{Src: res}
					_, hs.Async = attr(s, "async")
					_, hs.Defer = attr(s, "defer")
					if t, okt := attr(s, "type"); okt {
						hs.Type = sp(t)
						hs.Module = t == "module"
					}
					p.HeadScripts = append(p.HeadScripts, hs)
				}
			}
			if u, ok := abs(src, true); ok && !seenScript[u] {
				seenScript[u] = true
				p.ScriptSrcs = append(p.ScriptSrcs, u)
			}
		}
		if strings.EqualFold(attrOr(s, "type"), "application/ld+json") {
			raw := strings.TrimSpace(textContent(s))
			if raw == "" {
				continue
			}
			clean := strings.TrimSpace(raw)
			clean = strings.TrimSuffix(strings.TrimPrefix(clean, "<!--"), "-->")
			var data any
			if err := json.Unmarshal([]byte(clean), &data); err != nil {
				r := raw
				if len(r) > 2000 {
					r = r[:2000]
				}
				p.JSONLD = append(p.JSONLD, JSONLD{Raw: r, OK: false, Error: err.Error()})
				continue
			}
			r := raw
			if len(r) > 4000 {
				r = r[:4000]
			}
			p.JSONLD = append(p.JSONLD, JSONLD{Raw: r, OK: true})
			var push func(n any)
			push = func(n any) {
				if m, ok := n.(map[string]any); ok {
					if g, ok := m["@graph"].([]any); ok {
						for _, e := range g {
							push(e)
						}
					} else {
						p.SchemaNodes = append(p.SchemaNodes, m)
					}
				}
			}
			if arr, ok := data.([]any); ok {
				for _, e := range arr {
					push(e)
				}
			} else {
				push(data)
			}
			collectTypes(data, types, &typeOrder, 0)
		}
	}
	p.SchemaTypes = append(p.SchemaTypes, typeOrder...)

	// ------------------------------------------------------------------ main content
	mainEl := findFirst(root, func(n *html.Node) bool {
		return n.Data == "main" || attrOr(n, "role") == "main" || attrOr(n, "id") == "MainContent" || attrOr(n, "id") == "main-content"
	})
	rootSel := mainEl
	if rootSel == nil {
		rootSel = body
	}
	if rootSel == nil {
		rootSel = root
	}
	segments := segmentsOf(rootSel, nil)
	p.Segments = segments
	var mainParts []string
	for _, s := range segments {
		mainParts = append(mainParts, s.Text)
		if s.Kind == "text" {
			p.blocks = append(p.blocks, s.Text)
		}
	}
	p.mainText = strings.Join(mainParts, "\n")
	p.WordCount = wordCount(p.mainText)
	gridSkip := func(n *html.Node) bool {
		if gridClass.MatchString(attrOr(n, "class")) {
			return true
		}
		_, ok := attr(n, "data-product-grid")
		return ok
	}
	own := segmentsOf(rootSel, gridSkip)
	var ownParts []string
	for _, s := range own {
		ownParts = append(ownParts, s.Text)
		if s.Kind == "text" {
			p.OwnBlocks = append(p.OwnBlocks, s.Text)
		}
	}
	p.ContentWordsExcludingGrid = wordCount(strings.Join(ownParts, "\n"))
	if body != nil {
		for _, s := range segmentsOf(body, nil) {
			if s.Kind == "heading" {
				p.Headings = append(p.Headings, Heading{Level: s.Level, Text: s.Text})
			}
		}
		for _, h := range findAll(body, tagIs("h1")) {
			if !inSVG(h) {
				p.H1s = append(p.H1s, textOfNode(h, nil))
			}
		}
	}
	descEl := findFirst(root, func(n *html.Node) bool {
		if !(hasClass(n, "product__description", "product-description", "product-single__description", "collection-description", "collection__description", "collection-hero__description", "rte") || attrOr(n, "itemprop") == "description") {
			return false
		}
		return closest(n, func(x *html.Node) bool {
			return hasClass(x, "product-card", "card-wrapper", "grid__item", "related-products")
		}) == nil
	})
	if descEl != nil {
		d := textOfNode(descEl, nil)
		p.DescriptionText = sp(d)
		p.DescriptionWords = wordCount(d)
	}

	// ------------------------------------------------------------------ links
	isChrome := func(x *html.Node) bool {
		return x.Data == "header" || x.Data == "nav" || x.Data == "footer" || attrOr(x, "role") == "navigation"
	}
	seenInt, seenExt := map[string]bool{}, map[string]bool{}
	for _, a := range findAll(root, tagIs("a")) {
		href, ok := attr(a, "href")
		if !ok {
			continue
		}
		u, ok := resolveURL(href, pageURL)
		if !ok {
			continue
		}
		chrome := closest(a, isChrome) != nil
		inMain := !chrome && (mainEl == nil || inside(a, mainEl))
		text := collapse(textContent(a))
		if utf8.RuneCountInString(text) > 100 {
			text = string([]rune(text)[:100])
		}
		l := Link{URL: u, Text: text, Internal: isSameSite(u, siteHost), InMain: inMain}
		if rel, ok := attr(a, "rel"); ok {
			l.Rel = sp(rel)
		}
		p.Links = append(p.Links, l)
		if l.Internal {
			p.InternalLinkCount++
			if !seenInt[u] {
				seenInt[u] = true
				p.InternalLinks = append(p.InternalLinks, u)
			}
		} else if !seenExt[u] {
			seenExt[u] = true
			p.ExternalLinks = append(p.ExternalLinks, u)
		}
	}

	// ------------------------------------------------------------------ images
	if body != nil {
		for i, img := range findAll(body, tagIs("img")) {
			raw := attrOr(img, "src")
			if raw == "" {
				raw = attrOr(img, "data-src")
			}
			if raw == "" {
				set, ok := attr(img, "srcset")
				if !ok {
					set = attrOr(img, "data-srcset")
				}
				first := strings.TrimSpace(strings.Split(set, ",")[0])
				if f := strings.Fields(first); len(f) > 0 {
					raw = f[0]
				}
			}
			if raw == "" || strings.HasPrefix(raw, "data:") {
				continue
			}
			if strings.HasPrefix(raw, "//") {
				if strings.HasPrefix(pageURL, "https") {
					raw = "https:" + raw
				} else {
					raw = "http:" + raw
				}
			}
			src, ok := resolveURL(raw, pageURL)
			if !ok {
				continue
			}
			im := Image{Src: src, Index: i}
			if v, ok := attr(img, "alt"); ok {
				im.Alt = sp(v)
			}
			if v, ok := attr(img, "width"); ok {
				im.Width = sp(v)
			}
			if v, ok := attr(img, "height"); ok {
				im.Height = sp(v)
			}
			if v, ok := attr(img, "loading"); ok {
				im.Loading = sp(strings.ToLower(v))
			}
			if mainEl != nil {
				im.InMain = inside(img, mainEl)
			} else {
				im.InMain = closest(img, tagIs("header", "nav", "footer")) == nil
			}
			im.Location = imageLocation(img)
			p.Images = append(p.Images, im)
		}
	}

	// ------------------------------------------------------------------ prices / breadcrumbs / reviews
	isPrice := func(n *html.Node) bool {
		_, dp := attr(n, "data-product-price")
		return hasClass(n, "price-item--sale", "price-item--regular", "price", "product__price", "product-price") || dp || attrOr(n, "itemprop") == "price"
	}
	for _, e := range findAll(root, isPrice) {
		if closest(e, func(x *html.Node) bool {
			return hasClass(x, "product-card", "card-wrapper", "card", "grid__item", "related-products", "product-recommendations") || attrContainsCI(x, "class", "product-card")
		}) != nil {
			continue
		}
		nested := false
		for c := e.FirstChild; c != nil && !nested; c = c.NextSibling {
			if findFirst(c, isPrice) != nil {
				nested = true
			}
		}
		if nested {
			continue
		}
		t := collapse(textContent(e))
		if v := parsePriceValues(t); len(v) > 0 {
			p.VisiblePrices = append(p.VisiblePrices, Price{Text: t, Values: v})
		}
	}
	bc := findFirst(root, func(n *html.Node) bool {
		if n.Data == "script" {
			return false
		}
		return (n.Data == "nav" && attrContainsCI(n, "aria-label", "breadcrumb")) || attrContainsCI(n, "class", "breadcrumb") || strings.Contains(attrOr(n, "itemtype"), "BreadcrumbList")
	})
	if bc != nil {
		t := collapse(textContent(bc))
		p.Breadcrumb.Visible = t != ""
		p.Breadcrumb.Text = sp(t)
	}
	isReview := func(n *html.Node) bool {
		_, rid := attr(n, "data-review-id")
		return hasClass(n, "spr-review", "jdgm-rev", "review", "review-item", "yotpo-review", "stamped-review", "loox-review", "okeReviews-review", "product-review") || rid || attrOr(n, "itemprop") == "review"
	}
	var reviewTexts []string
	for _, e := range findAll(root, isReview) {
		if e.Parent != nil && closest(e.Parent, isReview) != nil {
			continue
		}
		if t := collapse(textContent(e)); wordCount(t) >= 3 {
			reviewTexts = append(reviewTexts, t)
		}
	}
	p.Reviews.VisibleCount = len(reviewTexts)
	if len(reviewTexts) > 30 {
		p.Reviews.Texts = reviewTexts[:30]
	} else if reviewTexts != nil {
		p.Reviews.Texts = reviewTexts
	}
	p.Reviews.HasVisible = len(reviewTexts) > 0
	if se := findFirst(root, func(n *html.Node) bool {
		return hasClass(n, "spr-badge", "jdgm-prev-badge", "rating", "stamped-badge") || attrContainsCI(n, "class", "rating")
	}); se != nil {
		if t := collapse(textContent(se)); t != "" {
			p.Reviews.SummaryText = sp(t)
		}
	}

	// ------------------------------------------------------------------ FAQ & question headings
	var faqItems []FAQItem
	inFaq := false
	faqLevel := 0
	for i, s := range segments {
		if s.Kind != "heading" {
			continue
		}
		lvl := s.Level
		if faqHeading.MatchString(s.Text) {
			inFaq, faqLevel = true, lvl
			continue
		}
		eq := endsQ.MatchString(s.Text)
		isQ := eq || (inFaq && questionStart.MatchString(s.Text))
		if inFaq && lvl <= faqLevel && !isQ {
			inFaq = false
		}
		if !isQ {
			continue
		}
		var parts []string
		for j := i + 1; j < len(segments) && segments[j].Kind == "text"; j++ {
			parts = append(parts, segments[j].Text)
		}
		first := ""
		if len(parts) > 0 {
			first = parts[0]
		}
		if eq && lvl >= 2 && lvl <= 4 {
			p.QuestionHeadings = append(p.QuestionHeadings, QHeading{Level: lvl, Text: s.Text, FirstAnswer: first, FirstAnswerWords: wordCount(first)})
		}
		if inFaq {
			faqItems = append(faqItems, FAQItem{Q: s.Text, A: strings.Join(parts, " ")})
		}
	}
	isFaqBox := func(x *html.Node) bool { return attrContainsCI(x, "class", "faq") || attrOr(x, "id") == "faq" }
	for _, d := range findAll(root, tagIs("details")) {
		var sum *html.Node
		for c := d.FirstChild; c != nil; c = c.NextSibling {
			if isElem(c) && c.Data == "summary" {
				sum = c
				break
			}
		}
		if sum == nil {
			continue
		}
		q := collapse(textContent(sum))
		if q == "" {
			continue
		}
		all := textOfNode(d, nil)
		idx := strings.Index(all, q)
		rest := ""
		if idx >= 0 {
			rest = all[idx+len(q):]
		} else if len(q)-1 < len(all) {
			rest = all[len(q)-1:]
		}
		a := collapse(rest)
		if endsQ.MatchString(q) || questionStart.MatchString(q) || closest(d, isFaqBox) != nil {
			faqItems = append(faqItems, FAQItem{Q: q, A: a})
		}
	}
	for _, dt := range findAll(root, tagIs("dt")) {
		if closest(dt.Parent, isFaqBox) == nil {
			continue
		}
		q := collapse(textContent(dt))
		a := ""
		for s := dt.NextSibling; s != nil; s = s.NextSibling {
			if isElem(s) {
				if s.Data == "dd" {
					a = collapse(textContent(s))
				}
				break
			}
		}
		if q != "" {
			faqItems = append(faqItems, FAQItem{Q: q, A: a})
		}
	}
	seenQ := map[string]bool{}
	for _, it := range faqItems {
		if !seenQ[it.Q] {
			seenQ[it.Q] = true
			p.FAQ.Items = append(p.FAQ.Items, it)
		}
	}
	p.FAQ.Present = len(p.FAQ.Items) > 0

	// ------------------------------------------------------------------ author / dates
	if ae := findFirst(root, func(n *html.Node) bool {
		return attrOr(n, "rel") == "author" || hasClass(n, "article__author", "article-author", "byline", "author") || attrOr(n, "itemprop") == "author" || attrContainsCI(n, "class", "author-name")
	}); ae != nil {
		if name := authorPrefix.ReplaceAllString(collapse(textContent(ae)), ""); name != "" {
			p.Author.Name = sp(name)
		}
	}
	if be := findFirst(root, func(n *html.Node) bool {
		return hasClass(n, "author-bio", "author__bio", "about-author") || attrContainsCI(n, "class", "author-bio") || attrContainsCI(n, "class", "author-info")
	}); be != nil {
		bio := collapse(textContent(be))
		p.Author.BioText = sp(bio)
		p.Author.HasBio = bio != "" && wordCount(bio) >= 12
	}
	for _, t := range findAll(root, tagIs("time")) {
		dt, hasDt := attr(t, "datetime")
		ctx := ""
		if t.Parent != nil {
			ctx = collapse(textContent(t.Parent))
		}
		label := "date"
		if updatedWord.MatchString(ctx) {
			label = "updated"
		} else if publishedWord.MatchString(ctx) {
			label = "published"
		}
		text := collapse(textContent(t))
		if text == "" {
			text = dt
		}
		iso := ""
		if hasDt && dt != "" {
			iso = toISO(dt)
		} else {
			iso = toISO(collapse(textContent(t)))
		}
		p.VisibleDates = append(p.VisibleDates, VisibleDate{Label: label, Text: text, ISO: iso})
	}
	bodyText := ""
	if body != nil {
		bodyText = textOfNode(body, nil)
	}
	for _, m := range updRe.FindAllStringSubmatch(bodyText, -1) {
		label := "published"
		if updatedWord.MatchString(m[1]) {
			label = "updated"
		}
		p.VisibleDates = append(p.VisibleDates, VisibleDate{Label: label, Text: m[0], ISO: toISO(m[2])})
	}

	// ------------------------------------------------------------------ mixed content
	if isHTTPS {
		walk(root, func(n *html.Node) bool {
			if !isElem(n) {
				return true
			}
			raw, ok := "", false
			switch n.Data {
			case "img", "script", "iframe", "source", "video", "audio", "embed":
				raw, ok = attr(n, "src")
			case "link":
				if strings.EqualFold(attrOr(n, "rel"), "stylesheet") {
					raw, ok = attr(n, "href")
				}
			}
			if ok && httpRaw.MatchString(strings.TrimSpace(raw)) {
				p.MixedContent = append(p.MixedContent, strings.TrimSpace(raw))
			}
			return true
		})
	}

	// ------------------------------------------------------------------ extractability features
	var tables, dls, ols []*html.Node
	walk(rootSel, func(n *html.Node) bool {
		if n != rootSel && isElem(n) {
			switch n.Data {
			case "table":
				tables = append(tables, n)
			case "dl":
				dls = append(dls, n)
			case "ol":
				ols = append(ols, n)
			}
		}
		return true
	})
	p.Features.Tables = len(tables)
	for _, t := range tables {
		if findFirst(t, tagIs("th")) != nil || len(findAll(t, tagIs("tr"))) >= 2 {
			p.Features.DataTables++
		}
	}
	for _, t := range append(append([]*html.Node{}, tables...), dls...) {
		if specKw.MatchString(textContent(t)) {
			p.Features.SpecTable = true
			break
		}
	}
	if !p.Features.SpecTable {
		for i, s := range segments {
			if s.Kind == "heading" && specHeading.MatchString(s.Text) && i+1 < len(segments) && segments[i+1].Kind == "text" {
				p.Features.SpecTable = true
				break
			}
		}
	}
	n := len(p.blocks)
	if n > 8 {
		n = 8
	}
outer:
	for _, b := range p.blocks[:n] {
		for _, sen := range splitSentences(b) {
			if definitionRe.MatchString(sen) {
				if wc := wordCount(sen); wc >= 8 && wc <= 45 {
					p.Features.DefinitionSentence = sp(sen)
					break outer
				}
			}
		}
	}
	for _, o := range ols {
		li := 0
		for c := o.FirstChild; c != nil; c = c.NextSibling {
			if isElem(c) && c.Data == "li" {
				li++
			}
		}
		if li >= 3 {
			p.Features.OrderedLists++
		}
	}
	p.Features.DefinitionLists = len(dls)
	p.Features.Video = findFirst(root, func(n *html.Node) bool {
		if n.Data == "video" {
			return true
		}
		if n.Data == "iframe" {
			return videoSrc.MatchString(attrOr(n, "src")) || strings.Contains(strings.ToLower(attrOr(n, "data-src")), "youtube")
		}
		return false
	}) != nil

	p.PhoneVisible = findFirst(root, func(n *html.Node) bool { return n.Data == "a" && strings.HasPrefix(attrOr(n, "href"), "tel:") }) != nil || phoneRe.MatchString(bodyText)
	return p
}
