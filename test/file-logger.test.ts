import { afterEach, describe, expect, it } from "vitest";
import { enterSessionLog, isFileLoggingEnabled } from "../src/file-logger";
import { _currentLogFileForTest } from "../src/debug";

describe("isFileLoggingEnabled (KIRO_FILE_LOG opt-in gating)", () => {
  const original = process.env.KIRO_FILE_LOG;
  const originalLogFile = process.env.KIRO_LOG_FILE;

  afterEach(() => {
    if (original === undefined) delete process.env.KIRO_FILE_LOG;
    else process.env.KIRO_FILE_LOG = original;
    if (originalLogFile === undefined) delete process.env.KIRO_LOG_FILE;
    else process.env.KIRO_LOG_FILE = originalLogFile;
  });

  it("does not route request debug logs to session files unless file logging is enabled", () => {
    delete process.env.KIRO_FILE_LOG;
    delete process.env.KIRO_LOG_FILE;
    enterSessionLog("private-session");
    expect(_currentLogFileForTest()).toBeNull();

    process.env.KIRO_FILE_LOG = "true";
    expect(_currentLogFileForTest()).toContain("session-private-session.log");
  });

  it("honors an explicit KIRO_LOG_FILE even when full request logging is off", () => {
    delete process.env.KIRO_FILE_LOG;
    process.env.KIRO_LOG_FILE = "tmp/explicit-kiro.log";
    expect(_currentLogFileForTest()).toBe(`${process.cwd()}/tmp/explicit-kiro.log`);

    process.env.KIRO_FILE_LOG = "true";
    enterSessionLog("another-private-session");
    expect(_currentLogFileForTest()).toBe(`${process.cwd()}/tmp/explicit-kiro.log`);
  });

  it("is OFF by default when the env var is unset", () => {
    delete process.env.KIRO_FILE_LOG;
    expect(isFileLoggingEnabled()).toBe(false);
  });

  it("is ON for truthy values, case-insensitive and trimmed", () => {
    for (const v of ["1", "true", "TRUE", "yes", "YES", "on", "  on  ", "True"]) {
      process.env.KIRO_FILE_LOG = v;
      expect(isFileLoggingEnabled()).toBe(true);
    }
  });

  it("is OFF for falsy / unrecognized values", () => {
    for (const v of ["", "0", "false", "no", "off", "2", "disabled"]) {
      process.env.KIRO_FILE_LOG = v;
      expect(isFileLoggingEnabled()).toBe(false);
    }
  });
});
