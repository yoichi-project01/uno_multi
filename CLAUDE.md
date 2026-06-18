# UNO Online — プロジェクト概要

オンライン対戦UNO Webアプリ（2〜4人、500点先取制）。  
**要件定義書**に基づいてMVP+αとして実装済み。

## 起動

```bash
npm install   # 初回のみ
npm start     # http://localhost:3000
```

開発中は `npx nodemon server.js` でホットリロード可。

---

## ファイル構成

```
uno_multi/
├── server.js                  # Express + Socket.io サーバー（全ゲームロジック含む）
├── game/
│   ├── cardDeck.js            # デッキ生成・シャッフル・点数計算
│   └── gameEngine.js          # canPlay / getPlayableUids / resolveCardEffect（純粋関数）
└── public/
    ├── index.html             # SPA（6画面状態を1ファイルで管理）
    ├── css/style.css          # ダークゲーミングUI、CSSベースカード描画
    ├── js/app.js              # クライアント側 Socket.io + UIレンダリング
    └── assets/cards/          # カード画像置き場（任意。なくてもCSSで動作）
```

---

## アーキテクチャ

### サーバー設計

- **ゲーム管理はすべてサーバー側** — ブラウザには「自分の手札」と「他プレイヤーの枚数」のみ送信
- `rooms: Map<roomCode, roomState>` — 全ルームをインメモリで管理
- `socketMeta: Map<socketId, { roomCode, playerId }>` — ソケットとルームの対応

**roomState の主なフィールド:**

```js
{
  code, hostPlayerId, players, status,        // 'waiting'|'playing'|'roundEnd'|'gameEnd'
  deck, discardPile, topCard, currentColor,
  currentPlayerIndex, direction,              // direction: 1=時計回り, -1=反時計回り
  unoState,        // { playerId, declared } | null
  waitingForColor, // { playerId, nextIndex } | null
  hasDrawnThisTurn, drawnCardUid,
  timerInterval, timerSeconds,
  lastActivity
}
```

### カードID体系

各カードは `uid`（デッキ内で一意）と `imageId`（画像ファイル名と1対1対応）を持つ:

| 種類 | uid 例 | imageId 例 |
|------|--------|------------|
| 数字カード | `c0`〜`c107` | `red-5` |
| 特殊カード | 同上 | `green-skip`, `yellow-reverse`, `red-draw2` |
| ワイルド | 同上 | `wild-normal`, `wild-draw4` |

---

## Socket.io イベント一覧

### クライアント → サーバー

| イベント | ペイロード | 説明 |
|----------|-----------|------|
| `createRoom` | `{ nickname }` | 部屋作成 |
| `joinRoom` | `{ roomCode, nickname, playerId? }` | 参加・再接続 |
| `startGame` | — | ゲーム開始（ホストのみ） |
| `playCard` | `{ uid }` | カードを出す |
| `chooseColor` | `{ color }` | ワイルドカードの色選択 |
| `drawCard` | — | 山札から1枚引く |
| `passTurn` | — | ドロー後にパス |
| `declareUno` | — | UNO宣言 |
| `challengeUno` | `{ targetPlayerId }` | UNO告発 |
| `sendEmote` | `{ emoteId }` | エモート送信 |
| `leaveRoom` | — | 退室 |

### サーバー → クライアント（全員）

| イベント | 内容 |
|----------|------|
| `roomUpdate` | 待機室プレイヤーリスト更新 |
| `gameStarting` | ゲーム開始アナウンス |
| `roundStarted` | ラウンド開始（画面遷移トリガー） |
| `turnStart` | `{ playerId, seconds }` ターン開始 |
| `timerTick` | `{ seconds }` 毎秒カウントダウン |
| `cardPlayed` | `{ playerId, imageId }` カードを出した通知 |
| `playerDrewCards` | `{ playerId, count }` カードを引いた通知 |
| `waitingForColor` | `{ playerId }` 色選択待ち |
| `colorChosen` | `{ color, playerId }` 色確定 |
| `unoWindow` | `{ playerId }` UNOボタン表示トリガー |
| `unoDeclared` | `{ playerId }` UNO宣言通知 |
| `unoChallenge` | `{ challengerId, targetId, success }` 告発結果 |
| `deckReshuffled` | 捨て札から山札を再生成した通知 |
| `emote` | `{ playerId, emoteId }` エモート |
| `playerDisconnected` | `{ playerId, players }` |
| `playerReconnected` | `{ playerId, players }` |
| `playerLeft` | `{ playerId, players }` |
| `roundResult` | `{ winnerId, roundScores, totalScores, hands }` |
| `gameResult` | `{ winnerId, totalScores }` |
| `gameCancelled` | `{ reason }` プレイヤー不足でゲーム終了 |

