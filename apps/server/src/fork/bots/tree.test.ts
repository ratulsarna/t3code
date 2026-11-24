// @effect-diagnostics nodeBuiltinImport:off -- The test simulates a torn on-disk record.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { Chat } from "./tree.ts";

it("recovers an interrupted tool result without duplicating the bb prefix or the call", async () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bot-memory-test-"));
  const date = "2025-01-01T12:00:00Z";
  const journal = NodePath.join(dir, "main", "2025-01-01.jsonl");
  try {
    const chat = Chat.open(dir);
    chat.append("user", "Original conversation", date, {
      stream: "thread:bb-fixture",
      at: 85,
      n: 0,
    });
    chat.append("tool", "read fixture", date, { stream: "t3:fixture:item:read", at: 0, n: 0 });
    await chat.close();

    // The file survives the crash with a partial second record and the cursor still behind it.
    const prefix = NodeFS.readFileSync(journal, "utf8");
    NodeFS.appendFileSync(journal, '{"i":2,"kind":"echo"');
    expect(Chat.read(dir).T).toBe(2);
    expect(NodeFS.statSync(journal).size).toBeGreaterThan(Buffer.byteLength(prefix));

    const resumed = Chat.open(dir);
    try {
      const result = { stream: "t3:fixture:item:read", at: 0, n: 0 };
      resumed.append("tool", "read fixture", date, result);
      resumed.append("echo", "fixture contents", date, result);
      await resumed.flush();
      expect(resumed.T).toBe(3);
      expect(resumed.zoom(2, 1)).toBe("echo: fixture contents");
      expect(NodeFS.readFileSync(journal, "utf8").startsWith(prefix)).toBe(true);
    } finally {
      await resumed.close();
    }
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});
