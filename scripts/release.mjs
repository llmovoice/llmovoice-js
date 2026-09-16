import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectories = [
  "packages/core",
  "packages/runtime",
  "packages/openai",
  "packages/providers",
  "packages/twilio",
  "packages/react",
  "packages/postgres",
  "packages/supabase",
  "packages/cloud",
];

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: process.env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: options.capture ? "utf8" : undefined,
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0 && !options.allowFailure) {
    fail(`${options.label ?? `${command} ${args.join(" ")}`} failed with exit code ${result.status ?? "unknown"}.`);
  }
  return result;
}

function output(command, args) {
  const result = run(command, args, { capture: true, label: command });
  return result.stdout.trim();
}

function packageManifests() {
  return packageDirectories.map((directory) => {
    const manifestPath = resolve(root, directory, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return { directory, manifest };
  });
}

function validateManifests() {
  const rootManifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const packages = packageManifests();
  const expectedVersion = rootManifest.version;
  const seen = new Set();

  for (const { directory, manifest } of packages) {
    if (!manifest.name?.startsWith("@llmovoice/")) fail(`${directory} has an unexpected package name.`);
    if (seen.has(manifest.name)) fail(`Duplicate package name: ${manifest.name}.`);
    seen.add(manifest.name);
    if (manifest.private) fail(`${manifest.name} is private and cannot be published.`);
    if (manifest.version !== expectedVersion) {
      fail(`${manifest.name} is ${manifest.version}; expected workspace version ${expectedVersion}.`);
    }
    if (manifest.publishConfig?.access !== "public") {
      fail(`${manifest.name} must set publishConfig.access to public.`);
    }
    if (!manifest.repository?.url) fail(`${manifest.name} is missing repository metadata.`);
  }

  console.log(`release: validated ${packages.length} packages at version ${expectedVersion}.`);
  return packages;
}

function verifyTarballContents() {
  for (const { directory, manifest } of packageManifests()) {
    const result = run("pnpm", ["pack", "--dry-run", "--json"], {
      cwd: resolve(root, directory),
      capture: true,
      label: `pack ${manifest.name}`,
    });
    const packed = JSON.parse(result.stdout);
    const files = (Array.isArray(packed) ? packed[0] : packed)?.files ?? [];
    const names = new Set(files.map((file) => file.path ?? file.name));
    for (const required of ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/index.d.ts"]) {
      if (!names.has(required)) fail(`${manifest.name} tarball is missing ${required}.`);
    }
  }
  console.log("release: npm tarball contents look complete.");
}

function check() {
  validateManifests();
  run("pnpm", ["audit", "--prod"]);
  run("pnpm", ["typecheck"]);
  run("pnpm", ["test:coverage"]);
  run("pnpm", ["build"]);
  verifyTarballContents();
}

function pack() {
  check();
  const destination = resolve(root, "artifacts/npm");
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const { directory, manifest } of packageManifests()) {
    run("pnpm", ["pack", "--pack-destination", destination], {
      cwd: resolve(root, directory),
      label: `pack ${manifest.name}`,
    });
  }
  console.log(`release: tarballs written to ${destination}.`);
}

function assertCleanGit() {
  const dirty = output("git", ["status", "--porcelain"]);
  if (dirty) fail("the Git worktree is not clean; commit or stash changes before a real release.");
}

function requireConfirmation(expected) {
  if (process.env.RELEASE_CONFIRM !== expected) {
    fail(`refusing external changes; set RELEASE_CONFIRM=${expected} (or use the documented make command).`);
  }
}

function publish({ dryRun = false, skipCheck = false } = {}) {
  if (!dryRun) requireConfirmation("publish");
  if (!skipCheck) check();
  const tag = process.env.NPM_TAG || "next";
  if (!/^[a-z][a-z0-9._-]*$/i.test(tag)) fail(`invalid npm dist-tag: ${tag}.`);

  if (!dryRun) {
    assertCleanGit();
    run("pnpm", ["whoami"], { label: "npm authentication check" });
  }

  for (const { directory, manifest } of packageManifests()) {
    const args = ["publish", "--access", "public", "--tag", tag, "--no-git-checks"];
    if (dryRun) args.push("--dry-run");
    console.log(`release: ${dryRun ? "checking" : "publishing"} ${manifest.name}@${manifest.version} (${tag}).`);
    run("pnpm", args, { cwd: resolve(root, directory), label: `publish ${manifest.name}` });
  }
}

function push() {
  requireConfirmation("push");
  assertCleanGit();
  const remote = process.env.GIT_REMOTE || "origin";
  const branch = process.env.GIT_BRANCH || output("git", ["branch", "--show-current"]);
  if (!branch) fail("could not determine the current Git branch.");
  run("git", ["push", remote, branch]);
  run("git", ["push", remote, "--tags"]);
}

function release() {
  requireConfirmation("release");
  check();
  assertCleanGit();
  const remote = process.env.GIT_REMOTE || "origin";
  const branch = process.env.GIT_BRANCH || output("git", ["branch", "--show-current"]);
  if (!branch) fail("could not determine the current Git branch.");
  run("git", ["push", remote, branch]);
  run("git", ["push", remote, "--tags"]);
  process.env.RELEASE_CONFIRM = "publish";
  publish({ skipCheck: true });
}

const [command = "help", ...flags] = process.argv.slice(2);
if (command === "check") check();
else if (command === "pack") pack();
else if (command === "publish") publish({ dryRun: flags.includes("--dry-run") });
else if (command === "push") push();
else if (command === "release") release();
else {
  console.log("Usage: node scripts/release.mjs <check|pack|publish|push|release> [--dry-run]");
  if (command !== "help") process.exitCode = 1;
}
