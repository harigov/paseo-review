import { afterEach, describe, expect, it, vi } from "vitest";
import { getSettings, setSettingsHandle } from "../server/core/settings";
import { DEFAULT_SETTINGS } from "../shared/settings";

describe("getSettings fallback logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs and falls back to defaults when the settings handle reports invalid state", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setSettingsHandle({
      read: async () => ({ status: "invalid", revision: "1", error: "boom: corrupt settings" }),
      subscribe: () => () => {},
    } as never);

    const settings = await getSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls.some((args) => String(args[0]).includes("corrupt settings"))).toBe(true);
  });

  it("logs and falls back to defaults when reading settings throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setSettingsHandle({
      read: async () => {
        throw new Error("daemon unreachable");
      },
      subscribe: () => () => {},
    } as never);

    const settings = await getSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls.some((args) => String(args[0]).includes("daemon unreachable"))).toBe(true);
  });

  it("returns the parsed settings without logging when they're ready and valid", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setSettingsHandle({
      read: async () => ({ status: "ready", revision: "1", values: { decisionRepos: ["owner/repo"] } }),
      subscribe: () => () => {},
    } as never);

    const settings = await getSettings();
    expect(settings.decisionRepos).toEqual(["owner/repo"]);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
