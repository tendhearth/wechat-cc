# CC page illustration unification

First-run preparation / ready, conversation empty state and memory illustration
reuse frozen canonical CC PNGs. Light uses the shared entity mask through CSS
masking, plus a separate scene contact shadow. No character art is regenerated.

The first-run scenes reuse the approved aquarium background. Chat pairs CC with
the existing mug prop. The memory background was generated with the built-in
image tool using the aquarium as the style reference: ivory paper, olive leaves,
blank journal and paper slips on the right, empty floor reserved for CC on the
left, no mascot or text. The only new runtime bitmap is
`src/assets/cc-memory-watercolor.png`.

`preview.html` serves outside frontendDist and imports the same component and
styles as production. Serve repository root and open this file's HTTP path.
`overview.png` records the illustration comparison. The chat screenshot comes
from the local app; the onboarding screenshot precedes the final paper-shell
color adjustment. The live local memory page remained loading without data;
its rendered illustration was inspected in the isolated preview instead.
The original memory button/data-action and panel behavior remain unchanged.
Do not interpret this as a live memory-data / expand-flow acceptance.

Validation: desktop 39 files / 628 tests; repository typecheck; diff check.
Frozen assets/pet and art/cc-v1 have no diff. This batch does not claim to restyle
all settings, lists, or content pages.
