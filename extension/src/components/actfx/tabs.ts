import type { ActDetail, Piece } from "./common";

/** Actions this module acts out: the rabbit and the browser's tabs and pages. */
export const TAB_ACTIONS = new Set(["open_tab", "switch_tab", "navigate", "go_back"]);

/**
 * Tabs and pages. open_tab: he hops up to the top edge under the tab strip and taps; a pixel tab card
 * pops out where he tapped and slides up into the strip. switch_tab: a tap, and the card slides sideways.
 * navigate and go_back: a tap on the top left, then the page goes the way the search does (the dive).
 * TODO(agent): the set pieces.
 */
export const playTabPiece: Piece<ActDetail> = () => undefined;
