package main

import "testing"

// The HTML location of each <img>: landmark › Shopify section › component class (same rules as the Node parser).
func TestImageLocation(t *testing.T) {
	doc := []byte(`<html><body>
<header><div class="header__heading-logo"><img src="/logo.png" alt="Logo"></div></header>
<main><div id="shopify-section-template--123__main"><div class="product__media-gallery"><ul class="product-gallery"><li><img src="/a.jpg"></li></ul></div></div>
<div id="shopify-section-template--123__image_with_text"><img src="/a.jpg"></div>
<p><img src="/plain.jpg" alt="x"></p></main>
<footer><div id="shopify-section-sections--9__footer"><div class="footer__payment badge-row"><img src="/badge.png" alt=""></div></div></footer>
</body></html>`)
	p := extractHTML(doc, "https://shop.test/products/a", "shop.test")
	want := []string{
		`header › .header__heading-logo`,
		`main › section "main" › .product-gallery`,
		`main › section "image_with_text"`,
		`main`,
		`footer › section "footer" › .footer__payment`,
	}
	if len(p.Images) != len(want) {
		t.Fatalf("images %d: %+v", len(p.Images), p.Images)
	}
	for i, w := range want {
		if p.Images[i].Location != w {
			t.Errorf("image %d (%s): location %q, want %q", i, p.Images[i].Src, p.Images[i].Location, w)
		}
	}
}
