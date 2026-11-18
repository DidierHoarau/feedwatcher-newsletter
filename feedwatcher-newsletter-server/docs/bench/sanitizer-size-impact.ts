import * as fs from "fs";
import path from "path";
import sanitizeHtml from "sanitize-html";
import { HtmlSanitizerSanitize } from "../../src/emails/HtmlSanitizer";

// Payload impact of the newsletter layout-fidelity policy: the same reduced
// corpus is sanitized with the previous options (baseline at 23001dd,
// measurement only) and with the current HtmlSanitizerSanitize.
//
// Run: cd feedwatcher-newsletter-server && npx tsx docs/bench/sanitizer-size-impact.ts

const FIXTURES = ["tldr", "morning-brew", "scmp", "kessel"] as const;

function sizeFromStyle(
  style: string | undefined,
  property: string,
): number | undefined {
  if (!style) return undefined;
  const match = style.match(new RegExp(`${property}\\s*:\\s*([0-9.]+)`, "i"));
  return match ? Number(match[1]) : undefined;
}

function dimensionFromAttribs(
  attribute: string | undefined,
  style: string | undefined,
  property: string,
): number | undefined {
  if (attribute !== undefined && attribute !== "") {
    const parsed = Number(attribute);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return sizeFromStyle(style, property);
}

// Verbatim behaviour of the pre-change options in HtmlSanitizer.ts at 23001dd.
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
  exclusiveFilter: (frame) => {
    if (frame.tag !== "img") {
      return false;
    }
    const width = dimensionFromAttribs(
      frame.attribs.width,
      frame.attribs.style,
      "width",
    );
    const height = dimensionFromAttribs(
      frame.attribs.height,
      frame.attribs.style,
      "height",
    );
    const known = [width, height].filter(
      (value): value is number => value !== undefined,
    );
    return (
      known.some((value) => value <= 1) &&
      !known.some((value) => value > 1)
    );
  },
};

function percent(value: number, base: number): string {
  if (base === 0) return "n/a";
  const change = ((value - base) / base) * 100;
  return `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`;
}

function pad(value: string, width: number): string {
  return value.padStart(width);
}

let rawTotal = 0;
let legacyTotal = 0;
let nextTotal = 0;

console.log(
  [
    pad("fixture", 14),
    pad("raw", 8),
    pad("legacy", 8),
    pad("current", 8),
    pad("current vs legacy", 18),
    pad("current vs raw", 16),
  ].join(" "),
);

for (const fixture of FIXTURES) {
  const raw = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "emails", "fixtures", `${fixture}.html`),
    "utf8",
  );
  const legacy = sanitizeHtml(raw, LEGACY_OPTIONS);
  const next = HtmlSanitizerSanitize(raw, true, false);
  rawTotal += raw.length;
  legacyTotal += legacy.length;
  nextTotal += next.length;
  console.log(
    [
      pad(fixture, 14),
      pad(String(raw.length), 8),
      pad(String(legacy.length), 8),
      pad(String(next.length), 8),
      pad(percent(next.length, legacy.length), 18),
      pad(percent(next.length, raw.length), 16),
    ].join(" "),
  );
}

console.log(
  [
    pad("total", 14),
    pad(String(rawTotal), 8),
    pad(String(legacyTotal), 8),
    pad(String(nextTotal), 8),
    pad(percent(nextTotal, legacyTotal), 18),
    pad(percent(nextTotal, rawTotal), 16),
  ].join(" "),
);
