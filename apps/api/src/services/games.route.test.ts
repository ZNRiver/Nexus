import { describe, expect, test } from "bun:test";
import { routeGameExec } from "./games.service";

const RCON_ENV = { ENABLE_RCON: "TRUE", RCON_PASSWORD: "secret123", RCON_PORT: "25575" };

describe("routeGameExec — game commands go through RCON", () => {
  test("plain in-game commands use rcon-cli when RCON is configured", () => {
    const { execCmd, shell } = routeGameExec(["list"], RCON_ENV);
    expect(shell).toBe(false);
    expect(execCmd).toEqual(["rcon-cli", "--host", "127.0.0.1", "--port", "25575", "--password", "secret123", "list"]);
  });

  test("command + arguments keep the full command on RCON", () => {
    const { execCmd, shell } = routeGameExec(["say", "hello", "world"], RCON_ENV);
    expect(shell).toBe(false);
    expect(execCmd).toEqual(["rcon-cli", "--host", "127.0.0.1", "--port", "25575", "--password", "secret123", "say", "hello", "world"]);
  });

  test("RCON port from env is used", () => {
    const { execCmd } = routeGameExec(["op", "steve"], { ...RCON_ENV, RCON_PORT: "25599" });
    expect(execCmd[4]).toBe("25599");
  });

  test("without RCON password the raw command is passed through", () => {
    const { execCmd, shell } = routeGameExec(["list"], {});
    expect(shell).toBe(false);
    expect(execCmd).toEqual(["list"]);
  });
});

describe("routeGameExec — system commands go through the shell", () => {
  const systemCommands: string[][] = [
    ["echo", "hi"],
    ["ls", "-la"],
    ["cd", "/data", "&&", "ls"],
    ["ps", "aux"],
    ["cat", "server.properties"],
    ["docker", "ps"],
    ["whoami"],
  ];

  for (const cmd of systemCommands) {
    test(`system command "${cmd.join(" ")}" is routed to the shell`, () => {
      const { shell } = routeGameExec(cmd, RCON_ENV);
      expect(shell).toBe(true);
    });
  }

  test("metacharacters force the shell path", () => {
    const injectable: string[][] = [
      ["echo", "a", "&&", "rm", "-rf", "/"],
      ["ls", "|", "grep", "world"],
      ["true", ";", "reboot"],
      ["echo", "$HOME"],
      ["echo", "x", ">", "/tmp/out"],
      ["echo", "`id`"],
    ];
    for (const cmd of injectable) {
      expect(routeGameExec(cmd, RCON_ENV).shell, cmd.join(" ")).toBe(true);
    }
  });

  test("shell-routed commands pass the original tokens (no rcon wrapper)", () => {
    const { execCmd, shell } = routeGameExec(["ls", "-la"], RCON_ENV);
    expect(shell).toBe(true);
    expect(execCmd).toEqual(["ls", "-la"]);
  });

  test("injection attempt is not silently rewritten — it is shell-routed as-is", () => {
    // The panel never interprets the string; the shell gets the tokens joined.
    // These go through /bin/sh -c, so the API must never *pre-parse* or escape
    // them itself — the tokens reach docker.exec verbatim.
    const { execCmd, shell } = routeGameExec(["echo", "hi", "&&", "rm", "-rf", "/"], RCON_ENV);
    expect(shell).toBe(true);
    expect(execCmd).toEqual(["echo", "hi", "&&", "rm", "-rf", "/"]);
  });
});
