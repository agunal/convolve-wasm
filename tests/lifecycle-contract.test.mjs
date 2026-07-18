import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("exposes the project-owned lifecycle command contract", () => {
  assert.deepEqual(
    Object.fromEntries(
      [
        "app:status",
        "app:url",
        "app:logs",
        "app:ready",
        "app:start:hidden",
        "app:stop",
        "app:restart:hidden",
        "app:doctor",
      ].map((name) => [name, packageJson.scripts[name]]),
    ),
    {
      "app:status": "node scripts/app.mjs status",
      "app:url": "node scripts/app.mjs url",
      "app:logs": "node scripts/app.mjs logs",
      "app:ready": "node scripts/app.mjs ready",
      "app:start:hidden": "node scripts/app.mjs start --hidden",
      "app:stop": "node scripts/app.mjs stop",
      "app:restart:hidden": "node scripts/app.mjs restart --hidden",
      "app:doctor": "node scripts/app.mjs doctor",
    },
  );
});

test("reports occupied, stale, and healthy lifecycle states", async () => {
  const lifecycle = await import("../scripts/app.mjs");
  assert.equal(typeof lifecycle.lifecycleStatus, "function");

  assert.deepEqual(
    await lifecycle.lifecycleStatus({
      readPidRecord: () => null,
      isPortOccupied: async () => true,
    }),
    {
      state: "blocked",
      detail: "port 4173 is occupied without an app-owned PID record",
    },
  );

  const record = { pid: 1234, nonce: "expected-nonce" };
  assert.deepEqual(
    await lifecycle.lifecycleStatus({
      readPidRecord: () => record,
      isProcessAlive: () => false,
      isPortOccupied: async () => false,
    }),
    { state: "stale-pid", pid: 1234 },
  );

  let readinessNonce;
  assert.deepEqual(
    await lifecycle.lifecycleStatus({
      readPidRecord: () => record,
      isProcessAlive: () => true,
      isOwnedProcess: () => true,
      isReady: async (nonce) => {
        readinessNonce = nonce;
        return true;
      },
    }),
    { state: "running-healthy", pid: 1234 },
  );
  assert.equal(readinessNonce, "expected-nonce");
});

test("refuses to stop a process not owned by the lifecycle", async () => {
  const lifecycle = await import("../scripts/app.mjs");
  assert.equal(typeof lifecycle.stop, "function");
  let terminated = false;

  await assert.rejects(
    lifecycle.stop({
      readPidRecord: () => ({ pid: 1234 }),
      isProcessAlive: () => true,
      isOwnedProcess: () => false,
      terminateOwnedProcess: () => {
        terminated = true;
      },
    }),
    /not the app-owned server process/u,
  );
  assert.equal(terminated, false);
});

test("waits for an owned process before removing its PID record", async () => {
  const lifecycle = await import("../scripts/app.mjs");
  assert.equal(typeof lifecycle.stop, "function");
  const events = [];

  await lifecycle.stop({
    readPidRecord: () => ({ pid: 1234 }),
    isProcessAlive: () => true,
    isOwnedProcess: () => true,
    terminateOwnedProcess: () => events.push("terminate"),
    waitUntilStopped: async () => {
      events.push("wait");
      return true;
    },
    removePidRecord: () => events.push("remove"),
    log: () => {},
  });

  assert.deepEqual(events, ["terminate", "wait", "remove"]);
});

test("captures child stdout and stderr in lifecycle logs", async () => {
  const lifecycle = await import("../scripts/app.mjs");
  assert.equal(typeof lifecycle.spawnLoggedNodeProcess, "function");

  const tempDirectory = new URL(
    `../.test_tmp/lifecycle-${randomUUID()}/`,
    import.meta.url,
  );
  const fixturePath = new URL("write-streams.mjs", tempDirectory);
  const stdoutPath = new URL("stdout.log", tempDirectory);
  const stderrPath = new URL("stderr.log", tempDirectory);
  await mkdir(tempDirectory, { recursive: true });

  try {
    await writeFile(
      fixturePath,
      'console.log("captured stdout"); console.error("captured stderr");\n',
    );
    const child = lifecycle.spawnLoggedNodeProcess({
      scriptPath: fileURLToPath(fixturePath),
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdoutPath: fileURLToPath(stdoutPath),
      stderrPath: fileURLToPath(stderrPath),
      env: process.env,
      hidden: true,
      detached: false,
    });
    const [exitCode] = await once(child, "exit");

    assert.equal(exitCode, 0);
    assert.match(await readFile(stdoutPath, "utf8"), /captured stdout/u);
    assert.match(await readFile(stderrPath, "utf8"), /captured stderr/u);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("lifecycle parser accepts the documented actions and bounded log tails", async () => {
  const { parseLifecycleArgs } = await import("../scripts/app.mjs");

  assert.deepEqual(parseLifecycleArgs(["status"]), {
    action: "status",
    hidden: false,
    tail: null,
  });
  assert.deepEqual(parseLifecycleArgs(["start", "--hidden"]), {
    action: "start",
    hidden: true,
    tail: null,
  });
  assert.deepEqual(parseLifecycleArgs(["logs", "--tail", "25"]), {
    action: "logs",
    hidden: false,
    tail: 25,
  });
  assert.deepEqual(parseLifecycleArgs(["logs", "--tail"]), {
    action: "logs",
    hidden: false,
    tail: 100,
  });
  assert.throws(
    () => parseLifecycleArgs(["logs", "--tail", "25junk"]),
    /tail must be an integer/i,
  );
  assert.throws(() => parseLifecycleArgs(["unknown"]), /unknown action/i);
});
