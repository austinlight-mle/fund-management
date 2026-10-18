'use strict';

// Starts the Electron app. Some hosts (e.g. VS Code's extension host) export
// ELECTRON_RUN_AS_NODE=1, which makes Electron behave like plain Node and the
// app fails with "Cannot read properties of undefined (reading 'setPath')".
// Remove those variables before spawning Electron.

const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const child = spawn(electron, [path.join(__dirname, '..'), ...process.argv.slice(2)], { stdio: 'inherit', env, windowsHide: false });
child.on('close', (code, signal) => process.exit(code === null ? (signal ? 1 : 0) : code));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
