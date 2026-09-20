# Set pieces the backend already supports: the backlog

Every idea here hangs off a signal the backend sends today, so none needs a new server feature. Signals: the executor's actions (`burrow:act`, one per action kind), the video watcher (`burrow:video`), the store's character states (thinking, speaking, listening, celebrating, confused, error), the proactive engine's offers and bubbles, the plan map, the handoff records (`burrow.grants`, `burrow.jump`), and the page arrival record. Built so far: the guide (pointing), the tunnel (the jump), the chalkboard, the teach card, the search escort, and the tabs pieces. S, M, L is the build size.

## Actions (burrow:act)

1. click: he hops beside it and presses; a teal ring and four sparks, a squash on him. (S, in progress)
2. double_click: two rings, two squashes, a "tap tap" cue. (S)
3. right_click: the ring plus a tiny pixel menu card that pops and vanishes. (S)
4. hover: he leans in, the ring breathes twice, no press. (S)
5. type: letters pop above the field and drop in one by one with blips; a pencil glyph tilts. (M, in progress)
6. clear: the letters fly out backwards behind a sweep. (S)
7. press_enter: he stamps; an "Enter" key cap with a return arrow bounces at the field's end. (S)
8. press_key: the same with the key's own label; arrows get a nudge of the page in that direction. (S)
9. scroll and scroll_to: he pushes; speed lines along the edge; the target's brackets lock on when it arrives. (S)
10. drag: a dotted trail to the drop point; he tows with a hop and a landing; the dropped thing gets a dust puff. (M)
11. select: a gold glint sweeps the option list top to bottom, stopping on the chosen one. (S)
12. focus: a soft ring plus a blinking pixel caret above the field. (S)
13. navigate: the address card presses in, he waves and dives; the new page pops him in. (S, done)
14. go_back: the back card, the same dive; on arrival he looks over his shoulder. (S, done)
15. open_tab: the jump and the tab card into the strip. (M, done)
16. switch_tab: the card slides along the strip behind a wipe. (S, done)
17. sketch: chalk dust puffs off his paw before the board rises; on "add" a single new line squeaks in. (S)
18. show_plan: the plan map unrolls like the notes scroll, each step stamped as it appears. (M)
19. wait: he checks his pocket watch (`idle_watch`) and taps his foot until the wait ends. (S)
20. ask_confirmation: he holds up a small pixel sign with "?" until the bubble is answered. (S)

## Watching along (burrow:video)

21. pause by us: he taps the frame's corner, a big pause glyph, the frame dims through dither, he turns to talk. (M, in progress)
22. play by us: a play glyph pulses, the dim lifts, motes drift, he settles to watch. (M, in progress)
23. seek by them: his watch spins in the corner with a tick. (S, in progress)
24. crucial idea coming (the watcher's cue before it pauses): a small "!" pops over his head a second early, so the pause never surprises. (S)
25. a replayed passage (the watcher's replay signal): he scratches his head (`confused` briefly) and a "again?" plank appears. (S)

## Thinking, talking, listening (character states)

26. thinking: the thought bubble already; add a slow drift of three pixel dots up from his head to the bubble. (S)
27. aha: the bulb already; add a ring of six sparks that fly out on the frame the bulb lights. (S)
28. speaking: the mouth already; add a faint 3px sound line that pulses beside him with the voice level. (S)
29. listening: his ears already rise; add a soft teal ring around the mic button that breathes with the input level. (S)
30. barge-in (speech starts while he talks): his bubble snaps shut with a dust puff and his ears go up. (S)
31. error (element missing, disabled control, covered by a dialog): he does `confused` and a pixel "hm" plank flips up; for "covered", the brackets go to the thing that covers it. (S)

## Offers and nudges (the proactive engine)

32. an offer arrives (a hint, a misconception nudge, a wrong step on the tablet or the whiteboard): he hops closer to the kid's side of the page and the offer bubble rises from his feet in three steps. (S)
33. the kid accepts: a `celebrate` and the bubble folds into the panel. Declines: he shrugs (`settle`) and the bubble sinks. (S)
34. a solved page (the engine's celebrate): confetti of cream, gold and teal pixels falls from the top edge in steps, and he does the full `celebrate`. (M)
35. a recurring mistake called back (the engine's callback): the chalkboard rises with the earlier example already written, in the "done" style, and he taps it. (S)

## Plans, memory, and the two laptops

36. a plan step completes (the plan map's live update): the step's stamp bounces once and a pixel tick draws itself. (S)
37. a plan is made (`make_plan`): the notes scroll unrolls with the steps typed out, then rolls into his jacket pocket. (M)
38. a grant arrives (`burrow.grants`, the parent said yes): the celebrate already; add the skill's icon floating down to him like a leaf. (S)
39. the jump (`burrow.jump`): done; add on the parent side the notes scroll landing on the desk with a thump. (S)
40. arrival on a page after an escort (the arrival record): he pops out already facing the thing he came for and the guide points once. (S)
41. teach card "Yes!" (`burrow:taught`): a sprout grows beside the meadow's search plank on the next new tab, the concept sign already on it. (M)

## Ambient (no signal, but cheap and demo-friendly)

42. long quiet on a page: he sits, then dozes (`sleepy`), a pixel "z" drifting up; any input wakes him with a small hop. (S)
43. the page scrolls a long way by hand: he hops to keep up, a few pawprints behind him. (S)
44. window resize: he hole-travels to his corner rather than sliding. (S)
