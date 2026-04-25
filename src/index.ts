#!/usr/bin/env node
import {
    McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import mime from "mime-types";

let PICSHA_API_URL = process.env.PICSHA_API_URL || "https://api.picsha.ai/v1";
if (PICSHA_API_URL.includes('{{')) {
    PICSHA_API_URL = "https://api.picsha.ai/v1";
}
const PICSHA_API_TOKEN = process.env.PICSHA_API_TOKEN || process.env.PICSHA_API_KEY;
const PICSHA_EXTERNAL_USER_ID = process.env.PICSHA_EXTERNAL_USER_ID;

if (!PICSHA_API_TOKEN) {
    console.error("PICSHA_API_TOKEN or PICSHA_API_KEY environment variable is required.");
    process.exit(1);
}

const server = new McpServer({
    name: "picsha-ai",
    version: "1.0.0"
});

async function fetchThumb(url: string): Promise<{ base64: string; mimeType: string } | null> {
    try {
        const res = await fetch(url, {
            headers: { "Authorization": `Bearer ${PICSHA_API_TOKEN}` }
        });
        if (!res.ok) {
            console.error(`Thumbnail fetch failed (${res.status}): ${url}`);
            return null;
        }
        const buf = await res.arrayBuffer();
        return {
            base64: Buffer.from(buf).toString("base64"),
            mimeType: res.headers.get("content-type") || "image/webp"
        };
    } catch (e: any) {
        console.error(`Thumbnail fetch error: ${e.message}`);
        return null;
    }
}

async function apiRequest(endpoint: string, options: RequestInit = {}) {
    const url = `${PICSHA_API_URL}${endpoint}`;
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${PICSHA_API_TOKEN}`
    };

    if (PICSHA_EXTERNAL_USER_ID) {
        headers["x-external-user-id"] = PICSHA_EXTERNAL_USER_ID;
    }

    const response = await fetch(url, {
        ...options,
        headers: {
            ...headers,
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
    "Search for assets in the Picsha AI platform using vector or standard keyword search. Note: If your agent instance is sandboxed to a specific user via environment variables, this search will ONLY return assets owned by that specific user. You are securely retrieving their contextual assets.",
    {
        query: z.string().describe("The search query string. You can append natural language dates/actions like 'added today' or 'uploaded last week' to filter by time."),
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

            // Top 5 results only
            const topResults = ((results?.results || []) as any[]).slice(0, 5);

            // Fetch w=80 (JSON embed for inline widget) and w=400 (tool panel image block) concurrently
            const thumbResults = await Promise.all(
                topResults.map(async (asset: any) => {
                    const baseUrl = `${PICSHA_API_URL}/assets/${asset.id}/render`;
                    const [small, large] = await Promise.all([
                        fetchThumb(`${baseUrl}?w=80&fmt=webp&proxy=true`),
                        fetchThumb(`${baseUrl}?w=400&fmt=webp&proxy=true`)
                    ]);
                    return { small, large };
                })
            );

            const content: any[] = [];

            for (let i = 0; i < topResults.length; i++) {
                const asset = topResults[i];
                const { small, large } = thumbResults[i];

                // Embed w=200 base64 in JSON so Claude can use it in inline widgets
                content.push({
                    type: "text",
                    text: JSON.stringify({
                        ...asset,
                        thumbnail_url: `${PICSHA_API_URL}/assets/${asset.id}/render?w=600&fmt=webp`,
                        thumbnail_b64: small
                            ? `data:${small.mimeType};base64,${small.base64}`
                            : null
                    }, null, 2)
                });

                // w=400 image block for the tool panel
                if (large) {
                    content.push({
                        type: "image",
                        data: large.base64,
                        mimeType: large.mimeType
                    });
                }
            }

            return {
                content
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

server.tool(
    "upload_asset",
    "Upload a local file directly to the Picsha AI platform. This acts as a proxy, fetching a pre-signed S3 URL and executing the PUT request automatically. If your agent is running with user sandboxing, this file will automatically be securely bound to that user's identity. Note: Uploading immediately triggers the asynchronous 'picsha-ai-ingest' pipeline which will extract metadata, generate thumbnails, and run AI analysis (faces, tags, bedrcock summaries). Therefore, the returned asset will initially be in a 'pending' state. You should use the 'get_asset' tool a few seconds after uploading to retrieve the final AI-processed results.",
    {
        filePath: z.string().describe("Absolute path to the local file (e.g. /Users/name/images/photo.jpg) to upload"),
        filename: z.string().optional().describe("Optional original filename to associate with the asset. Defaults to the file's basename.")
    },
    async ({ filePath, filename }) => {
        try {
            // 1. Read local file
            const fileBuffer = await fs.readFile(filePath);
            const actualFilename = filename || path.basename(filePath);
            const contentType = mime.lookup(actualFilename) || "application/octet-stream";

            // 2. Get signed upload URL
            const signResponse = await apiRequest("/upload/sign", {
                method: "POST",
                body: JSON.stringify({
                    contentType,
                    filename: actualFilename
                })
            });

            if (!signResponse.uploadUrl || !signResponse.assetId) {
                throw new Error("Invalid response from sign endpoint");
            }

            // 3. Upload to S3
            const uploadResponse = await fetch(signResponse.uploadUrl, {
                method: signResponse.method || "PUT",
                headers: {
                    "Content-Type": contentType
                },
                body: fileBuffer
            });

            if (!uploadResponse.ok) {
                throw new Error(`Failed to upload to S3: ${uploadResponse.statusText}`);
            }

            return {
                content: [
                    {
                        type: "text",
                        text: `Successfully uploaded asset. Tracking ID: ${signResponse.assetId}`
                    }
                ]
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error uploading asset: ${error.message}` }],
                isError: true
            };
        }
    }
);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Picsha AI MCP Server started on stdio.");
}

main().catch(console.error);
