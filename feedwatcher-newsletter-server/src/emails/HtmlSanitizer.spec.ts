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

describe("HtmlSanitizerSanitize newsletter layout attributes", () => {
  it("keeps table, row and cell layout attributes", () => {
    const out = HtmlSanitizerSanitize(
      '<table width="600" height="400" align="center" valign="top" bgcolor="#ffffff" border="0" cellpadding="8" cellspacing="0">' +
        '<caption align="bottom" valign="top">c</caption>' +
        '<colgroup width="200" span="2" align="left" valign="top"><col width="100" span="1" align="right" valign="bottom"></colgroup>' +
        '<tr width="600" height="20" align="left" valign="middle" bgcolor="#eeeeee">' +
        '<th width="300" height="20" align="left" valign="top" bgcolor="#dddddd" colspan="2" rowspan="1" scope="col">h</th>' +
        '<td width="100" height="20" align="right" valign="bottom" bgcolor="#cccccc" colspan="1" rowspan="2">d</td>' +
        "</tr></table>",
    );
    for (const attribute of [
      'width="600"',
      'height="400"',
      'align="center"',
      'valign="top"',
      'bgcolor="#ffffff"',
      'cellpadding="8"',
      'cellspacing="0"',
      'colspan="2"',
      'rowspan="2"',
      'scope="col"',
      'span="2"',
    ]) {
      expect(out).toContain(attribute);
    }
  });

  it("keeps presentational center and font tags", () => {
    const out = HtmlSanitizerSanitize(
      '<center><font face="Arial, sans-serif" color="#123456" size="4">text</font></center>',
    );
    expect(out).toBe(
      '<center><font face="Arial, sans-serif" color="#123456" size="4">text</font></center>',
    );
  });

  it("keeps allowlisted inline style categories", () => {
    const out = HtmlSanitizerSanitize(
      '<td style="color:#123456;background-color:#ffffff;background:#eeeeee;' +
        "font-family:Arial, sans-serif;font-size:14px;font-weight:bold;font-style:italic;" +
        "line-height:1.5;letter-spacing:1px;text-transform:uppercase;text-decoration:underline;white-space:nowrap;" +
        "text-align:center;vertical-align:middle;" +
        "padding:8px 12px;padding-top:4px;margin:0 auto;margin-left:10px;" +
        'width:600px;max-width:100%;height:auto;' +
        "border:1px solid #cccccc;border-top:2px dashed #ff0000;border-width:1px 2px;" +
        "border-style:solid dashed;border-color:#ffffff #000000;" +
        'border-collapse:collapse;border-spacing:0 4px;border-radius:4px">x</td>',
    );
    for (const declaration of [
      "color:#123456",
      "background-color:#ffffff",
      "background:#eeeeee",
      "font-family:Arial, sans-serif",
      "font-size:14px",
      "font-weight:bold",
      "font-style:italic",
      "line-height:1.5",
      "letter-spacing:1px",
      "text-transform:uppercase",
      "text-decoration:underline",
      "white-space:nowrap",
      "text-align:center",
      "vertical-align:middle",
      "padding:8px 12px",
      "padding-top:4px",
      "margin:0 auto",
      "margin-left:10px",
      "width:600px",
      "max-width:100%",
      "height:auto",
      "border:1px solid #cccccc",
      "border-top:2px dashed #ff0000",
      "border-width:1px 2px",
      "border-style:solid dashed",
      "border-color:#ffffff #000000",
      "border-collapse:collapse",
      "border-spacing:0 4px",
      "border-radius:4px",
    ]) {
      expect(out).toContain(declaration);
    }
  });

  it("keeps !important on an allowlisted property", () => {
    const out = HtmlSanitizerSanitize(
      '<p style="color:#123456 !important;position:absolute !important">x</p>',
    );
    expect(out).toContain("color:#123456 !important");
    expect(out).not.toContain("position");
  });

  it("drops hostile or unknown inline declarations", () => {
    const out = HtmlSanitizerSanitize(
      '<div style="position:absolute;overflow:hidden;top:0;left:0;z-index:9;' +
        "display:block;float:left;transform:scale(1);filter:blur(1px);opacity:0;content:\\'x\\';" +
        "background-image:url(https://evil.example/x.png);" +
        "background:url(https://evil.example/y.png);" +
        "list-style-image:url(https://evil.example/z.png);" +
        "color:expression(alert(1));behavior:url(https://evil.example/b.htc);" +
        "-moz-binding:url(https://evil.example/bind.xml);--custom:1;" +
        "color:var(--x);width:calc(100% - 10px);height:env(safe-area-inset-top);" +
        'background:u\\72l(https://evil.example/escaped.png);color:#123456">x</div>',
    );
    expect(out).not.toMatch(
      /position|overflow|top:|left:|z-index|display|float:|transform|filter:|opacity|content:|url\s*\(|expression|behavior|moz-binding|--custom|var\(|calc\(|env\(/i,
    );
    expect(out).toContain("color:#123456");
  });

  it("removes style blocks, links and active embedding", () => {
    const out = HtmlSanitizerSanitize(
      '<style>body { background: url(https://evil.example/bg.png); }</style>' +
        '<link rel="stylesheet" href="https://evil.example/x.css">' +
        '<iframe src="https://evil.example"></iframe>' +
        '<object data="https://evil.example"></object>' +
        '<form action="https://evil.example"><input name="q"></form>' +
        "<p>kept</p>",
    );
    expect(out).toBe("<p>kept</p>");
  });

  it("removes background and srcset attributes while keeping images", () => {
    const out = HtmlSanitizerSanitize(
      '<table background="https://tracker.example/bg"><tr>' +
        '<td background="https://tracker.example/cell">x</td></tr></table>' +
        '<img src="https://cdn.example/photo.jpg" srcset="https://cdn.example/2x.jpg 2x" alt="p" width="600" height="400">',
    );
    expect(out).not.toContain("tracker.example");
    expect(out).not.toContain("srcset");
    expect(out).toContain('src="https://cdn.example/photo.jpg"');
    expect(out).toContain('width="600"');
    expect(out).toContain('height="400"');
  });

  it("keeps the tracking-pixel detection with inline styles allowed", () => {
    for (const html of [
      '<img src="https://tracker.example/p" width="1" height="1">',
      '<img src="https://tracker.example/p" style="width:1px;height:auto">',
      '<img src="https://tracker.example/p" style="width:1px;height:1px">',
    ]) {
      expect(HtmlSanitizerSanitize(html)).not.toContain("<img");
    }
    const normal = HtmlSanitizerSanitize(
      '<img src="https://cdn.example/hero.jpg" width="600" height="400" style="width:600px;height:auto">',
    );
    expect(normal).toContain('width="600"');
    expect(normal).toContain('style="width:600px;height:auto"');
  });
});

describe("HtmlSanitizerSanitize links", () => {
  it("forces target and rel on links", () => {
    const out = HtmlSanitizerSanitize('<a href="https://example.com">x</a>');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain('target="_blank"');
  });

  it("replaces an attacker-supplied rel", () => {
    const out = HtmlSanitizerSanitize(
      '<a href="https://example.com" rel="opener">x</a>',
    );
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).not.toMatch(/rel="[^"]*opener"/);
  });

  it("still drops dangerous and protocol-relative URLs", () => {
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "//evil.example/x",
    ]) {
      const out = HtmlSanitizerSanitize(`<a href="${href}">x</a>`);
      expect(out).not.toContain("href=");
    }
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
