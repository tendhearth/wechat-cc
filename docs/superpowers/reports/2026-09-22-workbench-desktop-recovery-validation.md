# Desktop task connection recovery — 2026-09-22

## Delivered

Task-detail streaming failures are now visible independently of list refreshes. The last conversation remains available, a reconnect notice states that the view is stale, and explicit retry forces a fresh detail request. A successful response clears the notice even when no new events arrived. Task header and list both use the backend turn phase, so an answered task is not presented as an independently accepted result.

## Evidence

Two new controller/render regressions were run red before implementation and green afterward. Browser smoke exercises production desktop modules, host proxy, internal HTTP API, service and SQLite, with a synthetic executor:

- Only task-detail requests fail while task listing remains healthy: reconnect notice appears.
- Explicit retry recovers and clears the notice.
- Reload restores the selected task and unsent draft.
- Child-agent output is safely rendered and expandable.
- Supplement stays pending until executor acknowledgment, then records delivery in the same run.
- Closing an answered retained session completes it, saves the artifact and releases the directory to the queued task.
- Header and list both display 已答复.

The smoke harness was brought up to the existing contract: answered-session closure is completed, not cancelled; its HTTP idle timeout must exceed the 20-second long poll. UI assertions check visible wording rather than guessing the internal data-status value.

Final full-suite results: Bun 8,350 passed / 10 skipped; Node 7,118 passed / 11 skipped. Typecheck passed. Dependency check: 0 errors, 7 warnings. One earlier Node run failed the pre-existing chunked-upload route test with write ECONNRESET; two later full Node runs passed without modifying that test.

## Boundaries

This is browser/frontend recovery evidence, not a fresh native Claude/Codex capability or app restart test. Real native execution and handoff were separately verified in the workbench contract report. No native desktop bundle has been rebuilt for this frontend-only change.
