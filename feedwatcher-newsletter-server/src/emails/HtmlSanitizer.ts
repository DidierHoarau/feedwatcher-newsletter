import sanitizeHtml from "sanitize-html";

const SUMMARY_MAX_LENGTH = 500;

// Inline styles are allowlisted for presentation only: `<style>` blocks and
// remote CSS stay banned, no value may load a URL or execute code. Each regex
// is anchored because sanitize-html matches declarations with RegExp.test.
const LENGTH = String.raw`(?:0|-?[0-9]+(?:\.[0-9]+)?(?:px|pt|em|rem|%))`;
const COLOR = String.raw`(?:#[0-9a-f]{3,8}|rgba?\([^()]*\)|hsla?\([^()]*\)|(?!url|expression|image-set|var|env|attr)[a-z]{3,20})`;
const colorRe = new RegExp(`^${COLOR}$`, "i");
const sizeRe = new RegExp(`^(?:auto|${LENGTH})$`, "i");
const boxRe = new RegExp(
  `^(?:auto|${LENGTH})(?:\\s+(?:auto|${LENGTH})){0,3}$`,
  "i",
);
const borderRe = new RegExp(
  `^(?:0|none|[0-9]+(?:\\.[0-9]+)?(?:px|pt|em|rem)?\\s+` +
    `(?:none|solid|dashed|dotted|double|groove|ridge|inset|outset)(?:\\s+${COLOR})?)$`,
  "i",
);
const borderWidthRe = new RegExp(
  `^(?:thin|medium|thick|${LENGTH})(?:\\s+(?:thin|medium|thick|${LENGTH})){0,3}$`,
  "i",
);
const borderStyleRe = new RegExp(
  `^(?:none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)` +
    `(?:\\s+(?:none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)){0,3}$`,
  "i",
);
const borderColorRe = new RegExp(`^${COLOR}(?:\\s+${COLOR}){0,3}$`, "i");

// Allowed values are presentation-only: a table/cell layout, typography,
// colors, borders, spacing, sizing and alignment. Anything unknown (including
// position, overflow, display, float, transforms, custom properties and
// url()/expression()/var()/calc()) is dropped by this allowlist, never by a
// blacklist.
const allowedStyles: sanitizeHtml.IOptions["allowedStyles"] = {
  "*": {
    color: [colorRe],
    "background-color": [colorRe],
    background: [colorRe],
    "font-family": [/^[a-z0-9][a-z0-9 ,'"_-]*$/i],
    "font-size": [
      new RegExp(
        `^(?:${LENGTH}|xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)$`,
        "i",
      ),
    ],
    "font-weight": [/^(?:normal|bold|bolder|lighter|[1-9]00)$/i],
    "font-style": [/^(?:normal|italic|oblique)$/i],
    "line-height": [
      /^(?:normal|[0-9]+(?:\.[0-9]+)?(?:px|pt|em|rem|%)?)$/i,
    ],
    "letter-spacing": [new RegExp(`^(?:normal|${LENGTH})$`, "i")],
    "text-align": [/^(?:left|right|center|justify|start|end)$/i],
    "vertical-align": [
      new RegExp(
        `^(?:baseline|sub|super|text-top|text-bottom|middle|top|bottom|${LENGTH})$`,
        "i",
      ),
    ],
    "text-transform": [/^(?:none|capitalize|uppercase|lowercase)$/i],
    "text-decoration": [/^(?:none|underline|overline|line-through)$/i],
    "white-space": [/^(?:normal|nowrap|pre|pre-wrap|pre-line)$/i],
    padding: [boxRe],
    margin: [boxRe],
    "padding-top": [new RegExp(`^${LENGTH}$`, "i")],
    "padding-right": [new RegExp(`^${LENGTH}$`, "i")],
    "padding-bottom": [new RegExp(`^${LENGTH}$`, "i")],
    "padding-left": [new RegExp(`^${LENGTH}$`, "i")],
    "margin-top": [sizeRe],
    "margin-right": [sizeRe],
    "margin-bottom": [sizeRe],
    "margin-left": [sizeRe],
    width: [sizeRe],
    "max-width": [sizeRe],
    height: [sizeRe],
    border: [borderRe],
    "border-top": [borderRe],
    "border-right": [borderRe],
    "border-bottom": [borderRe],
    "border-left": [borderRe],
    "border-width": [borderWidthRe],
    "border-style": [borderStyleRe],
    "border-color": [borderColorRe],
    "border-collapse": [/^(?:collapse|separate)$/i],
    "border-spacing": [new RegExp(`^${LENGTH}(?:\\s+${LENGTH})?$`, "i")],
    "border-radius": [
      new RegExp(`^${LENGTH}(?:\\s+${LENGTH}){0,3}$`, "i"),
    ],
  },
};

function buildSanitizeOptions(
  stripTrackingPixels: boolean,
  blockRemoteImages: boolean,
): sanitizeHtml.IOptions {
  return {
    // img, center and font are not in the sanitize-html defaults but
    // newsletter bodies need them for their legacy table layout.
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      "img",
      "center",
      "font",
    ]),
    allowedSchemes: ["http", "https", "mailto"],
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      "*": ["style", "align", "valign"],
      table: [
        "width",
        "height",
        "align",
        "valign",
        "bgcolor",
        "border",
        "cellpadding",
        "cellspacing",
      ],
      td: ["width", "height", "align", "valign", "bgcolor", "colspan", "rowspan"],
      th: [
        "width",
        "height",
        "align",
        "valign",
        "bgcolor",
        "colspan",
        "rowspan",
        "scope",
      ],
      tr: ["width", "height", "align", "valign", "bgcolor"],
      caption: ["align", "valign"],
      col: ["width", "span", "align", "valign"],
      colgroup: ["width", "span", "align", "valign"],
      font: ["face", "color", "size"],
      img: ["src", "alt", "title", "width", "height", "style"],
      // rel must be allowed for the forced noopener/noreferrer/nofollow
      // transform below to survive attribute filtering
      a: ["href", "name", "target", "title", "rel"],
    },
    allowedStyles,
    allowProtocolRelative: false,
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer nofollow" }),
      img: (tagName, attribs) =>
        blockRemoteImages ? blockRemoteImageSource(tagName, attribs) : { tagName, attribs },
    },
    exclusiveFilter: (frame) => {
      if (!stripTrackingPixels || frame.tag !== "img") {
        return false;
      }
      // A tracking pixel is an image with at least one known dimension <= 1
      // and no known dimension > 1: covers 1x1 images declared with both
      // dimensions as well as <img width="1"> / style="width:1px" (height
      // auto). Width/height may come from attributes or inline style.
      const width = dimensionFromAttribs(frame.attribs.width, frame.attribs.style, "width");
      const height = dimensionFromAttribs(frame.attribs.height, frame.attribs.style, "height");
      const known = [width, height].filter(
        (value): value is number => value !== undefined,
      );
      return (
        known.some((value) => value <= 1) &&
        !known.some((value) => value > 1)
      );
    },
  };
}

