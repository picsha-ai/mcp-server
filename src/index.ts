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
            let apiSort: string = sort;
            if (sort === "newest") apiSort = "created-desc";
            if (sort === "oldest") apiSort = "created-asc";

            const results = await apiRequest("/search", {
                method: "POST",
                body: JSON.stringify({ query, mode, threshold, sort: apiSort })
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

server.tool(
    "list_recent_assets",
    "List recently added assets in the Picsha platform. IMPORTANT: When replying to the user, ALWAYS format this as a clean Markdown table with columns for ID, Original Name, Status, and Date.",
    {
        limit: z.number().optional().default(10).describe("Number of assets to retrieve")
    },
    async ({ limit }) => {
        try {
            const results = await apiRequest(`/assets?limit=${limit}`);
            return {
                content: [{ type: "text", text: JSON.stringify(results.data || results, null, 2) }]
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error listing assets: ${error.message}` }],
                isError: true
            };
        }
    }
);

server.tool(
    "update_asset",
    "Update an asset's tags or custom metadata. Prefix a tag with a hyphen (e.g. '-discard') to remove it, or specify normally to add it.",
    {
        id: z.string().describe("The unique ID of the asset"),
        name: z.string().optional().describe("Optional new name/title for the asset"),
        tags: z.array(z.string()).optional().describe("Array of strings to append as tags. Prefix with a hyphen to remove."),
        metadata: z.record(z.string(), z.any()).optional().describe("Custom key-value dictionary to attach")
    },
    async ({ id, name, tags, metadata }) => {
        try {
            const body: any = {};
            if (name) body.meta = { title: name };
            if (tags) body.tags = tags;
            if (metadata) body.metadata = metadata;

            const result = await apiRequest(`/assets/${id}`, {
                method: "PATCH",
                body: JSON.stringify(body)
            });
            return {
                content: [{ type: "text", text: `Successfully updated asset ${id}: ${JSON.stringify(result, null, 2)}` }]
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error updating asset: ${error.message}` }],
                isError: true
            };
        }
    }
);

server.tool(
    "delete_asset",
    "Permanently delete an asset from the database, search indexes, and physical storage.",
    {
        id: z.string().describe("The unique ID of the asset to delete")
    },
    async ({ id }) => {
        try {
            const result = await apiRequest(`/assets/${id}`, {
                method: "DELETE"
            });
            return {
                content: [{ type: "text", text: `Successfully deleted asset ${id}: ${JSON.stringify(result, null, 2)}` }]
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error deleting asset: ${error.message}` }],
                isError: true
            };
        }
    }
);

server.tool(
    "moderate_asset",
    "Approve or reject a moderated asset pending manual review.",
    {
        id: z.string().describe("The unique ID of the asset"),
        action: z.enum(["approve", "reject"]).describe("The moderation action to perform")
    },
    async ({ id, action }) => {
        try {
            const result = await apiRequest(`/assets/${id}/moderation`, {
                method: "POST",
                body: JSON.stringify({ action })
            });
            return {
                content: [{ type: "text", text: `Successfully applied moderation action '${action}' to asset ${id}: ${JSON.stringify(result, null, 2)}` }]
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error moderating asset: ${error.message}` }],
                isError: true
            };
        }
    }
);

