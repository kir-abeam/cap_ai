/**
 * Shared LLM plumbing — client construction, prompt execution, multimodal
 * content items, JSON parsing. Used by DocumentProcessingService and by
 * document-classifier.js, so there is one model configuration rather than two
 * that can drift apart.
 *
 * Deliberately prompt-free: every prompt lives with the code that owns it.
 */

const DEFAULT_MAX_TOKENS = 8000;

async function createClient() {
    const { OrchestrationClient } = require('@sap-ai-sdk/orchestration');

    const MODEL_NAME = process.env.AICORE_INVOICE_MODEL ?? 'anthropic--claude-4.6-sonnet';
    const RESOURCE_GROUP = process.env.AICORE_RESOURCE_GROUP ?? 'abmy-project';

    return new OrchestrationClient(
        {
            promptTemplating: {
                model: { name: MODEL_NAME, version: 'latest' },
            },
        },
        { resourceGroup: RESOURCE_GROUP }
    );
}

async function runPrompt(client, systemPrompt, userPrompt, { maxTokens = DEFAULT_MAX_TOKENS } = {}) {

    const response = await client.chatCompletion({
        messages: [
            {
                role: 'system',
                content: systemPrompt
            },
            {
                role: 'user',
                content: userPrompt
            }
        ],

        // Generous by design: an extraction with several line items, or a
        // page-range list for a multi-invoice PDF, truncates mid-JSON at a
        // low ceiling and then fails to parse.
        max_tokens: maxTokens,
        temperature: 0.2
    });

    return response.getContent();
}

async function buildContentItem(fileContent, filename = 'invoice.pdf') {

    return {
        type: 'file',
        file: {
            file_data: `data:application/pdf;base64,${fileContent}`,
            filename,
        },
    };
}

async function buildFileItem(files) {

    return files.map((file) => ({
        type: 'file',
        file: {
            file_data: `data:application/pdf;base64,${file.content}`,
            filename: file.name,
        },
    }));
}

async function parseAIJson(text) {
    text = String(text).trim();

    if (text.startsWith("```")) {
        text = text
            .replace(/^```json\s*/i, "")
            .replace(/^```\s*/i, "")
            .replace(/\s*```$/, "");
    }

    return JSON.parse(text);
}

module.exports = {
    createClient,
    runPrompt,
    buildContentItem,
    buildFileItem,
    parseAIJson
};
