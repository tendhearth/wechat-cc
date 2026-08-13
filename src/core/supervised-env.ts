/**
 * supervised-env — shared name of the env var that marks "something will
 * restart me if I exit" (self-restart spec 2026-08-03 §"KeepAlive
 * precondition"). Lives in core (not daemon/ or cli/) because BOTH sides of
 * the daemon↛cli layering boundary need it without crossing that boundary:
 * `cli/service-manager.ts` WRITES it into the launchd plist / systemd unit at
 * `service install` time; `daemon/main.ts` READS it to decide whether the
 * idle self-restart mechanism is safe to enable at all. A single exported
 * string keeps both sides byte-identical — a typo in either one would
 * silently break the gate (writer sets a name the reader never checks, or
 * vice versa) with no error, just a self-restart that never fires or a
 * daemon that exits into nothing.
 */
export const SUPERVISED_ENV = 'WECHAT_CC_SUPERVISED'
