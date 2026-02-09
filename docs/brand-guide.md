# fufnotes brand guide

This app uses a whimsical palette inspired by the “Fairyloss” illustration (lavender sky, pink clouds, gold moon/stars, mint sparkles).

## CSS variables

Defined in `tools/theme.css` under `:root`.

### Whimsical palette

- `--whimsy-twilight-lavender` — main sky lavender (`#bca9d6`)
- `--whimsy-dream-lilac` — light lilac highlight (`#d8c9ee`)
- `--whimsy-cloud-pink` — cloud pink (`#f2b6d4`)
- `--whimsy-cloud-blush` — soft blush for surfaces (`#fad2e6`)
- `--whimsy-moon-gold` — moon/stars gold (`#e8c51a`)
- `--whimsy-starlight-butter` — soft star-glow (`#fff2a8`)
- `--whimsy-sparkle-mint` — mint sparkle (`#bff2e7`)
- `--whimsy-snowglow` — white (`#ffffff`)
- `--whimsy-ink-plum` — primary ink (`#2f1937`)
- `--whimsy-ink-plum-muted` — muted ink (`#553660`)

### App tokens (what components should use)

These map the palette onto the existing design system:

- `--bg` — page background
- `--surface`, `--surface-2` — cards/panels/background accents
- `--border`, `--border-strong` — outlines/dividers
- `--text`, `--text-muted` — typography
- `--accent`, `--accent-soft` — primary action color + focus ring

### Tabs

- `--tab-notes-active` — active Notes tab fill
- `--tab-projects-active` — active Projects tab fill
- `--tab-shadow` — shared tab shadow
