import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

interface PackResult {
  filename: string;
  files: Array<{ path: string }>;
}

function run(
  command: string,
  args: string[],
  cwd: string,
): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runNpm(args: string[], cwd: string): string {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error("npm_execpath is required to run package-consumer commands");
  }

  return run(process.execPath, [npmCli, ...args], cwd);
}

function listFiles(root: string, relative = ""): string[] {
  const directory = join(root, relative);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(relative, entry.name);
    return entry.isDirectory() ? listFiles(root, path) : [path];
  });
}

describe("packed package consumer", () => {
  it(
    "builds from the documented root export with local worker and WASM assets",
    () => {
      const repositoryRoot = fileURLToPath(
        new URL("../../..", import.meta.url),
      );
      const temporaryRoot = mkdtempSync(
        join(tmpdir(), "convolve-wasm-consumer-"),
      );

      try {
        const packageEntrypoint = readFileSync(
          join(repositoryRoot, "packages/convolve-wasm/dist/index.js"),
          "utf8",
        );
        expect(packageEntrypoint).toMatch(
          /^\/\/ @ts-self-types="\.\/index\.d\.ts"/,
        );

        const packDirectory = join(temporaryRoot, "pack");
        mkdirSync(packDirectory);
        const packed = JSON.parse(
          runNpm(
            [
              "pack",
              "--json",
              "--pack-destination",
              packDirectory,
              "-w",
              "@takana-labs/convolve-wasm",
            ],
            repositoryRoot,
          ),
        ) as PackResult[];
        const packageFiles = packed[0]!.files.map(({ path }) => path);
        expect(packageFiles).toContain("LICENSE");
        expect(packageFiles).toContain("README.md");
        const tarball = join(packDirectory, packed[0]!.filename);
        const consumer = join(temporaryRoot, "consumer");
        mkdirSync(join(consumer, "src"), { recursive: true });
        writeFileSync(
          join(consumer, "package.json"),
          JSON.stringify(
            {
              private: true,
              type: "module",
              scripts: { build: "vite build" },
              dependencies: {
                "@takana-labs/convolve-wasm": `file:${tarball}`,
              },
              devDependencies: { vite: "8.1.4" },
            },
            null,
            2,
          ),
        );
        writeFileSync(
          join(consumer, "index.html"),
          '<script type="module" src="/src/main.ts"></script>\n',
        );
        writeFileSync(
          join(consumer, "src/main.ts"),
          [
            'import { CONVOLVE } from "@takana-labs/convolve-wasm";',
            "globalThis.__convolve = CONVOLVE;",
            "export {};",
            "",
          ].join("\n"),
        );

        runNpm(["install", "--ignore-scripts"], consumer);
        const buildOutput = runNpm(["run", "build"], consumer);
        const dist = join(consumer, "dist");
        const files = listFiles(dist);
        const JavaScript = files
          .filter((file) => file.endsWith(".js"))
          .map((file) => readFileSync(join(dist, file), "utf8"))
          .join("\n");

        expect(
          files.some((file) => /convolve\.worker-.*\.js$/.test(file)),
          `consumer files:\n${files.join("\n")}`,
        ).toBe(true);
        expect(files.some((file) => file.endsWith(".wasm"))).toBe(true);
        expect(JavaScript).not.toMatch(/https?:\/\//);
        expect(JavaScript).not.toMatch(/data:application\/wasm/);
        expect(buildOutput).not.toMatch(/missing.*wasm/i);
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
