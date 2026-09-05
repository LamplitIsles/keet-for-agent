import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";

const run = promisify(execFile);

interface LoaderSpec {
  id?: string;
  factory?: (require: (specifier: string) => unknown) => unknown;
}

interface RuntimeProcess {
  child: ChildProcess;
  baseUrl: string;
  launchUrl: string;
}

async function packageVersion(root: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string") throw new Error("package.json has no package version");
  return manifest.version;
}

function rootDirectory(): string {
  return resolve(new URL("..", import.meta.url).pathname);
}

function dshExecutable(): string {
  const configured = process.env.DSH_CLI;
  if (configured && existsSync(configured)) return configured;
  try {
    const discovered = execFileSync("which", ["dsh"], { encoding: "utf8" }).trim();
    if (discovered && existsSync(discovered)) return discovered;
  } catch {
    // Fall through to the actionable error below.
  }
  throw new Error("pack-smoke requires the installed DSH CLI (set DSH_CLI to its path)");
}

interface DshInvocation { command: string; prefix: string[] }

function dshInvocation(entry: string): DshInvocation {
  // The installed `dsh` bin is a shell shim. Running its real JS entry with
  // Node's internal Loader access lets the smoke exercise profile package
  // resolution exactly as the Loader expects.
  const candidate = resolve(dirname(entry), "..", "@deepseek-ai", "dsh", "lib", "bin.js");
  if (existsSync(candidate)) {
    let node = process.execPath;
    try { node = execFileSync("which", ["node"], { encoding: "utf8" }).trim() || node; } catch { /* Bun fallback */ }
    return { command: node, prefix: ["--expose-internals", candidate] };
  }
  return { command: entry, prefix: [] };
}

async function dshVersion(entry: string, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const invocation = dshInvocation(entry);
    const { stdout } = await run(invocation.command, [...invocation.prefix, "--version"], { env });
    if (stdout.trim() !== "0.1.2-rc.1") throw new Error(`found ${stdout.trim() || "unknown"}`);
  } catch (error) {
    throw new Error(`pack-smoke requires DSH 0.1.2-rc.1: ${String(error)}`);
  }
}

function isolatedEnvironment(temp: string, dshHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "PATHEXT", "COMSPEC", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const testHome = join(temp, "home");
  return {
    ...env,
    HOME: testHome,
    USERPROFILE: testHome,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: "1",
    npm_config_store_dir: join(temp, "pnpm-store"),
    npm_config_cache: join(temp, "npm-cache"),
    XDG_CACHE_HOME: join(temp, "cache"),
    XDG_CONFIG_HOME: join(temp, "config"),
    XDG_DATA_HOME: join(temp, "data"),
    XDG_STATE_HOME: join(temp, "state")
  };
}

async function startRuntime(entry: string, env: NodeJS.ProcessEnv, cwd: string): Promise<RuntimeProcess> {
  const invocation = dshInvocation(entry);
  const child = spawn(invocation.command, [...invocation.prefix, "--profile", "web", "--host", "127.0.0.1", "--port", "0", "--no-open"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise((resolveRuntime, rejectRuntime) => {
    const finish = (error: Error | undefined, launchUrl?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) rejectRuntime(error);
      else if (launchUrl) resolveRuntime({ child, baseUrl: new URL(launchUrl).origin, launchUrl });
      else rejectRuntime(new Error(`DSH Web runtime exited without a URL: ${output}`));
    };
    const readOutput = (chunk: Buffer | string) => {
      output += chunk.toString();
      const match = output.match(/dsh web:\s+(https?:\/\/127\.0\.0\.1:\d+(?:\/\?token=[^\s\r\n]+)?)/);
      if (match?.[1]) finish(undefined, match[1]);
    };
    child.stdout?.on("data", readOutput);
    child.stderr?.on("data", readOutput);
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) finish(new Error(`DSH Web runtime exited before ready (${code ?? "?"}/${signal ?? "?"}): ${output}`));
    });
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`timed out waiting for DSH Web runtime: ${output}`));
    }, 30_000);
  });
}

