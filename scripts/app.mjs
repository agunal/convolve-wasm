import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { get } from "node:http";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveNpmInvocation } from "./npm-command.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = join(repoRoot, "app_work", "runtime");
const pidPath = join(runtimeDir, "app.pid.json");
const stdoutPath = join(runtimeDir, "app.stdout.log");
const stderrPath = join(runtimeDir, "app.stderr.log");
const appUrl = "http://127.0.0.1:4173";
const serverHelperPath = join(repoRoot, "scripts", "app-server.mjs");
const lifecycleHeaderName = "x-convolve-lifecycle";
const windowsPowershellPath =
  "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const actions = new Set([
  "status",
  "url",
  "logs",
  "ready",
  "start",
  "stop",
  "restart",
  "doctor",
]);

export function parseLifecycleArgs(args) {
  const [action = "status", ...flags] = args;
  if (!actions.has(action)) {
    throw new Error(`Unknown action: ${action}`);
  }

  let hidden = false;
  let tail = null;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--hidden") {
      hidden = true;
      continue;
    }
    if (flag === "--tail") {
      const candidate = flags[index + 1];
      if (candidate === undefined || candidate.startsWith("--")) {
        tail = 100;
      } else {
        const parsed = Number(candidate);
        if (
          !/^[1-9]\d*$/u.test(candidate) ||
          !Number.isSafeInteger(parsed) ||
          parsed > 10_000
        ) {
          throw new Error("--tail must be an integer from 1 to 10000");
        }
        tail = parsed;
        index += 1;
      }
      continue;
    }
    throw new Error(`Unknown option: ${flag}`);
  }

  if (hidden && action !== "start" && action !== "restart") {
    throw new Error("--hidden is only valid for start or restart");
  }
  if (tail !== null && action !== "logs") {
    throw new Error("--tail is only valid for logs");
  }
  return { action, hidden, tail };
}

function ensureRuntimeDir() {
  mkdirSync(runtimeDir, { recursive: true });
}

function readPidRecord() {
  if (!existsSync(pidPath)) return null;
  try {
    const record = JSON.parse(readFileSync(pidPath, "utf8"));
    if (
      !Number.isSafeInteger(record.pid) ||
      record.pid < 1 ||
      resolve(record.cwd ?? "") !== repoRoot ||
      record.url !== appUrl ||
      resolve(record.helperPath ?? "") !== serverHelperPath ||
      typeof record.nonce !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(record.nonce)
    ) {
      return { invalid: true };
    }
    return record;
  } catch {
    return { invalid: true };
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function isOwnedProcess(pid) {
  if (process.platform === "win32") {
    const script = [
      "$owned = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $env:CONVOLVE_OWNED_PID)",
      "if ($null -eq $owned) { exit 3 }",
      "$owned.CommandLine",
    ].join("; ");
    const result = spawnSync(
      windowsPowershellPath,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CONVOLVE_OWNED_PID: String(pid),
        },
        windowsHide: true,
      },
    );
    return (
      result.status === 0 &&
      result.stdout.toLowerCase().includes(serverHelperPath.toLowerCase())
    );
  }

  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.includes(serverHelperPath);
}

function isPortOccupied() {
  return new Promise((resolvePromise) => {
    let settled = false;
    const socket = connect(4173, "127.0.0.1");
    const finish = (occupied) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(occupied);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

function isReady(expectedNonce) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      resolvePromise(ready);
    };
    const request = get(appUrl, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.once("end", () => {
        finish(
          response.statusCode !== undefined &&
            response.statusCode >= 200 &&
            response.statusCode < 300 &&
            body.includes('name="convolve-build"') &&
            response.headers[lifecycleHeaderName] === expectedNonce,
        );
      });
      response.once("error", () => finish(false));
    });
    request.setTimeout(1_000, () => {
      request.destroy();
      finish(false);
    });
    request.once("error", () => finish(false));
  });
}

