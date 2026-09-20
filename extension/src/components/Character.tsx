import type { CharacterState } from "../content/store";
import { SpritePet, type PetBox, type PetController } from "./pet";

export interface CharacterProps {
  state: CharacterState;
  /** 0..1 audio level; drives the mouth overlay while speaking. */
  level: number;
  /** Kept for callers; the rabbit does not lean or walk, so it is ignored. */
  lookAt: { x: number; y: number } | null;
  attention: 0 | 1 | 2;
  reducedMotion: boolean;
  /** Rough target height in px. Rounded to a whole-number sprite scale. Ignored when `scale` is set. */
  size?: number;
  /** Whole-number draw scale. Default 3. */
  scale?: number;
  /** Folder under public/characters. Default rabbit. */
  character?: string;
  /** Reports the character's current center in viewport coordinates (used by the pointer beam). */
  onAnchor?: (getCenter: () => { x: number; y: number }) => void;
  /** Receives the clamped footprint when the pet is dragged or moved. Enables dragging. */
  onPosition?: (box: PetBox) => void;
  /** Receives the imperative pet API once the art is loaded, null on unmount. */
  onController?: (controller: PetController | null) => void;
  /** Nothing is going on (panel closed, no bubble, idle, voice off). Lets the pet wander now and then. */
  quiet?: boolean;
  /** Called with the strip name each time a different state starts showing. */
  onShown?: (state: string) => void;
}

/** Store state to manifest state. Speaking is idle plus the mouth overlay. */
const STATE_MAP: Record<CharacterState, string> = {
  idle: "idle",
  listening: "listening",
  thinking: "thinking",
  speaking: "idle",
  pointing: "idle",
  acting: "idle",
  celebrating: "celebrate",
  confused: "confused",
  sleeping: "sleepy",
  error: "confused",
};

export function mapCharacterState(state: CharacterState, attention: 0 | 1 | 2): { name: string; speaking: boolean } {
  const base = STATE_MAP[state] ?? "idle";
  const name = attention === 2 && base === "idle" ? "confused" : base;
  return { name, speaking: state === "speaking" };
}

/** The White Rabbit: a manifest-driven sprite. Art and playback live in ./pet; only the mapping lives here. */
export function Character({ state, level, attention, reducedMotion, size, scale, character, onAnchor, onPosition, onController, quiet, onShown }: CharacterProps) {
  const mapped = mapCharacterState(state, attention);
  return (
    <SpritePet
      character={character}
      state={mapped.name}
      speaking={mapped.speaking}
      level={level}
      reducedMotion={reducedMotion}
      scale={scale}
      size={size}
      onAnchor={onAnchor}
      onPosition={onPosition}
      onController={onController}
      quiet={quiet}
      onShown={onShown}
    />
  );
}
