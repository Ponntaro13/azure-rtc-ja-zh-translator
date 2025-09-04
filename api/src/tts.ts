import { app, HttpRequest, HttpResponseInit } from "@azure/functions";

const SPEECH_KEY = process.env.SPEECH_KEY!;
const SPEECH_REGION = process.env.SPEECH_REGION!; // 例: "japaneast"

// 好みで調整OK
const VOICE_MAP: Record<string, string> = {
  "ja": "ja-JP-NanamiNeural",
  "zh": "zh-CN-YunyiMultilingualNeural", // 簡体中国語
};

const FORMAT_MAP = {
  mp3: { header: "audio-16khz-128kbitrate-mono-mp3", mime: "audio/mpeg", ext: "mp3" },
  wav: { header: "riff-16khz-16bit-mono-pcm",       mime: "audio/wav",  ext: "wav"  },
} as const;

type TtsBody = {
  text?: string;
  target?: string;   // "ja" | "zh" など。未指定なら "ja"
  format?: "mp3" | "wav"; // 未指定なら "mp3"
  voice?: string;    // 任意。指定あれば優先
};

// 最低限のXMLエスケープ（必要十分ならOK）
function escapeXml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildSsml(text: string, voiceName: string) {
  const safe = escapeXml(text);
  return `
<speak version="1.0" xml:lang="en-US">
  <voice name="${voiceName}">${safe}</voice>
</speak>`.trim();
}

async function getSpeechToken(): Promise<string> {
  const url = `https://${SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": SPEECH_KEY }
  });
  if (!r.ok) throw new Error(`issueToken failed: HTTP ${r.status}`);
  return await r.text();
}

app.http("tts", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req: HttpRequest): Promise<HttpResponseInit> => {
    try {
      if (!SPEECH_KEY || !SPEECH_REGION) {
        return { status: 500, jsonBody: { error: "SPEECH_KEY/REGION missing" } };
      }

      const { text, target = "ja", format = "mp3", voice } = (await req.json()) as TtsBody;

      if (!text || !text.trim()) {
        return { status: 400, jsonBody: { error: "text is required" } };
      }
      const fmt = FORMAT_MAP[format] ?? FORMAT_MAP.mp3;
      const voiceName = voice || VOICE_MAP[target] || VOICE_MAP.ja;

      // 1) STSでBearerトークン取得
      const token = await getSpeechToken();

      // 2) TTS RESTへSSMLで合成依頼
      const ttsUrl = `https://${SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;
      const ssml = buildSsml(text, voiceName);
      const res = await fetch(ttsUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": fmt.header,
          // "User-Agent": "swa-tts"  // 任意
        },
        body: ssml
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        return { status: 500, jsonBody: { error: "tts request failed", detail: errText } };
      }

      const buf = Buffer.from(await res.arrayBuffer());
      return {
        status: 200,
        body: buf,
        headers: {
          "Content-Type": fmt.mime,
          "Content-Disposition": `inline; filename="tts.${fmt.ext}"`,
          "Cache-Control": "no-store"
        }
      };
    } catch (e: any) {
      return { status: 500, jsonBody: { error: "internal error", detail: String(e?.message || e) } };
    }
  }
});
