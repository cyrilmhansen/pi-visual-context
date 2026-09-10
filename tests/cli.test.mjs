import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const cli = join(root, "bin/pvc.mjs");

function spawn(args, cwd) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
}

test("headless CLI prepares a portable bundle and resolves it without Pi or sources", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pvc-cli-"));
  const source = join(dir, "sample.py");
  const bundle = join(dir, "bundle");
  cpSync(join(root, "tests/fixtures/sample.py"), source);
  const prepare = await spawn(["prepare", "--cwd", dir, "--output", bundle, "sample.py"], dir);
  assert.equal(prepare.status, 0, prepare.stderr);
  const snapshot = JSON.parse(prepare.stdout);
  assert.equal(prepare.stdout.trim().startsWith("{"), true);
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(readFileSync(join(bundle, "snapshot.json"), "utf8"), prepare.stdout);
  assert.ok(snapshot.artifacts.every((artifact) => artifact.relativePath?.startsWith("artifacts/")));
  assert.ok(snapshot.artifacts.every((artifact) => existsSync(join(bundle, artifact.relativePath))));
  assert.ok(readdirSync(join(bundle, "artifacts")).length >= 1);
  const tablet = snapshot.tablets[0].id;
  const resolved = await spawn(["resolve-tablet", "--snapshot", join(bundle, "snapshot.json"), tablet], "/");
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(resolved.stdout.includes("Focus on source tablet"), false);
  assert.equal(JSON.parse(resolved.stdout).tablet.id, tablet);
  const symbol = await spawn(["resolve-symbol", "--snapshot", join(bundle, "snapshot.json"), "compute"], "/");
  assert.equal(symbol.status, 0, symbol.stderr);
  assert.equal(JSON.parse(symbol.stdout).symbol.name, "compute");
  const symbols = await spawn(["symbols", "--snapshot", join(bundle, "snapshot.json"), "compute"], "/");
  assert.equal(symbols.status, 0, symbols.stderr);
  assert.equal(JSON.parse(symbols.stdout).symbols.length >= 1, true);
  const overwrite = spawn(["prepare", "--cwd", dir, "--output", bundle, "sample.py"], dir);
  assert.notEqual(overwrite.status, 0);
  assert.match(overwrite.stderr, /output already exists/);
  rmSync(source, { force: true });
  rmSync(join(dir, ".pi"), { recursive: true, force: true });
  const afterDeletion = await spawn(["symbols", "--snapshot", join(bundle, "snapshot.json")], "/");
  assert.equal(afterDeletion.status, 0, afterDeletion.stderr);
  rmSync(dir, { recursive: true, force: true });
});

test("headless CLI rejects invalid snapshots before resolution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pvc-cli-invalid-"));
  const invalid = join(dir, "snapshot.json");
  writeFileSync(invalid, JSON.stringify({ schemaVersion: 2 }));
  const result = await spawn(["resolve-tablet", "--snapshot", invalid, "VC-000001"], "/");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported SourceContextSnapshot schemaVersion/);
  assert.equal(result.stdout, "");
  rmSync(dir, { recursive: true, force: true });
});
