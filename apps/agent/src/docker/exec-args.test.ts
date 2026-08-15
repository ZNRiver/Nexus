import { describe, expect, test } from "bun:test";
import { buildExecArgs } from "./service";

const BASE = ["-H", "unix:///var/run/docker.sock"];
const ID = "abc123";

describe("buildExecArgs — non-shell mode passes args verbatim (no shell interpretation)", () => {
  test("simple command tokens", () => {
    expect(buildExecArgs(BASE, ID, ["echo", "hello"], false)).toEqual([
      ...BASE, "exec", "-i", ID, "echo", "hello",
    ]);
  });

  test("metacharacters are inert as exec-args (cannot be injected)", () => {
    // Without a shell, `&&`, `;`, `$`, backticks, redirection are just
    // arguments passed to the binary — docker exec never interprets them.
    expect(buildExecArgs(BASE, ID, ["echo", "a", "&&", "rm", "-rf", "/"], false)).toEqual([
      ...BASE, "exec", "-i", ID, "echo", "a", "&&", "rm", "-rf", "/",
    ]);
  });

  test("flags and paths pass through untouched", () => {
    expect(buildExecArgs(BASE, ID, ["ls", "-la", "/data"], false)).toEqual([
      ...BASE, "exec", "-i", ID, "ls", "-la", "/data",
    ]);
  });
});

describe("buildExecArgs — shell mode joins into /bin/sh -c", () => {
  test("compound command joined with spaces", () => {
    expect(buildExecArgs(BASE, ID, ["echo", "hi", "&&", "pwd"], true)).toEqual([
      ...BASE, "exec", "-i", ID, "/bin/sh", "-c", "echo hi && pwd",
    ]);
  });

  test("single-arg shell command", () => {
    expect(buildExecArgs(BASE, ID, ["ps", "aux"], true)).toEqual([
      ...BASE, "exec", "-i", ID, "/bin/sh", "-c", "ps aux",
    ]);
  });
});

describe("assertSafeCmdArgs — control characters are rejected", () => {
  const { assertSafeCmdArgs } = require("../handlers");

  test("normal arguments pass", () => {
    expect(() => assertSafeCmdArgs(["list", "--flag", "/path with spaces"])).not.toThrow();
  });

  test("null byte is rejected", () => {
    expect(() => assertSafeCmdArgs(["echo", "a\u0000b"])).toThrow(/invalid command argument/);
  });

  test("control characters are rejected", () => {
    for (const bad of ["a\u0001b", "a\u0007b", "a\u001fb", "a\u007fb"]) {
      expect(() => assertSafeCmdArgs([bad])).toThrow(/invalid command argument/);
    }
  });

  test("newline inside an argument is rejected", () => {
    expect(() => assertSafeCmdArgs(["echo", "line1\nline2"])).toThrow(/invalid command argument/);
  });
});
