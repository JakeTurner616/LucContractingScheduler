import { spawn, spawnSync } from "node:child_process";

const commands = [
  {
    name: "worker",
    command: "npx",
    args: ["wrangler", "dev", "--local", "--port", "8787"],
  },
  {
    name: "astro",
    command: "npx",
    args: ["astro", "dev", "--host", "127.0.0.1", "--port", "4325"],
  },
];

const setupCommands = [
  {
    name: "scheduler-db",
    command: "npx",
    args: ["wrangler", "d1", "execute", "luc-contracting-scheduler-db", "--local", "--file", "worker/schema.sql"],
  },
  {
    name: "consult-db",
    command: "npx",
    args: ["wrangler", "d1", "execute", "luc-contracting-db", "--local", "--file", "worker/consult-schema.sql"],
  },
];

const children = [];
let shuttingDown = false;

function stopAll(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }

  setTimeout(() => process.exit(exitCode), 300);
}

for (const item of setupCommands) {
  const result = spawnSync(item.command, item.args, {
    env: { ...process.env, ...item.env },
    shell: true,
    stdio: "pipe",
  });

  if (result.stdout?.length) process.stdout.write(prefixLines(item.name, result.stdout));
  if (result.stderr?.length) process.stderr.write(prefixLines(item.name, result.stderr));

  if (result.status !== 0) {
    console.error(`[${item.name}] setup failed with ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

for (const item of commands) {
  const child = spawn(item.command, item.args, {
    env: { ...process.env, ...item.env },
    shell: true,
    stdio: ["inherit", "pipe", "pipe"],
  });

  children.push(child);

  child.stdout.on("data", (chunk) => {
    process.stdout.write(prefixLines(item.name, chunk));
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(prefixLines(item.name, chunk));
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[${item.name}] exited with ${signal || code}`);
    stopAll(code ?? 1);
  });
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

function prefixLines(name, chunk) {
  return String(chunk)
    .split(/\r?\n/)
    .map((line, index, lines) => {
      if (index === lines.length - 1 && line === "") return "";
      return `[${name}] ${line}`;
    })
    .join("\n");
}
