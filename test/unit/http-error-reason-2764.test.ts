/**
 * flair#2764 — the message of the ApiHttpError raised for a failed REST
 * request is `HTTP <status>` plus the JSON body's named error, or else a
 * bounded one-line excerpt of the body. The error keeps the full body, which
 * sendJsonRequest prints only with FLAIR_DEBUG set.
 *
 * Every request goes through the real sendJsonRequest to a node HTTP listener
 * on 127.0.0.1 that this file starts; the last describe spawns the built CLI
 * against another such listener, with a scratch HOME and FLAIR_URL naming it.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import { ApiHttpError, apiErrorBody, sendJsonRequest } from "../../src/lib/auth-resolve.ts";
import { isNoBackendConfigured, isRemAbortedFailure, runNightlyCycle } from "../../src/rem/runner.ts";
import { describeReflectError } from "../../src/commands/rem.ts";
import { isFederationStatusAuthFailure } from "../../src/commands/federation.ts";
import {
  FederationPairLocalAccessError,
  rewriteFederationPairLocalAccessError,
} from "../../src/lib/federation-pair-access.ts";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.js";
import { nodeBin } from "../helpers/node-runtime.js";

type Reply = { status: number; body: string };

async function startListener(route: (line: string) => Reply) {
  const seen: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      const line = `${req.method} ${req.url}`;
      seen.push(line);
      const reply = route(line);
      res.writeHead(reply.status, { "Content-Type": "text/plain" });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { seen, port, close };
}

const replies = new Map<string, Reply>();
let listener: Awaited<ReturnType<typeof startListener>>;

beforeAll(async () => {
  listener = await startListener((line) => replies.get(line) ?? { status: 404, body: `no route for ${line}` });
});
afterAll(async () => {
  if (listener) await listener.close();
});

/** GET `path` from this file's listener, answered with `reply`; returns the thrown ApiHttpError. */
async function failWith(
  path: string,
  reply: Reply,
  opts: { authHeader?: string; isLocal?: boolean; signedOnly?: { keysDir: string } } = { authHeader: "Basic fixture" },
): Promise<ApiHttpError> {
  replies.set(`GET ${path}`, reply);
  const url = new URL(path, `http://127.0.0.1:${listener.port}`);
  expect(url.host).toBe(`127.0.0.1:${listener.port}`);
  let caught: unknown;
  try {
    await sendJsonRequest(url, "GET", undefined, opts.authHeader, opts.isLocal ?? true, { signedOnly: opts.signedOnly });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ApiHttpError);
  return caught as ApiHttpError;
}

