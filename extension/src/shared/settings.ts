export interface Settings {
  serverUrl: string;
  proactiveEnabled: boolean;
  ttsEnabled: boolean;
  debugMode: boolean;
  onboarded: boolean;
  micGranted: boolean;
  characterName: string;
  /** Hostnames where the companion stays hidden. */
  hiddenOnHosts: string[];
  /** Start listening automatically when a page loads (only after the user enabled voice once). */
  voiceAutoResume: boolean;
  reducedMotion: "auto" | "on" | "off";
  /**
   * Watching videos along with the student. "ask" offers once; "on" is standing permission to
   * follow silently, offer help, and pause the video for an idea that really matters; "off" never surfaces anything.
   */
  videoCompanion: "ask" | "on" | "off";
  /** Lets the rabbit escalate to real mouse/keyboard input (chrome.debugger). Off by default: attaching shows Chrome's debugging bar. */
  trustedInput: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: "http://localhost:8787",
  proactiveEnabled: true,
  ttsEnabled: true,
  debugMode: false,
  onboarded: false,
  micGranted: false,
  characterName: "White Rabbit",
  hiddenOnHosts: [],
  voiceAutoResume: true,
  reducedMotion: "auto",
  videoCompanion: "ask",
  trustedInput: false,
};

const KEY = "pip.settings";

export async function getSettings(): Promise<Settings> {
  try {
    const raw = await chrome.storage.local.get(KEY);
    return { ...DEFAULT_SETTINGS, ...((raw?.[KEY] as Partial<Settings>) ?? {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export function onSettingsChange(cb: (settings: Settings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== "local" || !changes[KEY]) return;
    cb({ ...DEFAULT_SETTINGS, ...((changes[KEY].newValue as Partial<Settings>) ?? {}) });
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
