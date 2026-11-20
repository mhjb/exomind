# Project notes for Claude

## Visual style
The house style lives in a separate folder beside this checkout and isn't part of this repository;
the tokens the app needs are already copied in (below), so it builds without it.

Follow the shared house style in `../house-style/SKILL.md` for any UI, chart, graph or
document. Values come from `../house-style/tokens.json` (CSS: `tokens.css` + `house.css`);
don't introduce colours or fonts that aren't there. Copy patterns from
`../house-style/examples/`.

The tokens are copied into `web/src/house-tokens.css`. After the house tokens change, copy
`../house-style/tokens.css` there again, dropping its Google Fonts `@import` (fonts come from
`@fontsource`, imported in `web/src/fonts.ts`). Exo-mind uses the house's app density, with the
local alterations listed in `house-style-variations.md`; add to that file whenever the app departs
from the style.

## Versions
Every change to the app bumps the version in `package.json` (shown at the top right of the band),
following semver: a new feature bumps the minor number (0.2.0 → 0.3.0), a fix the patch (0.2.0 → 0.2.1).
Use `npm version <x.y.z> --no-git-tag-version` so `package-lock.json` follows.