describe("flair#2764 — the reason a failed request prints", () => {
  test("a JSON error body prints its named error: error, else code, else message", async () => {
    const cases: Array<[number, unknown, string]> = [
      [503, { error: "rem_aborted", code: "E_PAUSE", message: "paused", detail: "operator pause" }, "HTTP 503: rem_aborted"],
      [429, { code: "E_QUOTA", message: "over quota" }, "HTTP 429: E_QUOTA"],
      [400, { message: "bad input" }, "HTTP 400: bad input"],
      [500, { error: { nested: true } }, 'HTTP 500: {"error":{"nested":true}}'],
    ];
    for (const [i, [status, json, expected]] of cases.entries()) {
      const body = JSON.stringify(json);
      const err = await failWith(`/json-${i}`, { status, body });
      expect(err.message).toBe(expected);
      expect(err.status).toBe(status);
      expect(err.body).toBe(body);
      expect(apiErrorBody(err)).toBe(body);
    }
  });

  test("a large text body prints the capped excerpt, and the error keeps the whole body", async () => {
    const body = `${"a".repeat(150)} ${"b".repeat(10_000)}`;
    const err = await failWith("/large", { status: 500, body });
    expect(err.message).toBe(`HTTP 500: ${"a".repeat(150)} ${"b".repeat(49)}...`);
    expect(err.body).toBe(body);
  });

  test("a zero-length error response prints the status alone, and the error's body is empty", async () => {
    const err = await failWith("/empty", { status: 500, body: "" });
    expect(err.message).toBe("HTTP 500");
    expect(err.body).toBe("");
    expect(err.noCredentials).toBe(false);
  });

  test("a body with newlines and control characters prints one clean line", async () => {
    const text = await failWith("/control", {
      status: 502,
      body: "\r\n  first line\r\n\tsecond\u001b[2J line\u0000\u0007\u009b end\u2028after\n\n",
    });
    expect(text.message).toBe("HTTP 502: first line second[2J line end after");
    const named = await failWith("/control-json", {
      status: 400,
      body: JSON.stringify({ error: "bad\nthing\u001b\u0007" }),
    });
    expect(named.message).toBe("HTTP 400: bad thing");
    for (const message of [text.message, named.message]) {
      expect(message).not.toMatch(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/);
    }
  });

  test("FLAIR_DEBUG prints the full body to stderr; unset, no body line is written", async () => {
    const body = `${"x".repeat(5_000)}\nsecond line`;
    const written: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const saved = process.env.FLAIR_DEBUG;
    try {
      delete process.env.FLAIR_DEBUG;
      await failWith("/debug-off", { status: 500, body });
      process.env.FLAIR_DEBUG = "1";
      const err = await failWith("/debug-on", { status: 500, body });
      expect(err.message).toBe(`HTTP 500: ${"x".repeat(200)}...`);
    } finally {
      spy.mockRestore();
      if (saved === undefined) delete process.env.FLAIR_DEBUG;
      else process.env.FLAIR_DEBUG = saved;
    }
    expect(written.filter((w) => w.startsWith("[flair] GET /debug-"))).toEqual([
      `[flair] GET /debug-on answered HTTP 500; response body: ${JSON.stringify(body)}\n`,
    ]);
  });

  test("the no-credentials 403 keeps main's hint text byte for byte, with a JSON body and a zero-length body", async () => {
    const cases: Array<[string, { isLocal: boolean; signedOnly?: { keysDir: string } }, string]> = [
      ["local", { isLocal: true }, "HTTP 403: no credentials sent. Set FLAIR_ADMIN_PASS, or run `flair init` to provision ~/.flair/admin-pass or an agent key."],
      ["remote", { isLocal: false }, "HTTP 403: no credentials sent. Set FLAIR_ADMIN_PASS (remote targets have no local admin-pass fallback)."],
      [
        "signed-only",
        { isLocal: true, signedOnly: { keysDir: "/fixture/keys" } },
        "HTTP 403: no credentials sent. This request can send only an Ed25519 agent signature; the admin password is not sent on this path. Provide the key of an agent registered on the target instance at /fixture/keys/<agent-id>.key.",
      ],
    ];
    for (const [shape, body] of [["json", JSON.stringify({ error: "forbidden" })], ["empty", ""]] as const) {
      for (const [name, opts, expected] of cases) {
        const err = await failWith(`/no-creds-${name}-${shape}`, { status: 403, body }, opts);
        expect(err.message, `${name}, ${shape} body`).toBe(expected);
        expect(err.status).toBe(403);
        expect(err.noCredentials).toBe(true);
      }
    }
  });
});