async function stopRuntime(runtime: RuntimeProcess | undefined): Promise<void> {
  const child = runtime?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop) => {
    let finished = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, 5_000);
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolveStop();
    };
    child.once("exit", finish);
    if (!child.kill("SIGTERM")) finish();
  });
}

async function authenticateRuntime(runtime: RuntimeProcess): Promise<string> {
  const response = await fetch(runtime.launchUrl, { redirect: "manual" });
  if (response.status !== 303) throw new Error(`DSH Web launch URL returned ${response.status} instead of a browser-auth redirect`);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("DSH Web launch URL did not issue a browser-auth cookie");
  return cookie;
}

async function jsonRequest(baseUrl: string, path: string, body: unknown, cookie: string): Promise<{ response: Response; value: unknown }> {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`DSH returned non-JSON from ${path}: ${text.slice(0, 200)}`);
  }
  return { response, value };
}

function clientCodeChecks(code: string): void {
  if (!code.includes("data-plugin-css") || !code.includes("--dsw-alias-label-primary")) {
    throw new Error("served client bundle does not contain the inlined semantic stylesheet");
  }
  for (const forbidden of ["require(\"@deepseek-ai/dsh-credentials\")", "require(\"@deepseek-ai/schemastery\")", "KeetSettingsSchema"]) {
    if (code.includes(forbidden)) throw new Error(`browser bundle contains Host-only dependency ${forbidden}`);
  }
}

