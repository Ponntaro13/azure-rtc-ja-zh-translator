// ---- utils/logging.ts ----
type Any = any;

export function parseCand(cand: string) {
  // "candidate:foundation 1 udp 2122260223 192.168.1.2 60769 typ host ..." を分解
  const m = cand.match(
    /candidate:(\S+)\s+\d+\s+(\S+)\s+\d+\s+(\S+)\s+(\d+)\s+typ\s+(\S+)(?:\s+raddr\s+(\S+)\s+rport\s+(\d+))?/i
  );
  if (!m) return { raw: cand };
  const [_, foundation, protocol, address, port, typ, raddr, rport] = m;
  return { foundation, protocol, address, port: Number(port), typ, raddr, rport, raw: cand };
}

export function attachPCDebug(pc: RTCPeerConnection, label = "pc") {
  (window as any)[label] = pc; // devtools から参照できるように

  pc.addEventListener("negotiationneeded", () => console.log(`[${label}] negotiationneeded`));
  pc.addEventListener("signalingstatechange", () =>
    console.log(`[${label}] signalingState=`, pc.signalingState)
  );
  pc.addEventListener("icegatheringstatechange", () =>
    console.log(`[${label}] iceGatheringState=`, pc.iceGatheringState)
  );
  pc.addEventListener("iceconnectionstatechange", () =>
    console.log(`[${label}] iceConnectionState=`, pc.iceConnectionState)
  );
  pc.addEventListener("connectionstatechange", () =>
    console.log(`[${label}] connectionState=`, pc.connectionState)
  );

  pc.addEventListener("icecandidate", (e) => {
    if (!e.candidate) {
      console.log(`[${label}] ICE gathering complete`);
      return;
    }
    const p = parseCand(e.candidate.candidate);
    console.log(`[${label}] local ICE`, p);
  });

  pc.addEventListener("icecandidateerror", (e: Any) => {
    // RTCPeerConnectionIceErrorEvent
    console.warn(
      `[${label}] icecandidateerror`,
      { url: e.url, errorCode: e.errorCode, errorText: e.errorText, hostCandidate: e.hostCandidate }
    );
  });

  pc.addEventListener("track", (e) => {
    for (const t of e.streams?.[0]?.getTracks() || []) {
      console.log(`[${label}] ontrack:`, {
        kind: t.kind, id: t.id, readyState: t.readyState, muted: (t as Any).muted
      });
    }
  });

  pc.addEventListener("datachannel", (e) => {
    console.log(`[${label}] ondatachannel:`, e.channel.label);
    e.channel.addEventListener("open", () => console.log(`[${label}] dc open:`, e.channel.label));
    e.channel.addEventListener("close", () => console.log(`[${label}] dc close:`, e.channel.label));
    e.channel.addEventListener("message", (m) => console.log(`[${label}] dc msg:`, e.channel.label, m.data));
    e.channel.addEventListener("error", (err) => console.warn(`[${label}] dc error:`, err));
  });

  // 選択された候補ペア / コーデックなどを定期的に要約
  let statsTimer: any = null;
  const pullStats = async () => {
    if (!pc) return;
    const stats = await pc.getStats();
    const byType = new Map<string, RTCStats[]>();
    stats.forEach((s) => {
      const arr = byType.get(s.type) || [];
      arr.push(s as Any);
      byType.set(s.type, arr);
    });

    // transport -> selected candidate pair id
    const transport = (byType.get("transport") || [])[0] as Any;
    const selectedId =
      transport?.selectedCandidatePairId ||
      (transport && transport["rtcpTransportStatsId"]) ||
      undefined;

    // candidate-pair summary
    let pair: Any;
    (byType.get("candidate-pair") || []).forEach((p: Any) => {
      if (p.id === selectedId || p.selected) pair = p;
    });

    const locals = new Map<string, Any>();
    (byType.get("local-candidate") || []).forEach((c: Any) => locals.set(c.id, c));
    const remotes = new Map<string, Any>();
    (byType.get("remote-candidate") || []).forEach((c: Any) => remotes.set(c.id, c));

    if (pair) {
      const lc = locals.get(pair.localCandidateId);
      const rc = remotes.get(pair.remoteCandidateId);
      console.log("[stats] selected pair:", {
        state: pair.state,
        currentRoundTripTime: pair.currentRoundTripTime,
        availableOutgoingBitrate: pair.availableOutgoingBitrate,
        local: lc && { type: lc.candidateType, ip: lc.ip || lc.address, port: lc.port, protocol: lc.protocol, networkType: lc.networkType },
        remote: rc && { type: rc.candidateType, ip: rc.ip || rc.address, port: rc.port, protocol: rc.protocol }
      });
    } else {
      console.log("[stats] no selected candidate pair yet");
    }

    // メディアのアウト/インのビットレートなど（目視判断用）
    for (const t of (byType.get("outbound-rtp") || [])) {
      if ((t as Any).mediaType === "video") {
        console.log("[stats] outbound video:", {
          bitrate: (t as Any).bytesSent,
          frames: (t as Any).framesEncoded,
          encoderImplementation: (t as Any).encoderImplementation
        });
      }
    }
    for (const t of (byType.get("inbound-rtp") || [])) {
      if ((t as Any).mediaType === "video") {
        console.log("[stats] inbound video:", {
          bitrate: (t as Any).bytesReceived,
          frames: (t as Any).framesDecoded,
          jitter: (t as Any).jitter
        });
      }
    }
  };

  const startStats = () => {
    if (statsTimer) return;
    statsTimer = setInterval(pullStats, 2000);
  };
  const stopStats = () => statsTimer && clearInterval(statsTimer);

  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "connected") startStats();
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) stopStats();
  });
}
