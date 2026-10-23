import { ROOT_CONTEXT } from "@opentelemetry/api";
import { FastifyRequest } from "fastify";
import { OTelRequestContext, OTelRunWithRequestContext } from "./OTelContext";

jest.mock("@devopsplaybook.io/otel-utils-fastify", () => ({
  ...jest.requireActual("@devopsplaybook.io/otel-utils-fastify"),
  OTelRequestContext: jest.fn(),
}));

const requestContextMock = OTelRequestContext as unknown as jest.Mock;

describe("OTelRunWithRequestContext", () => {
  const request = {} as FastifyRequest;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("runs the handler inside the request context and returns its value", () => {
    requestContextMock.mockReturnValue(ROOT_CONTEXT);
    const handler = jest.fn(() => "result");

    expect(OTelRunWithRequestContext(request, handler)).toBe("result");
    expect(requestContextMock).toHaveBeenCalledWith(request);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("calls the handler directly when the request was not traced", () => {
    requestContextMock.mockReturnValue(undefined);
    const handler = jest.fn(() => "fallback");

    expect(OTelRunWithRequestContext(request, handler)).toBe("fallback");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
