import { PlaybackTracker, type TranscriptSegment, type VideoSignals } from "@shared/video";

/** Smaller than this is a thumbnail preview or a decorative loop, not something being watched. */
const MIN_AREA = 200 * 150;
const FRAME_MAX_WIDTH = 768;

export interface VideoWatcherEvents {
  /** A different video is now the one being watched (also fires for the first). */
  onVideo: (key: string | null) => void;
  /** Continuous forward playback moved from `from` to `to` (seconds). */
  onProgress: (from: number, to: number) => void;
  /** Something about how they're watching changed: a seek, a pause, a resume, a rate change. */
  onBehaviour: () => void;
}

/** Identity of what's playing: the page (minus position noise) plus the media, so SPA navigations and playlists register. */
function videoKey(video: HTMLVideoElement): string {
  const u = new URL(location.href);
  u.hash = "";
  u.searchParams.delete("t");
  return `${u.toString()}|${Math.round(video.duration || 0)}`;
}

/**
 * The rabbit's eyes and ears on a <video>: which one the student is watching, how they are
 * watching it (fed to a {@link PlaybackTracker}), the exact frame on screen, and any captions the
 * page itself carries. Works on any site — nothing here is specific to one player.
 */
export class VideoWatcher {
  readonly tracker = new PlaybackTracker();
  private video: HTMLVideoElement | null = null;
  private key: string | null = null;
  private lastT = 0;
  private detach: (() => void) | null = null;

  constructor(private events: VideoWatcherEvents) {}

  get active(): boolean {
    return this.video !== null && this.key !== null;
  }

  get playing(): boolean {
    return this.active && !this.video!.paused && !this.video!.ended;
  }

  /** Re-scan the page (cheap). Call on init and on every page change. */
  refresh(): void {
    const found = this.findMain();
    if (found !== this.video) this.attach(found);
    else if (found) this.checkIdentity();
  }

  stop(): void {
    this.attach(null);
  }

  private findMain(): HTMLVideoElement | null {
    let best: HTMLVideoElement | null = null;
    let bestArea = MIN_AREA;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      // A muted loop is page decoration (hero banners), not something anyone is watching.
      if (area >= bestArea && !(v.loop && v.muted) && (v.currentSrc || v.src || v.querySelector("source"))) {
        best = v;
        bestArea = area;
      }
    }
    return best;
  }

  /** YouTube plays adverts through the same element; nothing about them is the lesson. */
  private get inAdvert(): boolean {
    return !!this.video?.closest(".ad-showing, .ad-interrupting");
  }

  private attach(video: HTMLVideoElement | null): void {
    this.detach?.();
    this.detach = null;
    this.video = video;
    this.key = null;
    if (!video) {
      this.events.onVideo(null);
      return;
    }
    const on = <K extends keyof HTMLMediaElementEventMap>(type: K, fn: () => void) => {
      video.addEventListener(type, fn);
      return () => video.removeEventListener(type, fn);
    };
    const offs = [
      on("timeupdate", () => {
        if (this.inAdvert || !this.checkIdentity()) return;
        const t = video.currentTime;
        this.tracker.time(t);
        // timeupdate fires ~4×/s; a bigger jump is a seek and is reported by "seeked" instead.
        if (!video.seeking && t > this.lastT && t - this.lastT <= 2) this.events.onProgress(this.lastT, t);
        if (!video.seeking) this.lastT = t;
      }),
      on("seeked", () => {
        if (this.inAdvert || !this.checkIdentity()) return;
        this.tracker.seek(this.lastT, video.currentTime, Date.now());
        this.lastT = video.currentTime;
        this.events.onBehaviour();
      }),
      on("pause", () => {
        if (this.inAdvert || video.ended) return;
        this.tracker.pause(video.currentTime, Date.now());
        this.events.onBehaviour();
      }),
      on("play", () => {
        this.tracker.play(video.playbackRate);
        this.events.onBehaviour();
      }),
      on("ratechange", () => {
        this.tracker.rateChange(video.playbackRate);
        this.events.onBehaviour();
      }),
      on("loadedmetadata", () => void this.checkIdentity()),
      on("durationchange", () => void this.checkIdentity()),
    ];
    this.detach = () => offs.forEach((off) => off());
    this.checkIdentity();
  }

  /** Detects a new video in the same element. Returns false while there is no real video to follow. */
  private checkIdentity(): boolean {
    const video = this.video;
    // Clips under 20s are previews and stingers, not lessons.
    if (!video || this.inAdvert || !Number.isFinite(video.duration) || video.duration < 20) return false;
    const key = videoKey(video);
    if (key !== this.key) {
      this.key = key;
      this.lastT = video.currentTime;
      this.tracker.reset();
      if (video.paused) this.tracker.pause(video.currentTime, Date.now());
      else this.tracker.play(video.playbackRate);
      this.events.onVideo(key);
    }
    return true;
  }

  signals(now: number): VideoSignals {
    if (this.video) this.tracker.time(this.video.currentTime);
    return this.tracker.snapshot(now);
  }

  get duration(): number {
    return this.video && Number.isFinite(this.video.duration) ? this.video.duration : 0;
  }

  get rect(): DOMRect | null {
    return this.video?.getBoundingClientRect() ?? null;
  }

  pause(): void {
    this.video?.pause();
  }

  play(): void {
    void this.video?.play().catch(() => undefined);
  }

  /**
   * The exact frame on screen as a JPEG data URL — read off the element, so no page chrome, no
   * rabbit, and no round trip to the background. null for DRM or cross-origin media (tainted canvas).
   */
  frame(): string | null {
    const v = this.video;
    if (!v || !v.videoWidth || v.readyState < 2) return null;
    try {
      const scale = Math.min(1, FRAME_MAX_WIDTH / v.videoWidth);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(v.videoWidth * scale);
      canvas.height = Math.round(v.videoHeight * scale);
      canvas.getContext("2d")!.drawImage(v, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.6);
    } catch {
      return null;
    }
  }

  /**
   * Captions the page itself carries (<track> elements). A disabled track has no cues loaded;
   * "hidden" loads them without showing anything. Resolves [] when there are none.
   */
  async nativeSegments(timeoutMs = 4000): Promise<TranscriptSegment[]> {
    const v = this.video;
    if (!v) return [];
    const tracks = [...v.textTracks].filter((t) => t.kind === "captions" || t.kind === "subtitles");
    const track = tracks.find((t) => t.language.toLowerCase().startsWith("en")) ?? tracks[0];
    if (!track) return [];
    if (track.mode === "disabled") track.mode = "hidden";
    const started = Date.now();
    while (!track.cues?.length && Date.now() - started < timeoutMs) await new Promise((r) => setTimeout(r, 200));
    return [...(track.cues ?? [])].map((c) => ({ start: c.startTime, end: c.endTime, text: (c as VTTCue).text ?? "" })).filter((s) => s.text.trim());
  }
}
