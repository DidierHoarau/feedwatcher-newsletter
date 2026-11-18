import * as fs from "fs";
import * as os from "os";
import path from "path";
import { Config } from "../Config";
import { EmailsDataInit } from "../emails/EmailsData";
import { IdleWatcherGetState } from "../emails/IdleWatcher";
import {
  ServerStatusRecordFetchError,
  ServerStatusRecordFetchSuccess,
} from "../ServerStatus";
import {
  HealthBannerMessage,
  HealthGet,
  HealthNeedsBanner,
  IngestionHealth,
} from "./Health";
import { HealthFormatDuration } from "./HealthFormat";

jest.mock("../emails/IdleWatcher", () => ({
  IdleWatcherGetState: jest.fn(() => ({ enabled: false, connected: false })),
}));

const idleMock = IdleWatcherGetState as unknown as jest.Mock;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const NOW = Date.parse("2026-11-18T12:00:00.000Z");

let dataDir: string;
let config: Config;

function makeHealth(overrides: Partial<IngestionHealth> = {}): IngestionHealth {
  return {
    status: "starting",
    staleAfterSeconds: 7200,
    quietAfterDays: 7,
    lastSuccessfulFetchAt: null,
    lastSuccessfulFetchAgeSeconds: null,
    idle: { enabled: false, connected: false },
    lastError: null,
    storage: {
      journalExisted: false,
      legacyJournalExisted: false,
      uidMarkerExisted: false,
      freshDataDirectory: true,
    },
    ...overrides,
  };
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "health-"));
  EmailsDataInit(7, dataDir);
  config = Object.assign(new Config(), { EMAIL_FETCH_CRON: "0 * * * *" });
  idleMock.mockReturnValue({ enabled: false, connected: false });
});

// Order matters: the fetch state is module-level, so the first test observes
// the untouched state and every later test sets what it needs.
describe("HealthGet", () => {
  it("reports starting before any fetch has completed or failed", () => {
    const health = HealthGet(config, NOW);
    expect(health.status).toBe("starting");
    expect(health.lastSuccessfulFetchAt).toBeNull();
    expect(health.lastSuccessfulFetchAgeSeconds).toBeNull();
    expect(health.lastError).toBeNull();
    expect(health.staleAfterSeconds).toBe(7200);
    expect(health.quietAfterDays).toBe(7);
    expect(health.storage.freshDataDirectory).toBe(true);
    expect(HealthNeedsBanner(health)).toBe(false);
    expect(HealthBannerMessage(health)).toBe("");
  });

  it("reports degraded when the first fetch failed", () => {
    ServerStatusRecordFetchError("imap connect failed", NOW);
    const health = HealthGet(config, NOW);
    expect(health.status).toBe("degraded");
    expect(health.lastError).toBe("imap connect failed");
    expect(HealthNeedsBanner(health)).toBe(true);
    expect(HealthBannerMessage(health)).toContain("degraded");
    expect(HealthBannerMessage(health)).toContain("imap connect failed");
  });

  it("reports stale when the last success is older than twice the cron interval", () => {
    ServerStatusRecordFetchSuccess(NOW - 3 * HOUR);
    const health = HealthGet(config, NOW);
    expect(health.status).toBe("stale");
    expect(health.lastSuccessfulFetchAgeSeconds).toBe(3 * 3600);
    expect(HealthNeedsBanner(health)).toBe(true);
    const message = HealthBannerMessage(health);
    expect(message).toContain("stale");
    expect(message).toContain(new Date(NOW - 3 * HOUR).toISOString());
    expect(message).toContain("2 hours");
  });

  it("reports ok for a recent success without an error", () => {
    ServerStatusRecordFetchSuccess(NOW - 30 * MINUTE);
    const health = HealthGet(config, NOW);
    expect(health.status).toBe("ok");
    expect(health.lastSuccessfulFetchAgeSeconds).toBe(30 * 60);
    expect(HealthNeedsBanner(health)).toBe(false);
  });

  it("reports degraded when IDLE is enabled, disconnected and the last fetch failed", () => {
    ServerStatusRecordFetchSuccess(NOW - MINUTE);
    ServerStatusRecordFetchError("idle connection lost", NOW);
    idleMock.mockReturnValue({ enabled: true, connected: false });
    const health = HealthGet(config, NOW);
    expect(health.status).toBe("degraded");
    expect(health.idle).toEqual({ enabled: true, connected: false });
    expect(HealthBannerMessage(health)).toContain("idle connection lost");
  });

  it("stays ok when IDLE is connected despite a recent error", () => {
    ServerStatusRecordFetchSuccess(NOW - MINUTE);
    ServerStatusRecordFetchError("transient error", NOW);
    idleMock.mockReturnValue({ enabled: true, connected: true });
    expect(HealthGet(config, NOW).status).toBe("ok");
  });

  it("prefers stale over degraded when the success is old", () => {
    ServerStatusRecordFetchSuccess(NOW - 3 * HOUR);
    ServerStatusRecordFetchError("still failing", NOW);
    idleMock.mockReturnValue({ enabled: true, connected: false });
    expect(HealthGet(config, NOW).status).toBe("stale");
  });

  it("falls back to a two-hour stale threshold for an unsupported cron", () => {
    config.EMAIL_FETCH_CRON = "0 0 8 * * *";
    expect(HealthGet(config, NOW).staleAfterSeconds).toBe(7200);
  });

  it("derives the threshold from a slower cron schedule", () => {
    config.EMAIL_FETCH_CRON = "0 */6 * * *";
    ServerStatusRecordFetchSuccess(NOW - 11 * HOUR);
    expect(HealthGet(config, NOW).status).toBe("ok");
    ServerStatusRecordFetchSuccess(NOW - 13 * HOUR);
    expect(HealthGet(config, NOW).status).toBe("stale");
  });
});

