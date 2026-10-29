/**
 * pi-ssh-workspace
 *
 * Route pi's read, write, edit and bash tools to a remote machine over SSH.
 * Model calls still leave from the local machine; only file and shell work is remote.
 *
 * Usage:
 *   pi --ssh my-host --ssh-cwd /home/user/code/project
 *   pi --ssh user@host:/path
 *
 * Runtime:
 *   /ssh-cwd            print the active remote working directory
 *   /ssh-cwd <path>     switch it; relative paths resolve against the current remote
 *                       directory, ~ expands to the remote $HOME, and the target must
 *                       be an existing directory on the remote
 *
 * Requirements:
 *   - SSH key auth, bash on remote
 *   - ControlMaster in ~/.ssh/config for latency
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type EditOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15"];

function sshExec(remote: string, command: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", [...SSH_OPTS, remote, command], { stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		child.stdout.on("data", (d) => chunks.push(d));
		child.stderr.on("data", (d) => errChunks.push(d));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`SSH failed (${code}): ${Buffer.concat(errChunks).toString()}`));
			} else {
				resolve(Buffer.concat(chunks));
			}
		});
	});
}

function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Shell-quote a remote path, expanding a leading `~` through $HOME. */
function remotePathExpr(path: string): string {
	if (path === "~") return '"$HOME"';
	if (path.startsWith("~/")) return `"$HOME"${JSON.stringify(path.slice(1))}`;
	return JSON.stringify(path);
}

/**
 * Resolve a remote directory, with relative paths resolving against `base`.
 * Uses `pwd -P` so the stored directory is physical and never contains `~` or symlink surprises.
 */
async function resolveRemoteDir(remote: string, base: string, target: string): Promise<string> {
	const out = await sshExec(remote, `cd ${remotePathExpr(base)} && cd ${remotePathExpr(target)} && pwd -P`);
	const resolved = out.toString().trim();
	if (!resolved) throw new Error(`could not resolve remote directory: ${target}`);
	return resolved;
}

/** Prefix-safe path mapping: only rewrite when the path is inside localCwd. */
function makeMapper(localCwd: string, remoteCwd: string) {
	const norm = (p: string) => p.replace(/\/+$/, "");
	const lc = norm(localCwd);
	const rc = norm(remoteCwd);
	return (p: string) => {
		const abs = p.startsWith("/") ? p : `${lc}/${p}`;
		if (abs === lc) return rc;
		if (abs.startsWith(`${lc}/`)) return rc + abs.slice(lc.length);
		return abs; // outside the workspace: keep as-is (remote path must match)
	};
}

function createRemoteReadOps(remote: string, remoteCwd: string, localCwd: string): ReadOperations {
	const toRemote = makeMapper(localCwd, remoteCwd);
	return {
		readFile: (p) => sshExec(remote, `cat ${JSON.stringify(toRemote(p))}`),
		access: (p) => sshExec(remote, `test -r ${JSON.stringify(toRemote(p))}`).then(() => {}),
		detectImageMimeType: async (p) => {
			try {
				const r = await sshExec(remote, `file --mime-type -b ${JSON.stringify(toRemote(p))}`);
				const m = r.toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
			} catch {
				return null;
			}
		},
	};
}

function createRemoteWriteOps(remote: string, remoteCwd: string, localCwd: string): WriteOperations {
	const toRemote = makeMapper(localCwd, remoteCwd);
	return {
		writeFile: async (p, content) => {
			const b64 = Buffer.from(content).toString("base64");
			await sshExec(remote, `mkdir -p $(dirname ${JSON.stringify(toRemote(p))}) && echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(toRemote(p))}`);
		},
		mkdir: (dir) => sshExec(remote, `mkdir -p ${JSON.stringify(toRemote(dir))}`).then(() => {}),
	};
}

