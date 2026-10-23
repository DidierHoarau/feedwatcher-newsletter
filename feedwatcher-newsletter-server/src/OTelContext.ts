import { context } from "@opentelemetry/api";
import { createOTelContext } from "@devopsplaybook.io/common-utils";
import { OTelRequestContext } from "@devopsplaybook.io/otel-utils-fastify";
import { FastifyRequest } from "fastify";

const otel = createOTelContext();

export const OTelTracer = otel.OTelTracer;
export const OTelSetTracer = otel.OTelSetTracer;
export const OTelMeter = otel.OTelMeter;
export const OTelSetMeter = otel.OTelSetMeter;
export const OTelLogger = otel.OTelLogger;
export const OTelRequestSpan = otel.OTelRequestSpan;
export { OTelRequestContext };

// Run a handler with the HTTP server span active, so spans created during the
// handler become children of the request span. Falls back to a plain call when
// the request was not traced (e.g. /api/status).
export function OTelRunWithRequestContext<T>(
  request: FastifyRequest,
  handler: () => T,
): T {
  const requestContext = OTelRequestContext(request);
  return requestContext ? context.with(requestContext, handler) : handler();
}
