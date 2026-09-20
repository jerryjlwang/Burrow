import type { Piece, VideoDetail } from "./common";

/**
 * Watching along. pause by us: he hops to the video's corner and pats a big pixel pause glyph; the frame
 * dims in Bayer steps while he talks. play by us: he taps a play glyph that pulses, the dim lifts and he
 * settles beside the frame to watch. pause, play and seek by them: he reacts from where he is (turns to
 * watch, a glance at his pocket watch on a seek). TODO(agent): the set pieces.
 */
export const playVideoPiece: Piece<VideoDetail> = () => undefined;
