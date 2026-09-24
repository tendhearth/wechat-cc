/** phone.html 首个 <script> 里由 daemon 填的两个全局,和公网壳页(relay/pset.html)注入的 __CC_SHELL__。 */
declare var T: string
declare var REMOTE: { relay: string; id: string } | null
interface Window { __CC_SHELL__?: { relay: string; id: string } }
