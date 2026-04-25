import { spawn } from 'child_process';

const child = spawn(process.execPath, ['dist/index.js'], {
    env: { ...process.env, PICSHA_API_TOKEN: "dummy" },
    stdio: ['pipe', 'pipe', 'pipe']
});

child.stdout.on('data', data => console.log(`STDOUT: ${data}`));
child.stderr.on('data', data => console.error(`STDERR: ${data}`));

child.on('close', code => console.log(`Exited with code ${code}`));

const req = {
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    jsonrpc: "2.0",
    id: 0
};
child.stdin.write(JSON.stringify(req) + '\n');
