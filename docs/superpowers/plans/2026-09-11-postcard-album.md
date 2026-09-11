# Postcard album implementation

Approved scope: keep SVG postcards; defer Atelier. Make sent picture + narration discoverable in Foraging, support detail view, explicit favorite, and offline export.

1. Journal persistence: append schema migration for favorite flag. Keep favorites outside the rolling 500 non-favorites. Add an independent paginated image-postcard query (not the default recent journal slice). Test migration, retention, filtering and pagination.
2. Trusted API: expose postcard list and favorite mutation with validation. Sanitize stored SVG on read. Test authorization tiers, invalid input, missing rows and unsafe stored images.
3. Desktop: dedicated postcard album module and section above mixed finds. All/Favorites, load more, accessible modal containing original picture, narration/date/title. Favorite updates only after successful persistence. Export self-contained HTML with embedded SVG image and escaped text via existing native save_text_file; browser fallback. Explicit loading/error/empty states. Tests for rendering, stale responses, mutation errors and export escaping.
4. Verify focused backend/frontend tests and whole-repo typecheck. Browser preview with fixtures using production module, not a parallel mock implementation. Keep evidence outside production src. No deployment or sending messages.
