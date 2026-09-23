# Settings panel HTTP timeout: isolated network evidence

Recorded: 2026-09-13. Repository: `/Users/nategu_mac_company/Documents/tendhearth/wechat-cc-cc-kit`. Comparison baseline: `e81fe704`.

## Conclusion and limits

The observed failure is an environment-specific IPv4 wildcard listener/connectivity limitation on this host. A service listening on `127.0.0.1` accepts a request immediately; a service listening on `0.0.0.0` does not receive the same request to `127.0.0.1`. This reproduces in both Bun and Node with no repository imports, before the Node server records any TCP connection. IPv6 loopback works in the Bun probe.

This establishes that the failing HTTP tests do not require the current workbench/model changes to reproduce. It does **not** establish a particular firewall rule, OS permission, or other underlying network configuration cause. No firewall, network, user settings, or real bot process was inspected or changed.

No repository files were changed for this investigation. No tests were skipped, timeouts increased, or production listener defaults changed to obtain green results. The 1200 ms probe abort is only a bounded diagnostic request, not a change to the test suite timeout.

## Existing listener and tests

`src/daemon/settings-panel.ts:413–421` starts the settings panel with `Bun.serve({ hostname: '0.0.0.0', port, fetch: handleRequest })`. The HTTP tests request the panel through `http://127.0.0.1:<allocated-port>`.

The already completed isolated test invocation was:

```sh
cd /Users/nategu_mac_company/Documents/tendhearth/wechat-cc-cc-kit
bun --bun vitest run src/daemon/settings-panel.test.ts
```

Observed result: exit 1; 30 tests, **16 failed and 14 passed**; total duration **80.32 s**, tests approximately **80.09 s**. The 16 failures were the same HTTP-test set as the full run; each reached its existing 5000 ms timeout (observed approximately 5002–5006 ms). This isolated suite was not rerun for this evidence-document request.

The full-suite log remains at `/tmp/cc-task-execution-models-full-vitest.log`. Its relevant line is:

```text
104: ❯ src/daemon/settings-panel.test.ts (30 tests | 16 failed) 80091ms
```

The full suite additionally had other failures owned by the parent investigation; this note does not diagnose or attribute them.

## File identity evidence

The following commands were checked again while preparing this note:

```sh
cd /Users/nategu_mac_company/Documents/tendhearth/wechat-cc-cc-kit
git rev-parse e81fe704:src/daemon/settings-panel.ts HEAD:src/daemon/settings-panel.ts e81fe704:src/daemon/settings-panel.test.ts HEAD:src/daemon/settings-panel.test.ts
git diff --numstat e81fe704 -- src/daemon/settings-panel.ts src/daemon/settings-panel.test.ts
```

Output of `git rev-parse`, in argument order:

```text
7a09659b55e355733e65a7e6f1abbfb972ac63bc
7a09659b55e355733e65a7e6f1abbfb972ac63bc
defaaa1ce0fb3ee366a73f51fef00abb0a5ba364
defaaa1ce0fb3ee366a73f51fef00abb0a5ba364
```

`git diff --numstat` produced no output and exited 0. Thus both tracked current files, including working-tree content, match the baseline.

## Runtime versions

```sh
bun --version
node --version
```

```text
1.3.14
v26.4.0
```

## Exact bounded Bun probe

This self-contained probe creates and stops only its own ephemeral-port servers. It prints only the presence of common proxy environment variables, never their values. It imports no repository code.

The exact source below was rerun for this note; command exit status was 0:

```sh
bun --eval 'console.log(JSON.stringify({ runtime: Bun.version, proxyEnvironment: Object.fromEntries(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"].map(key => [key, Boolean(process.env[key])])) }));
for (const [hostname, target] of [["127.0.0.1", "127.0.0.1"], ["0.0.0.0", "127.0.0.1"], ["::1", "[::1]"], ["::", "[::1]"]]) {
  let requests = 0;
  const server = Bun.serve({ hostname, port: 0, fetch() { requests++; return new Response("owned-ok"); } });
  const started = performance.now();
  try {
    const response = await fetch("http://" + target + ":" + server.port, { signal: AbortSignal.timeout(1200) });
    console.log(JSON.stringify({ hostname, target, status: response.status, body: await response.text(), requests, elapsedMs: Math.round(performance.now() - started) }));
  } catch (error) {
    console.log(JSON.stringify({ hostname, target, error: error.name, requests, elapsedMs: Math.round(performance.now() - started) }));
  } finally {
    server.stop(true);
  }
}
'
```

Captured output:

```jsonl
{"runtime":"1.3.14","proxyEnvironment":{"HTTP_PROXY":false,"HTTPS_PROXY":false,"ALL_PROXY":false,"NO_PROXY":false,"http_proxy":false,"https_proxy":false,"all_proxy":false,"no_proxy":false}}
{"hostname":"127.0.0.1","target":"127.0.0.1","status":200,"body":"owned-ok","requests":1,"elapsedMs":4}
{"hostname":"0.0.0.0","target":"127.0.0.1","error":"TimeoutError","requests":0,"elapsedMs":1201}
{"hostname":"::1","target":"[::1]","status":200,"body":"owned-ok","requests":1,"elapsedMs":1}
{"hostname":"::","target":"[::1]","status":200,"body":"owned-ok","requests":1,"elapsedMs":1}
```

## Exact bounded Node probe

This independent probe uses `node:http` and counts both TCP connections and HTTP requests. Each server is closed in `finally`. It imports no repository code.

The exact source below was rerun for this note; command exit status was 0:

```sh
node --input-type=module --eval 'import http from "node:http";
console.log(JSON.stringify({ runtime: process.version }));
for (const hostname of ["127.0.0.1", "0.0.0.0"]) {
  let connections = 0;
  let requests = 0;
  const server = http.createServer((request, response) => { requests++; response.end("owned-ok"); });
  server.on("connection", () => { connections++; });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, hostname, resolve); });
  const port = server.address().port;
  const started = performance.now();
  try {
    const response = await fetch("http://127.0.0.1:" + port, { signal: AbortSignal.timeout(1200) });
    console.log(JSON.stringify({ hostname, target: "127.0.0.1", status: response.status, body: await response.text(), connections, requests, elapsedMs: Math.round(performance.now() - started) }));
  } catch (error) {
    console.log(JSON.stringify({ hostname, target: "127.0.0.1", error: error.name, connections, requests, elapsedMs: Math.round(performance.now() - started) }));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
'
```

Captured output:

```jsonl
{"runtime":"v26.4.0"}
{"hostname":"127.0.0.1","target":"127.0.0.1","status":200,"body":"owned-ok","connections":1,"requests":1,"elapsedMs":9}
{"hostname":"0.0.0.0","target":"127.0.0.1","error":"TimeoutError","connections":0,"requests":0,"elapsedMs":1202}
```

## Interpretation for validation reporting

Record these 16 existing settings-panel HTTP failures as an observed host network limitation, with the above reproduction evidence. Keep the test failures visible. A green result would require resolving or changing the execution environment; this investigation does not justify skipping tests, raising timeouts, or changing the product's LAN listener default.