export async function lifecycleStatus({
  readPidRecord: readRecord = readPidRecord,
  isPortOccupied: portOccupied = isPortOccupied,
  isProcessAlive: processAlive = isProcessAlive,
  isOwnedProcess: processOwned = isOwnedProcess,
  isReady: ready = isReady,
} = {}) {
  const record = readRecord();
  if (record?.invalid) {
    return { state: "blocked", detail: "invalid PID record" };
  }
  if (!record) {
    if (await portOccupied()) {
      return {
        state: "blocked",
        detail: "port 4173 is occupied without an app-owned PID record",
      };
    }
    return { state: "stopped" };
  }
  if (!processAlive(record.pid)) {
    if (await portOccupied()) {
      return {
        state: "blocked",
        detail: "recorded PID is stale but port 4173 remains occupied",
        pid: record.pid,
      };
    }
    return { state: "stale-pid", pid: record.pid };
  }
  if (!processOwned(record.pid)) {
    return {
      state: "blocked",
      detail: "PID record no longer owns the app process",
      pid: record.pid,
    };
  }
  return {
    state: (await ready(record.nonce)) ? "running-healthy" : "running-unhealthy",
    pid: record.pid,
  };
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitUntilReady(pid, nonce, timeoutMilliseconds = 30_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return false;
    if (await isReady(nonce)) return true;
    await sleep(250);
  }
  return false;
}

async function waitUntilStopped(pid, timeoutMilliseconds = 10_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid) && !(await isPortOccupied())) return true;
    await sleep(100);
  }
  return false;
}

function removePidRecord() {
  rmSync(pidPath, { force: true });
}