function createRemoteEditOps(remote: string, remoteCwd: string, localCwd: string): EditOperations {
	const r = createRemoteReadOps(remote, remoteCwd, localCwd);
	const w = createRemoteWriteOps(remote, remoteCwd, localCwd);
	return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function createRemoteBashOps(remote: string, remoteCwd: string, localCwd: string): BashOperations {
	const toRemote = makeMapper(localCwd, remoteCwd);
	return {
		exec: (command, cwd, { onData, signal, timeout }) =>
			new Promise((resolve, reject) => {
				const cmd = `cd ${JSON.stringify(toRemote(cwd))} && ${command}`;
				const child = spawn("ssh", [...SSH_OPTS, remote, cmd], { stdio: ["ignore", "pipe", "pipe"] });
				let timedOut = false;
				const timer = timeout
					? setTimeout(() => {
							timedOut = true;
							child.kill();
						}, timeout * 1000)
					: undefined;
				child.stdout.on("data", onData);
				child.stderr.on("data", onData);
				child.on("error", (e) => {
					if (timer) clearTimeout(timer);
					reject(e);
				});
				const onAbort = () => child.kill();
				signal?.addEventListener("abort", onAbort, { once: true });
				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				});
			}),
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("ssh", { description: "SSH remote: user@host (optionally user@host:/path)", type: "string" });
	pi.registerFlag("ssh-cwd", { description: "Remote working directory", type: "string" });

	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);

	let resolvedSsh: { remote: string; remoteCwd: string } | null = null;
	const getSsh = () => resolvedSsh;

	const showStatus = (ctx: ExtensionContext) => {
		const ssh = getSsh();
		ctx.ui.setStatus("ssh", ssh ? ctx.ui.theme.fg("accent", `SSH: ${ssh.remote}:${ssh.remoteCwd}`) : undefined);
	};

	const wrap = <T extends { name: string; execute: (...a: any[]) => any }>(
		localTool: T,
		build: (ssh: { remote: string; remoteCwd: string }) => T,
	) => ({
		...localTool,
		async execute(id: string, params: any, signal: AbortSignal, onUpdate: any, _ctx: any) {
			const ssh = getSsh();
			if (ssh) return build(ssh).execute(id, params, signal, onUpdate);
			return localTool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool(
		wrap(localRead, (ssh) =>
			createReadTool(localCwd, { operations: createRemoteReadOps(ssh.remote, ssh.remoteCwd, localCwd) }),
		),
	);
	pi.registerTool(
		wrap(localWrite, (ssh) =>
			createWriteTool(localCwd, { operations: createRemoteWriteOps(ssh.remote, ssh.remoteCwd, localCwd) }),
		),
	);
	pi.registerTool(
		wrap(localEdit, (ssh) =>
			createEditTool(localCwd, { operations: createRemoteEditOps(ssh.remote, ssh.remoteCwd, localCwd) }),
		),
	);
	pi.registerTool(
		wrap(localBash, (ssh) =>
			createBashTool(localCwd, { operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd) }),
		),
	);

	pi.on("session_start", async (_event, ctx) => {
		const arg = pi.getFlag("ssh") as string | undefined;
		if (!arg) return;
		const colon = arg.indexOf(":");
		const remote = colon === -1 ? arg : arg.slice(0, colon);
		const inlineCwd = colon === -1 ? undefined : arg.slice(colon + 1);
		const flagCwd = pi.getFlag("ssh-cwd") as string | undefined;

		let remoteCwd: string;
		try {
			remoteCwd = await resolveRemoteDir(remote, "~", inlineCwd || flagCwd || "~");
		} catch (err) {
			ctx.ui.notify(`SSH mode not enabled: ${describeError(err)}`, "error");
			return;
		}

		resolvedSsh = { remote, remoteCwd };
		showStatus(ctx);
		ctx.ui.notify(`SSH mode: ${remote}:${remoteCwd}`, "info");
	});

	// Switch the remote working directory without restarting Pi.
	pi.registerCommand("ssh-cwd", {
		description: "Show or change the remote working directory (requires --ssh)",
		handler: async (args, ctx) => {
			const ssh = getSsh();
			if (!ssh) {
				ctx.ui.notify("SSH mode is off: start pi with --ssh <host> --ssh-cwd <path>", "error");
				return;
			}

			const target = args.trim();
			if (!target) {
				ctx.ui.notify(`Remote working directory: ${ssh.remote}:${ssh.remoteCwd}`, "info");
				return;
			}

			let resolved: string;
			try {
				resolved = await resolveRemoteDir(ssh.remote, ssh.remoteCwd, target);
			} catch (err) {
				ctx.ui.notify(`Cannot switch to ${target}: ${describeError(err)}`, "error");
				return;
			}

			if (resolved === ssh.remoteCwd) {
				ctx.ui.notify(`Remote working directory unchanged: ${resolved}`, "info");
				return;
			}

			resolvedSsh = { remote: ssh.remote, remoteCwd: resolved };
			showStatus(ctx);
			ctx.ui.notify(`Remote working directory: ${resolved}`, "info");
			pi.sendMessage({
				customType: "ssh-cwd",
				content: `Remote working directory switched to ${resolved} on ${ssh.remote}. read, write, edit and bash now target that directory.`,
				display: true,
			});
		},
	});

	// `!` commands also run on the remote
	pi.on("user_bash", (_event) => {
		const ssh = getSsh();
		if (!ssh) return;
		return { operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd) };
	});

	// Keep the model's cwd section and the execution split in step with the active remote.
	// Mutating systemPromptOptions instead of replacing the whole prompt keeps the structured
	// prompt, so only the changed sections are sent as a delta.
	pi.on("before_agent_start", async (event) => {
		const ssh = getSsh();
		if (!ssh) return;

		event.systemPromptOptions.cwd = ssh.remoteCwd;
		const note = [
			`Execution split: read, write, edit and bash run on the REMOTE machine ${ssh.remote}, working directory ${ssh.remoteCwd}.`,
			`Path arguments are resolved against the local directory ${localCwd} and mapped into ${ssh.remoteCwd} on the remote.`,
			`ls, grep, find, process and pi-lens still run LOCALLY against ${localCwd}; that local tree is not synchronized with the remote, so never treat it as the remote state.`,
			`List, search and inspect remote files through bash on the remote.`,
		].join("\n");
		event.systemPromptOptions.appendSystemPrompt = [event.systemPromptOptions.appendSystemPrompt, note]
			.filter(Boolean)
			.join("\n\n");
	});
}
