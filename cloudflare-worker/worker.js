/**
 * Cloudflare Worker for ESO Portfolio AI Concierge
 * ----------------------------------------------------
 * - Free Tier: 100,000 requests/day
 * - Securely protects your GEMINI_API_KEY as an environment secret
 * - Strict Knowledge Guardrails: Only knows what is on esodevelops.com
 * - Routes out-of-bounds questions ONLY to Eso's personal authored posts
 */

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

            const apiKey = (env.GEMINI_API_KEY || "").trim();
            
            // 1. Discover available models for this specific API key (with 2026 latest models)
            let candidateModels = [
                "models/gemini-2.5-flash",
                "models/gemini-2.0-flash",
                "models/gemini-2.0-flash-lite",
                "models/gemini-1.5-flash-latest",
                "models/gemini-1.5-pro-latest"
            ];

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
                            // Sort so flash models are prioritized for fast response time
                            supported.sort((a, b) => {
                                const aFlash = a.name.includes("flash") ? 1 : 0;
                                const bFlash = b.name.includes("flash") ? 1 : 0;
                                return bFlash - aFlash;
                            });
                            candidateModels = supported.map(m => m.name);
                        }
                    }
                }
            } catch (err) {
                console.warn("Could not dynamically query models, using defaults:", err);
            }

            let response = null;
            let lastErrText = "";
            let usedModel = "";

            for (const modelName of candidateModels) {
                const cleanModel = modelName.startsWith("models/") ? modelName : `models/${modelName}`;
                const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/${cleanModel}:generateContent?key=${apiKey}`;
                usedModel = cleanModel;

                const userParts = [];
                if (userAudio) {
                    userParts.push({
                        text: userMessage 
                            ? `User query note: ${userMessage}. Answer the user's spoken audio question according to your strict knowledge instructions:` 
                            : "Listen to the user's spoken audio question and answer it concisely according to your strict knowledge instructions:"
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

                response = await fetch(geminiUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
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
                            maxOutputTokens: 300,
                        }
                    })
                });

                if (response.ok) {
                    break;
                } else {
                    lastErrText = await response.text();
                    console.error(`Gemini (${cleanModel}) Error:`, lastErrText);
                }
            }

            if (!response || !response.ok) {
                return new Response(JSON.stringify({
                    reply: "Unable to reach Gemini dialog engine at the moment. Please try again or reach Eso at eso@esodevelops.com.",
                    details: lastErrText,
                    triedModel: usedModel
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
                });
            }

            const data = await response.json();
            const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 
                "This information is not available on this site. You can check Eso's updates directly on X (@EsoUpdates) or LinkedIn.";

            // 2. Synthesize Gemini Native Studio Voice Audio
            let audioData = null;
            let audioMime = null;

            try {
                const ttsModel = "models/gemini-2.0-flash";
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
                        audioData = blob.data;
                        audioMime = blob.mimeType || blob.mime_type || "audio/wav";
                    }
                } else {
                    console.warn("Gemini Audio Generation error:", await ttsRes.text());
                }
            } catch (ttsErr) {
                console.warn("TTS Error:", ttsErr);
            }

            return new Response(JSON.stringify({ 
                reply: replyText,
                audio: audioData,
                audioMime: audioMime
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
