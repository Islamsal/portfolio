/**
 * Cloudflare Worker for ESO Portfolio AI Concierge
 * ----------------------------------------------------
 * - Free Tier: 100,000 requests/day
 * - Securely protects your GEMINI_API_KEY as an environment secret
 * - Strict Knowledge Guardrails: Only knows what is on esodevelops.com
 * - Routes out-of-bounds questions ONLY to Eso's personal authored posts
 */

let cachedModels = null;

function base64ToUint8(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

function uint8ToBase64(bytes) {
    let bin = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        bin += String.fromCharCode(bytes[i]);
    }
    return btoa(bin);
}

function concatBase64Chunks(chunks) {
    if (!chunks || chunks.length === 0) return null;
    if (chunks.length === 1) return chunks[0];
    const uint8Arrays = chunks.map(base64ToUint8);
    const totalLen = uint8Arrays.reduce((sum, a) => sum + a.length, 0);
    const combined = new Uint8Array(totalLen);
    let offset = 0;
    for (const arr of uint8Arrays) {
        combined.set(arr, offset);
        offset += arr.length;
    }
    return uint8ToBase64(combined);
}

/**
 * Connect to Gemini Live API over WebSocket (bidiGenerateContent)
 * Model: Gemini 2.5 Flash Native Audio Dialog (Live API: Unlimited Free Quota)
 */
async function requestGeminiLiveAudio({ apiKey, userText, userAudio, audioMime, systemPrompt }) {
    return new Promise((resolve, reject) => {
        let isDone = false;
        const liveModel = "models/gemini-2.5-flash-native-audio-preview-09-2025";
        const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;

        let ws;
        try {
            ws = new WebSocket(wsUrl);
        } catch(err) {
            return reject(err);
        }

        const timeout = setTimeout(() => {
            if (!isDone) {
                isDone = true;
                try { ws.close(); } catch(e){}
                reject(new Error("Live API timeout after 7500ms"));
            }
        }, 7500);

        const audioChunks = [];
        let accumulatedText = "";

        ws.addEventListener("open", () => {
            // Send setup handshake
            const setupMsg = {
                setup: {
                    model: liveModel,
                    generationConfig: {
                        responseModalities: ["AUDIO", "TEXT"],
                        speechConfig: {
                            voiceConfig: {
                                prebuiltVoiceConfig: {
                                    voiceName: "Puck"
                                }
                            }
                        }
                    },
                    systemInstruction: {
                        parts: [{ text: systemPrompt }]
                    }
                }
            };
            ws.send(JSON.stringify(setupMsg));
        });

        ws.addEventListener("message", (event) => {
            if (isDone) return;
            try {
                let data;
                if (typeof event.data === "string") {
                    data = JSON.parse(event.data);
                } else {
                    return;
                }

                if (data.setupComplete) {
                    if (userAudio) {
                        ws.send(JSON.stringify({
                            realtimeInput: {
                                mediaChunks: [
                                    {
                                        mimeType: audioMime || "audio/webm",
                                        data: userAudio
                                    }
                                ]
                            }
                        }));
                    } else {
                        ws.send(JSON.stringify({
                            clientContent: {
                                turns: [
                                    {
                                        role: "user",
                                        parts: [{ text: userText }]
                                    }
                                ],
                                turnComplete: true
                            }
                        }));
                    }
                    return;
                }

                if (data.serverContent?.modelTurn?.parts) {
                    for (const part of data.serverContent.modelTurn.parts) {
                        if (part.text) accumulatedText += part.text;
                        const inline = part.inlineData || part.inline_data;
                        if (inline?.data) {
                            audioChunks.push(inline.data);
                        }
                    }
                }

                if (data.serverContent?.turnComplete) {
                    isDone = true;
                    clearTimeout(timeout);
                    try { ws.close(); } catch(e){}

                    const finalAudio = concatBase64Chunks(audioChunks);
                    resolve({
                        reply: accumulatedText.trim() || "System online. Ready to talk code, systems, and low-overhead software.",
                        audio: finalAudio,
                        audioMime: "audio/l16; rate=24000; channels=1",
                        engine: "Gemini 2.5 Flash Native Audio Dialog (Live API: Unlimited)"
                    });
                }
            } catch(e) {
                console.warn("Live API message parse error:", e);
            }
        });

        ws.addEventListener("error", (err) => {
            if (!isDone) {
                isDone = true;
                clearTimeout(timeout);
                try { ws.close(); } catch(e){}
                reject(err);
            }
        });

        ws.addEventListener("close", () => {
            if (!isDone) {
                isDone = true;
                clearTimeout(timeout);
                if (audioChunks.length > 0) {
                    resolve({
                        reply: accumulatedText.trim() || "System online.",
                        audio: concatBase64Chunks(audioChunks),
                        audioMime: "audio/l16; rate=24000; channels=1",
                        engine: "Gemini 2.5 Flash Native Audio Dialog (Live API: Unlimited)"
                    });
                } else {
                    reject(new Error("Live API connection closed before content received"));
                }
            }
        });
    });
}