function buildApp() {
  const invocation = resolveNpmInvocation({
    execPath: process.execPath,
    npmExecPath: process.env.npm_execpath,
    platform: process.platform,
  });
  const result = spawnSync(
    invocation.command,
    [...invocation.prefix, "run", "build"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: process.env,
      windowsHide: true,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Application build failed before startup: ${result.stderr || result.stdout}`,
    );
  }
}

export function spawnLoggedNodeProcess({
  scriptPath,
  cwd,
  stdoutPath: childStdoutPath,
  stderrPath: childStderrPath,
  env,
  hidden,
  detached,
}) {
  const stdout = openSync(childStdoutPath, "a");
  const stderr = openSync(childStderrPath, "a");
  let child;
  try {
    child = spawn(process.execPath, [scriptPath], {
      cwd,
      detached,
      env,
      stdio: ["ignore", stdout, stderr],
      windowsHide: hidden,
    });
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }

  if (detached) child.unref();
  return child;
}

function spawnBackgroundServer(hidden, nonce) {
  const child = spawnLoggedNodeProcess({
    scriptPath: serverHelperPath,
    cwd: repoRoot,
    stdoutPath,
    stderrPath,
    env: {
      ...process.env,
      CONVOLVE_APP_HIDDEN: hidden ? "1" : "0",
      CONVOLVE_APP_NONCE: nonce,
      CONVOLVE_STDERR_PATH: stderrPath,
      CONVOLVE_STDOUT_PATH: stdoutPath,
    },
    hidden,
    detached: true,
  });
  return child.pid;
}

async function start({ hidden }) {
  ensureRuntimeDir();
  const status = await lifecycleStatus();
  if (status.state === "running-healthy") {
    console.log(`already running: ${appUrl} (pid ${status.pid})`);
    return;
  }
  if (status.state === "running-unhealthy") {
    throw new Error(
      "Refusing to start an unhealthy owned server. Run npm run app:logs -- --tail 100, then npm run app:stop.",
    );
  }
  if (status.state === "blocked") {
    throw new Error(
      `Refusing to start: ${status.detail}. Resolve the conflicting process or PID record; app:stop only stops a verified app-owned server.`,
    );
  }
  if (status.state === "stale-pid") {
    removePidRecord();
  }

  buildApp();
  const nonce = randomUUID();
  const pid = spawnBackgroundServer(hidden, nonce);
  writeFileSync(
    pidPath,
    JSON.stringify(
      {
        pid,
        cwd: repoRoot,
        helperPath: serverHelperPath,
        url: appUrl,
        nonce,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  if (!(await waitUntilReady(pid, nonce))) {
    await stop();
    throw new Error(
      `App failed to become ready. Inspect npm run app:logs -- --tail 100.`,
    );
  }
  console.log(`ready: ${appUrl} (pid ${pid})`);
}

export async function stop({
  readPidRecord: readRecord = readPidRecord,
  isProcessAlive: processAlive = isProcessAlive,
  isOwnedProcess: processOwned = isOwnedProcess,
  terminateOwnedProcess,
  waitUntilStopped: waitStopped = waitUntilStopped,
  removePidRecord: removeRecord = removePidRecord,
  log = console.log,
} = {}) {
  const record = readRecord();
  if (!record) {
    log("already stopped");
    return;
  }
  if (record.invalid) {
    throw new Error(
      `Invalid PID record at ${pidPath}; remove it only after verifying no app process is running.`,
    );
  }
  if (processAlive(record.pid)) {
    if (!processOwned(record.pid)) {
      throw new Error(
        `Refusing to stop PID ${record.pid} because it is not the app-owned server process.`,
      );
    }
    if (terminateOwnedProcess) {
      terminateOwnedProcess(record.pid);
    } else if (process.platform === "win32") {
      const result = spawnSync(
        "taskkill.exe",
        ["/PID", String(record.pid), "/T", "/F"],
        { encoding: "utf8", windowsHide: true },
      );
      if (result.status !== 0 && processAlive(record.pid)) {
        throw new Error(
          `Failed to stop PID ${record.pid}: ${result.stderr || result.stdout}`,
        );
      }
    } else {
      try {
        process.kill(-record.pid, "SIGTERM");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  }
  if (!(await waitStopped(record.pid))) {
    throw new Error(
      `PID ${record.pid} or port 4173 did not stop within 10 seconds; retaining the PID record.`,
    );
  }

  removeRecord();
  log("stopped");
}

function tailFile(path, lineCount) {
  if (!existsSync(path)) {
    console.log(`${path}: missing`);
    return;
  }
  const lines = readFileSync(path, "utf8").split(/\r?\n/u);
  console.log(`--- ${path} (last ${lineCount} lines) ---`);
  console.log(lines.slice(-lineCount).join("\n"));
}

function logs(tail) {
  ensureRuntimeDir();
  if (tail === null) {
    for (const path of [stdoutPath, stderrPath]) {
      const detail = existsSync(path) ? `${statSync(path).size} bytes` : "missing";
      console.log(`${path}: ${detail}`);
    }
    return;
  }
  tailFile(stdoutPath, tail);
  tailFile(stderrPath, tail);
}

function doctor() {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  const checks = {
    node24OrNewer: nodeMajor >= 24,
    packageJson: existsSync(join(repoRoot, "package.json")),
    dependencies: existsSync(join(repoRoot, "node_modules")),
    demoWorkspace: existsSync(join(repoRoot, "apps", "demo", "package.json")),
  };
  console.log(JSON.stringify(checks, null, 2));
  if (Object.values(checks).some((value) => !value)) {
    process.exitCode = 1;
  }
}

async function main() {
  const options = parseLifecycleArgs(process.argv.slice(2));
  switch (options.action) {
    case "status": {
      const status = await lifecycleStatus();
      const label = status.pid
        ? `${status.state}: ${appUrl} (pid ${status.pid})`
        : `${status.state}: ${appUrl}`;
      console.log(
        status.detail ? `${label} - ${status.detail}` : label,
      );
      if (status.state === "blocked" || status.state === "running-unhealthy") {
        process.exitCode = 1;
      }
      break;
    }
    case "url":
      console.log(appUrl);
      break;
    case "logs":
      logs(options.tail);
      break;
    case "ready":
      if ((await lifecycleStatus()).state === "running-healthy") {
        console.log(`ready: ${appUrl}`);
      } else {
        console.error(`not ready: ${appUrl}`);
        process.exitCode = 1;
      }
      break;
    case "start":
      await start(options);
      break;
    case "stop":
      await stop();
      break;
    case "restart":
      await stop();
      await start(options);
      break;
    case "doctor":
      doctor();
      break;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
