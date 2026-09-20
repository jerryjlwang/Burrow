import type { ActDetail, Piece } from "./common";

/** Actions this module acts out: the rabbit's paws on the page. */
export const HAND_ACTIONS = new Set(["click", "double_click", "right_click", "hover", "drag", "press_key", "press_enter", "type", "clear", "select", "focus", "scroll", "scroll_to"]);

/**
 * Hands on the page. click and friends: he hops beside the element, reaches and presses; a squash, a
 * pixel ripple ring and a tap. type: he stands by the field and each character pops in with a blip.
 * press_key and press_enter: a stamp of the foot, a pixel key cap bounces. scroll: he pushes and the
 * page moves with speed lines. drag: he tows it. TODO(agent): the set pieces.
 */
export const playHandsPiece: Piece<ActDetail> = () => undefined;
