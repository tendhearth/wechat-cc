# Native UI icons

Transparent PNGs rendered from the official Lucide package used in the approved preview:
https://unpkg.com/lucide@1.17.0/dist/umd/lucide.js

Source project: https://github.com/lucide-icons/lucide
License source: https://raw.githubusercontent.com/lucide-icons/lucide/main/LICENSE
The unmodified ISC and Feather MIT notices are included in LICENSE.

Exported on 2026-10-24 by Lucide's createIcons DOM API, then rasterized in Chrome.
Each 96×96 PNG represents a 24pt icon at 4× resolution, with transparent background,
black strokes, 1.65 logical stroke width, and round caps/joins from the original SVG.
The app uses Image tintColor and an explicit display size. No SVG paths were recreated;
assets are never downloaded at runtime.

The 2026-10-28 minimal phone integration extends the set using the same pinned package,
DOM export and 96×96 transparent PNG process. Settings, search, attachment, permission,
navigation and secondary entry icons share the same 1.65 logical stroke width.

App names map to Lucide names in Icon.tsx: stop = square, close = x, help = circle-help,
refresh = refresh-cw, alert = circle-alert; remaining names use the corresponding kebab-case names.
