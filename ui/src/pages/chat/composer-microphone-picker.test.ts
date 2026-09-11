import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { ComposerMicrophonePicker } from "./composer-microphone-picker.ts";
import * as realtimeTalkInput from "./realtime-talk-input.ts";

function catalog(ready: boolean) {
  return {
    realtime: { ready, providers: [] },
    transcription: { ready, providers: [] },
  };
}

function standaloneDictationCatalog(ready: boolean) {
  return { ready, providers: [] };
}

let picker: ComposerMicrophonePicker;

afterEach(() => {
  picker?.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("composer voice readiness", () => {
  it("refreshes after returning from login on the same Gateway connection", async () => {
    let ready = false;
    const request = vi.fn(async (method: string) =>
      method === "dictation.catalog" ? standaloneDictationCatalog(ready) : catalog(ready),
    );
    const client = { request } as unknown as GatewayBrowserClient;
    picker = new ComposerMicrophonePicker(vi.fn());
    picker.syncCatalog(client, true);
    await vi.waitFor(() => expect(picker.realtimeStatus).toBe("unavailable"));

    ready = true;
    window.dispatchEvent(new Event("focus"));

    await vi.waitFor(() => expect(picker.realtimeStatus).toBe("ready"));
    expect(picker.dictationStatus).toBe("ready");
    expect(request).toHaveBeenCalledTimes(4);
    expect(request).toHaveBeenLastCalledWith("dictation.catalog", {});
    expect(picker.open).toBe(false);
  });

  it("retires focus requests on disposal and reconnects a reused picker without stale results", async () => {
    const stale = createDeferred<ReturnType<typeof catalog>>();
    let talkRequests = 0;
    let dictationRequests = 0;
    const request = vi.fn((method: string) => {
      if (method === "talk.catalog") {
        talkRequests += 1;
        if (talkRequests === 1) {
          return Promise.resolve(catalog(false));
        }
        if (talkRequests === 2) {
          return stale.promise;
        }
        return Promise.resolve(catalog(true));
      }
      dictationRequests += 1;
      return Promise.resolve(standaloneDictationCatalog(dictationRequests > 2));
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const requestUpdate = vi.fn();
    picker = new ComposerMicrophonePicker(requestUpdate);
    picker.syncCatalog(client, true);
    await vi.waitFor(() => expect(picker.realtimeStatus).toBe("unavailable"));
    window.dispatchEvent(new Event("focus"));
    expect(request).toHaveBeenCalledTimes(4);

    picker.dispose();
    window.dispatchEvent(new Event("focus"));
    expect(request).toHaveBeenCalledTimes(4);
    expect(picker.realtimeStatus).toBe("unknown");

    picker.syncCatalog(client, true);
    await vi.waitFor(() => expect(picker.realtimeStatus).toBe("ready"));
    requestUpdate.mockClear();
    stale.resolve(catalog(false));
    await stale.promise;
    await Promise.resolve();
    expect(picker.realtimeStatus).toBe("ready");
    expect(requestUpdate).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("focus"));
    expect(request).toHaveBeenCalledTimes(8);
    picker.syncCatalog(client, false);
    window.dispatchEvent(new Event("focus"));
    expect(request).toHaveBeenCalledTimes(8);
  });

  it("loads the standalone dictation catalog when the Talk catalog fails", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.catalog") {
        throw new Error("Talk catalog unavailable");
      }
      if (method === "dictation.catalog") {
        return standaloneDictationCatalog(true);
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    picker = new ComposerMicrophonePicker(vi.fn());
    picker.syncCatalog(client, true);
    await vi.waitFor(() => expect(picker.dictationStatus).toBe("ready"));
    expect(picker.realtimeStatus).toBe("unavailable");
    expect(request).toHaveBeenNthCalledWith(1, "talk.catalog", {});
    expect(request).toHaveBeenNthCalledWith(2, "dictation.catalog", {});
  });
});

describe("media permission lifetime: composer", () => {
  it.each(["close", "dispose", "replace", "remain open"] as const)(
    "%s during pending discovery",
    async (transition) => {
      const initial = createDeferred<MediaDeviceInfo[]>();
      const replacement = createDeferred<MediaDeviceInfo[]>();
      const enumerateDevices = vi.fn().mockReturnValueOnce(initial.promise);
      if (transition === "replace") {
        enumerateDevices.mockReturnValueOnce(replacement.promise);
      }
      enumerateDevices.mockResolvedValue([]);
      const stop = vi.fn();
      const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
      const addEventListener = vi.fn();
      const removeEventListener = vi.fn();
      vi.stubGlobal("navigator", {
        mediaDevices: { enumerateDevices, getUserMedia, addEventListener, removeEventListener },
      });
      // Call through unchanged: the returned promise only makes the actual owner boundary awaitable.
      const discovery = vi.spyOn(realtimeTalkInput, "discoverRealtimeTalkInputs");
      picker = new ComposerMicrophonePicker(vi.fn());
      picker.handleOpen();
      expect(enumerateDevices).toHaveBeenCalledOnce();
      expect(getUserMedia).not.toHaveBeenCalled();
      if (transition === "dispose") {
        picker.dispose();
      } else if (transition !== "remain open") {
        picker.handleClose();
      }
      if (transition === "replace") {
        picker.handleOpen();
      }
      initial.resolve([]);
      const initialDiscovery = discovery.mock.results[0];
      assert.isDefined(initialDiscovery);
      await initialDiscovery.value;
      const staleProbes = getUserMedia.mock.calls.length;
      if (transition === "replace") {
        replacement.resolve([]);
        const replacementDiscovery = discovery.mock.results[1];
        assert.isDefined(replacementDiscovery);
        await replacementDiscovery.value;
      }
      expect(staleProbes).toBe(transition === "remain open" ? 1 : 0);
      const permits = transition === "remain open" || transition === "replace";
      expect(getUserMedia).toHaveBeenCalledTimes(permits ? 1 : 0);
      expect(stop).toHaveBeenCalledTimes(permits ? 1 : 0);
      expect(picker.open).toBe(permits);
      picker.dispose();
      expect(removeEventListener.mock.calls).toEqual(addEventListener.mock.calls);
    },
  );
});
