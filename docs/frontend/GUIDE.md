# The guide: how the rabbit shows you something

When the agent points at something (`point_to`, a hint on the answer box, "where is the sign in button"), the page used to get a dashed curve with a stock arrowhead and a rectangle ring. It now gets the rabbit's own way of showing: `extension/src/components/Overlay.tsx`, the `.pip-hl` and `.pip-beam` rules in `styles.css`, and the pieces in `extension/public/ui/guide/` from `tools/sprites/guide_px.py`.

## The parts

- The trail. A hop of pawprints is laid along a gentle arc from his feet to the target, one print every 70 ms, left and right paws a little either side of the path and turned to follow it. Only the last seven prints stay, the older ones fading in two steps, so the eye follows the newest. After a short hold the hop is laid again while the point lasts. When either end moves more than a grid of 24 px (he hops over, the page scrolls) the trail is laid from the new places.
- The lock-on. Four pixel corner brackets (cream with a brown outline, gold while he is about to act) snap in from two grid steps out over three steps, then breathe one step out and back every 1.2 s. The frame follows the target through scrolling as before.
- The spotlight. A flat tint of ink at 20 percent under a 4 by 4 Bayer dither of soft ink cells, with a window cut out around the target that closes in on it in six steps. Text under the dim stays readable; the target is untouched.
- The plank. A label hangs from the top bracket on a small plank with the bubble frame, on the side away from the rabbit, or stands under the bottom bracket when the target is near the top of the window.
- Off screen. A target outside the window gets a pawprint at the nearest edge, nudging the way twice a second, until the target scrolls in.
- The rabbit waves once when he starts pointing (`pointing` maps to `wave`) and keeps looking at the target.

Reduced motion: no trail, the brackets appear where they land, the spotlight appears whole.

## Testing

The Developer panel's "point: here" button (or `window.dispatchEvent(new CustomEvent("burrow:point", { detail: { selector: "header a.btn", label: "Sign in" } }))` on any page) points him at an element through the same `OverlayController.pointAt` the agent uses. The checks in `tools/pet/check.mjs` and `e2e/smoke.mjs` look for `.pip-hl`, `.pip-hl-label` and `.pip-beam`; those names stay.

Inspiration: screen-edge waypoint markers and lock-on brackets from game HUDs (the Game UI Database's markers collection), the spotlight and single-element focus of coach marks (Adobe Spectrum's coach mark, ui-patterns.com's coachmarks), and pixel cursor trails.
