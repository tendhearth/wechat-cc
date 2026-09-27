# Download page artwork

The standalone page composes existing CC art with CSS. The copies below are
byte-for-byte runtime assets; the frozen character and mask are unchanged.

| Page asset | Source under `apps/desktop/src/` |
| --- | --- |
| `cc-aquarium.png` | `assets/home-cc-aquarium-base.png` |
| `cc-fish-atlas.png` | `assets/home-cc-fish-atlas.png` |
| `cc-companion.png` | `assets/pet/cc-v1/canonical/lit/front.png` |
| `cc-mask.png` | `assets/pet/cc-v1/masks/front.png` |
| `cc-logo.png` | `wechat-cc-logo.png` |

Copies keep the page deployable as a single directory. `build:icons` refreshes
the page logo and the phone route's embedded PNG alongside the desktop logo.
The other assets are copied unchanged when their approved sources are updated.
