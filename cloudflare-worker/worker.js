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
    return new Promise(async (resolve, reject) => {
        let isDone = false;
        const trace = [];
        const liveModel = "models/gemini-2.5-flash-native-audio-preview-09-2025";
        const fetchUpgradeUrl = `https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
        const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;

        let ws = null;
        let isAlreadyOpen = false;

        // Method A: Cloudflare Workers native fetch with Upgrade header (requires https:// scheme)
        try {
            trace.push("attempt_fetch_upgrade");
            const wsRes = await fetch(fetchUpgradeUrl, {
                headers: { "Upgrade": "websocket" }
            });
            trace.push("fetch_status_" + wsRes.status);
            if (wsRes && wsRes.webSocket) {
                ws = wsRes.webSocket;
                try { ws.binaryType = "arraybuffer"; } catch(e){}
                ws.accept();
                isAlreadyOpen = true;
                trace.push("ws_accepted");
            } else {
                trace.push("no_websocket_in_res");
            }
        } catch (fetchErr) {
            trace.push("fetch_err:" + fetchErr.message);
            console.warn("fetch websocket upgrade error:", fetchErr);
        }

        // Method B: Standard global WebSocket client fallback
        if (!ws) {
            try {
                trace.push("attempt_new_websocket");
                if (typeof WebSocket !== "undefined") {
                    ws = new WebSocket(wsUrl);
                    try { ws.binaryType = "arraybuffer"; } catch(e){}
                    trace.push("new_ws_created");
                }
            } catch (wsErr) {
                trace.push("new_ws_err:" + wsErr.message);
                console.warn("new WebSocket constructor error:", wsErr);
            }
        }

        if (!ws) {
            return reject(new Error("Cloudflare Worker outbound WebSocket client not available: " + trace.join(" > ")));
        }

        let hasReceivedSetupComplete = false;
        let activeTimeout = setTimeout(() => {
            if (!isDone) {
                isDone = true;
                try { ws.close(); } catch(e){}
                reject(new Error("Live API handshake timeout (3500ms). Trace: " + trace.join(" > ")));
            }
        }, 3500);

        const audioChunks = [];
        let accumulatedText = "";

        const sendSetup = () => {
            try {
                trace.push("setup_sent");
                const setupMsg = {
                    setup: {
                        model: liveModel,
                        generationConfig: {
                            responseModalities: ["AUDIO"],
                            thinkingConfig: {
                                thinkingBudget: 0
                            },
                            speechConfig: {
                                voiceConfig: {
                                    prebuiltVoiceConfig: {
                                        voiceName: "Aoede"
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
            } catch (err) {
                trace.push("setup_err:" + err.message);
                console.warn("Send setup error:", err);
            }
        };

        if (isAlreadyOpen) {
            sendSetup();
        } else {
            ws.addEventListener("open", sendSetup);
        }

        ws.addEventListener("message", async (event) => {
            if (isDone) return;
            try {
                let rawText = "";
                if (typeof event.data === "string") {
                    rawText = event.data;
                } else if (event.data instanceof ArrayBuffer) {
                    rawText = new TextDecoder().decode(event.data);
                } else if (event.data && typeof event.data.text === "function") {
                    rawText = await event.data.text();
                } else if (event.data && typeof event.data.arrayBuffer === "function") {
                    const buf = await event.data.arrayBuffer();
                    rawText = new TextDecoder().decode(buf);
                } else {
                    trace.push("unknown_msg_data:" + typeof event.data);
                    return;
                }

                let data;
                try {
                    data = JSON.parse(rawText);
                } catch(parseErr) {
                    trace.push("json_parse_err");
                    return;
                }

                trace.push("keys:" + Object.keys(data).join(","));

                if (data.error) {
                    isDone = true;
                    clearTimeout(activeTimeout);
                    try { ws.close(); } catch(e){}
                    return reject(new Error("Live API Error: " + (data.error.message || JSON.stringify(data.error))));
                }

                if (data.setupComplete || data.setup_complete) {
                    hasReceivedSetupComplete = true;
                    clearTimeout(activeTimeout);
                    activeTimeout = setTimeout(() => {
                        if (!isDone) {
                            isDone = true;
                            try { ws.close(); } catch(e){}
                            reject(new Error("Live API audio generation timeout (6000ms). Trace: " + trace.join(" > ")));
                        }
                    }, 6000);

                    trace.push("sending_query");
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

                if (data.serverContent?.outputTranscription?.text) {
                    accumulatedText += data.serverContent.outputTranscription.text;
                }

                if (data.serverContent?.modelTurn?.parts) {
                    for (const part of data.serverContent.modelTurn.parts) {
                        trace.push("p:" + JSON.stringify(part).substring(0, 60));
                        if (part.thought) continue;
                        if (part.text) {
                            accumulatedText += part.text;
                        }
                        const inline = part.inlineData || part.inline_data || part.blob;
                        if (inline && (inline.data || inline.bytes)) {
                            audioChunks.push(inline.data || inline.bytes);
                        } else if (part.data) {
                            audioChunks.push(part.data);
                        }
                    }
                }

                if (data.serverContent?.turnComplete) {
                    trace.push("done_audio:" + audioChunks.length);
                    isDone = true;
                    clearTimeout(activeTimeout);
                    try { ws.close(); } catch(e){}

                    const finalAudio = concatBase64Chunks(audioChunks);
                    resolve({
                        reply: accumulatedText.trim() || "System online. Ready to talk code, systems, and low-overhead software.",
                        audio: finalAudio,
                        audioMime: "audio/l16; rate=24000; channels=1",
                        engine: "Gemini 2.5 Flash Native Audio Dialog (Live API: Unlimited)",
                        debugLiveErr: trace.join(" > ")
                    });
                }
            } catch(e) {
                console.warn("Live API message parse error:", e);
            }
        });

        ws.addEventListener("error", (err) => {
            if (!isDone) {
                isDone = true;
                clearTimeout(activeTimeout);
                try { ws.close(); } catch(e){}
                reject(err);
            }
        });

        ws.addEventListener("close", (event) => {
            if (!isDone) {
                isDone = true;
                clearTimeout(activeTimeout);
                if (audioChunks.length > 0) {
                    resolve({
                        reply: accumulatedText.trim() || "System online.",
                        audio: concatBase64Chunks(audioChunks),
                        audioMime: "audio/l16; rate=24000; channels=1",
                        engine: "Gemini 2.5 Flash Native Audio Dialog (Live API: Unlimited)"
                    });
                } else {
                    const code = event ? event.code : "none";
                    const reason = event ? (event.reason || "none") : "none";
                    reject(new Error(`Live API closed before content. Code: ${code}, Reason: ${reason}`));
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
            let primaryLiveError = null;
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
                primaryLiveError = liveErr.message || String(liveErr);
                console.warn("Primary Live API Audio Engine fallback to REST:", primaryLiveError);
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
                                    const aName = a.name || "";
                                    const bName = b.name || "";
                                    const aLite = aName.includes("flash-lite") ? 2 : (aName.includes("flash") ? 1 : 0);
                                    const bLite = bName.includes("flash-lite") ? 2 : (bName.includes("flash") ? 1 : 0);
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
                : ["models/gemini-2.0-flash"];

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
            const ttsCandidates = [
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
                                            voiceName: "Aoede"
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
                            break;
                        }
                    }
                } catch (ttsErr) {
                    console.warn(`Fallback TTS Error on ${ttsModel}:`, ttsErr.message || ttsErr);
                }
            }

            return new Response(JSON.stringify({ 
                reply: replyText,
                audio: outputAudioData,
                audioMime: outputAudioMime,
                debugLiveErr: primaryLiveError
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