describe("Health storage state", () => {
  it("reports a fresh directory until a journal, legacy store or UID marker exists", () => {
    expect(HealthGet(config, NOW).storage.freshDataDirectory).toBe(true);

    fs.writeFileSync(path.join(dataDir, "emails.jsonl"), "");
    EmailsDataInit(7, dataDir);
    const withJournal = HealthGet(config, NOW).storage;
    expect(withJournal.journalExisted).toBe(true);
    expect(withJournal.freshDataDirectory).toBe(false);

    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "health-legacy-"));
    fs.writeFileSync(path.join(legacyDir, "emails.json"), "[]");
    EmailsDataInit(7, legacyDir);
    expect(HealthGet(config, NOW).storage.legacyJournalExisted).toBe(true);
    expect(HealthGet(config, NOW).storage.freshDataDirectory).toBe(false);

    const uidDir = fs.mkdtempSync(path.join(os.tmpdir(), "health-uid-"));
    fs.writeFileSync(path.join(uidDir, "last-uid.txt"), "12");
    EmailsDataInit(7, uidDir);
    expect(HealthGet(config, NOW).storage.uidMarkerExisted).toBe(true);
    expect(HealthGet(config, NOW).storage.freshDataDirectory).toBe(false);
  });
});

describe("HealthBannerMessage", () => {
  it("describes a degraded state without an error", () => {
    const message = HealthBannerMessage(
      makeHealth({ status: "degraded", idle: { enabled: true, connected: false } }),
    );
    expect(message).toContain("degraded");
    expect(message).toContain("IDLE");
  });

  it("describes a stale state without a previous success", () => {
    const message = HealthBannerMessage(
      makeHealth({ status: "stale", lastSuccessfulFetchAgeSeconds: null }),
    );
    expect(message).toContain("no fetch has succeeded yet");
  });
});

describe("HealthFormatDuration", () => {
  it("renders sub-minute, minutes, hours and days", () => {
    expect(HealthFormatDuration(null)).toBe("unknown");
    expect(HealthFormatDuration(Number.NaN)).toBe("unknown");
    expect(HealthFormatDuration(-1)).toBe("unknown");
    expect(HealthFormatDuration(0)).toBe("less than a minute");
    expect(HealthFormatDuration(59)).toBe("less than a minute");
    expect(HealthFormatDuration(60)).toBe("1 minute");
    expect(HealthFormatDuration(120)).toBe("2 minutes");
    expect(HealthFormatDuration(3600)).toBe("1 hour");
    expect(HealthFormatDuration(7200)).toBe("2 hours");
    expect(HealthFormatDuration(86400)).toBe("1 day");
    expect(HealthFormatDuration(3 * 86400)).toBe("3 days");
  });
});
