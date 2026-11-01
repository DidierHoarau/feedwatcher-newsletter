import * as fs from "fs";
import * as os from "os";
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

describe("Config.reloadAtomic", () => {
  const touchedFields = [
    "IMAP_HOST",
    "EMAIL_FETCH_IDLE",
    "EMAIL_RETENTION_DAYS",
    "FEED_OVERRIDES",
    "CORS_POLICY_ORIGIN",
  ];
  let tmpDir: string;
  let savedEnv: Record<string, string | undefined>;

  const writeConfig = (content: unknown): void => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify(content));
  };

  beforeEach(() => {
    savedEnv = { CONFIG_FILE: process.env.CONFIG_FILE };
    for (const field of touchedFields) {
      savedEnv[field] = process.env[field];
      delete process.env[field];
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "feedwatcher-config-"));
    process.env.CONFIG_FILE = path.join(tmpDir, "config.json");
  });

  afterEach(() => {
    for (const [field, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[field];
      } else {
        process.env[field] = value;
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects an invalid number and keeps every previous value", async () => {
    const config = new Config();
    config.CORS_POLICY_ORIGIN = "https://old.example";
    config.IMAP_HOST = "imap1.example.com";
    config.EMAIL_RETENTION_DAYS = 3;
    writeConfig({
      CORS_POLICY_ORIGIN: "https://new.example",
      IMAP_HOST: "imap2.example.com",
      EMAIL_RETENTION_DAYS: "not-a-number",
    });

    await expect(config.reloadAtomic()).rejects.toThrow(
      /EMAIL_RETENTION_DAYS/,
    );

    expect(config.CORS_POLICY_ORIGIN).toBe("https://old.example");
    expect(config.IMAP_HOST).toBe("imap1.example.com");
    expect(config.EMAIL_RETENTION_DAYS).toBe(3);
  });

  it("rejects an invalid boolean and keeps every previous value", async () => {
    const config = new Config();
    config.IMAP_HOST = "imap1.example.com";
    config.EMAIL_RETENTION_DAYS = 3;
    writeConfig({
      IMAP_HOST: "imap2.example.com",
      EMAIL_RETENTION_DAYS: 5,
      EMAIL_FETCH_IDLE: "not-a-boolean",
    });

    await expect(config.reloadAtomic()).rejects.toThrow(/EMAIL_FETCH_IDLE/);

    expect(config.IMAP_HOST).toBe("imap1.example.com");
    expect(config.EMAIL_RETENTION_DAYS).toBe(3);
    expect(config.EMAIL_FETCH_IDLE).toBe(true);
  });

  it("rejects an invalid object and keeps every previous value", async () => {
    const config = new Config();
    config.IMAP_HOST = "imap1.example.com";
    writeConfig({
      IMAP_HOST: "imap2.example.com",
      FEED_OVERRIDES: "not-json",
    });

    await expect(config.reloadAtomic()).rejects.toThrow(/FEED_OVERRIDES/);

    expect(config.IMAP_HOST).toBe("imap1.example.com");
    expect(config.FEED_OVERRIDES).toEqual({});
  });

  it("applies every declared field when the whole file is valid", async () => {
    const config = new Config();
    writeConfig({
      CORS_POLICY_ORIGIN: "https://new.example",
      IMAP_HOST: "imap2.example.com",
      EMAIL_RETENTION_DAYS: 5,
      EMAIL_FETCH_IDLE: false,
      FEED_OVERRIDES: { "news@example.com": { feedId: "daily" } },
    });

    await expect(config.reloadAtomic()).resolves.toBeUndefined();

    expect(config.CORS_POLICY_ORIGIN).toBe("https://new.example");
    expect(config.IMAP_HOST).toBe("imap2.example.com");
    expect(config.EMAIL_RETENTION_DAYS).toBe(5);
    expect(config.EMAIL_FETCH_IDLE).toBe(false);
    expect(config.FEED_OVERRIDES).toEqual({
      "news@example.com": { feedId: "daily" },
    });
    expect(config.IMAP_PORT).toBe(993);
  });
});
