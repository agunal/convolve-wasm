import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(args, env = process.env) {
  const result = spawnSync(npm, args, {
    stdio: "inherit",
    env,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(["run", "build:wasm"]);
run(["run", "build", "-w", "@agunal/convolve-wasm"]);
run(["run", "build", "-w", "@agunal/convolve-demo"], {
  ...process.env,
  CONVOLVE_DEMO_BASE: "/convolve-wasm/",
});
