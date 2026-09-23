# Second-batch browser playback evidence

Current manifest hash and observed behavior coverage: results.json. Normal and
reduced-motion pet-lab each loaded all 13 behaviors in both forms. Records use
DOM src-change/load observations so 250 ms one-shots are captured before returning
to the resting state; button snapshots alone can already show that returned state.
Temporary observation listeners were discarded by page reload after capture.

Dark→Light loaded all eight transition frames. Light→Dark retains its existing
fade fallback and corresponding warning; no transition behavior was changed.
`blocked-working.json` records a temporary browser network block, canonical fallback
and preserved working behavior. The block/cache override were cleared and working
loaded normally afterward. No workspace assets were removed for this test.

Screenshots are browser captures, not native transparent-window or wallpaper
compositing evidence. The QA app was rebuilt but no new native run is claimed.
