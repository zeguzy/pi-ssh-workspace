import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PHASE = process.argv[2] === "local" ? "local" : "ssh";
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const EXT = join(PACKAGE_ROOT, "src", "index.ts");
const DOUBLE = join(HERE, "fixtures", "ssh-double.sh");

const ROOT = realpathSync(mkdtempRoot());
function mkdtempRoot() {
	const dir = join(realpathSync(tmpdir()), `pi-ssh-workspace-test-${process.pid}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

const HOME = join(ROOT, "home");
const WORK = join(ROOT, "work");
const BIN = join(ROOT, "bin");
const HOST_LOG = join(ROOT, "last-host.txt");

// The ssh double resolves `~` through $HOME, so point HOME at a sandbox home.
process.env.HOME = HOME;
process.env.SSH_DOUBLE_LOG = HOST_LOG;
mkdirSync(BIN, { recursive: true });
mkdirSync(join(HOME, "alpha", "beta", "nested"), { recursive: true });
mkdirSync(join(HOME, "beta", "nested"), { recursive: true });
mkdirSync(WORK, { recursive: true });
const sshPath = join(BIN, "ssh");
writeFileSync(sshPath, readFileSync(DOUBLE, "utf8"), { mode: 0o755 });
process.env.PATH = `${BIN}:${process.env.PATH}`;
process.chdir(WORK);
const PHYSICAL_WORK = process.cwd();

const statuses = [];
const notices = [];
const messages = [];
const tools = new Map();
const commands = new Map();
const flags = new Map();
const handlers = new Map();
const flagValues = new Map();

const pi = {
	registerFlag(name, options) {
		flags.set(name, options);
		if (options.default !== undefined) flagValues.set(name, options.default);
	},
	getFlag(name) {
		return flagValues.get(name);
	},
	registerTool(tool) {
		tools.set(tool.name, tool);
	},
	registerCommand(name, options) {
		commands.set(name, options);
	},
	on(event, handler) {
		handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		return () => {};
	},
	sendMessage(message) {
		messages.push(message);
	},
};

const ui = {
	theme: { fg: (_color, text) => text },
	setStatus(key, text) {
		statuses.push([key, text]);
	},
	notify(message, type) {
		notices.push([type, message]);
	},
};

const ctx = { mode: "tui", hasUI: true, ui };

// Node >= 22.19 strips TypeScript types, so the extension loads straight from src/.
// pi-coding-agent resolves through node_modules, which `npm install` provides.
let mod;
try {
	mod = await import(EXT);
} catch (error) {
	throw new Error(`cannot load ${EXT}: ${error.message}. Run npm install first.`);
}
mod.default(pi);

const emit = async (event, payload = {}) => {
	const results = [];
	for (const handler of handlers.get(event) ?? []) results.push(await handler({ type: event, ...payload }, ctx));
	return results;
};

const callTool = (name, params) =>
	tools.get(name).execute(`${name}-call`, params, undefined, () => {}, { signal: undefined, onUpdate: () => {} });

const textOf = (result) => result.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
const lastStatus = () => statuses.at(-1)?.[1];
const lastNotice = () => notices.at(-1);

let passed = 0;
const check = async (label, fn) => {
	try {
		await fn();
		passed += 1;
		console.log(`ok   ${label}`);
	} catch (error) {
		console.error(`FAIL ${label}\n     ${String(error.message).split("\n").join("\n     ")}`);
		process.exitCode = 1;
	}
};

if (PHASE === "local") {
	await check("registers the --ssh and --ssh-cwd flags and the /ssh-cwd command", () => {
		assert.deepEqual([...flags.keys()].sort(), ["ssh", "ssh-cwd"]);
		assert.ok(commands.has("ssh-cwd"));
	});

	await check("session_start without --ssh stays in local mode", async () => {
		await emit("session_start", {});
		assert.equal(statuses.length, 0);
		assert.equal(notices.length, 0);
	});

	await check("read stays local", async () => {
		writeFileSync(join(WORK, "local.txt"), "local-content");
		assert.match(textOf(await callTool("read", { path: join(WORK, "local.txt") })), /local-content/);
	});

	await check("write stays local", async () => {
		await callTool("write", { path: join(WORK, "local-only.txt"), content: "local-write" });
		assert.equal(readFileSync(join(WORK, "local-only.txt"), "utf8"), "local-write");
	});

	await check("bash stays local", async () => {
		assert.equal(textOf(await callTool("bash", { command: "pwd" })).trim(), PHYSICAL_WORK);
	});

	await check("/ssh-cwd explains that SSH mode is off", async () => {
		await commands.get("ssh-cwd").handler("", ctx);
		assert.equal(lastNotice()[0], "error");
		assert.match(lastNotice()[1], /SSH mode is off/);
	});

	await check("before_agent_start leaves the prompt untouched", async () => {
		const event = {
			prompt: "hi",
			systemPrompt: "",
			systemPromptOptions: { cwd: PHYSICAL_WORK, appendSystemPrompt: "sentinel", selectedTools: [] },
		};
		await emit("before_agent_start", event);
		assert.equal(event.systemPromptOptions.cwd, PHYSICAL_WORK);
		assert.equal(event.systemPromptOptions.appendSystemPrompt, "sentinel");
	});

	await check("user_bash is not intercepted", async () => {
		const [result] = await emit("user_bash", { command: "pwd", cwd: PHYSICAL_WORK, excludeFromContext: false });
		assert.equal(result, undefined);
	});
} else {
	await check("--ssh-cwd resolves against the remote home", async () => {
		flagValues.set("ssh", "fakehost");
		flagValues.set("ssh-cwd", "~/alpha");
		await emit("session_start", {});
		assert.equal(lastStatus(), `SSH: fakehost:${HOME}/alpha`);
		assert.match(lastNotice()[1], /SSH mode: fakehost:/);
	});

	await check("host:path form is accepted", async () => {
		flagValues.set("ssh", "fakehost:~/beta");
		flagValues.delete("ssh-cwd");
		await emit("session_start", {});
		assert.equal(lastStatus(), `SSH: fakehost:${HOME}/beta`);
	});

	await check("a missing directory leaves SSH disabled", async () => {
		flagValues.set("ssh", "fakehost");
		flagValues.set("ssh-cwd", "~/missing");
		const before = statuses.length;
		await emit("session_start", {});
		assert.equal(lastNotice()[0], "error");
		assert.match(lastNotice()[1], /SSH mode not enabled/);
		assert.equal(statuses.length, before);
		flagValues.set("ssh-cwd", "~/alpha");
		await emit("session_start", {});
	});

	await check("/ssh-cwd without an argument prints the current directory", async () => {
		const before = messages.length;
		await commands.get("ssh-cwd").handler("   ", ctx);
		assert.equal(lastNotice()[0], "info");
		assert.match(lastNotice()[1], /Remote working directory: fakehost:/);
		assert.equal(messages.length, before);
	});

	await check("/ssh-cwd switches to an absolute directory", async () => {
		await commands.get("ssh-cwd").handler(` ${HOME}/beta `, ctx);
		await commands.get("ssh-cwd").handler(` ${HOME}/alpha `, ctx);
		assert.equal(lastStatus(), `SSH: fakehost:${HOME}/alpha`);
		assert.equal(lastNotice()[1], `Remote working directory: ${HOME}/alpha`);
		assert.equal(messages.at(-1).customType, "ssh-cwd");
		assert.match(messages.at(-1).content, new RegExp(`${HOME}/alpha`));
	});

	await check("/ssh-cwd resolves a relative directory", async () => {
		await commands.get("ssh-cwd").handler("beta/nested", ctx);
		assert.equal(lastStatus(), `SSH: fakehost:${HOME}/alpha/beta/nested`);
	});

	await check("/ssh-cwd resolves ..", async () => {
		await commands.get("ssh-cwd").handler("../../../alpha", ctx);
		assert.equal(lastStatus(), `SSH: fakehost:${HOME}/alpha`);
	});

	await check("/ssh-cwd expands ~ on the remote", async () => {
		await commands.get("ssh-cwd").handler("~/beta", ctx);
		assert.equal(lastStatus(), `SSH: fakehost:${HOME}/beta`);
	});

	await check("/ssh-cwd keeps the old directory when the target is missing", async () => {
		const before = lastStatus();
		await commands.get("ssh-cwd").handler("does-not-exist", ctx);
		assert.equal(lastNotice()[0], "error");
		assert.match(lastNotice()[1], /Cannot switch to does-not-exist/);
		assert.equal(lastStatus(), before);
	});

	await check("/ssh-cwd rejects a file path", async () => {
		writeFileSync(join(HOME, "alpha", "plain.txt"), "x");
		await commands.get("ssh-cwd").handler(join(HOME, "alpha", "plain.txt"), ctx);
		assert.equal(lastNotice()[0], "error");
	});

	await check("/ssh-cwd is idempotent", async () => {
		await commands.get("ssh-cwd").handler(`${HOME}/alpha`, ctx);
		const before = messages.length;
		await commands.get("ssh-cwd").handler(`${HOME}/alpha/`, ctx);
		assert.match(lastNotice()[1], /unchanged/);
		assert.equal(messages.length, before);
	});

	await check("read follows the switch", async () => {
		await commands.get("ssh-cwd").handler(`${HOME}/alpha`, ctx);
		writeFileSync(join(HOME, "alpha", "marker.txt"), "alpha-marker");
		assert.match(textOf(await callTool("read", { path: join(WORK, "marker.txt") })), /alpha-marker/);
	});

	await check("write follows the switch", async () => {
		await commands.get("ssh-cwd").handler(`${HOME}/alpha`, ctx);
		await callTool("write", { path: join(WORK, "written.txt"), content: "written-by-test" });
		assert.equal(readFileSync(join(HOME, "alpha", "written.txt"), "utf8"), "written-by-test");
	});

	await check("write creates missing parent directories", async () => {
		await commands.get("ssh-cwd").handler(`${HOME}/alpha`, ctx);
		await callTool("write", { path: join(WORK, "deep", "deeper", "new.txt"), content: "deep" });
		assert.equal(readFileSync(join(HOME, "alpha", "deep", "deeper", "new.txt"), "utf8"), "deep");
	});

	await check("edit follows the switch", async () => {
		await commands.get("ssh-cwd").handler(`${HOME}/alpha`, ctx);
		await callTool("edit", {
			path: join(WORK, "written.txt"),
			edits: [{ oldText: "written-by-test", newText: "edited-by-test" }],
		});
		assert.equal(readFileSync(join(HOME, "alpha", "written.txt"), "utf8"), "edited-by-test");
	});

	await check("bash runs in the switched directory", async () => {
		await commands.get("ssh-cwd").handler(`${HOME}/beta`, ctx);
		assert.equal(textOf(await callTool("bash", { command: "pwd" })).trim(), `${HOME}/beta`);
	});

	await check("bash maps an explicit local cwd into the remote tree", async () => {
		await commands.get("ssh-cwd").handler(`${HOME}/beta`, ctx);
		assert.equal(textOf(await callTool("bash", { command: "pwd", cwd: PHYSICAL_WORK })).trim(), `${HOME}/beta`);
	});

	await check("before_agent_start points the cwd section at the remote", async () => {
		await commands.get("ssh-cwd").handler(`${HOME}/beta`, ctx);
		const event = {
			prompt: "hi",
			systemPrompt: "",
			systemPromptOptions: { cwd: PHYSICAL_WORK, appendSystemPrompt: "", selectedTools: ["read"] },
		};
		await emit("before_agent_start", event);
		assert.equal(event.systemPromptOptions.cwd, `${HOME}/beta`);
		assert.match(event.systemPromptOptions.appendSystemPrompt, /Execution split/);
		assert.match(event.systemPromptOptions.appendSystemPrompt, /not synchronized/);
		assert.doesNotMatch(event.systemPromptOptions.appendSystemPrompt, /rsync/);
	});

	await check("before_agent_start follows later switches", async () => {
		await commands.get("ssh-cwd").handler(`${HOME}/alpha`, ctx);
		const event = {
			prompt: "hi",
			systemPrompt: "",
			systemPromptOptions: { cwd: PHYSICAL_WORK, appendSystemPrompt: "", selectedTools: ["read"] },
		};
		await emit("before_agent_start", event);
		assert.equal(event.systemPromptOptions.cwd, `${HOME}/alpha`);
		assert.match(event.systemPromptOptions.appendSystemPrompt, /working directory .*alpha/);
	});

	await check("user_bash runs on the remote", async () => {
		await commands.get("ssh-cwd").handler(`${HOME}/alpha`, ctx);
		const [result] = await emit("user_bash", { command: "pwd", cwd: PHYSICAL_WORK, excludeFromContext: false });
		assert.ok(result?.operations, "expected remote operations");
		const output = [];
		const exit = await result.operations.exec("pwd", PHYSICAL_WORK, { onData: (data) => output.push(data.toString()) });
		assert.equal(exit.exitCode, 0);
		assert.equal(output.join("").trim(), `${HOME}/alpha`);
	});

	await check("the ssh double served every call", async () => {
		assert.equal(readFileSync(HOST_LOG, "utf8").trim(), "fakehost");
	});
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n[${PHASE}] ${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
