import { startServer } from "./App";

jest.mock("@devopsplaybook.io/otel-utils", () => ({
  StandardTracer: jest.fn(),
  StandardMeter: jest.fn(),
}));

jest.mock("./OTelContext", () => {
  const span = { end: jest.fn() };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const startSpan = jest.fn(() => span);
  const initOTel = jest.fn();
  return {
    OTelLogger: jest.fn(() => ({ createModuleLogger: () => logger, initOTel })),
    OTelSetTracer: jest.fn(),
    OTelSetMeter: jest.fn(),
    OTelTracer: jest.fn(() => ({ startSpan })),
    __span: span,
    __logger: logger,
    __startSpan: startSpan,
    __initOTel: initOTel,
  };
});

jest.mock("./Config", () => {
  const instance = {
    reload: jest.fn().mockResolvedValue(undefined),
    API_PORT: 8080,
    CONFIG_FILE: "config.json",
  };
  return { Config: jest.fn(() => instance), __instance: instance };
});

jest.mock("./Scheduler", () => ({
  SchedulerInit: jest.fn().mockResolvedValue(undefined),
  SchedulerReload: jest.fn(),
}));

jest.mock("./AppBuilder", () => {
  const listen = jest.fn();
  return { buildApp: jest.fn(() => ({ listen })), __listen: listen };
});

jest.mock("fs-extra", () => {
  const state: { watchCallback?: () => Promise<void> } = {};
  return {
    watchFile: jest.fn((_file: string, callback: () => Promise<void>) => {
      state.watchCallback = callback;
    }),
    readJson: jest.fn(),
    __state: state,
  };
});

const otelMock = jest.requireMock("./OTelContext");
const configMock = jest.requireMock("./Config").__instance;
const schedulerMock = jest.requireMock("./Scheduler");
const appBuilderMock = jest.requireMock("./AppBuilder");
const fseMock = jest.requireMock("fs-extra");
const fseState = fseMock.__state;

let exitMock: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  appBuilderMock.__listen.mockImplementation(
    (_options: unknown, callback: (err?: Error) => void) => callback(),
  );
  exitMock = jest
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
});

afterEach(() => {
  exitMock.mockRestore();
});

describe("startServer", () => {
  it("does not start the server when the module is imported", () => {
    expect(appBuilderMock.buildApp).not.toHaveBeenCalled();
    expect(appBuilderMock.__listen).not.toHaveBeenCalled();
  });

  it("loads the configuration, initialises telemetry and the scheduler, then listens", async () => {
    await startServer();

    expect(configMock.reload).toHaveBeenCalledTimes(1);
    expect(otelMock.OTelSetTracer).toHaveBeenCalledTimes(1);
    expect(otelMock.OTelSetMeter).toHaveBeenCalledTimes(1);
    expect(otelMock.__initOTel).toHaveBeenCalledWith(configMock);
    expect(otelMock.__startSpan).toHaveBeenCalledWith("init");
    expect(schedulerMock.SchedulerInit).toHaveBeenCalledWith(
      otelMock.__span,
      configMock,
    );
    expect(otelMock.__span.end).toHaveBeenCalledTimes(1);
    expect(appBuilderMock.buildApp).toHaveBeenCalledWith(configMock);
    expect(appBuilderMock.__listen).toHaveBeenCalledWith(
      { port: 8080, host: "0.0.0.0" },
      expect.any(Function),
    );
    expect(otelMock.__logger.info).toHaveBeenCalledWith(
      "API Listening on port 8080",
    );
  });

  it("logs the listen error, exits and does not report a listening API", async () => {
    appBuilderMock.__listen.mockImplementation(
      (_options: unknown, callback: (err?: Error) => void) =>
        callback(new Error("EADDRINUSE")),
    );

    await startServer();

    expect(otelMock.__logger.error).toHaveBeenCalledWith(
      "Error Starting API",
      expect.any(Error),
    );
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(otelMock.__logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("API Listening"),
    );
  });

  it("keeps the last valid configuration when the reload file is unreadable", async () => {
    await startServer();
    fseMock.readJson.mockRejectedValueOnce(new Error("invalid JSON"));

    await fseState.watchCallback();

    expect(configMock.reload).toHaveBeenCalledTimes(1);
    expect(schedulerMock.SchedulerReload).not.toHaveBeenCalled();
    expect(otelMock.__logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring config reload"),
    );
  });

  it("reloads the configuration and reschedules when the file is valid", async () => {
    await startServer();
    fseMock.readJson.mockResolvedValueOnce({});

    await fseState.watchCallback();

    expect(configMock.reload).toHaveBeenCalledTimes(2);
    expect(schedulerMock.SchedulerReload).toHaveBeenCalledWith(configMock);
    expect(otelMock.__logger.info).toHaveBeenCalledWith(
      "Configuration reloaded and applied",
    );
  });
});