async function main(): Promise<void> {
  const root = rootDirectory();
  const packageRoot = join(root, "packages", "dsh-keet");
  if (!existsSync(join(packageRoot, "dist", "index.js")) || !existsSync(join(packageRoot, "dist", "client.js"))) {
    throw new Error("pack-smoke requires a fresh `bun run build`");
  }
  const entry = dshExecutable();
  const expectedPackageVersion = await packageVersion(packageRoot);
  const temp = await mkdtemp(join(tmpdir(), "dsh-keet-pack-smoke-"));
  const dshHome = join(temp, "dsh-home");
  const runtimeCwd = join(temp, "runtime-cwd");
  await mkdir(runtimeCwd, { recursive: true });
  const env = isolatedEnvironment(temp, dshHome);
  let runtime: RuntimeProcess | undefined;
  try {
    await dshVersion(entry, env);
    const { stdout } = await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temp], { cwd: packageRoot, env });
    const packed = JSON.parse(stdout) as Array<{ filename?: string }>;
    const filename = packed[0]?.filename;
    if (!filename) throw new Error("npm pack did not produce an artifact");
    const artifact = join(temp, filename);
    const artifactFiles = (await run("tar", ["-tzf", artifact], { env })).stdout.split("\n").filter(Boolean);
    const requiredFiles = ["package/dist/index.js", "package/dist/setup.js", "package/dist/client.js", "package/dist/index.d.ts", "package/dist/client.d.cts", "package/cordis.patch.yml", "package/README.md", "package/LICENSE", "package/THIRD_PARTY_NOTICES.md"];
    for (const file of requiredFiles) if (!artifactFiles.includes(file)) throw new Error(`artifact missing ${file}`);
    if (artifactFiles.some((file) => file.includes(".scratch") || /(?:runtime|identity|invitation|avatar-input|message-data)/i.test(file))) {
      throw new Error("artifact contains private runtime or state material");
    }

    const invocation = dshInvocation(entry);
    await run(invocation.command, [...invocation.prefix, "plugin", "--profile", "web", "add", artifact, "--ignore-scripts"], {
      cwd: runtimeCwd,
      env,
      maxBuffer: 2 * 1024 * 1024
    });
    const profile = join(dshHome, "profiles", "web");
    const installed = join(profile, "node_modules", "@lamplitisles", "dsh-keet");
    const metadata = JSON.parse(await readFile(join(installed, "package.json"), "utf8")) as {
      name?: string;
      version?: string;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      dsh?: { bundle?: { patch?: string }; client?: { platform?: string; inject?: string[] } };
    };
    if (metadata.name !== "@lamplitisles/dsh-keet" || metadata.version !== expectedPackageVersion) throw new Error("installed package metadata mismatch");
    if (metadata.dsh?.bundle?.patch !== "./cordis.patch.yml" || metadata.dsh.client?.platform !== "web") throw new Error("installed DSH manifest mismatch");
    if (!metadata.dsh.client.inject?.includes("@deepseek-ai/dsh-client-ui-workspace")) throw new Error("workspace client injection missing");
    if (metadata.peerDependencies?.["@deepseek-ai/cordis"] !== "4.0.2") throw new Error("Cordis peer is not pinned to 4.0.2");
    if (metadata.peerDependencies?.["@deepseek-ai/dsh-tools"] !== "0.1.2-rc.1") throw new Error("dsh-tools peer is not pinned to 0.1.2-rc.1");
    if (metadata.dependencies?.sharp !== "0.33.5") throw new Error("avatar image dependency is not pinned");
    for (const [name, version] of Object.entries(metadata.peerDependencies ?? {})) {
      if (name.startsWith("@deepseek-ai/dsh-") && version !== "0.1.2-rc.1") throw new Error(`non-rc DSH peer: ${name}@${version}`);
    }
    const patchText = await readFile(join(installed, "cordis.patch.yml"), "utf8");
    for (const required of ["dsh-keet", "@lamplitisles/dsh-keet", "connection", "settings", "tools", "systemPrompt", "workspaceRegistry", "sessionController"]) {
      if (!patchText.includes(required)) throw new Error(`Cordis patch is missing ${required}`);
    }
    const hostBundle = await readFile(join(installed, "dist", "index.js"), "utf8");
    for (const required of ["keet_list_groups", "keet_list_members", "keet_read_recent_messages", "keet_send_message", "groupId returned by keet_list_groups", "DM sends do not support replyTo", "dmMemberId"]) {
      if (!hostBundle.includes(required)) throw new Error(`packed Host bundle is missing ${required}`);
    }
    const setupBundle = await readFile(join(installed, "dist", "setup.js"), "utf8");
    for (const required of ["dm-requests", "dm-accept", "--avatar"]) {
      if (!setupBundle.includes(required)) throw new Error(`packed setup executable is missing ${required}`);
    }

    runtime = await startRuntime(entry, env, runtimeCwd);
    const cookie = await authenticateRuntime(runtime);
    const homePage = await fetch(new URL("/", runtime.baseUrl), { headers: { cookie } });
    if (!homePage.ok) throw new Error(`installed DSH Web runtime returned ${homePage.status} for /`);
    const html = await homePage.text();
    const bootStart = html.indexOf('globalThis["__DSH_BOOT__"]');
    const bootEnd = bootStart < 0 ? -1 : html.indexOf("</script>", bootStart);
    const bootSource = bootStart < 0 || bootEnd < 0 ? "" : html.slice(bootStart, bootEnd);
    const jsonStart = bootSource.indexOf("{");
    const jsonEnd = bootSource.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd < jsonStart) throw new Error("DSH Web bootstrap did not expose __DSH_BOOT__");
    const boot = JSON.parse(bootSource.slice(jsonStart, jsonEnd + 1)) as { entries?: Array<{ id?: string; url?: string }> };
    const pluginEntry = boot.entries?.find((candidate) => candidate.id === metadata.name);
    if (!pluginEntry?.url) throw new Error("installed plugin is absent from the DSH Web bootstrap entries");
    const clientResponse = await fetch(new URL(pluginEntry.url, runtime.baseUrl), { headers: { cookie } });
    if (!clientResponse.ok) throw new Error(`installed DSH client bundle returned ${clientResponse.status}`);
    const clientCode = await clientResponse.text();
    clientCodeChecks(clientCode);
    let loaded: LoaderSpec | undefined;
    vm.runInNewContext(clientCode, { window: { __ModuleLoader__: { load(spec: LoaderSpec) { loaded = spec; } } } });
    if (loaded?.id !== metadata.name || typeof loaded.factory !== "function") throw new Error("real Loader client entry did not register");

    // Execute the served Loader factory against test-owned service stubs. This
    // exercises the package's actual client activation function while keeping
    // external credentials and Keet services out of the smoke run.
    const reactStub = { createElement: (...args: unknown[]) => args };
    const client = loaded.factory((specifier) => specifier === "react" ? reactStub : {}) as { apply: (context: unknown) => void };
    if (typeof client.apply !== "function") throw new Error("client Loader factory did not expose apply");
    const clientDisposers: Array<unknown> = [];
    client.apply({
      locale: { register: () => () => undefined },
      settingsScope: { bind: () => ({ getSnapshot: () => ({ status: "loading", mode: "host", writable: false }), subscribe: () => () => undefined, set: async () => undefined, unset: async () => undefined }) },
      connection: { isLoopback: true, rpc: { call: async () => ({ ok: true, value: { state: "disabled" } }) } },
      workspaces: { list: { getSnapshot: () => ({ items: [], archivedSessionIds: [], state: "idle", phase: "ready", error: null }), subscribe: () => () => undefined } },
      slots: { inject: () => undefined, register: () => undefined },
      effect: (factory: () => unknown) => { clientDisposers.push(factory()); }
    });
    for (const disposer of clientDisposers.reverse()) if (typeof disposer === "function") await (disposer as () => unknown)();

    const readiness = await jsonRequest(runtime.baseUrl, "/dsh-keet/readiness", {
      type: "client-request",
      rpcId: "pack-smoke-readiness",
      method: "readiness",
      payload: {}
    }, cookie);
    const readinessEnvelope = readiness.value as { type?: string; rpcId?: string; result?: { ok?: boolean; value?: { state?: string } } };
    if (!readiness.response.ok || readinessEnvelope.type !== "server-response" || readinessEnvelope.rpcId !== "pack-smoke-readiness" || readinessEnvelope.result?.ok !== true || readinessEnvelope.result.value?.state !== "missing-settings") {
      throw new Error(`installed Host Keet readiness RPC did not activate: ${JSON.stringify(readiness.value)}`);
    }

    const settings = await jsonRequest(runtime.baseUrl, "/api/settings/describe", {
      type: "client-request",
      rpcId: "pack-smoke-settings",
      method: "settings/describe",
      payload: { args: {} }
    }, cookie);
    const settingsEnvelope = settings.value as { type?: string; rpcId?: string; result?: { ok?: boolean; value?: { namespaces?: Array<{ ns?: string; value?: { groupId?: string; workspaceId?: string }; applies?: string }> } } };
    const namespace = settingsEnvelope.result?.value?.namespaces?.find((candidate) => candidate.ns === "dsh-keet");
    if (!settings.response.ok || settingsEnvelope.type !== "server-response" || settingsEnvelope.rpcId !== "pack-smoke-settings" || settingsEnvelope.result?.ok !== true || !namespace?.value || namespace.applies !== "restart") {
      throw new Error(`installed Settings registration did not activate: ${JSON.stringify(settings.value)}`);
    }

    await writeFile(join(dshHome, "smoke-result.json"), JSON.stringify({ package: metadata.name, client: loaded.id, readiness: readinessEnvelope.result?.value?.state, settings: namespace.ns }));
    console.log(JSON.stringify({ artifact, dshHome, files: artifactFiles.length, host: true, client: true, loader: true, css: true, readiness: readinessEnvelope.result?.value?.state }, null, 2));
  } finally {
    await stopRuntime(runtime);
    await rm(temp, { recursive: true, force: true });
  }
}

await main();
