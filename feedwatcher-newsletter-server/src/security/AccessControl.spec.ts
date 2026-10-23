import { Config } from "../Config";
import {
  AccessControlIsAuthorized,
  AccessControlIsEnabled,
} from "./AccessControl";

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return Object.assign(new Config(), {
    AUTH_USERNAME: "feedwatcher",
    AUTH_PASSWORD: "s3cret",
    ...overrides,
  });
}

describe("AccessControlIsEnabled", () => {
  it("is disabled when AUTH_PASSWORD is empty", () => {
    expect(AccessControlIsEnabled(makeConfig({ AUTH_PASSWORD: "" }))).toBe(false);
  });

  it("is enabled when AUTH_PASSWORD is set", () => {
    expect(AccessControlIsEnabled(makeConfig())).toBe(true);
  });
});

describe("AccessControlIsAuthorized", () => {
  it("accepts valid credentials", () => {
    expect(
      AccessControlIsAuthorized(basic("feedwatcher", "s3cret"), makeConfig()),
    ).toBe(true);
  });

  it("rejects a wrong username", () => {
    expect(
      AccessControlIsAuthorized(basic("other", "s3cret"), makeConfig()),
    ).toBe(false);
  });

  it("rejects a wrong password", () => {
    expect(
      AccessControlIsAuthorized(basic("feedwatcher", "wrong"), makeConfig()),
    ).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(AccessControlIsAuthorized(undefined, makeConfig())).toBe(false);
  });

  it("rejects a non-Basic scheme", () => {
    expect(
      AccessControlIsAuthorized("Bearer some-token", makeConfig()),
    ).toBe(false);
  });

  it("rejects a malformed credential without a colon", () => {
    const header = `Basic ${Buffer.from("feedwatcher").toString("base64")}`;
    expect(AccessControlIsAuthorized(header, makeConfig())).toBe(false);
  });

  it("accepts a password containing a colon", () => {
    const config = makeConfig({ AUTH_PASSWORD: "pa:ss:word" });
    expect(
      AccessControlIsAuthorized(basic("feedwatcher", "pa:ss:word"), config),
    ).toBe(true);
  });

  it("is case-insensitive on the scheme", () => {
    const header = basic("feedwatcher", "s3cret").replace("Basic", "basic");
    expect(AccessControlIsAuthorized(header, makeConfig())).toBe(true);
  });
});
