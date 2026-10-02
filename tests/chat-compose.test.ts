import { describe, expect, it } from "vitest";
import { composeChatMessage } from "../client/review/chat-compose";

describe("composeChatMessage", () => {
  it("returns the trimmed question unchanged when no context is attached", () => {
    expect(composeChatMessage("  What does this change?  ", null)).toBe("What does this change?");
    expect(composeChatMessage("Hi", undefined)).toBe("Hi");
  });

  it("appends the context block after a blank line, with a labelled separator", () => {
    const message = composeChatMessage("What's risky here?", {
      label: "Module: Analysis · 12 files",
      text: "Module: Analysis\n\nFiles:\n- a.ts\n- b.ts",
    });
    expect(message).toBe("What's risky here?\n\nContext — Module: Analysis · 12 files:\nModule: Analysis\n\nFiles:\n- a.ts\n- b.ts");
  });

  it("trims the question before composing, leaving the context text untouched", () => {
    const message = composeChatMessage("  Summarize this  ", { label: "Thread on x.ts:12", text: "alice: looks off  " });
    expect(message).toBe("Summarize this\n\nContext — Thread on x.ts:12:\nalice: looks off  ");
  });

  it("omits the leading blank line when the question itself is empty", () => {
    const message = composeChatMessage("   ", { label: "Thread on x.ts:12", text: "alice: looks off" });
    expect(message).toBe("Context — Thread on x.ts:12:\nalice: looks off");
  });
});
