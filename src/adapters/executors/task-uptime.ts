/** Fixed CC-owned preload; no repository initialization code is evaluated. */
export const TASK_UPTIME_PRELOAD = `const os = require('node:os');
const original = os.uptime;
const boot = Number(process.env.CC_TASK_SYSTEM_BOOT_MS);
const initial = (Date.now() - boot) / 1000;
const started = process.hrtime.bigint();
const validBaseline = Number.isFinite(boot) && boot > 0 && initial >= 0;
const deniedUptime = error => {
  const native = error?.code === 'ERR_SYSTEM_ERROR' ? error.info : error;
  return ['EPERM', 'EACCES'].includes(native?.code) && native?.syscall === 'uv_uptime';
};
// Codex applies shell_environment_policy to approved unsandboxed commands too.
// Probe the native operation, not a self-reported sandbox environment marker:
// healthy runtimes retain every builtin function and subprocess argument.
let taskUptimeRestricted = false;
try {
  const value = original();
  taskUptimeRestricted = validBaseline && !(Number.isFinite(value) && (value > 0 || (value === 0 && initial < 1)));
} catch (error) {
  taskUptimeRestricted = validBaseline && deniedUptime(error);
}
if (taskUptimeRestricted) {
os.uptime = function () {
  try {
    const value = original();
    // Bun 1.3.14 reports zero instead of throwing when kern.boottime is denied.
    if (Number.isFinite(value) && (value > 0 || (value === 0 && initial < 1))) return value;
    if (!Number.isFinite(boot) || boot <= 0 || initial < 0) return value;
    return initial + Number(process.hrtime.bigint() - started) / 1e9;
  }
  catch (error) {
    const native = error?.code === 'ERR_SYSTEM_ERROR' ? error.info : error;
    if (!['EPERM', 'EACCES'].includes(native?.code) || native?.syscall !== 'uv_uptime' || !Number.isFinite(boot) || boot <= 0 || initial < 0) throw error;
    return initial + Number(process.hrtime.bigint() - started) / 1e9;
  }
};
require('node:module').syncBuiltinESMExports();
}
`

/** Bun ignores NODE_OPTIONS in direct absolute-path subprocesses. Keep the
 * compatibility hook within this task process tree, including worker helpers. */
export const TASK_SUBPROCESS_PRELOAD = `
if (taskUptimeRestricted) {
const cp = require('node:child_process');
const fs = require('node:fs');
const runtime = fs.realpathSync(process.execPath);
const isRuntime = command => {
  if (typeof command !== 'string') return false;
  if (command === process.execPath) return true;
  try { return fs.realpathSync(command) === runtime; } catch { return false; }
};
const preloadArgs = args => args.includes(__filename) || args.includes('--require=' + __filename) ? args : ['--require=' + __filename, ...args];
const taskOptions = options => options && typeof options === 'object' && options.env
  ? {...options, env: {...options.env, CC_TASK_SYSTEM_BOOT_MS: String(boot)}} : options;
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = cp[name];
  const wrapped = function (command, args, ...rest) {
    if (!isRuntime(command)) return original.apply(this, arguments);
    if (Array.isArray(args)) return original.call(this, command, preloadArgs(args), ...rest.map(taskOptions));
    if (args == null && rest.length) return original.call(this, command, preloadArgs([]), ...rest.map(taskOptions));
    return original.call(this, command, preloadArgs([]), taskOptions(args), ...rest);
  };
  if (name === 'execFile') wrapped[require('node:util').promisify.custom] = (...args) => new Promise((resolve, reject) => {
    wrapped(...args, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve({stdout, stderr});
    });
  });
  cp[name] = wrapped;
}
const bun = globalThis.Bun;
if (bun) for (const name of ['spawn', 'spawnSync']) {
  const original = bun[name];
  bun[name] = function (command, options) {
    if (Array.isArray(command) && isRuntime(command[0])) return original.call(this, [command[0], ...preloadArgs(command.slice(1))], taskOptions(options));
    if (command && Array.isArray(command.cmd) && isRuntime(command.cmd[0])) return original.call(this, taskOptions({...command, cmd: [command.cmd[0], ...preloadArgs(command.cmd.slice(1))]}));
    return original.apply(this, arguments);
  };
}
require('node:module').syncBuiltinESMExports();
}
`
