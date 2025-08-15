import { useEffect, useMemo, useRef, useState } from "react";
import { WebPubSubClient } from "@azure/web-pubsub-client";
import * as SpeechSDK from "microsoft-cognitiveservices-speech-sdk";

type Line = {
  id: string; who: "self" | "peer";
  t: number; srcLang: string; original: string; translated: string;
};

type Signal = { type: "join" | "offer" | "answer" | "ice"; sdp?: any; candidate?: any; id?: string; };

const roomFromURL = () => new URL(location.href).searchParams.get("room") || "demo";

export default function App() {
  // Video refs
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  // States
  const [started, setStarted] = useState(false);
  const [partial, setPartial] = useState("");
  const [lines, setLines] = useState<Line[]>([]);

  // WebRTC stuff
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const sendChanRef = useRef<RTCDataChannel | null>(null);
  const peerJoinedRef = useRef(false);

  // Web PubSub
  const wpsRef = useRef<WebPubSubClient | null>(null);
  const myConnIdRef = useRef<string>("");

  // Speech
  const recogRef = useRef<SpeechSDK.TranslationRecognizer | null>(null);

  const room = useMemo(roomFromURL, []);

  const pushLine = (l: Line) => setLines(prev => [l, ...prev].slice(0, 200));

 const sendSignal = async (payload: Signal) => {
   const wps = wpsRef.current!;
   await wps.sendToGroup(
     room,
     JSON.stringify({ ...payload, senderId: myConnIdRef.current }),
     "text"
   );
 };

  // ===== Start =====
  const start = async () => {
    if (started) return;

    // 1) Local media
    const local = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = local;
      await localVideoRef.current.play();
    }

    // 2) RTCPeerConnection（STUNのみ。本番はTURNを追加）
    const pc = new RTCPeerConnection({
      iceServers: [
        // STUN は併記でOK
        { urls: "stun:stun.l.google.com:19302" },
        {
          urls: [
            "turn:turn-example-com.japaneast.cloudapp.azure.com:3478?transport=udp",
            "turn:turn-example-com.japaneast.cloudapp.azure.com:3478?transport=tcp",
            // 証明書OKならTLSも
            "turns:turn-example-com.japaneast.cloudapp.azure.com:5349?transport=tcp",
          ],
          username: "webrtcuser",         // 方式Aのとき
          credential: "webrtcpw"
          // 方式Bなら、サーバで HMAC を発行して渡す（下の例）
        }
      ],
      iceTransportPolicy: "relay" // まずは確実に通すテスト。成功したら "all" に戻す
    });
    pcRef.current = pc;

    local.getTracks().forEach(tr => pc.addTrack(tr, local));

    pc.ontrack = (ev) => {
      const [stream] = ev.streams;
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = stream;
        remoteVideoRef.current.play().catch(() => {});
      }
    };

    const data = pc.createDataChannel("captions");
    data.onopen = () => {};
    data.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === "caption") {
          pushLine({ id: crypto.randomUUID(), who: "peer", t: m.t, srcLang: m.srcLang, original: m.original, translated: m.translated });
        }
      } catch {}
    };
    sendChanRef.current = data;

    pc.ondatachannel = (ev) => {
      if (ev.channel.label === "captions") {
        ev.channel.onmessage = (e) => {
          try {
            const m = JSON.parse(e.data);
            if (m.type === "caption") {
              pushLine({ id: crypto.randomUUID(), who: "peer", t: m.t, srcLang: m.srcLang, original: m.original, translated: m.translated });
            }
          } catch {}
        };
      }
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) sendSignal({ type: "ice", candidate: ev.candidate.toJSON() });
    };

    // 3) Web PubSub 接続（/api/negotiate を使う）
    const wps = new WebPubSubClient({
      async getClientAccessUrl() {
        const r = await fetch("/api/negotiate", { method: "POST" });
        const { url } = await r.json();
        return url;
      }
    });
    wpsRef.current = wps;

 wps.on("connected", (e: any) => { myConnIdRef.current = e.connectionId; });
 wps.on("group-message", async (e: any) => {
      const msg: Signal & { senderId?: string } = JSON.parse(e.message.data);
      // 自分が送ったものは無視
      if (msg.senderId && msg.senderId === myConnIdRef.current) return;

      if (!pcRef.current) return;
      const pc = pcRef.current;

  if (msg.type === "join") {
    // 同時入室でも片側のみがオファーを出すように、接続IDで役割を決める
    if (!peerJoinedRef.current) {
      peerJoinedRef.current = true;
      const iAmOfferer = (myConnIdRef.current || "") > (msg.senderId || "");
      if (iAmOfferer) await makeOffer();
    }
      } else if (msg.type === "offer" && msg.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await sendSignal({ type: "answer", sdp: pc.localDescription });
      } else if (msg.type === "answer" && msg.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      } else if (msg.type === "ice" && msg.candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
      }
    });

    await wps.start();
    await wps.joinGroup(room);
    await sendSignal({ type: "join", id: myConnIdRef.current });


    // 4) Azure Speech（連続翻訳）
    await startSpeech(local);

    setStarted(true);
  };

  const makeOffer = async () => {
    const pc = pcRef.current!;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await sendSignal({ type: "offer", sdp: pc.localDescription });
  };

  const startSpeech = async (local: MediaStream)  => {
    const { token, region } = await (await fetch("/api/speechToken", { method: "POST" })).json();

    const tcfg = SpeechSDK.SpeechTranslationConfig.fromAuthorizationToken(token, region);
    tcfg.speechRecognitionLanguage = "ja-JP";  // 既定。実際は LID が ja-JP/zh-CN を切り替え
    tcfg.addTargetLanguage("ja");
    tcfg.addTargetLanguage("zh-Hans"); // 簡体（繁体にしたいときは "zh-Hant"）
    //const lid = SpeechSDK.AutoDetectSourceLanguageConfig.fromLanguages(["ja-JP", "zh-CN"]);
    // LID の候補を作成
    const lid: SpeechSDK.AutoDetectSourceLanguageConfig =SpeechSDK.AutoDetectSourceLanguageConfig.fromLanguages(["ja-JP", "zh-CN"]);
    // （必要なら）連続LIDに
    tcfg.setProperty(
      SpeechSDK.PropertyId.SpeechServiceConnection_LanguageIdMode,
      "Continuous" // or "AtStart"
    );

    const track = local.getAudioTracks()[0];
    let acfg: SpeechSDK.AudioConfig;
    try {
      // まずは track.getSettings().deviceId を試す
      const devId = track?.getSettings?.().deviceId;
      if (devId && typeof devId === "string") {
        acfg = SpeechSDK.AudioConfig.fromMicrophoneInput(devId);
      } else {
        // 取れないブラウザ用のフォールバック：label で一致を探す
        const label = track?.label;
        const devs = await navigator.mediaDevices.enumerateDevices();
        const mic = devs.find(d => d.kind === "audioinput" && d.label === label);
        acfg = mic
          ? SpeechSDK.AudioConfig.fromMicrophoneInput(mic.deviceId)
          : SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
      }
    } catch {
      acfg = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
    }

    //const recognizer = new SpeechSDK.TranslationRecognizer(tcfg, lid, acfg);
    const recognizer = SpeechSDK.TranslationRecognizer.FromConfig(tcfg, lid, acfg);
    recogRef.current = recognizer;

    recognizer.recognizing = (_s, e) => {
      const lang = SpeechSDK.AutoDetectSourceLanguageResult.fromResult(e.result).language || "";
      const toZh = lang.startsWith("ja");
      const live = e.result.translations.get(toZh ? "zh-Hans" : "ja") || "";
      setPartial(`${e.result.text} → ${live}`);
    };

    recognizer.recognized = (_s, e) => {
      if (!e.result?.text) return;
      const lang = SpeechSDK.AutoDetectSourceLanguageResult.fromResult(e.result).language || "";
      const toZh = lang.startsWith("ja");
      const translated = e.result.translations.get(toZh ? "zh-Hans" : "ja") || "";
      const payload = { type: "caption", t: Date.now(), srcLang: lang, original: e.result.text, translated };
      // 自分のUI
      pushLine({ id: crypto.randomUUID(), who: "self", t: payload.t, srcLang: lang, original: payload.original, translated });
      setPartial("");
      // 相手に送信
      if (sendChanRef.current?.readyState === "open") {
        sendChanRef.current.send(JSON.stringify(payload));
      }
    };

    //recognizer.canceled = () => stop();
    // 失敗時に理由が出るようハンドラも追加
    recognizer.canceled = (_s, e) => {
    console.warn("Speech canceled:", e.errorDetails || e);
 };
    recognizer.sessionStopped = () => stop();
    recognizer.startContinuousRecognitionAsync();
  };

  const stop = () => {
    recogRef.current?.stopContinuousRecognitionAsync(() => {
      recogRef.current?.close(); recogRef.current = null;
    });
    pcRef.current?.close(); pcRef.current = null;
    wpsRef.current?.stop(); wpsRef.current = null;
    sendChanRef.current = null;
    setStarted(false);
    setPartial("");
  };

  useEffect(() => () => stop(), []);

  return (
    <div style={{height:"100vh", display:"grid", gridTemplateRows:"1fr 1fr"}}>
      {/* 上：ローカル／リモート映像 */}
      <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, padding:8, background:"#000"}}>
        <video ref={localVideoRef} style={{width:"100%",height:"100%",objectFit:"cover"}} muted playsInline />
        <video ref={remoteVideoRef} style={{width:"100%",height:"100%",objectFit:"cover"}} playsInline />
      </div>

      {/* 下：字幕タイムライン */}
      <div style={{padding:12, overflow:"auto", background:"#101010", color:"#eee"}}>
        <div style={{display:"flex", gap:8, marginBottom:8}}>
          {!started
            ? <button onClick={start} style={{padding:"8px 12px"}}>▶ 接続開始（room: {room}）</button>
            : <button onClick={stop}  style={{padding:"8px 12px"}}>⏹ 終了</button>}
        </div>

        {partial && (
          <div style={{padding:"8px 10px", marginBottom:8, background:"#1f1f1f", borderLeft:"4px solid #6a6a6a"}}>
            <div style={{fontSize:12, opacity:.8}}>（認識中）</div>
            <div>{partial}</div>
          </div>
        )}

        {lines.map(l => (
          <div key={l.id} style={{padding:"10px 12px", marginBottom:10, background:"#171717", borderLeft:`4px solid ${l.who==="self"?"#2aa":"#e34"}`}}>
            <div style={{fontSize:12, opacity:.7}}>
              {new Date(l.t).toLocaleTimeString()} / {l.who === "self" ? "You" : "Peer"} / Detected: {l.srcLang}
            </div>
            <div style={{fontWeight:600}}>{l.original}</div>
            <div>→ {l.translated}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