server.tool(
    "create_dam_group",
    "Create a new Digital Asset Management (DAM) group/collection (folder) to organize assets.",
    {
        name: z.string().describe("The name of the collection/folder"),
        description: z.string().optional().describe("A description for the group")
    },
    async ({ name, description }) => {
        try {
            const result = await apiRequest("/dam/groups", {
                method: "POST",
                body: JSON.stringify({
                    name,
                    metadata: { description }
                })
            });
            return {
                content: [{ type: "text", text: `Successfully created DAM group: ${JSON.stringify(result, null, 2)}` }]
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error creating DAM group: ${error.message}` }],
                isError: true
            };
        }
    }
);

server.tool(
    "link_assets",
    "Link a source/parent asset to a target/child asset (e.g. variations, derived formats, social crops) with a custom relationship description.",
    {
        sourceId: z.string().describe("The parent/source asset ID"),
        targetId: z.string().describe("The child/target asset ID"),
        relationshipType: z.string().describe("Description of the link relationship (e.g. 'variation', 'social_crop', 'thumbnail')")
    },
    async ({ sourceId, targetId, relationshipType }) => {
        try {
            const result = await apiRequest("/dam/relationships", {
                method: "POST",
                body: JSON.stringify({
                    sourceAssetId: sourceId,
                    targetAssetId: targetId,
                    relationshipType
                })
            });
            return {
                content: [{ type: "text", text: `Successfully linked asset ${targetId} to ${sourceId} as '${relationshipType}': ${JSON.stringify(result, null, 2)}` }]
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error linking assets: ${error.message}` }],
                isError: true
            };
        }
    }
);

server.tool(
    "trigger_url_ingest",
    "Ingest a public web asset directly into the Picsha AI platform by downloading and putting it through the ingestion pipeline.",
    {
        url: z.string().url().describe("Public URL of the media asset to download and ingest"),
        filename: z.string().optional().describe("Optional original filename to associate with the asset"),
        config: z.object({
            auto_summarize: z.boolean().optional(),
            auto_tag: z.boolean().optional(),
            vectorize: z.boolean().optional(),
            location_lookup: z.boolean().optional(),
            adaptive_stream: z.boolean().optional()
        }).optional().describe("Configuration for AI processing, mimicking ingest options")
    },
    async ({ url, filename, config }) => {
        try {
            const result = await apiRequest("/assets", {
                method: "POST",
                body: JSON.stringify({
                    url,
                    originalName: filename,
                    config
                })
            });
            return {
                content: [{ type: "text", text: `Successfully triggered URL ingest: ${JSON.stringify(result, null, 2)}` }]
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error triggering URL ingest: ${error.message}` }],
                isError: true
            };
        }
    }
);

server.tool(
    "escalate_to_support",
    "Use this tool ONLY when you need to log a feature request, report a documentation gap, or escalate an issue to the engineering team. This will actually send an email to support@picsha.ai.",
    {
        subject: z.string().describe("The subject of the escalation email"),
        headline: z.string().describe("A short, punchy headline for the email (e.g. 'Docs Gap Report')"),
        message: z.string().describe("The full summary of the request, formatted nicely. Use \\n for line breaks.")
    },
    async ({ subject, headline, message }) => {
        try {
            const result = await apiRequest("/support/escalate", {
                method: "POST",
                body: JSON.stringify({
                    subject,
                    headline,
                    message
                })
            });
            return {
                content: [{ type: "text", text: `Successfully escalated support report: ${JSON.stringify(result, null, 2)}` }]
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error escalating to support: ${error.message}` }],
                isError: true
            };
        }
    }
);

server.prompt(
    "analyze_asset_profile",
    "Provides a structured template to do a deep analysis of a media asset's metadata, EXIF details, and AI tags.",
    {
        assetId: z.string().describe("The unique ID of the asset to analyze")
    },
    async ({ assetId }) => {
        let metadataStr = "";
        try {
            const asset = await apiRequest(`/assets/${assetId}`, { method: "GET" });
            metadataStr = JSON.stringify(asset, null, 2);
        } catch (e: any) {
            metadataStr = `Asset metadata could not be fetched: ${e.message}`;
        }

        return {
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `You are an expert Media Archivist and Creative Director. I have loaded the metadata for asset "${assetId}":

${metadataStr}

Please perform a comprehensive creative and technical evaluation of this media asset.
Your evaluation must analyze:
1. **Visual/Content Composition**: What objects, faces, text, and themes are detected? What is the mood or style?
2. **Technical Quality**: Based on size, mime-type, and EXIF parameters (if available).
3. **Metadata Audit**: Suggest additions or revisions to the current tags and custom metadata to maximize search relevance.
4. **Creative Ideas**: How could this asset be used in campaigns, websites, or platform-specific social media copy?`
                    }
                }
            ]
        };
    }
);

