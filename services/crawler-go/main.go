// Command sentinel-crawler is DeoDap SEO Sentinel's production website crawler.
//
// Protocol v1 (newline-delimited JSON over stdio):
//
//	stdin  line 1: {"type":"start","protocol":1,"job":{...}}      — see Job
//	stdin  later : {"type":"cancel","reason":"user"|"resource"}  — stop, keep what was fetched
//	stdout       : {"type":"hello"|"phase"|"progress"|"sitemap"|"warning"|"error"|"done", ...}
//
// Results are written to the job's work directory (pages.ndjson.gz, urls.ndjson.gz, sitemap.ndjson.gz, context.json
// and, from the Rust text core, text.json). Only progress and the final summary travel over stdout.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"
)

const protocolVersion = 1
const crawlerVersion = "1.0.0"

type emitter struct {
	mu sync.Mutex
	w  *bufio.Writer
}

func (e *emitter) emit(v map[string]any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	e.mu.Lock()
	e.w.Write(b)
	e.w.WriteByte('\n')
	e.w.Flush()
	e.mu.Unlock()
}

func (e *emitter) warn(code, msg string) {
	e.emit(map[string]any{"type": "warning", "code": code, "message": msg})
}

type startMsg struct {
	Type     string `json:"type"`
	Protocol int    `json:"protocol"`
	Job      Job    `json:"job"`
}

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "--version" || os.Args[1] == "version") {
		fmt.Printf("sentinel-crawler %s (protocol %d, %s)\n", crawlerVersion, protocolVersion, runtime.Version())
		return
	}
	ev := &emitter{w: bufio.NewWriter(os.Stdout)}
	in := bufio.NewReaderSize(os.Stdin, 1<<20)
	line, err := in.ReadString('\n')
	if err != nil && strings.TrimSpace(line) == "" {
		ev.emit(map[string]any{"type": "error", "code": "no_job", "message": "no start message on stdin"})
		os.Exit(2)
	}
	var start startMsg
	if err := json.Unmarshal([]byte(line), &start); err != nil || start.Type != "start" {
		ev.emit(map[string]any{"type": "error", "code": "bad_job", "message": fmt.Sprintf("invalid start message: %v", err)})
		os.Exit(2)
	}
	if start.Protocol != protocolVersion {
		ev.emit(map[string]any{"type": "error", "code": "protocol_mismatch", "message": fmt.Sprintf("crawler speaks protocol %d, API sent %d", protocolVersion, start.Protocol)})
		os.Exit(2)
	}
	ev.emit(map[string]any{"type": "hello", "protocol": protocolVersion, "version": crawlerVersion, "go": runtime.Version(), "pid": os.Getpid()})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c, err := newCrawler(ctx, cancel, start.Job, ev)
	if err != nil {
		ev.emit(map[string]any{"type": "error", "code": "bad_job", "message": err.Error()})
		ev.emit(map[string]any{"type": "done", "state": "failed", "reason": err.Error()})
		os.Exit(1)
	}
	// Control messages: cancel. EOF (the API process went away) also stops the crawl.
	go func() {
		for {
			l, err := in.ReadString('\n')
			if strings.TrimSpace(l) != "" {
				var m struct {
					Type   string `json:"type"`
					Reason string `json:"reason"`
				}
				if json.Unmarshal([]byte(l), &m) == nil && m.Type == "cancel" {
					c.stop(m.Reason)
				}
			}
			if err != nil {
				c.stop("parent_gone")
				return
			}
		}
	}()
	code := c.run()
	time.Sleep(10 * time.Millisecond)
	os.Exit(code)
}
