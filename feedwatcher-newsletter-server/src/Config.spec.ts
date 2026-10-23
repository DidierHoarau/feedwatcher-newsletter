import * as fs from "fs";
import path from "path";
import { Config } from "./Config";

describe("Config", () => {
  it("defaults EMAIL_RETENTION_DAYS to 3", () => {
    expect(new Config().EMAIL_RETENTION_DAYS).toBe(3);
  });

  it("ships a config.json with the same retention default", () => {
    const config = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../config.json"), "utf8"),
    );
    expect(config.EMAIL_RETENTION_DAYS).toBe(3);
  });

  it("documents the same retention default in the README", () => {
    const readme = fs.readFileSync(
      path.resolve(__dirname, "../../README.md"),
      "utf8",
    );
    expect(readme).toMatch(/`EMAIL_RETENTION_DAYS`[^\n]*\|\s*`3`\s*\|/);
  });

  it("defaults the IMAP and fetch timeouts", () => {
    const config = new Config();
    expect(config.IMAP_SOCKET_TIMEOUT_MS).toBe(120000);
    expect(config.IMAP_IDLE_SOCKET_TIMEOUT_MS).toBe(600000);
    expect(config.EMAIL_FETCH_DEADLINE_MS).toBe(300000);
  });

  it("disables authentication, strict private URLs and proxy trust by default", () => {
    const config = new Config();
    expect(config.AUTH_USERNAME).toBe("feedwatcher");
    expect(config.AUTH_PASSWORD).toBe("");
    expect(config.FEED_PRIVATE_URLS_STRICT).toBe(false);
    expect(config.TRUST_PROXY).toBe(false);
  });

  it("verifies IMAP TLS by default and has no CA override", () => {
    const config = new Config();
    expect(config.IMAP_TLS).toBe(true);
    expect(config.IMAP_TLS_INSECURE).toBe(false);
    expect(config.IMAP_TLS_CA_FILE).toBe("");
  });

  it("reports the server package version, not the shared library one", () => {
    const serverPkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
    );
    expect(serverPkg.name).toBe("feedwatcher-newsletter-server");
    expect(new Config().VERSION).toBe(serverPkg.version);
  });
});
