package main

import (
	"regexp"
	"strconv"
	"strings"
)

// robots.txt parsing and matching with the same semantics as the Node API (RFC 9309 as implemented by Google):
// consecutive User-agent lines form one group; the longest matching product-token group wins, else "*"; inside a group
// the longest matching rule wins and Allow wins ties; "*" and "$" are supported. Crawl-delay is read per group.

type robotsRule struct {
	Allow   bool
	Path    string
	Line    int
	pattern *regexp.Regexp
}

type robotsGroup struct {
	Agents     []string
	Rules      []*robotsRule
	CrawlDelay float64 // seconds; <0 = not set
}

type robots struct {
	Groups   []*robotsGroup
	Sitemaps []string
}

var robotsLine = regexp.MustCompile(`^([A-Za-z-]+)\s*:\s*(.*)$`)

func parseRobots(text string) *robots {
	r := &robots{}
	var cur *robotsGroup
	lastAgent := false
	text = strings.TrimPrefix(text, "\ufeff")
	for i, raw := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		line := raw
		if j := strings.IndexByte(line, '#'); j >= 0 {
			line = line[:j]
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		m := robotsLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		key := strings.ToLower(m[1])
		val := strings.TrimSpace(m[2])
		switch key {
		case "user-agent":
			if cur == nil || !lastAgent {
				cur = &robotsGroup{CrawlDelay: -1}
				r.Groups = append(r.Groups, cur)
			}
			cur.Agents = append(cur.Agents, strings.ToLower(val))
			lastAgent = true
			continue
		case "sitemap":
			r.Sitemaps = append(r.Sitemaps, val)
		case "allow", "disallow":
			if cur != nil && val != "" {
				cur.Rules = append(cur.Rules, &robotsRule{Allow: key == "allow", Path: val, Line: i + 1, pattern: robotsPattern(val)})
			}
		case "crawl-delay":
			if v, err := strconv.ParseFloat(strings.Replace(val, ",", ".", 1), 64); err == nil && v >= 0 && cur != nil {
				cur.CrawlDelay = v
			}
		}
		lastAgent = false
	}
	return r
}

func robotsPattern(p string) *regexp.Regexp {
	anchored := strings.HasSuffix(p, "$")
	body := strings.TrimSuffix(p, "$")
	parts := strings.Split(body, "*")
	for i := range parts {
		parts[i] = regexp.QuoteMeta(parts[i])
	}
	s := "^" + strings.Join(parts, ".*")
	if anchored {
		s += "$"
	}
	re, err := regexp.Compile(s)
	if err != nil {
		return regexp.MustCompile(`^\x00never`)
	}
	return re
}

func productToken(ua string) string {
	ua = strings.TrimSpace(ua)
	f := strings.FieldsFunc(ua, func(r rune) bool { return r == ' ' || r == '/' || r == '\t' })
	if len(f) == 0 {
		return strings.ToLower(ua)
	}
	return strings.ToLower(f[0])
}

// groupFor returns the rules and Crawl-delay (seconds, <0 when none) that apply to the user-agent.
func (r *robots) groupFor(ua string) (agent string, rules []*robotsRule, delay float64) {
	tok := productToken(ua)
	best := ""
	delay = -1
	for _, g := range r.Groups {
		for _, a := range g.Agents {
			if a == "*" || !(tok == a || strings.Contains(tok, a)) {
				continue
			}
			if len(a) > len(best) {
				best, rules, delay = a, nil, -1
			}
			if a == best {
				rules = append(rules, g.Rules...)
				if g.CrawlDelay > delay {
					delay = g.CrawlDelay
				}
			}
		}
	}
	if best != "" {
		return best, rules, delay
	}
	for _, g := range r.Groups {
		for _, a := range g.Agents {
			if a == "*" {
				rules = append(rules, g.Rules...)
				if g.CrawlDelay > delay {
					delay = g.CrawlDelay
				}
				break
			}
		}
	}
	return "*", rules, delay
}

// allowed decides whether pathWithQuery may be fetched by ua.
func (r *robots) allowed(ua, pathWithQuery string) (bool, *robotsRule) {
	if r == nil {
		return true, nil
	}
	_, rules, _ := r.groupFor(ua)
	var best *robotsRule
	bestLen := -1
	for _, rule := range rules {
		if !rule.pattern.MatchString(pathWithQuery) {
			continue
		}
		l := len(strings.TrimSuffix(rule.Path, "$"))
		if l > bestLen || (l == bestLen && rule.Allow) {
			best, bestLen = rule, l
		}
	}
	return best == nil || best.Allow, best
}
