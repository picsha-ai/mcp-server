const { spawn } = require('child_process');

const mcp = spawn('node', ['dist/index.js'], {
    env: { ...process.env, PICSHA_API_TOKEN: 'YOUR_TOKEN_HERE' }
});

let response = '';

mcp.stdout.on('data', (data) => {
    response += data.toString();
    console.log('STDOUT:', data.toString());
});

mcp.stderr.on('data', (data) => {
    console.error('STDERR:', data.toString());
});

const req = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
        name: "search_assets",
        arguments: {
            query: "#picsha-docs"
        }
    }
};

mcp.stdin.write(JSON.stringify(req) + '\n');

setTimeout(() => {
    mcp.kill();
    process.exit(0);
}, 2000);