### サーバー → 特定クライアント

| イベント | 内容 |
|----------|------|
| `roomCreated` | `{ roomCode, playerId, players }` |
| `roomJoined` | `{ roomCode, playerId, isHost }` |
| `gameState` | 個人宛ゲーム状態（手札含む） |
| `drewCard` | `{ card, canPlay }` 自分が引いたカード |
| `error` | `{ message }` |

---

## ゲームフロー実装詳細

### ターン進行
1. `startTurn(room)` → 15秒タイマー開始、`turnStart` を全員に送信
2. 現在プレイヤーが `playCard` or `drawCard` を送信
3. サーバーが検証・処理 → `advanceTurn(room, nextIndex)` で次のターンへ
4. タイマー切れ → 自動1枚ドロー＋ターン移行

### ワイルドカードの色選択（2ステップ）
1. プレイヤーが `playCard` → サーバーが `waitingForColor` を全員に送信
2. 対象プレイヤーの画面に色選択ポップアップ表示
3. プレイヤーが `chooseColor` → `colorChosen` を全員に送信 → ターン進行

### 上がり処理（draw2 / wild-draw4 が最後の1枚の場合）
次のプレイヤーに規定枚数を引かせてから `endRound()` を呼ぶ。  
引いたカードも得点計算に含まれる（要件通り）。

### UNO宣言・告発
- 手札が2→1枚になった瞬間、`unoState = { playerId, declared: false }` をセット
- 本人が `declareUno` → `declared = true`（以降の告発は失敗扱い）
- 他プレイヤーが `challengeUno` かつ `!declared` → 対象プレイヤーが2枚ドロー
- 次のプレイヤーがアクションを起こすと `unoState` はクリア

### 再接続
- クライアントは `localStorage` に `roomCode` と `playerId` を保存
- 再接続時に `joinRoom { roomCode, nickname, playerId }` を送信
- サーバーは `playerId` でプレイヤーを特定し、ソケットIDを更新して復帰

### 部屋のクリーンアップ
- `lastActivity` から30分経過したルームを毎分チェックして削除

---

## カード画像の追加方法

`public/assets/cards/` に PNG（背景透過推奨、200×300px基準）を配置するだけで自動適用される。  
画像がない場合はCSSカードにフォールバックするため、画像なしでも完全プレイアブル。

**命名規則:**

```
red-0.png 〜 red-9.png   (青・緑・黄も同様)
red-skip.png, red-reverse.png, red-draw2.png  (色×種類)
wild-normal.png, wild-draw4.png
card-back.png
```

---

## UI設計方針

### スクロールを最小化する
- **各画面は1スクリーン内に収める** — ユーザーがスクロールしなくても全ての操作が見える設計にする
- コンテンツが多い画面（設定など）は**タブ**で分割し、1タブあたりのコンテンツをスクリーン内に収める
- フォームはシンプルに保ち、1画面に入力欄を詰め込みすぎない
- 縦スクロールが必要な箇所は原則として避ける。やむを得ない場合は最小限にとどめる

### 画面構成
- 白背景（#fff / #f5f5f7）: ログイン・設定画面
- ダーク背景（#111827）: トップ・ロビー（ルール設定）・参加・ゲーム・待機室画面
- 白背景画面では input・ボタン・ラベルすべてをダークテーマ用スタイルで上書きする

---

## 未実装・今後の拡張候補

- [ ] カード画像アセット（要件定義の命名規則に沿って追加するだけ）
- [ ] HTTPS対応（本番公開時は nginx / Cloudflare Tunnel 等でラップ）
- [ ] 観戦モード
- [ ] チャット機能
- [ ] サウンドエフェクト
- [ ] ゲームログ / アニメーション強化
