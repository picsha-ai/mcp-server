import {
    McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const PICSHA_API_URL = process.env.PICSHA_API_URL || "http://localhost:3000/v1";
const PICSHA_API_TOKEN = process.env.PICSHA_API_TOKEN;

if (!PICSHA_API_TOKEN) {
    console.error("PICSHA_API_TOKEN environment variable is required.");
    process.exit(1);
}

const server = new McpServer({
    name: "picsha-ai",
    version: "1.0.0"
});

async function apiRequest(endpoint: string, options: RequestInit = {}) {
    const url = `${PICSHA_API_URL}${endpoint}`;
    const response = await fetch(url, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${PICSHA_API_TOKEN}`,
            ...options.headers
        }
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Picsha API error (${response.status}): ${errorText}`);
    }

    return response.json();
}

server.tool(
    "search_assets",
    "Search for assets in the Picsha AI platform using vector or standard keyword search",
    {
        query: z.string().describe("The search query string"),
        mode: z.enum(["ai", "standard"]).optional().default("ai").describe("Search mode. 'ai' uses vector hybrid search, 'standard' uses exact keyword / tag matching."),
        threshold: z.number().min(0).max(1).optional().default(0.6).describe("Confidence threshold for AI searches (0.0 to 1.0)"),
        sort: z.enum(["relevance", "newest", "oldest"]).optional().default("relevance").describe("Sort order for the results")
    },
    async ({ query, mode, threshold, sort }) => {
        try {
            const results = await apiRequest("/search", {
                method: "POST",
                body: JSON.stringify({ query, mode, threshold, sort })
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(results, null, 2)
                    }
                ]
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error searching assets: ${error.message}` }],
                isError: true
            };
        }
    }
);

server.tool(
    "get_asset",
    "Retrieve detailed metadata and AI analysis results for a specific asset",
    {
        id: z.string().describe("The unique ID of the asset to retrieve")
    },
    async ({ id }) => {
        try {
            const result = await apiRequest(`/assets/${id}`, {
                method: "GET"
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result, null, 2)
                    }
                ]
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error retrieving asset: ${error.message}` }],
                isError: true
            };
        }
    }
);

server.tool(
    "reanalyze_asset",
    "Manually trigger AI re-analysis on an existing asset to detect faces, objects, etc.",
    {
        id: z.string().describe("The unique ID of the asset")
    },
    async ({ id }) => {
        try {
            const result = await apiRequest(`/assets/${id}/analyze`, {
                method: "POST"
            });
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error reanalyzing asset: ${error.message}` }],
                isError: true
            };
        }
    }
);

server.tool(
    "summarize_asset",
    "Utilize Claude Sonnet via Amazon Bedrock to summarize documents on demand",
    {
        id: z.string().describe("The unique ID of the asset (document/text) to summarize")
    },
    async ({ id }) => {
        try {
            const result = await apiRequest(`/assets/${id}/summarize`, {
                method: "POST"
            });
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error summarizing asset: ${error.message}` }],
                isError: true
            };
        }
    }
);

server.tool(
    "get_rendered_asset_url",
    "Generate a dynamic delivery URL for an asset with transformation parameters (e.g. width, height, format, smart crop)",
    {
        id: z.string().describe("The unique ID of the asset"),
        params: z.string().describe("Query parameters string for transformations (e.g. 'w=500&h=500&fmt=webp&crop=face')")
    },
    async ({ id, params }) => {
        try {
            // Since this tool just generates a URL, it doesn't necessarily need to call the API
            // However, the proxy URL through the Picsha API is the standard delivery method
            const url = `${PICSHA_API_URL}/assets/${id}/render?${params}`;
            return {
                content: [{ type: "text", text: `Render URL for Asset ${id}:\n${url}` }]
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error generating render URL: ${error.message}` }],
                isError: true
            };
        }
    }
);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.log("Picsha AI MCP Server started.");
}

main().catch(console.error);