server.prompt(
    "generate_social_campaign",
    "Helps generate platform-specific social media copy and smart crop parameters based on an asset's content.",
    {
        assetId: z.string().describe("The unique ID of the asset to generate campaigns for"),
        campaignContext: z.string().describe("The marketing theme or context (e.g. 'Summer Beach Launch', 'B2B Tech Webinar')")
    },
    async ({ assetId, campaignContext }) => {
        let metadataStr = "";
        try {
            const asset = await apiRequest(`/assets/${assetId}`, { method: "GET" });
            metadataStr = JSON.stringify(asset, null, 2);
        } catch (e: any) {
            metadataStr = `Asset metadata could not be fetched: ${e.message}`;
        }

        return {
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `You are a social media growth manager and copywriting expert. I have a media asset with the following description/tags:

${metadataStr}

And the campaign context/theme is: "${campaignContext}".

Please design a high-impact, multi-channel social media rollout:
1. **Instagram/Threads (1:1 Smart Crop)**: Write visual copy, recommend hashtags, and construct a Picsha CDN delivery URL using a 1080x1080 smart crop: \`https://api.picsha.ai/v1/assets/${assetId}/render?w=1080&h=1080&crop=face\` (or crop=entropy if no faces are present).
2. **Twitter/LinkedIn (16:9 Landscape Crop)**: Write professional/engaging copy and provide a 1200x675 crop URL (\`https://api.picsha.ai/v1/assets/${assetId}/render?w=1200&h=675&crop=entropy\`).
3. **Pinterest/TikTok (9:16 Portrait Crop)**: Write engaging vertical copy and provide a 1080x1920 crop URL (\`https://api.picsha.ai/v1/assets/${assetId}/render?w=1080&h=1920&crop=entropy\`).`
                    }
                }
            ]
        };
    }
);

server.prompt(
    "image_magic_transform",
    "Walks the LLM and user through Picsha's generative AI fill and background removal parameters.",
    {
        assetId: z.string().describe("The unique ID of the asset to transform"),
        targetWidth: z.string().describe("Target width (e.g. '800')"),
        targetHeight: z.string().describe("Target height (e.g. '600')"),
        generativePrompt: z.string().describe("What background or elements to generate (e.g. 'beautiful forest sunset background')")
    },
    async ({ assetId, targetWidth, targetHeight, generativePrompt }) => {
        let metadataStr = "";
        try {
            const asset = await apiRequest(`/assets/${assetId}`, { method: "GET" });
            metadataStr = JSON.stringify(asset, null, 2);
        } catch (e: any) {
            metadataStr = `Asset metadata could not be fetched: ${e.message}`;
        }

        const encodedPrompt = encodeURIComponent(generativePrompt);

        return {
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `You are a Picsha AI CDN integration expert. We want to apply an advanced generative AI transformation to asset "${assetId}".

Asset Details:
${metadataStr}

The user's requested transformation details:
- **Target Size**: ${targetWidth}px wide by ${targetHeight}px high
- **Generative Prompt**: "${generativePrompt}"

Please:
1. Explain the specific transformation parameters that will be applied (e.g., smart-cropping, aspect-ratio extension via generative fill, background removal).
2. Construct the exact Picsha CDN delivery render URL using the appropriate transformation keys (e.g., \`https://api.picsha.ai/v1/assets/${assetId}/render?w=${targetWidth}&h=${targetHeight}&gen_fill=true&prompt=${encodedPrompt}&fmt=webp\`).
3. Advise on caching and performance optimizations (such as format conversion, quality tuning, or pre-warming the cache).`
                    }
                }
            ]
        };
    }
);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Picsha AI MCP Server started on stdio.");
}

main().catch(console.error);
