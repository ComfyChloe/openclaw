import { readFileSync, realpathSync, statSync, statfsSync } from "node:fs";
import { hostname } from "node:os";
import { join, sep } from "node:path";

function bytes(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
}

function pendingBytes(path) {
  const rows = new Map(
    readFileSync(join(path, "memory.stat"), "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(/\s+/)),
  );
  return (
    bytes(Number(rows.get("file_dirty")), "file_dirty") +
    bytes(Number(rows.get("file_writeback")), "file_writeback")
  );
}

function writerIdentity(path) {
  const stat = statSync(path, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}

export function parsePhaseWrites(input) {
  if (input && !input.endsWith("\n")) throw new Error("Invalid incomplete io.stat frame");
  const io = input.trim();
  const writes = {};
  for (const line of io ? io.split("\n") : []) {
    const [device, ...fields] = line.trim().split(/\s+/);
    const value = fields.find((field) => field.startsWith("wbytes="));
    if (
      !/^\d+:\d+$/.test(device) ||
      Object.hasOwn(writes, device) ||
      (fields.length > 0 && (!value || !/^wbytes=\d+$/.test(value)))
    )
      throw new Error(`Invalid io.stat row: ${line}`);
    writes[device] = fields.length === 0 ? 0 : bytes(Number(value.slice(7)), "wbytes");
  }
  return writes;
}

export function readPhaseWriter(path) {
  const canonical = realpathSync(path);
  if (
    canonical !== path ||
    !path.startsWith(`/sys/fs/cgroup${sep}`) ||
    statfsSync(path).type !== 0x63677270
  ) {
    throw new Error(`Use an exact local cgroup-v2 directory: ${path}`);
  }
  const identity = writerIdentity(path);
  // Dirty pages may flush while reading io.stat. Keep both pending samples so
  // a flush cannot remove the charge before its write counter is observed.
  const before = pendingBytes(path);
  const writes = parsePhaseWrites(readFileSync(join(path, "io.stat"), "utf8"));
  const pending = Math.max(before, pendingBytes(path));
  if (writerIdentity(path) !== identity)
    throw new Error(`Writer cgroup changed while sampled: ${path}`);
  return { path, identity, writes, pendingBytes: pending };
}

export function capturePhaseBudget({
  phaseId,
  limitBytes,
  prechargedBytes,
  cancellationMarginBytes,
  writerPaths,
}) {
  if (typeof phaseId !== "string" || !phaseId.trim())
    throw new Error("A recorded phase ID is required");
  bytes(limitBytes, "phase limit");
  bytes(prechargedBytes, "precharged bytes");
  bytes(cancellationMarginBytes, "cancellation margin");
  if (
    cancellationMarginBytes === 0 ||
    cancellationMarginBytes >= limitBytes ||
    prechargedBytes >= limitBytes - cancellationMarginBytes
  ) {
    throw new Error(
      "The unchanged phase limit must cover precharged bytes and a positive cancellation margin",
    );
  }
  if (!Array.isArray(writerPaths) || writerPaths.length === 0)
    throw new Error("List every task-owned allocating cgroup");
  const paths = [...writerPaths].sort();
  for (let index = 1; index < paths.length; index++) {
    if (
      paths.some(
        (parent, parentIndex) =>
          parentIndex < index &&
          (paths[index] === parent || paths[index].startsWith(`${parent}${sep}`)),
      )
    ) {
      throw new Error("Writer cgroups must be distinct and non-overlapping");
    }
  }
  return {
    version: 1,
    phaseId,
    limitBytes,
    prechargedBytes,
    cancellationMarginBytes,
    host: hostname(),
    bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    writers: paths.map(readPhaseWriter),
  };
}

export function evaluatePhaseBudget(baseline, previous, current) {
  if (previous.length !== baseline.writers.length || current.length !== baseline.writers.length)
    throw new Error("Writer coverage changed");
  let writtenBytes = 0;
  let pending = 0;
  for (let index = 0; index < baseline.writers.length; index++) {
    const initial = baseline.writers[index];
    const last = previous[index];
    const now = current[index];
    if (
      initial.path !== now.path ||
      initial.identity !== now.identity ||
      initial.path !== last.path ||
      initial.identity !== last.identity
    ) {
      throw new Error(`Writer identity changed: ${initial.path}`);
    }
    for (const [device, value] of Object.entries(last.writes)) {
      if (!Object.hasOwn(now.writes, device) || now.writes[device] < value)
        throw new Error(`Write counter regressed: ${initial.path} ${device}`);
    }
    // Count all devices and all owned writers. A stacked block device can be
    // counted twice; this conservative cost is preferable to omitting a disk.
    for (const [device, value] of Object.entries(now.writes))
      writtenBytes += bytes(value, "wbytes") - (initial.writes[device] ?? 0);
    pending += bytes(now.pendingBytes, "pending write bytes");
  }
  const chargedBytes = bytes(baseline.prechargedBytes + writtenBytes + pending, "phase charge");
  const stopAtBytes = baseline.limitBytes - baseline.cancellationMarginBytes;
  return {
    check: "phase-disk",
    phaseId: baseline.phaseId,
    passed: chargedBytes < stopAtBytes,
    limitBytes: baseline.limitBytes,
    cancellationMarginBytes: baseline.cancellationMarginBytes,
    prechargedBytes: baseline.prechargedBytes,
    writtenBytes,
    pendingBytes: pending,
    chargedBytes,
    stopAtBytes,
    writers: current,
  };
}

export function guardPhaseBudget(baseline) {
  baseline = structuredClone(baseline);
  let previous = baseline.writers;
  let closed = false;
  return () => {
    if (closed)
      throw new Error(
        "Phase guard is closed; retain the failure and use the owner's recorded resume decision",
      );
    try {
      if (
        baseline.version !== 1 ||
        baseline.host !== hostname() ||
        baseline.bootId !== readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
      ) {
        throw new Error("Phase baseline belongs to a different host, boot or format");
      }
      const current = baseline.writers.map(({ path }) => readPhaseWriter(path));
      const observation = evaluatePhaseBudget(baseline, previous, current);
      previous = structuredClone(current);
      if (!observation.passed) {
        const error = new Error(
          `Phase disk stop: ${observation.chargedBytes} bytes reached ${observation.stopAtBytes}`,
        );
        error.observation = observation;
        throw error;
      }
      return observation;
    } catch (error) {
      closed = true;
      throw error;
    }
  };
}
