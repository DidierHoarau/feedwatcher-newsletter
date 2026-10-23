import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as tls from "tls";
import { Config } from "../Config";
import {
  BuildImapFlowOptions,
  ImapLogConnectionError,
  ImapTlsFailureMessage,
  IsImapTlsError,
} from "./ImapConnection";

jest.mock("../OTelContext", () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return {
    OTelLogger: () => ({ createModuleLogger: () => logger }),
    __mockLogger: logger,
  };
});

const mockLogger = jest.requireMock("../OTelContext").__mockLogger;

function makeConfig(overrides: Partial<Config> = {}): Config {
  return Object.assign(new Config(), {
    IMAP_HOST: "imap.example.com",
    IMAP_PORT: 993,
    IMAP_USER: "newsletter@example.com",
    IMAP_PASSWORD: "secret",
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("BuildImapFlowOptions", () => {
  it("verifies the server certificate by default (no TLS override)", () => {
    const options = BuildImapFlowOptions(makeConfig(), 120000, true);

    expect(options.host).toBe("imap.example.com");
    expect(options.port).toBe(993);
    expect(options.secure).toBe(true);
    expect(options.auth).toEqual({
      user: "newsletter@example.com",
      pass: "secret",
    });
    expect(options.logger).toBe(false);
    expect(options.disableAutoIdle).toBe(true);
    expect(options.socketTimeout).toBe(120000);
    expect(options.connectionTimeout).toBe(90000);
    expect(options.greetingTimeout).toBe(16000);
    // No tls object at all: Node validates against its default CA store.
    expect(options.tls).toBeUndefined();
    expect(JSON.stringify(options)).not.toContain("rejectUnauthorized");
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("follows IMAP_TLS for the secure flag", () => {
    expect(BuildImapFlowOptions(makeConfig({ IMAP_TLS: false }), 0, false).secure).toBe(false);
  });

  it("disables the socket timeout only for an explicit 0", () => {
    const options = BuildImapFlowOptions(makeConfig(), 0, false);
    expect(options.socketTimeout).toBe(2147483647);
  });

  it("disables verification only when IMAP_TLS_INSECURE is explicitly set", () => {
    const options = BuildImapFlowOptions(
      makeConfig({ IMAP_TLS_INSECURE: true }),
      120000,
      false,
    );
    expect(options.tls?.rejectUnauthorized).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("IMAP_TLS_INSECURE=true"),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("imap.example.com:993"),
    );
  });

  it("adds the configured CA bundle on top of Node's trusted roots", () => {
    const caFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "imap-ca-")),
      "ca.pem",
    );
    fs.writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\ncustom\n-----END CERTIFICATE-----\n");

    const options = BuildImapFlowOptions(
      makeConfig({ IMAP_TLS_CA_FILE: caFile }),
      120000,
      false,
    );

    const ca = options.tls?.ca as string[];
    expect(Array.isArray(ca)).toBe(true);
    expect(ca).toContain(
      "-----BEGIN CERTIFICATE-----\ncustom\n-----END CERTIFICATE-----\n",
    );
    // The public roots stay trusted, the file only adds anchors.
    expect(ca).toEqual(tls.rootCertificates.concat(ca[ca.length - 1]));
    expect(options.tls?.rejectUnauthorized).not.toBe(false);
  });
});

describe("IsImapTlsError", () => {
  it("recognises certificate error codes", () => {
    expect(
      IsImapTlsError(Object.assign(new Error("x"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" })),
    ).toBe(true);
    expect(
      IsImapTlsError(Object.assign(new Error("x"), { code: "SELF_SIGNED_CERT_IN_CHAIN" })),
    ).toBe(true);
    expect(
      IsImapTlsError(Object.assign(new Error("x"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" })),
    ).toBe(true);
    expect(
      IsImapTlsError(Object.assign(new Error("x"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" })),
    ).toBe(true);
    expect(IsImapTlsError(new Error("CERT_HAS_EXPIRED"))).toBe(true);
  });

  it("recognises certificate errors by message", () => {
    expect(IsImapTlsError(new Error("self-signed certificate"))).toBe(true);
    expect(IsImapTlsError(new Error("unable to get local issuer certificate"))).toBe(true);
  });

  it("does not treat unrelated failures as TLS errors", () => {
    expect(IsImapTlsError(new Error("Connection not available"))).toBe(false);
    expect(IsImapTlsError(Object.assign(new Error("auth failed"), { code: "AUTHENTICATIONFAILED" }))).toBe(false);
    expect(IsImapTlsError(undefined)).toBe(false);
  });
});

describe("ImapLogConnectionError", () => {
  it("adds an actionable hint to TLS failures without hiding the error", () => {
    const config = makeConfig();
    const err = Object.assign(new Error("certificate has expired"), {
      code: "CERT_HAS_EXPIRED",
    });

    ImapLogConnectionError("IMAP connection error", err, config);

    expect(mockLogger.error).toHaveBeenCalledWith(
      `IMAP connection error: ${ImapTlsFailureMessage(config)}`,
      err,
      undefined,
    );
    expect(ImapTlsFailureMessage(config)).toContain(
      "IMAP_TLS_INSECURE=true only if you accept the risk",
    );
  });

  it("logs other connection errors unchanged", () => {
    const config = makeConfig();
    const err = new Error("Connection not available");

    ImapLogConnectionError("IMAP connection error", err, config);

    expect(mockLogger.error).toHaveBeenCalledWith(
      "IMAP connection error",
      err,
      undefined,
    );
  });
});
