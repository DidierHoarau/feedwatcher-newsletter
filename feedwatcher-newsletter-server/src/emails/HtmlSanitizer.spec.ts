import {
  HtmlSanitizerGetTextSummary,
  HtmlSanitizerSanitize,
  HtmlSanitizerTextToHtml,
} from "./HtmlSanitizer";

describe("HtmlSanitizerSanitize", () => {
  it("strips script tags and their content", () => {
    expect(
      HtmlSanitizerSanitize('<p>hi</p><script>alert("xss")</script>'),
    ).toBe("<p>hi</p>");
  });

  it("strips event handler attributes", () => {
    expect(HtmlSanitizerSanitize('<p onclick="evil()">hi</p>')).toBe("<p>hi</p>");
  });

  it("strips javascript: URLs", () => {
    const out = HtmlSanitizerSanitize('<a href="javascript:evil()">x</a>');
    expect(out).not.toContain("javascript:");
  });

  it("keeps links and images", () => {
    const out = HtmlSanitizerSanitize(
      '<a href="https://example.com">x</a><img src="https://example.com/i.png" alt="i" width="10" height="10">',
    );
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('src="https://example.com/i.png"');
  });

  it("strips 1x1 tracking pixels declared with attributes", () => {
    const out = HtmlSanitizerSanitize(
      '<img src="https://tracker.example/pixel" width="1" height="1">',
    );
    expect(out).not.toContain("tracker.example");
  });

  it("strips 1x1 tracking pixels declared with inline style", () => {
    const out = HtmlSanitizerSanitize(
      '<img src="https://tracker.example/pixel" style="width:1px;height:1px">',
    );
    expect(out).not.toContain("tracker.example");
  });

  it("keeps normal sized images", () => {
    const out = HtmlSanitizerSanitize(
      '<img src="https://example.com/photo.jpg" width="600" height="400">',
    );
    expect(out).toContain("photo.jpg");
  });

  it("strips one-dimension tracking pixels (width or height only)", () => {
    const cases = [
      '<img src="https://tracker.example/w" width="1">',
      '<img src="https://tracker.example/h" height="1">',
      '<img src="https://tracker.example/sw" style="width:1px">',
      '<img src="https://tracker.example/sh" style="height:1px">',
      '<img src="https://tracker.example/sa" style="width:1px;height:auto">',
    ];
    for (const html of cases) {
      expect(HtmlSanitizerSanitize(html)).not.toContain("tracker.example");
    }
  });

  it("keeps images with one small and one large known dimension", () => {
    const out = HtmlSanitizerSanitize(
      '<img src="https://example.com/line.gif" width="1" height="10">',
    );
    expect(out).toContain("line.gif");
  });

  it("keeps tracking pixels when stripping is disabled", () => {
    const twoDimensions =
      '<img src="https://tracker.example/2d" width="1" height="1">';
    const oneDimension = '<img src="https://tracker.example/1d" width="1">';
    expect(HtmlSanitizerSanitize(twoDimensions, false)).toContain(
      "tracker.example/2d",
    );
    expect(HtmlSanitizerSanitize(oneDimension, false)).toContain(
      "tracker.example/1d",
    );
  });
});

describe("HtmlSanitizerSanitize remote image blocking", () => {
  it("keeps remote image sources when blocking is disabled", () => {
    const html = '<img src="https://cdn.example/hero.jpg" alt="Hero">';
    expect(HtmlSanitizerSanitize(html)).toContain(
      'src="https://cdn.example/hero.jpg"',
    );
    expect(HtmlSanitizerSanitize(html, true, false)).toContain(
      'src="https://cdn.example/hero.jpg"',
    );
  });

  it("removes remote sources and preserves alt, title and dimensions", () => {
    const out = HtmlSanitizerSanitize(
      '<img src="https://cdn.example/hero.jpg" alt="Hero" title="Hero title" width="600" height="400">',
      true,
      true,
    );
    expect(out).not.toContain("cdn.example");
    expect(out).not.toContain("src=");
    expect(out).toContain('alt="Hero"');
    expect(out).toContain('title="Hero title"');
    expect(out).toContain('width="600"');
    expect(out).toContain('height="400"');
  });

  it("removes remote sources regardless of case or surrounding whitespace", () => {
    for (const src of [
      "HTTP://cdn.example/a.jpg",
      "  https://cdn.example/b.jpg  ",
      "//cdn.example/c.jpg",
    ]) {
      const out = HtmlSanitizerSanitize(
        `<img src="${src}" alt="x">`,
        true,
        true,
      );
      expect(out).not.toContain("cdn.example");
      expect(out).not.toContain("src=");
      expect(out).toContain('alt="x"');
    }
  });

  it("leaves relative sources untouched", () => {
    for (const src of ["/img/local.png", "images/local.png"]) {
      const out = HtmlSanitizerSanitize(
        `<img src="${src}" alt="local">`,
        true,
        true,
      );
      expect(out).toContain(`src="${src}"`);
    }
  });

  it("adds a placeholder alt only when the image has no alt text", () => {
    const withoutAlt = HtmlSanitizerSanitize(
      '<img src="https://cdn.example/a.jpg">',
      true,
      true,
    );
    expect(withoutAlt).toContain('alt="[remote image blocked]"');

    const emptyAlt = HtmlSanitizerSanitize(
      '<img src="https://cdn.example/b.jpg" alt="">',
      true,
      true,
    );
    expect(emptyAlt).toContain('alt="[remote image blocked]"');
  });

  it("keeps tracking-pixel stripping independent of remote blocking", () => {
    const pixel = '<img src="https://tracker.example/p" width="1" height="1">';
    // Block on + strip on: the pixel is removed entirely.
    expect(HtmlSanitizerSanitize(pixel, true, true)).not.toContain("<img");
    // Block on + strip off: the image stays without its source.
    const kept = HtmlSanitizerSanitize(pixel, false, true);
    expect(kept).toContain("<img");
    expect(kept).not.toContain("src=");
    expect(kept).not.toContain("tracker.example");
    // Block off + strip on: the pixel is still removed.
    expect(HtmlSanitizerSanitize(pixel, true, false)).not.toContain("<img");
  });
});

describe("HtmlSanitizerGetTextSummary", () => {
  it("extracts plain text from HTML", () => {
    expect(HtmlSanitizerGetTextSummary("<p>Hello <b>world</b></p>")).toBe(
      "Hello world",
    );
  });

  it("truncates long text with an ellipsis", () => {
    const long = "x".repeat(1000);
    const out = HtmlSanitizerGetTextSummary(`<p>${long}</p>`);
    expect(out.length).toBeLessThanOrEqual(501);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("HtmlSanitizerTextToHtml", () => {
  it("escapes HTML in plain text and wraps paragraphs", () => {
    const out = HtmlSanitizerTextToHtml("<b>bold</b>\n\nsecond");
    expect(out).toContain("<p>&lt;b&gt;bold&lt;/b&gt;</p>");
    expect(out).toContain("<p>second</p>");
  });

  it("converts single newlines to line breaks", () => {
    const out = HtmlSanitizerTextToHtml("line1\nline2");
    expect(out).toContain("line1<br/>line2");
  });
});
