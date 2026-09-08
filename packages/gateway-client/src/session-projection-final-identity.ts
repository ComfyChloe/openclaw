/** Terminal identity rules used to reconcile live and durable assistant projections. */

import { asNullableRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import {
  hasDisplayableSessionMessage,
  readSessionMessageDisplayContent,
} from "./session-projection-message-content.js";
import {
  readSessionMessageIdentity,
  type SessionMessageIdentity,
} from "./session-projection-message-identity.js";

type TerminalProjectionEntry = {
  message: unknown;
  identity: SessionMessageIdentity | null;
  live: boolean;
};

type TerminalProjectionRun = {
  message?: unknown;
  status: string;
  acceptedFinalMessageIdentities?: readonly string[];
};

function readPersistedFinalIdentity(message: unknown): string | null {
  const identity = readSessionMessageIdentity(message);
  if (identity?.externalSource) {
    return `import:${identity.role}:${identity.externalSource}`;
  }
  if (identity?.id && !identity.isImported) {
    return `id:${identity.role}:${identity.id}`;
  }
  if (identity?.sequence !== null && identity?.sequence !== undefined) {
    return `seq:${identity.role}:${identity.sequence}`;
  }
  return null;
}

function hasCompatiblePersistedFinalIdentity(currentMessage: unknown, incomingMessage: unknown) {
  const current = readSessionMessageIdentity(currentMessage);
  const incoming = readSessionMessageIdentity(incomingMessage);
  if (!current || !incoming || current.role !== incoming.role) {
    return false;
  }
  if (current.isImported || incoming.isImported) {
    if (!current.isImported || !incoming.isImported) {
      return false;
    }
    if (current.externalSource && incoming.externalSource) {
      return current.externalSource === incoming.externalSource;
    }
    return (
      current.sequence !== null &&
      incoming.sequence !== null &&
      current.sequence === incoming.sequence
    );
  }
  if (current.id && incoming.id) {
    return current.id === incoming.id;
  }
  return (
    current.sequence !== null &&
    incoming.sequence !== null &&
    current.sequence === incoming.sequence
  );
}

function readFinalContentIdentity(message: unknown): string | null {
  const display = readSessionMessageDisplayContent(message);
  if (!display.text && !display.hasNonText) {
    return null;
  }
  const identity = readSessionMessageIdentity(message);
  const record = readRecord(message);
  const metadata = readRecord(record?.["__openclaw"]);
  try {
    return `content:${stableStringify([
      identity?.role ?? "assistant",
      typeof message === "string" ? message : (record?.content ?? null),
      metadata?.media ?? null,
      identity?.isImported
        ? [
            metadata?.importedFrom ?? null,
            metadata?.cliSessionId ?? null,
            metadata?.externalId ?? null,
          ]
        : null,
      ...(display.usesFallbackText ? [record?.text] : []),
    ])}`;
  } catch {
    return null;
  }
}

/** Read stable persisted identity first, falling back to canonical display content. */
export function readSessionProjectionFinalMessageIdentity(message: unknown): string | null {
  if (!hasDisplayableSessionMessage(message)) {
    return null;
  }
  return readPersistedFinalIdentity(message) ?? readFinalContentIdentity(message);
}

/** Check whether a displayable terminal may recover a prior empty terminal. */
export function canRecoverSessionProjectionFinal(
  currentMessage: unknown,
  incomingMessage: unknown,
): boolean {
  if (hasDisplayableSessionMessage(currentMessage)) {
    return false;
  }
  const currentIdentity = readPersistedFinalIdentity(currentMessage);
  return (
    currentIdentity === null || hasCompatiblePersistedFinalIdentity(currentMessage, incomingMessage)
  );
}

/** Check whether a run has already accepted the same terminal reply. */
export function hasSessionProjectionAcceptedFinal(
  run: TerminalProjectionRun | undefined,
  message: unknown,
): boolean {
  const identity = readSessionProjectionFinalMessageIdentity(message);
  return Boolean(
    identity &&
    run &&
    (run.acceptedFinalMessageIdentities?.includes(identity) ||
      readSessionProjectionFinalMessageIdentity(run.message) === identity),
  );
}

/** Match an unsequenced live terminal to exactly one durable same-run terminal row. */
export function hasUniqueSnapshotTerminalMatch(
  current: TerminalProjectionEntry,
  matches: readonly TerminalProjectionEntry[],
  run: TerminalProjectionRun | undefined,
): boolean {
  if (
    !current.live ||
    current.identity?.role !== "assistant" ||
    current.identity.id ||
    current.identity.sequence !== null ||
    !run ||
    run.status === "streaming"
  ) {
    return false;
  }
  const terminalContent = readFinalContentIdentity(current.message);
  if (!terminalContent || readFinalContentIdentity(run.message) !== terminalContent) {
    return false;
  }
  const durableTerminalMatches = matches.filter((entry) => {
    const metadata = readRecord(readRecord(entry.message)?.["__openclaw"]);
    return (
      metadata?.runTerminal === true && readFinalContentIdentity(entry.message) === terminalContent
    );
  });
  return durableTerminalMatches.length === 1;
}

/** Check whether ordinary single-match promotion needs terminal-content verification. */
export function isUnsequencedLiveTerminal(
  current: TerminalProjectionEntry,
  run: TerminalProjectionRun | undefined,
): boolean {
  return Boolean(
    current.live &&
    current.identity?.role === "assistant" &&
    !current.identity.id &&
    current.identity.sequence === null &&
    run &&
    run.status !== "streaming" &&
    readFinalContentIdentity(current.message) === readFinalContentIdentity(run.message),
  );
}
