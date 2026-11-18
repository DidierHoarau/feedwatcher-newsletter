import * as fs from "fs";
import path from "path";
import sanitizeHtml from "sanitize-html";
import { HtmlSanitizerSanitize } from "./HtmlSanitizer";

// Reduced, anonymized reconstructions of four newsletter families (see the
// comment at the top of each fixture). They reproduce the layout signatures
// and the adversarial cases the sanitizer must handle.
const FIXTURES = ["tldr", "morning-brew", "scmp", "kessel"] as const;

function loadFixture(name: string): string {
  return fs.readFileSync(
    path.join(__dirname, "fixtures", `${name}.html`),
    "utf8",
  );
}

// The pre-change sanitizer options, verbatim in behaviour: default tags plus
// img, no layout attributes, style only on images. Used only to measure the
// payload impact; the production policy lives in HtmlSanitizer.ts.
const LEGACY_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
  allowedSchemes: ["http", "https", "mailto"],
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    img: ["src", "alt", "title", "width", "height", "style"],
    a: ["href", "name", "target", "title"],
  },
  allowedStyles: {
    img: {
      width: [/^[0-9.]+(%|px)?$/],
      height: [/^[0-9.]+(%|px)?$/],
    },
  },
  allowProtocolRelative: false,
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", {
      target: "_blank",
      rel: "noopener noreferrer nofollow",
    }),
  },
};

// Defense in depth: snapshots can be blindly updated, these assertions cannot.
const FORBIDDEN_IN_OUTPUT: Array<{ label: string; pattern: RegExp }> = [
  { label: "script tag", pattern: /<script/i },
  { label: "event handler", pattern: /\son[a-z]+\s*=/i },
  { label: "style block", pattern: /<style/i },
  { label: "url()", pattern: /url\s*\(/i },
  { label: "expression()", pattern: /expression\s*\(/i },
  { label: "position", pattern: /position\s*:/i },
  { label: "overflow", pattern: /overflow\s*:/i },
  { label: "moz-binding", pattern: /-moz-binding/i },
  { label: "behavior", pattern: /behavior\s*:/i },
  { label: "custom property", pattern: /--[a-z-]+\s*:/i },
  { label: "active embedding", pattern: /<iframe|<object|<form|<link/i },
];

describe("HtmlSanitizerSanitize newsletter corpus", () => {
  for (const fixture of FIXTURES) {
    it(`keeps the layout and presentation of the ${fixture} fixture`, () => {
      const html = loadFixture(fixture);
      const out = HtmlSanitizerSanitize(html, true, false);

      expect(out).toMatchSnapshot();
      expect(out).toContain("cellpadding=");
      expect(out).toContain("align=");
      expect(out).toContain("bgcolor=");
      expect(out).toContain("<center>");
      expect(out).toContain("<font");
      expect(out).toMatch(/style="[^"]*color:[^"]*"/);
      expect(out).toMatch(/style="[^"]*font-family:[^"]*"/);
    });

    it(`removes every active or exfiltrating construct from the ${fixture} fixture`, () => {
      const out = HtmlSanitizerSanitize(loadFixture(fixture), true, false);
      for (const { label, pattern } of FORBIDDEN_IN_OUTPUT) {
        expect({ label, found: pattern.test(out) }).toEqual({
          label,
          found: false,
        });
      }
      expect(out).not.toMatch(/<img[^>]*\bwidth="1"[^>]*>/);
      expect(out).not.toContain("tracker.example.com");
      expect(out).not.toContain("evil.example.com");
    });

    it(`is idempotent on the ${fixture} fixture`, () => {
      const once = HtmlSanitizerSanitize(loadFixture(fixture), true, false);
      expect(HtmlSanitizerSanitize(once, true, false)).toBe(once);
    });
  }

  it("keeps the layout when remote images are blocked", () => {
    const html = loadFixture("morning-brew");
    const out = HtmlSanitizerSanitize(html, true, true);

    expect(out).toMatchSnapshot();
    expect(out).toContain('width="600"');
    expect(out).toContain("cellpadding=");
    expect(out).toContain("<center>");
    expect(out).not.toContain("images.example.com");
    expect(out).not.toMatch(/<img[^>]*\bsrc=/);
    expect(out).toContain('alt="Today\'s hero"');
  });

  it("grows the payload only through the preserved presentation", () => {
    // Loose guard: every fixture gains layout attributes and inline styles, so
    // the sanitized output is larger than under the legacy policy. The
    // authoritative numbers come from docs/bench/sanitizer-size-impact.ts.
    for (const fixture of FIXTURES) {
      const html = loadFixture(fixture);
      const legacy = sanitizeHtml(html, LEGACY_OPTIONS);
      const next = HtmlSanitizerSanitize(html, true, false);
      expect(legacy.length).toBeGreaterThan(0);
      expect(next.length).toBeGreaterThan(legacy.length);
    }
  });
});
