import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { WebPubSubServiceClient } from "@azure/web-pubsub";

const HUB = process.env.WEB_PUBSUB_HUB || "signal";
const CONN_STR = process.env.WEB_PUBSUB_CONNECTION_STRING!;

app.http("negotiate", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (_req: HttpRequest): Promise<HttpResponseInit> => {
    if (!CONN_STR) {
      return { status: 500, jsonBody: { error: "WEB_PUBSUB_CONNECTION_STRING missing" } };
    }
    const service = new WebPubSubServiceClient(CONN_STR, HUB);
    const token = await service.getClientAccessToken({
      roles: ["webpubsub.joinLeaveGroup", "webpubsub.sendToGroup"]
    });
    return { status: 200, jsonBody: { url: token.url, hub: HUB } };
  }
});
