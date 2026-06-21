import { afterEach, describe, expect, it } from "vitest";
import { isFileLoggingEnabled } from "../src/file-logger";

describe("isFileLoggingEnabled (KIRO_FILE_LOG opt-in gating)", () => {
  const original = process.env.KIRO_FILE_LOG;

  afterEach(() => {
    if (original === undefined) delete process.env.KIRO_FILE_LOG;
    else process.env.KIRO_FILE_LOG = original;
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
