import sanitizeHtml from "sanitize-html";

const SUMMARY_MAX_LENGTH = 500;

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  // img is not in the sanitize-html defaults but newsletter bodies need it
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
  allowedSchemes: ["http", "https", "mailto"],
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    img: ["src", "alt", "title", "width", "height", "style"],
    a: ["href", "name", "target", "title"],
  },
  // style is kept on images only for width/height, so tracking pixels can be
  // detected below; everything else is stripped
  allowedStyles: {
    img: {
      width: [/^[0-9.]+(%|px)?$/],
      height: [/^[0-9.]+(%|px)?$/],
    },
  },
  allowProtocolRelative: false,
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer nofollow" }),
  },
  exclusiveFilter: (frame) => {
    if (frame.tag !== "img") {
      return false;
    }
    // Tracking pixels: 1x1 (or 0-sized) images whose only purpose is read
    // receipts. Width/height may come from attributes or inline style.
    const width = Number(frame.attribs.width ?? widthFromStyle(frame.attribs.style));
    const height = Number(frame.attribs.height ?? heightFromStyle(frame.attribs.style));
    if (Number.isNaN(width) || Number.isNaN(height)) {
      return false;
    }
    return width <= 1 && height <= 1;
  },
};

function sizeFromStyle(style: string | undefined, property: string): number | undefined {
  if (!style) return undefined;
  const match = style.match(new RegExp(`${property}\\s*:\\s*([0-9.]+)`, "i"));
  return match ? Number(match[1]) : undefined;
}

function widthFromStyle(style: string | undefined): number | undefined {
  return sizeFromStyle(style, "width");
}

function heightFromStyle(style: string | undefined): number | undefined {
  return sizeFromStyle(style, "height");
}

// Strip scripts, event handlers, dangerous URLs and tracking pixels while
// keeping links, images and the regular newsletter layout tags.
export function HtmlSanitizerSanitize(html: string): string {
  if (!html) return "";
  return sanitizeHtml(html, SANITIZE_OPTIONS);
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
