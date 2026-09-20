# Front end status

Updated: 2026-09-19

## Done

- Oriented in the repo. Front end code lives in `extension/src/components`, `extension/src/content`, `extension/public`, `extension/manifest.json` and `extension/build.mjs`. Static files in `extension/public` are copied to the dist root by the build.
- Rabbit sprite strips and their manifest moved to `extension/public/characters/rabbit` (14 strips, 48 x 58 cells). They ship in dist as `characters/rabbit/*`.
- Sprite tools moved to `tools/sprites/rabbit_px.py`, `tools/sprites/README.md` and `tools/sprite-editor.html`. The two reference players stay in `tools/reference`.
- Generator output path fixed so `python tools/sprites/rabbit_px.py` writes into `extension/public/characters/rabbit`.
- `web_accessible_resources` added for `characters/*` so the content script can load sprites with `chrome.runtime.getURL`.
- Product renamed to Wonderland in front end files: manifest, package.json, popup, onboarding, debug panel. Default character name is White Rabbit. Backend-owned files still say Pip, see `BACKEND_REQUESTS.md`.

## In progress

- Nothing.

## Blocked

- Nothing.

## Next three tasks

1. Thinking animation: keep both eye shapes in place and move only the shine. Verify at 8x on light and dark.
2. Replace the three thinking dots with a hand-placed thought bubble with animated contents.
3. Transition frames between states and a state graph in the character manifest.

## Notes

- Typecheck, build and unit tests pass on the `frontend` branch as of this update.
- The onboarding page still renders the old CSS/SVG mascot. It switches to the rabbit once the sprite player exists.
