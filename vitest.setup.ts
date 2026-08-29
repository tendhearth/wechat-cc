/**
 * Unit-suite hermeticity against the operator's machine.
 *
 * Bundled-plugin discovery (`bundledPluginsDir()`) falls back to the repo's
 * own `plugins/` dir, so a dev box with e.g. `plugins/wxsearch/.venv`
 * installed makes wxsearch enabled+ready inside EVERY test that calls
 * buildBootstrap — and assertions like `mcpServers == {}` or "no
 * knowledge-orchestration section" only pass on machines without the venv.
 * Point discovery at a fresh empty temp dir by default; tests that exercise
 * bundled discovery (bootstrap.test.ts's wxsearch fixture / empty-dir cases)
 * already set and restore this env themselves, which overrides this default.
 *
 * Same posture as vitest.config.ts's WECHAT_DISABLE_LOG_FILE: tests must
 * never see (or touch) the operator's real install.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR) {
  process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR = mkdtempSync(join(tmpdir(), 'wcc-test-no-bundled-plugins-'))
}
