import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export function saveDurableJson(directory, name, value) {
  const file = fs.openSync(path.join(directory, name), "wx", 0o600);
  try {
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
    fs.fsyncSync(file);
  } finally {
    fs.closeSync(file);
  }
  const parent = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(parent);
  } finally {
    fs.closeSync(parent);
  }
}

export function exportTerminalEvidence({ directory, cgroup, readPhaseWriter, evaluatePhaseBudget }) {
  const errors = {};
  const observe = (name, read) => {
    try {
      return read();
    } catch (error) {
      errors[name] = String(error);
      return null;
    }
  };
  const remainingPids = observe("remainingPids", () =>
    fs.readFileSync(path.join(cgroup, "cgroup.procs"), "utf8").trim()
      .split(/\s+/u).filter(Boolean).map(Number).filter(pid => pid !== process.pid),
  );
  const priorEvidence = observe("priorEvidence", () => {
    const names = ["plan.json", "baseline.json", "allocator.json", "result.json", "guard-stop.json", "spawn-error.json", "final-sample-error.json", "monitor-death-intent.json"];
    return names.filter(name => fs.existsSync(path.join(directory, name))).map(name => {
      const bytes = fs.readFileSync(path.join(directory, name));
      return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    });
  });
  const stop = {
    at: new Date().toISOString(),
    exporterPid: process.pid,
    invocationId: process.env.INVOCATION_ID ?? null,
    serviceResult: process.env.SERVICE_RESULT ?? null,
    exitCode: process.env.EXIT_CODE ?? null,
    exitStatus: process.env.EXIT_STATUS ?? null,
    cgroup,
    cgroupIdentity: observe("cgroupIdentity", () => {
      const stat = fs.statSync(cgroup, { bigint: true });
      return `${stat.dev}:${stat.ino}`;
    }),
    remainingPids,
    stopped: remainingPids === null ? null : remainingPids.length === 0,
    memoryPeak: observe("memoryPeak", () => fs.readFileSync(path.join(cgroup, "memory.peak"), "utf8").trim()),
    priorEvidence,
    errors,
    accountingStatus: "pending",
  };
  // Keep lifecycle and earlier failures durable before the final counter reader can fail.
  saveDurableJson(directory, "terminal-stop.json", stop);

  let writer = null;
  let charge = null;
  let samplingError = null;
  let accountingStatus = "unavailable";
  try {
    const baselineFile = path.join(directory, "baseline.json");
    const baseline = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, "utf8")) : null;
    writer = readPhaseWriter(cgroup);
    if (baseline) {
      charge = evaluatePhaseBudget(baseline, baseline.writers, [writer]);
      accountingStatus = "complete";
    }
  } catch (error) {
    samplingError = { error: String(error), stack: error?.stack ?? null };
    accountingStatus = "error";
  }
  const terminal = {
    ...stop,
    at: new Date().toISOString(),
    stopReceipt: "terminal-stop.json",
    accountingStatus,
    writer,
    charge,
    pendingBytes: writer?.pendingBytes ?? null,
    samplingError,
    receiptAfterSample: true,
    tailHoldBytes: 1048576,
  };
  saveDurableJson(directory, "terminal.json", terminal);
  return terminal;
}
