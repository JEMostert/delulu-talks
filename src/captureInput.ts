export interface CaptureInput {
  stream: MediaStream;
  deviceId: string;
  label: string;
  defaultDeviceId: string | null;
  usesSystemDefault: boolean;
}

export interface CaptureInputEvent {
  kind: "default-changed" | "input-lost";
  message: string;
}

function isPhysicalId(deviceId: string | undefined): deviceId is string {
  return Boolean(
    deviceId && deviceId !== "default" && deviceId !== "communications",
  );
}

function physicalInputs(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
  return devices.filter(
    (device) => device.kind === "audioinput" && isPhysicalId(device.deviceId),
  );
}

function fromGroup(
  devices: MediaDeviceInfo[],
  groupId: string | undefined,
): MediaDeviceInfo | undefined {
  if (!groupId) return undefined;
  const matches = physicalInputs(devices).filter(
    (device) => device.groupId === groupId,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function defaultInput(devices: MediaDeviceInfo[]): MediaDeviceInfo | undefined {
  const alias = devices.find(
    (device) => device.kind === "audioinput" && device.deviceId === "default",
  );
  return fromGroup(devices, alias?.groupId);
}

function trackInput(
  track: MediaStreamTrack,
  devices: MediaDeviceInfo[],
): MediaDeviceInfo | undefined {
  const settings = track.getSettings();
  if (isPhysicalId(settings.deviceId)) {
    const direct = physicalInputs(devices).find(
      (device) => device.deviceId === settings.deviceId,
    );
    if (direct) return direct;
  }
  return fromGroup(devices, settings.groupId);
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // A failing track must not prevent releasing the remaining tracks.
    }
  }
}

function audioTrack(stream: MediaStream): MediaStreamTrack {
  const track = stream.getAudioTracks()[0];
  if (!track || track.readyState === "ended")
    throw new Error(
      "The microphone stopped before recording could start. Choose an available input and try again.",
    );
  return track;
}

function boundedLabel(label: string): string {
  return label
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 160);
}

function constraints(deviceId?: string): MediaStreamConstraints {
  return {
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  };
}

export async function acquireCaptureInput(
  requestedDeviceId: string,
): Promise<CaptureInput> {
  const mediaDevices = navigator.mediaDevices;
  const ownedStreams = new Set<MediaStream>();
  try {
    const useDefault = !requestedDeviceId || requestedDeviceId === "default";
    if (!useDefault && !isPhysicalId(requestedDeviceId))
      throw new Error(
        "Choose a physical microphone or System default in Settings, then try again.",
      );
    let stream = await mediaDevices.getUserMedia(
      constraints(useDefault ? undefined : requestedDeviceId),
    );
    ownedStreams.add(stream);
    let track = audioTrack(stream);
    let devices: MediaDeviceInfo[];
    try {
      devices = await mediaDevices.enumerateDevices();
    } catch (error) {
      if (useDefault) throw error;
      // An exact physical request already pins an explicit selection. A
      // transient enumeration failure must not prevent that capture.
      devices = [];
    }
    // Enumerating after permission is essential: IDs and groups may previously
    // have been withheld by the browser.
    const physical =
      trackInput(track, devices) ??
      (useDefault ? defaultInput(devices) : undefined);
    const physicalId =
      physical?.deviceId ?? (!useDefault ? requestedDeviceId : undefined);
    if (!physicalId)
      throw new Error(
        "The browser could not identify the physical microphone. Choose a specific microphone in Settings and try again.",
      );
    const actualId = track.getSettings().deviceId;
    if (
      !useDefault &&
      (physicalId !== requestedDeviceId ||
        (actualId && actualId !== requestedDeviceId))
    )
      throw new Error(
        "The selected microphone is unavailable. Choose an available input in Settings and try again.",
      );
    const initialDefault =
      defaultInput(devices)?.deviceId ?? (useDefault ? physicalId : null);

    // Any stream requested with default constraints may follow OS changes,
    // even when its current settings report a physical ID. Always reopen with
    // that exact physical ID before giving ownership to the recorder.
    if (useDefault) {
      const pinned = await mediaDevices.getUserMedia(constraints(physicalId));
      ownedStreams.add(pinned);
      stopStream(stream);
      ownedStreams.delete(stream);
      stream = pinned;
      track = audioTrack(stream);
      devices = await mediaDevices.enumerateDevices();
    }
    if (
      track.readyState === "ended" ||
      (!useDefault &&
        Boolean(track.getSettings().deviceId) &&
        track.getSettings().deviceId !== physicalId) ||
      (useDefault && track.getSettings().deviceId !== physicalId) ||
      (useDefault &&
        !physicalInputs(devices).some(
          (device) => device.deviceId === physicalId,
        ))
    )
      throw new Error(
        "The browser could not keep the selected physical microphone fixed. Choose another microphone in Settings and try again.",
      );
    const label = boundedLabel(physical?.label || track.label) || "Microphone";
    ownedStreams.delete(stream);
    return {
      stream,
      deviceId: physicalId,
      label,
      defaultDeviceId: initialDefault,
      usesSystemDefault: useDefault,
    };
  } catch (error) {
    for (const stream of ownedStreams) stopStream(stream);
    throw error;
  }
}

