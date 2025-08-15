import { app, HttpRequest, HttpResponseInit } from "@azure/functions";

const SPEECH_KEY = process.env.SPEECH_KEY!;
const SPEECH_REGION = process.env.SPEECH_REGION!; // 例: "japaneast"

app.http("speechToken", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (_req: HttpRequest): Promise<HttpResponseInit> => {
    if (!SPEECH_KEY || !SPEECH_REGION) {
      return { status: 500, jsonBody: { error: "SPEECH_KEY/REGION missing" } };
    }
    const url = `https://${SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Ocp-Apim-Subscription-Key": SPEECH_KEY }
    });
    if (!r.ok) {
      return { status: 500, jsonBody: { error: "token request failed" } };
    }
    const token = await r.text();
    return { status: 200, jsonBody: { token, region: SPEECH_REGION } };
  }
});