// Privacy: remove the source of remote images so the reader's browser never
// contacts the sender. The image stays in place (with its layout attributes
// and alt/title) so the newsletter structure is preserved; relative and
// already-disallowed sources are left to the regular sanitizer.
function blockRemoteImageSource(
  tagName: string,
  attribs: Record<string, string>,
): { tagName: string; attribs: Record<string, string> } {
  const src = (attribs.src || "").trim().toLowerCase();
  const isRemote =
    src.startsWith("http://") || src.startsWith("https://") || src.startsWith("//");
  if (!isRemote) {
    return { tagName, attribs };
  }
  const { src: _src, ...rest } = attribs;
  if (!rest.alt || rest.alt.trim() === "") {
    rest.alt = "[remote image blocked]";
  }
  return { tagName, attribs: rest };
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

function sizeFromStyle(style: string | undefined, property: string): number | undefined {
  if (!style) return undefined;
  const match = style.match(new RegExp(`${property}\\s*:\\s*([0-9.]+)`, "i"));
  return match ? Number(match[1]) : undefined;
}

// Strip scripts, event handlers, dangerous URLs and tracking pixels while
// keeping links, images, the regular newsletter layout tags, table/cell layout
// attributes and presentation-only inline styles. `<style>` blocks and remote
// CSS stay banned. Tracking-pixel stripping can be disabled per call
// (EMAIL_STRIP_TRACKING_PIXELS); remote image blocking is opt-in
// (EMAIL_BLOCK_REMOTE_IMAGES).
export function HtmlSanitizerSanitize(
  html: string,
  stripTrackingPixels = true,
  blockRemoteImages = false,
): string {
  if (!html) return "";
  return sanitizeHtml(
    html,
    buildSanitizeOptions(stripTrackingPixels, blockRemoteImages),
  );
}

// Plain-text summary of an HTML body, for the RSS <description> element.
export function HtmlSanitizerGetTextSummary(html: string): string {
  if (!html) return "";
  const text = sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= SUMMARY_MAX_LENGTH) {
    return text;
  }
  return `${text.slice(0, SUMMARY_MAX_LENGTH).trimEnd()}…`;
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Convert a plain-text body to simple HTML paragraphs so every stored body is
// valid HTML (ingestion normalizes to HTML).
export function HtmlSanitizerTextToHtml(text: string): string {
  if (!text) return "";
  return text
    .split(/\r?\n\r?\n+/)
    .map(
      (paragraph) =>
        `<p>${escapeHtmlText(paragraph).replace(/\r?\n/g, "<br/>")}</p>`,
    )
    .join("\n");
}