export function watchCaptureInput(
  input: CaptureInput,
  onEvent: (event: CaptureInputEvent) => void,
): () => void {
  const mediaDevices = navigator.mediaDevices;
  const track = input.stream.getAudioTracks()[0];
  let active = true;
  let lost = false;
  let epoch = 0;
  let checking = false;
  let rerun = false;
  let lastDefault = input.defaultDeviceId;
  const label = boundedLabel(input.label) || "Microphone";

  const reportLost = () => {
    if (!active || lost) return;
    lost = true;
    onEvent({
      kind: "input-lost",
      message: `The recording microphone (${label}) is no longer available. Capture stopped; audio already recorded is being kept for transcription. Reconnect it or choose another input.`,
    });
  };

  const inspect = (devices: MediaDeviceInfo[]) => {
    if (!active || lost) return;
    const settingsId = track?.getSettings().deviceId;
    if (
      !track ||
      track.readyState === "ended" ||
      !physicalInputs(devices).some(
        (device) => device.deviceId === input.deviceId,
      ) ||
      (Boolean(settingsId) && settingsId !== input.deviceId)
    ) {
      reportLost();
      return;
    }
    if (!input.usesSystemDefault) return;
    const currentDefault = defaultInput(devices)?.deviceId;
    // Some browsers omit the default marker. Unknown identity is not evidence
    // of a change or disconnection, and must not replace the last known ID.
    if (!currentDefault) return;
    const previous = lastDefault;
    lastDefault = currentDefault;
    if (previous !== null && currentDefault !== previous) {
      onEvent({
        kind: "default-changed",
        message: `The system default microphone changed. Recording continues with ${label}; the new default applies to the next recording.`,
      });
    }
  };

  const check = async () => {
    if (!active || lost) return;
    if (checking) {
      rerun = true;
      return;
    }
    checking = true;
    try {
      do {
        rerun = false;
        const startedEpoch = epoch;
        let devices: MediaDeviceInfo[];
        try {
          devices = await mediaDevices.enumerateDevices();
        } catch {
          // Permission or enumeration failures cannot prove an input vanished.
          continue;
        }
        if (active && !lost && startedEpoch === epoch) inspect(devices);
      } while (active && !lost && rerun);
    } finally {
      checking = false;
    }
  };

  const deviceChanged = () => {
    if (!active || lost) return;
    epoch += 1;
    void check();
  };
  const cleanup = () => {
    if (!active) return;
    active = false;
    epoch += 1;
    rerun = false;
    mediaDevices.removeEventListener("devicechange", deviceChanged);
    track?.removeEventListener("ended", reportLost);
  };
  mediaDevices.addEventListener("devicechange", deviceChanged);
  track?.addEventListener("ended", reportLost);
  // Catch a disconnect between acquisition and listener registration as well.
  if (!track || track.readyState === "ended") queueMicrotask(reportLost);
  else void check();
  return cleanup;
}
