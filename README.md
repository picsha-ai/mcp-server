# @picsha-ai/mcp-server

The official Model Context Protocol (MCP) proxy server for the **Picsha AI** platform.

This package provides a secure, local `stdio` proxy that connects your LLM and AI agents (like Claude Desktop or OpenClaw) directly to your Picsha AI environment. By running locally, the server is natively enabled to securely read local files and utilize Picsha's direct-to-S3 upload pipelines.

## Installation & Configuration

You do not need to install this package permanently. You can run it dynamically via `npx`. 

### Claude Desktop / OpenClaw

Add the following to your `claude_desktop_config.json` or `openclaw.json`:

```json
{
  "mcpServers": {
    "picsha-ai": {
      "command": "npx",
      "args": [
        "-y",
        "@picsha-ai/mcp-server@latest"
      ],
      "env": {
        "PICSHA_API_TOKEN": "<YOUR_API_TOKEN_HERE>"
      }
    }
  }
}
```

## Security & Multi-Tenancy

You can generate a `PICSHA_API_TOKEN` via your Picsha Admin Dashboard. By default, this token grants the AI agent administrative access across your entire organization's library.

**Sandbox Mode (User Isolation)**: If you are embedding this MCP server for end-user Slack bots or customer facing SaaS products, you can dynamically restrict the agent's context to a specific user by injecting their User ID as an environment variable:

```json
      "env": {
        "PICSHA_API_TOKEN": "<YOUR_API_TOKEN>",
        "PICSHA_EXTERNAL_USER_ID": "user_123"
      }
```

## Available Tools

This MCP server provides the following capabilities to your LLM:
* `search_assets`: Perform exact or hybrid semantic vector searches across your media.
* `get_asset`: Retrieve deep metadata profiles for resources.
* `upload_asset`: Automatically infers MIME types and effortlessly uploads local files into Picsha's asynchronous AI ingest pipeline.
* `generate_render_url`: Provides on-the-fly image transformations and AI generative fill parameters.
* `trigger_url_ingest`: Ingest public web media directly into the DAM.
* `moderate_asset`, `link_assets`, `create_dam_group`, `update_asset`, `delete_asset` ...and more!
