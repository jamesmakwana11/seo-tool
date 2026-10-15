package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"syscall"
	"time"
)

// SSRF protection, equivalent to the Node API's netguard:
//   - only http(s) URLs without credentials;
//   - internal host names (localhost, *.internal, *.local, metadata names) are refused;
//   - every address actually connected to is checked in the dialer's Control hook, so loopback, private, link-local
//     (cloud metadata), CGNAT, multicast, documentation and reserved ranges are refused at connect time — including
//     IPv4 embedded in IPv6 — which also defeats DNS rebinding; redirects are followed manually and re-checked.
//   - loopback may be allowed only for local fixture crawls outside production.

type blockedError struct{ msg string }

func (e *blockedError) Error() string { return e.msg }

func isBlocked(err error) bool {
	var b *blockedError
	return errors.As(err, &b)
}

type ipRange struct {
	prefix netip.Prefix
	label  string
}

var blockedRanges = func() []ipRange {
	spec := [][2]string{
		{"0.0.0.0/8", `"this network" range`}, {"10.0.0.0/8", "a private address"}, {"100.64.0.0/10", "a carrier-grade NAT address"},
		{"127.0.0.0/8", "a loopback address"}, {"169.254.0.0/16", "a link-local / cloud metadata address"}, {"172.16.0.0/12", "a private address"},
		{"192.0.0.0/24", "an IETF protocol address"}, {"192.0.2.0/24", "a documentation address"}, {"192.88.99.0/24", "a 6to4 relay address"},
		{"192.168.0.0/16", "a private address"}, {"198.18.0.0/15", "a benchmarking address"}, {"198.51.100.0/24", "a documentation address"},
		{"203.0.113.0/24", "a documentation address"}, {"224.0.0.0/4", "a multicast address"}, {"240.0.0.0/4", "a reserved address"},
		{"::/128", "the unspecified address"}, {"::1/128", "a loopback address"}, {"100::/64", "a discard address"}, {"2001:db8::/32", "a documentation address"},
		{"fc00::/7", "a private (unique local) address"}, {"fe80::/10", "a link-local address"}, {"fec0::/10", "a site-local address"}, {"ff00::/8", "a multicast address"},
	}
	out := make([]ipRange, 0, len(spec))
	for _, s := range spec {
		out = append(out, ipRange{netip.MustParsePrefix(s[0]), s[1]})
	}
	return out
}()

var (
	nat64  = netip.MustParsePrefix("64:ff9b::/96")
	sixTo4 = netip.MustParsePrefix("2002::/16")
)

// blockedAddressReason: why ip may not be contacted ("" = public).
func blockedAddressReason(ip netip.Addr, allowLoopback bool) string {
	ip = ip.WithZone("")
	if ip.Is4In6() {
		ip = ip.Unmap()
	}
	if ip.Is6() {
		b := ip.As16()
		if nat64.Contains(ip) {
			return blockedAddressReason(netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]}), allowLoopback)
		}
		if sixTo4.Contains(ip) {
			return blockedAddressReason(netip.AddrFrom4([4]byte{b[2], b[3], b[4], b[5]}), allowLoopback)
		}
	}
	for _, r := range blockedRanges {
		if r.prefix.Contains(ip) {
			if allowLoopback && r.label == "a loopback address" {
				return ""
			}
			return r.label
		}
	}
	return ""
}

var internalName = regexp.MustCompile(`(?i)(^|\.)(localhost|internal|local|localdomain|home\.arpa|intranet|lan)$|^metadata(\.google\.internal)?$|^instance-data$`)

// checkURL validates scheme, credentials, host name and IP literals before any request.
func checkURL(raw string, allowLoopback bool) error {
	u, err := url.Parse(raw)
	if err != nil {
		return &blockedError{fmt.Sprintf("blocked: not a valid URL (%.120s)", raw)}
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return &blockedError{fmt.Sprintf("blocked: only http and https URLs can be crawled (%s:)", u.Scheme)}
	}
	if u.User != nil {
		return &blockedError{"blocked: URLs with embedded credentials are not crawled"}
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "" {
		return &blockedError{"blocked: URL has no host"}
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		if why := blockedAddressReason(ip, allowLoopback); why != "" {
			return &blockedError{fmt.Sprintf("blocked: %s is %s", host, why)}
		}
		return nil
	}
	if internalName.MatchString(host) && !(allowLoopback && (host == "localhost" || strings.HasSuffix(host, ".localhost"))) {
		return &blockedError{fmt.Sprintf("blocked: %s is an internal host name", host)}
	}
	return nil
}

// guardedDialer refuses blocked addresses at connect time (after DNS resolution, for every connection).
func guardedDialer(allowLoopback bool, timeout time.Duration) *net.Dialer {
	return &net.Dialer{
		Timeout:   timeout,
		KeepAlive: 30 * time.Second,
		Control: func(network, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return &blockedError{"blocked: bad address " + address}
			}
			ip, err := netip.ParseAddr(host)
			if err != nil {
				return &blockedError{"blocked: unresolved address " + address}
			}
			if why := blockedAddressReason(ip, allowLoopback); why != "" {
				return &blockedError{fmt.Sprintf("blocked: connection to %s refused, %s", host, why)}
			}
			return nil
		},
	}
}

// preflightResolve checks every address a host resolves to (clear error before the crawl starts).
func preflightResolve(ctx context.Context, raw string, allowLoopback bool) error {
	if err := checkURL(raw, allowLoopback); err != nil {
		return err
	}
	u, _ := url.Parse(raw)
	host := u.Hostname()
	if _, err := netip.ParseAddr(host); err == nil {
		return nil
	}
	addrs, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return &blockedError{fmt.Sprintf("could not resolve %s: %v", host, err)}
	}
	if len(addrs) == 0 {
		return &blockedError{"could not resolve " + host}
	}
	for _, a := range addrs {
		if why := blockedAddressReason(a, allowLoopback); why != "" {
			return &blockedError{fmt.Sprintf("blocked: %s resolves to %s, %s", host, a, why)}
		}
	}
	return nil
}