export default {
    async fetch(request, env) {
        // Handle CORS Preflight
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: corsHeaders(request),
            });
        }

        // Only allow POST requests
        if (request.method !== "POST") {
            return new Response(JSON.stringify({ error: "Method not allowed" }), {
                status: 405,
                headers: { "Content-Type": "application/json", ...corsHeaders(request) },
            });
        }

        try {
            const body = await request.json();
            const userMessage = (body.message || "").trim();
            const userAudio = body.audio || null; // base64 encoded audio
            const audioMime = body.mimeType || "audio/webm";

            if (!userMessage && !userAudio) {
                return new Response(JSON.stringify({ error: "Empty message or audio" }), {
                    status: 400,
                    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
                });
            }

            if (!env.GEMINI_API_KEY) {
                return new Response(JSON.stringify({
                    reply: "Error: GEMINI_API_KEY secret is not set in Cloudflare Worker environment variables."
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
                });
            }

            const apiKey = (env.GEMINI_API_KEY || "").trim();

            // Diagnostic endpoint to inspect exact model availability
            if (userMessage === "__MODELS__") {
                const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
                const listData = await listRes.json();
                return new Response(JSON.stringify(listData), {
                    status: 200,
                    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
                });
            }

            // Strict Knowledge Prompt & Persona
            const systemInstruction = `
You are the AI dialog assistant for Eso's personal portfolio (esodevelops.com).

STRICT KNOWLEDGE & GUARDRAIL RULES:
1. KNOWLEDGE RESTRICTION:
   - Your primary knowledge is STRICTLY LIMITED to the information published on this portfolio webpage:
     * Author: Eso (Islam Salem), Computer Science student, builder of apps, systems, and solutions.
     * Core Philosophy & Pillars:
       - 01 · Local by Default: Software should remain useful offline. Cloud is a synchronization option, not an inescapable dependency.
       - 02 · Low Overhead / Anti-Bloat: Modern computers are fast enough for day-to-day workflows. Rather than rebuilding from scratch for every new trend, leverage what is already there, take time to provide tools that feel right, and write self-contained software without bloat.
       - 03 · Learning Cycle: Learning is a lifelong process. Curiosity, effort, and patience bring real growth. Accepting failure and viewing time spent on unpublished work as valuable experience keeps him passionate about what he does.
     * Featured Projects:
       - P.01 This Portfolio: Built with raw HTML, vanilla CSS, and vanilla JS. Zero frameworks. Custom 120 FPS binary dust interactive canvas engine and GPU circular reality portal theme transition.
       - P.02 Personal Automation Workflows: Custom CLI tools, data pipelines, hotkeys, and shell scripts built to eliminate friction and ship on his own clock.
     * Work Environment: Terminal and IDE-focused, prefers low overhead tools, fights app overload.
     * Direct Contact: eso@esodevelops.com.
     * Official Social Channels:
       - LinkedIn: https://www.linkedin.com/in/islam-salem-a1120b432/
       - X (Twitter): https://x.com/EsoUpdates
       - Reddit, Quora, GitHub.

2. HANDLING OUT-OF-BOUNDS OR UNANSWERED QUESTIONS (MANDATORY):
   - If a visitor asks a question that is NOT answered on this portfolio page, you MUST reply stating that this information is not available on this site.
   - STRICT EXCEPTION: ONLY in the case that Eso has PERSONALLY AUTHORED and posted about it on one of his official accounts (@EsoUpdates on X, or Islam Salem on LinkedIn), you can refer to those specific personal posts written by Eso.
   - FORBIDDEN:
     * NEVER refer to posts made by any other person.
     * NEVER refer to comments made by other people on Eso's posts.
     * NEVER invent, guess, or hallucinate facts about Eso, his life, or his work.
     * Only refer to Eso himself and what he personally writes.

3. TONE & MANNER:
   - Direct, authentic, humble, technical, and concise (hacker vibes, no corporate fluff, no buzzwords).
   - Keep answers focused, typically 1 to 3 sentences unless a deeper breakdown is requested.
`;

            // ----------------------------------------------------
            // 1. PRIMARY ENGINE: Gemini 2.5 Flash Native Audio Dialog (Live API WebSocket)
            // Model: models/gemini-2.5-flash-native-audio-preview-09-2025
            // Free Tier Quota: UNLIMITED (0 / Unlimited in Google AI Studio)
            // ----------------------------------------------------
            try {
                const liveResult = await requestGeminiLiveAudio({
                    apiKey,
                    userText: userMessage,
                    userAudio,
                    audioMime,
                    systemPrompt: systemInstruction
                });

                if (liveResult && (liveResult.audio || liveResult.reply)) {
                    return new Response(JSON.stringify({
                        reply: liveResult.reply,
                        audio: liveResult.audio,
                        audioMime: liveResult.audioMime,
                        engine: liveResult.engine
                    }), {
                        status: 200,
                        headers: { "Content-Type": "application/json", ...corsHeaders(request) },
                    });
                }
            } catch (liveErr) {
                console.warn("Primary Live API Audio Engine fallback to REST:", liveErr.message || liveErr);
            }

            // ----------------------------------------------------
            // 2. SECONDARY ENGINE (FALLBACK): High-Quota REST Models (500 RPD)
            // ----------------------------------------------------
            // Fast In-Memory Cached Model Discovery (Discovers exact working models on key, then caches in RAM)
            if (!cachedModels || cachedModels.length === 0) {
                try {
                    const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
                    if (listRes.ok) {
                        const listData = await listRes.json();
                        if (listData.models && listData.models.length > 0) {
                            const supported = listData.models.filter(m => 
                                m.supportedGenerationMethods && 
                                m.supportedGenerationMethods.includes("generateContent")
                            );
                            if (supported.length > 0) {
                                // Prioritize flash-lite models for highest daily quota (500 RPD) and low latency
                                supported.sort((a, b) => {
                                    const aLite = a.includes("flash-lite") ? 2 : (a.includes("flash") ? 1 : 0);
                                    const bLite = b.includes("flash-lite") ? 2 : (b.includes("flash") ? 1 : 0);
                                    return bLite - aLite;
                                });
                                cachedModels = supported.map(m => m.name);
                            }
                        }
                    }
                } catch (e) {
                    console.warn("Could not query model list:", e);
                }
            }

            const candidateModels = (cachedModels && cachedModels.length > 0) 
                ? cachedModels 
                : ["models/gemini-2.0-flash", "models/gemini-1.5-flash-latest"];

            const userParts = [];
            if (userAudio) {
                userParts.push({
                    text: userMessage 
                        ? `User query note: ${userMessage}. Answer the user's spoken audio question concisely according to your strict instructions:` 
                        : "Listen to the user's spoken audio question and answer it concisely according to your strict instructions:"
                });
                userParts.push({
                    inlineData: {
                        mimeType: audioMime,
                        data: userAudio
                    }
                });
            } else {
                userParts.push({ text: userMessage });
            }

            const payloadBody = JSON.stringify({
                system_instruction: {
                    parts: [{ text: systemInstruction }]
                },
                contents: [
                    {
                        role: "user",
                        parts: userParts
                    }
                ],
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: 180,
                }
            });

            let response = null;
            let lastErrText = "";
            let usedModel = "";

            for (const modelName of candidateModels) {
                const cleanModel = modelName.startsWith("models/") ? modelName : `models/${modelName}`;
                usedModel = cleanModel;
                const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/${cleanModel}:generateContent?key=${apiKey}`;

                response = await fetch(geminiUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: payloadBody
                });

                if (response.ok) {
                    break;
                } else {
                    lastErrText = await response.text();
                    console.error(`Gemini (${cleanModel}) Error:`, lastErrText);
                }
            }

            if (!response || !response.ok) {
                // Clear cache on fatal failure so next call re-syncs
                cachedModels = null;
                return new Response(JSON.stringify({
                    reply: "Unable to reach Gemini dialog engine at the moment. Please try again or reach Eso at eso@esodevelops.com.",
                    details: lastErrText
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
                });
            }

            const data = await response.json();
            const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 
                "This information is not available on this site. You can check Eso's updates directly on X (@EsoUpdates) or LinkedIn.";

            // 2. Direct Studio Audio Voice Generation (Uses verified audio-capable Gemini models)
            let outputAudioData = null;
            let outputAudioMime = null;
            let debugTtsLog = [];
            const ttsCandidates = [
                "models/gemini-2.5-flash-native-audio-latest",
                "models/gemini-2.5-flash-native-audio-preview-09-2025",
                "models/gemini-2.0-flash",
                "models/gemini-2.5-flash-preview-tts",
                "models/gemini-3.1-flash-tts-preview"
            ];

            for (const ttsModel of ttsCandidates) {
                try {
                    const ttsUrl = `https://generativelanguage.googleapis.com/v1beta/${ttsModel}:generateContent?key=${apiKey}`;
                    const ttsRes = await fetch(ttsUrl, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            contents: [
                                {
                                    role: "user",
                                    parts: [{ text: `Speak this answer concisely in an authentic, natural voice:\n${replyText}` }]
                                }
                            ],
                            generationConfig: {
                                responseModalities: ["AUDIO"],
                                speechConfig: {
                                    voiceConfig: {
                                        prebuiltVoiceConfig: {
                                            voiceName: "Puck"
                                        }
                                    }
                                }
                            }
                        })
                    });

                    if (ttsRes.ok) {
                        const ttsJson = await ttsRes.json();
                        const audioPart = ttsJson.candidates?.[0]?.content?.parts?.find(p => p.inlineData || p.inline_data);
                        if (audioPart) {
                            const blob = audioPart.inlineData || audioPart.inline_data;
                            outputAudioData = blob.data;
                            outputAudioMime = blob.mimeType || blob.mime_type || "audio/l16; rate=24000; channels=1";
                            debugTtsLog.push({ model: ttsModel, status: ttsRes.status, success: true });
                            break;
                        }
                    } else {
                        const errTxt = await ttsRes.text();
                        debugTtsLog.push({ model: ttsModel, status: ttsRes.status, error: errTxt.substring(0, 150) });
                    }
                } catch (ttsErr) {
                    debugTtsLog.push({ model: ttsModel, error: ttsErr.message });
                }
            }

            return new Response(JSON.stringify({ 
                reply: replyText,
                audio: outputAudioData,
                audioMime: outputAudioMime,
                debugTTS: debugTtsLog
            }), {
                status: 200,
                headers: { "Content-Type": "application/json", ...corsHeaders(request) },
            });

        } catch (error) {
            console.error("Worker Execution Error:", error);
            return new Response(JSON.stringify({ error: error.message }), {
                status: 500,
                headers: { "Content-Type": "application/json", ...corsHeaders(request) },
            });
        }
    }
};

/**
 * CORS headers allowing requests from your domain and localhost testing
 */
function corsHeaders(request) {
    const origin = request.headers.get("Origin") || "*";
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
    };
}
