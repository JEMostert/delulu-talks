import type { Page } from "@playwright/test";

/** Real Chromium fake audio with explicit fixture physical-device metadata. */
export async function identifySyntheticMicrophone(page: Page) {
  await page.addInitScript(() => {
    const devices = navigator.mediaDevices;
    const getUserMedia = devices.getUserMedia.bind(devices);
    devices.enumerateDevices = async () => [
      {
        deviceId: "fixture-microphone",
        groupId: "fixture-audio-group",
        kind: "audioinput",
        label: "Synthetic fixture microphone",
        toJSON() {
          return {
            deviceId: this.deviceId,
            groupId: this.groupId,
            kind: this.kind,
            label: this.label,
          };
        },
      },
    ];
    devices.getUserMedia = async (constraints) => {
      // The fixture identity is not a Chromium device ID; acquire the real
      // fake audio source, then annotate its track for physical pinning logic.
      const audio = constraints?.audio;
      const stream = await getUserMedia({
        ...constraints,
        audio:
          typeof audio === "object" ? { ...audio, deviceId: undefined } : audio,
      });
      for (const track of stream.getAudioTracks()) {
        const settings = track.getSettings.bind(track);
        track.getSettings = () => ({
          ...settings(),
          deviceId: "fixture-microphone",
          groupId: "fixture-audio-group",
        });
      }
      return stream;
    };
  });
}
