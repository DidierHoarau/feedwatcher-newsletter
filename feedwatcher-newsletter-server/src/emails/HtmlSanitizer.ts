import sanitizeHtml from "sanitize-html";

const SUMMARY_MAX_LENGTH = 500;

function buildSanitizeOptions(
  stripTrackingPixels: boolean,
  blockRemoteImages: boolean,
): sanitizeHtml.IOptions {
  return {
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
// keeping links, images and the regular newsletter layout tags. Tracking-pixel
// stripping can be disabled per call (EMAIL_STRIP_TRACKING_PIXELS); remote
// image blocking is opt-in (EMAIL_BLOCK_REMOTE_IMAGES).
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