describe("flair#2764 — code that classifies a failure reads the full body", () => {
  test("a 503 rem pause and a 503 missing backend still classify", async () => {
    const paused = await failWith("/reflect-paused", { status: 503, body: JSON.stringify({ error: "rem_aborted", detail: "paused" }) });
    expect(isRemAbortedFailure(paused)).toBe(true);
    const noBackend = await failWith("/reflect-no-backend", {
      status: 503,
      body: JSON.stringify({ error: "No generative backend configured. See the models configuration docs." }),
    });
    expect(isNoBackendConfigured(noBackend)).toBe(true);
  });

  test("a 502 distillation_failed still reads as distillation-failed with its detail", async () => {
    const err = await failWith("/reflect-failed", {
      status: 502,
      body: JSON.stringify({ error: "distillation_failed", detail: "model output did not validate after one retry" }),
    });
    expect(describeReflectError(err)).toEqual({
      kind: "distillation-failed",
      text: "model output did not validate after one retry",
    });
  });

  test("an AccessViolation 403 whose named error is forbidden still becomes the named pair error", async () => {
    const err = await failWith("/FederationInstance", {
      status: 403,
      body: '{"type":"error:AccessViolation","error":"forbidden","instance":"/FederationInstance"}',
    });
    expect(err.message).toBe("HTTP 403: forbidden");
    const rewritten = rewriteFederationPairLocalAccessError(err, { url: "http://127.0.0.1:9926", agentId: "agent-a" });
    expect(rewritten).toBeInstanceOf(FederationPairLocalAccessError);
  });

  test("rem's distillation error still names the body's error and detail", async () => {
    const root = mkdtempSync(join(tmpdir(), "flair-2764-runner-"));
    const routes: Record<string, Reply> = {
      "GET /Memory": { status: 200, body: JSON.stringify([{ id: "m1", agentId: AGENT_ID, content: "first memory" }]) },
      "GET /Soul": { status: 200, body: "[]" },
      "POST /MemoryMaintenance": { status: 200, body: JSON.stringify({ expired: 0, archived: 0, total: 0, errors: 0 }) },
      "POST /ReflectMemories": {
        status: 502,
        body: JSON.stringify({ error: "distillation_failed", detail: "model output did not validate after one retry" }),
      },
      "POST /MemoryDedupStats": {
        status: 200,
        body: JSON.stringify({ clusterCount: 0, largestClusterSize: 0, totalMemoriesInClusters: 0, computedAt: "2026-07-22T03:00:00.000Z" }),
      },
    };
    const own = await startListener((line) => routes[line.split("?")[0]] ?? { status: 404, body: `no route for ${line}` });
    try {
      const apiCall = (method: string, path: string, body?: unknown) =>
        sendJsonRequest(new URL(path, `http://127.0.0.1:${own.port}`), method, body, "Basic fixture", true);
      const r = await runNightlyCycle({
        agentId: AGENT_ID,
        flairVersion: "0.0.0-test",
        apiCall,
        snapshotRoot: join(root, "snapshots"),
        logPath: join(root, "rem-nightly.jsonl"),
        pauseFlagPath: join(root, "rem.paused"),
        envPaused: false,
        healthProbe: async () => ({ ok: true, elapsedMs: 1 }),
      });
      expect(r.logRow.errors, own.seen.join("\n")).toEqual([
        "distillation: distillation_failed: model output did not validate after one retry",
      ]);
    } finally {
      await own.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("federation status still reads an auth marker outside the named error", async () => {
    const err = await failWith("/federation-status", {
      status: 400,
      body: JSON.stringify({ error: "bad_request", detail: "missing_or_invalid_authorization" }),
    });
    expect(err.message).toBe("HTTP 400: bad_request");
    expect(isFederationStatusAuthFailure(err)).toBe(true);
  });
});

const CHILD_DEADLINE_MS = 20_000;
const CLI_PATH = join(import.meta.dirname ?? __dirname, "..", "..", "dist", "cli.js");
const AGENT_ID = "agent-a";

function runCli(args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith("FLAIR_") && !key.startsWith("HDB_")) childEnv[key] = value;
    }
    Object.assign(childEnv, env);
    const child = spawn(nodeBin({ env: childEnv, cwd: env.HOME }), [CLI_PATH, ...args], {
      cwd: env.HOME,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(childOverranDeadline("flair CLI", cliLeg(args), CHILD_DEADLINE_MS, { status: code, signal, elapsedMs: Date.now() - startedAt, stdout, stderr })));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

describe("flair#2764 — built CLI: flair rem nightly run-once lists the bounded reason under Errors:", () => {
  const body = `store down\r\n${"z".repeat(5_000)}`;
  let cliListener: Awaited<ReturnType<typeof startListener>>;
  let home: string;

  beforeAll(async () => {
    ensureCliBuild();
    home = mkdtempSync(join(tmpdir(), "flair-2764-cli-"));
    const keysDir = join(home, ".flair", "keys");
    mkdirSync(keysDir, { recursive: true });
    const kp = nacl.sign.keyPair();
    writeFileSync(join(keysDir, `${AGENT_ID}.key`), Buffer.from(kp.secretKey.slice(0, 32)), { mode: 0o600 });
    cliListener = await startListener((line) => {
      if (line === "GET /Health") return { status: 200, body: "[]" };
      if (line === `GET /Memory?agentId=${AGENT_ID}`) return { status: 503, body };
      if (line === `GET /Soul?agentId=${AGENT_ID}`) return { status: 200, body: "[]" };
      return { status: 404, body: `no route for ${line}` };
    });
  }, 120_000);

  afterAll(async () => {
    if (cliListener) await cliListener.close();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  for (const debug of [false, true]) {
    test(debug ? "with FLAIR_DEBUG=1 stderr also carries the full body" : "the Errors: line is the bounded reason", async () => {
      cliListener.seen.length = 0;
      const env: Record<string, string> = { HOME: home, FLAIR_URL: `http://127.0.0.1:${cliListener.port}` };
      if (debug) env.FLAIR_DEBUG = "1";
      const result = await runCli(["rem", "nightly", "run-once", "--agent", AGENT_ID, "--dry-run"], env);
      const detail = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
      expect(cliListener.seen, detail).toEqual(["GET /Health", `GET /Memory?agentId=${AGENT_ID}`, `GET /Soul?agentId=${AGENT_ID}`]);
      const lines = result.stdout.split("\n");
      const errorsAt = lines.indexOf("Errors:");
      expect(errorsAt, detail).toBeGreaterThan(-1);
      expect(lines, detail).toContain(`Memories:   unknown (HTTP 503: store down ${"z".repeat(189)}...)`);
      expect(lines[errorsAt + 1], detail).toBe(`  - memory-count: HTTP 503: store down ${"z".repeat(189)}...`);
      expect(result.stdout, detail).not.toContain("z".repeat(190));
      const debugLine = `[flair] GET /Memory answered HTTP 503; response body: ${JSON.stringify(body)}`;
      if (debug) expect(result.stderr.split("\n"), detail).toContain(debugLine);
      else expect(result.stderr, detail).not.toContain("z".repeat(190));
      expect(result.code, detail).toBe(1);
    }, 30_000);
  }
});
