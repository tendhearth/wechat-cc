# CC chat visual sample

Serve the repository root, then open `apps/desktop/art/cc-chat/preview.html`.
The links select empty, conversation, and recording states. This sample uses the production conversation module with simulated replies and microphone capture; it never opens a microphone or sends a real message. It lives outside the production frontend directory.

The chat uses frozen canonical Light CC, warm neutral surfaces, SVG controls, and one composer. Ending recording produces an editable draft and retains existing text. Cancellation discards captured audio and stops microphone tracks. The indicator is a recording status dot, not a simulated volume meter.

Validation: desktop suite 632 tests passed; repository typecheck passed. After the final avatar and alignment refinement, the three conversation regression tests passed again. Browser checked the empty page, sample conversation and recording-to-draft flow. Actual microphone hardware and configured speech service still require native testing.
