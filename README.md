# JP↔ZH Translator Call (Azure)

WebRTC で遠隔 2者が同じ URL に入室し、映像・音声通話しながら **Azure Speech** で自動文字起こし＋**日本語⇄中国語**の相互翻訳字幕を表示します。  
シグナリングは **Azure Web PubSub**、トークン払い出しは **Azure Functions**。

## 構成
- Frontend: React + Vite (`web/`)
- Backend: Azure Functions v4 (Node/TypeScript) (`api/`)
- Azure: Speech（翻訳・自動言語識別）, Web PubSub（シグナリング）
- WebRTC: P2P（STUNのみのサンプル。**本番は TURN 必須**）

---

## 前提ツール
- Node.js 18+
- Azure Functions Core Tools v4
- （任意）Azure CLI / Azure Portal

## Azure リソースの準備
1. **Speech** リソースを作成（リージョン例: `japaneast`）  
   - キーとリージョンを控えます。
2. **Azure Web PubSub** を作成  
   - 接続文字列（Connection string）を控えます。
3. （ローカル動作のみの場合）Azure Storage は不要。デプロイ時は Functions に紐づけ必要です。

## ローカル実行
1. 依存インストール
   ```bash
   cd api && npm i
   cd ../web && npm i
   cd .. && npm i   # ルートの concurrently 用（省略可）

## 1人での初動テスト（Speech単体＋UI）

ブラウザで http://localhost:5173/?room=debug1 を開く

「▶ 接続開始」を押して カメラ/マイク許可
まずは自分1人だけで、下部に「（認識中）」が出るか／確定字幕が積まれるかを確認
日本語で話す → Detected: ja-JP ＋ 中国語（簡体）へ翻訳
中国語で話す → Detected: zh-CN ＋ 日本語へ翻訳
ここまでで字幕が出れば Speech SDK はOK。
出ないときは：
ブラウザのマイク許可
Console のエラー（/api/speechToken 失敗、トークン切れ 10分問題など）

# ターミナルA（Functions）
cd api
npm run dev   # http://localhost:7071 でAPI起動

## 動作確認（別のターミナル or curl）
- Web PubSub ネゴシエーション（URLが返ればOK）
curl -X POST http://localhost:7071/api/negotiate

- Speech トークン（token と region が返ればOK）
curl -X POST http://localhost:7071/api/speechToken   # http://localhost:7071 でAPI起動

# ターミナルB（Vite）
cd web
npm run dev   # http://localhost:5173
