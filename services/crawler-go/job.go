package main

import (
	"errors"
	"net/url"
	"strings"
)

// Job is the crawl request sent by the Node.js API (protocol v1). Zero values mean "use the default".
type Job struct {
	JobID           string `json:"jobId"`
	Mode            string `json:"mode"` // "full" | "smart"
	StartURL        string `json:"startUrl"`
	BaseURL         string `json:"baseUrl"`
	ResolveStart    bool   `json:"resolveStart"`
	MaxPages        int    `json:"maxPages"` // 0 = no limit
	MaxDepth        int    `json:"maxDepth"` // <0 = no limit
	Concurrency     int    `json:"concurrency"`
	TimeoutMs       int    `json:"timeoutMs"`
	RequestDelayMs  int    `json:"requestDelayMs"`
	Retries         int    `json:"retries"`
	MaxRetryWaitMs  int    `json:"maxRetryWaitMs"`
	MaxCrawlDelayMs int    `json:"maxCrawlDelayMs"`
	UserAgent       string `json:"userAgent"`
	RespectRobots   bool   `json:"respectRobots"`
	MaxBodyBytes    int    `json:"maxBodyBytes"`
	MaxSitemapFiles int    `json:"maxSitemapFiles"`
	MaxSitemapBytes int    `json:"maxSitemapBytes"`
	AllowLoopback   bool   `json:"allowLoopback"`
	WorkDir         string `json:"workDir"`
	// Paths never crawled ("/blogs/*/tagged/*", "/pages/old"); "*" matches any run of characters.
	ExcludePatterns []string `json:"excludePatterns"`
	// Smart crawl: URLs with evidence (known issues, recently changed, top products) and their priority boost.
	Seeds []Seed `json:"seeds"`
	// Context checks to run after the crawl (robots, sitemap, linkTargets, images, external, scripts, tls, host,
	// collectionScoped, budget, pagination, botProbe).
	Needs         []string     `json:"needs"`
	Limits        Limits       `json:"limits"`
	BotProbes     []BotProbe   `json:"botProbes"`
	TextCore      TextCoreConf `json:"textCore"`
	MemoryLimitMB int          `json:"memoryLimitMB"` // stop taking new pages above this Go heap size (resource stop)
	ProgressMs    int          `json:"progressMs"`
	// ChecksBudgetMs: time the post-crawl checks may take; what is left after it is reported as deferred, never as
	// broken. 0 = automatic (as long as the page crawl took, at least 5 and at most 20 minutes).
	ChecksBudgetMs int `json:"checksBudgetMs,omitempty"`
	// Testing only: skip the TLS certificate probe (local fixtures have no certificate).
	SkipTLS bool `json:"skipTls"`
}

type Seed struct {
	URL      string  `json:"url"`
	Reason   string  `json:"reason"`
	Priority float64 `json:"priority"`
}

type Limits struct {
	LinkChecks              int `json:"linkChecks"`
	SitemapChecks           int `json:"sitemapChecks"`
	ImagesPerPage           int `json:"imagesPerPage"`
	ImagesTotal             int `json:"imagesTotal"`
	ExternalLinks           int `json:"externalLinks"`
	ThirdPartyScripts       int `json:"thirdPartyScripts"`
	CollectionScopedSamples int `json:"collectionScopedSamples"`
	BudgetSamples           int `json:"budgetSamples"`
	PaginationSamples       int `json:"paginationSamples"`
}

type BotProbe struct {
	Bot       string `json:"bot"`
	UserAgent string `json:"userAgent"`
}

type TextCoreConf struct {
	Bin      string `json:"bin"`
	Brand    string `json:"brand"`
	Disabled bool   `json:"disabled"`
}

func (j *Job) normalize() error {
	if j.Mode == "" {
		j.Mode = "full"
	}
	if j.Mode != "full" && j.Mode != "smart" {
		return errors.New("mode must be full or smart")
	}
	if j.WorkDir == "" {
		return errors.New("workDir is required")
	}
	if j.BaseURL == "" {
		j.BaseURL = j.StartURL
	}
	b, err := url.Parse(j.BaseURL)
	if err != nil || (b.Scheme != "http" && b.Scheme != "https") || b.Host == "" {
		return errors.New("baseUrl must be an absolute http(s) URL")
	}
	if j.StartURL == "" {
		j.StartURL = b.Scheme + "://" + b.Host + "/"
	}
	if !isSameSite(j.StartURL, b.Host) {
		return errors.New("startUrl must be on the same website as baseUrl")
	}
	def := func(v *int, d int) {
		if *v <= 0 {
			*v = d
		}
	}
	def(&j.Concurrency, 4)
	if j.Concurrency > 32 {
		j.Concurrency = 32
	}
	def(&j.TimeoutMs, 15000)
	def(&j.MaxRetryWaitMs, 30000)
	def(&j.MaxCrawlDelayMs, 30000)
	def(&j.MaxBodyBytes, 5<<20)
	def(&j.MaxSitemapFiles, 1000)
	def(&j.MaxSitemapBytes, 50<<20)
	def(&j.ProgressMs, 1000)
	if j.RequestDelayMs < 0 {
		j.RequestDelayMs = 0
	}
	if j.Retries < 0 {
		j.Retries = 0
	}
	if j.UserAgent == "" {
		j.UserAgent = "DeoDapSEOSentinel/1.0 (+site audit)"
	}
	l := &j.Limits
	def(&l.LinkChecks, 400)
	def(&l.SitemapChecks, 500)
	def(&l.ImagesPerPage, 10)
	def(&l.ImagesTotal, 300)
	def(&l.ExternalLinks, 60)
	def(&l.ThirdPartyScripts, 40)
	def(&l.CollectionScopedSamples, 8)
	def(&l.BudgetSamples, 10)
	def(&l.PaginationSamples, 5)
	if len(j.Needs) == 0 {
		j.Needs = []string{"robots", "sitemap", "linkTargets", "images", "external", "scripts", "tls", "host", "collectionScoped", "budget", "pagination", "botProbe"}
	}
	for i := range j.ExcludePatterns {
		j.ExcludePatterns[i] = strings.TrimSpace(j.ExcludePatterns[i])
	}
	return nil
}

func (j *Job) needs(n string) bool {
	for _, x := range j.Needs {
		if x == n {
			return true
		}
	}
	return false
}
