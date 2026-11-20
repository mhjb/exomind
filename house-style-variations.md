# Exo-mind: variations from the house style

**Project:** exo-mind, v0.1.0 · **Against:** `house-style/SKILL.md` and `tokens.json` as of 12 November 2026

Exo-mind follows the house style: one buttercup band, white below it, ink, Concrete hairlines, square corners, no shadows, IBM Plex Sans and Mono for the interface, Alegreya for a note read in full, the Harbour colours, square ink bullets and the app patterns. The tokens are copied in as `web/src/house-tokens.css` (without the Google Fonts import; the fonts come from `@fontsource`, so the app and shared pages work offline). This file lists every place it departs from the style, with the reason, so the style project can adopt the change or rule against it.

The aim throughout was to keep the information density Exo-mind had before the restyle: about the same number of notes in the list, and the same amount of a note above the fold.

---

## 1. The band

### 1.1 A slim band
- **House style (apps):** title 44/46 (34/40 past 16 characters), subtitle 16/24, padding 22 / 16 / 18.
- **Exo-mind:** one line, 44px tall: title 22/28 (the house's phone size for the app band), subtitle 14/20 beside it rather than below, version at the right. On narrow windows the subtitle is hidden.
- **Why:** Exo-mind is a three-pane tool used all day. An 86px band would take that much height from the note list, the reader and the graph on every screen. At 44px the band takes back the space of the old sidebar logo row, which it replaces.
- **Suggested SKILL.md wording:** "A working app whose screens are all panes may use a one-line band: title 22/28, subtitle 14/20 on the same line, 44px tall."

### 1.2 No kicker
- The band has no mono kicker: the title is the app's name, so a kicker would repeat it.

### 1.3 The band as the Mac app's title bar
- **House style:** says nothing about desktop windows.
- **Exo-mind (Mac app only):** the window has no title bar; the band is the top of the window. The traffic lights sit in its left end, centred in the 44px, and the band's left padding grows from 16px to 84px to clear them (back to 16px in full screen). The band is what the window is dragged by; its links stay clickable. Applied by the Electron wrapper (`electron/main.cjs`), not the stylesheet, so the browser version is unchanged.
- **Why:** a grey system title bar above a buttercup band would make two bands.
- **Suggested SKILL.md wording:** "In a desktop app the band doubles as the title bar: window controls sit inside it at the left, and it is the drag handle."

---

## 2. Type

### 2.1 Interface text at 14/20
- **House style:** body 16/24; dense 12.5/18 for panels, cards and tooltips.
- **Exo-mind:** navigation, buttons and forms are 13–14px on a 20px line. Cards, the side panel and tooltips use the house's dense 12.5/18, as the style asks.
- **Why:** at 16/24 the sidebar, list and toolbars grew by about a third and showed noticeably less.
- **Suggested SKILL.md wording:** add a type-table row "Interface (apps) | Plex Sans 400, 14/20".

### 2.2 Section labels at 12/16 in panes
- **House style:** section label 13/18.
- **Exo-mind:** 13/18 in the main column, 12/16 in the sidebar and side panel (with the 4px buttercup rule).

### 2.3 Transcripts in Alegreya 17/27
- **House style:** long reading is Alegreya 19/30.
- **Exo-mind:** the note itself is 19/30. A transcript or article text, which you scan for a passage more than read straight through, is 17/27, with Plex Mono timestamps.

---

## 3. Layout

### 3.1 Sidebar 232px
- **House style:** side pane 300px.
- **Exo-mind:** the left sidebar stays 232px and the note list 280–330px, so the reader keeps its 640px measure and the 280px side panel on a laptop screen.

### 3.2 Active rows marked with a buttercup edge
- **New pattern:** the active item in the sidebar and the selected note in the list sit on Receipt grey with a 4px buttercup rule on their left edge, matching the section labels' rule.
- **Suggested SKILL.md wording:** "The selected row in a list: Receipt ground and a 4px buttercup rule on its leading edge."

### 3.3 The gist as a standfirst
- A note's one-line gist opens it as the standfirst (Plex Sans 20/30) followed by the 48×4px buttercup rule, as the long-reading pattern asks; the Alegreya body follows.

---

## 4. Colour

### 4.1 Tags take the six Harbour colours by name
- **House style:** Harbour colours are assigned in slot order and never cycled.
- **Exo-mind:** there are over 200 tags. Each takes one of the six colours from a hash of its name (a tint ground, ink text and a square of the full colour), so a tag is the same colour everywhere. Several tags share each colour; the colour helps you spot a tag again, it doesn't identify it.
- **Why:** assigning in order would recolour every tag whenever one is added, which the style forbids for a different reason ("colour follows the entity").

### 4.2 Stars are buttercup with an ink edge
- Starred notes and people show a buttercup star outlined in ink, as a highlighted mark. In the sidebar's list of starred people, where every row is starred, the stars are ink outlines, so the column isn't a field of yellow.

### 4.3 No dark mode
- Exo-mind had a dark theme. The house style has no dark tokens, so it is gone.

---

## 5. Networks

### 5.1 No dashed lines in the people graphs
- **House style:** lines are solid; dash only links of a different sort (*writes about*, *influence*).
- **Exo-mind:** the secondary links are solid too, just fainter. In the note's people graph, "together elsewhere" is Faint at 0.3 (the main lines are Faint at 0.6, Ink for speakers together). In the library people graph, *talks about* is Faint at 0.2, beside *mentioned together* at 0.45.
- **Why:** in a graph with dozens of crossing lines, dashes read as noise rather than as a different kind of link, and they made the busy graphs look broken. Fainter is enough to set them apart.
- **Suggested SKILL.md wording:** "In a dense network, mark a secondary sort of link by making it fainter, not dashed."

### 5.2 The library people graph
- *Talk together* is Harbour (solid), *talks about* is Faint at 0.2 (solid; see 5.1), and *mentioned together* is Faint (solid, off by default).
- Speakers are ink dots, people only mentioned are Faint dots, and starred people are the buttercup highlights.

### 5.3 Notes graph
- Notes are ink dots. Highlighting a tag fades every other note rather than turning the tagged ones buttercup: a common tag covers up to half the library, which would be a field of yellow. Labels use the same no-overlap placement as the people graph.

---

## 6. Chart frame

### 6.1 No credit on the usage chart
- **House style:** the source line carries the project's credit and licence on the right.
- **Exo-mind:** the daily spending chart on the Usage page has the title, subtitle and source line, but no credit: it shows private costs and never leaves the machine.

---

## 7. Kept as the house style asks

- One band per page (the public share pages have their own), white below it, Concrete hairlines rather than boxes, square corners, no shadows or gradients.
- Text is ink or Muted ink only. Buttercup is never text.
- Plex Mono for dates, durations, counts, costs and timestamps. Titles of works in italic.
- Buttons with a 1.5px ink edge; primary buttons buttercup. 36px controls with a pointer, 44px on touch screens.
- Square ink bullets in the note; tick bars for connection strength.
- Floating panels and menus: white, 1.5px ink edge, buttercup rule under the head.
- Single-series chart (usage) in ink, with the hovered bar buttercup; gridlines in Grid; axis labels Plex Mono 11.
- Status as icon and words.
